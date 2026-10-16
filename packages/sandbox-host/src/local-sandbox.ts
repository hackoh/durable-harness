import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ExecOptions,
  type ExecResult,
  type Inspection,
  JOB_READ_LIMITS,
  type JobFiles,
  type JobParts,
  type Manifest,
  type ManifestOptions,
  parseReport,
  type SandboxHandle,
  type SandboxJob,
  type SandboxOwner,
  type SandboxProvider,
} from 'harness-world-hybrid';

/**
 * The job wrapper the daemon runs: the same job directory as
 * the Sandbox API path (`cmd`, `child.pid`, `stdout`, `stderr`,
 * `result.json`, optional `report.env`), in Node so it runs anywhere the
 * daemon does (the VM, and a laptop for local e2e). It is spawned detached:
 * it outlives the daemon, puts the command in a process group of its own (a
 * kill reaches everything it started), enforces the command's own budget
 * (exit 124, or 137 after the grace kill), and writes `result.json` before it
 * exits. The command runs with an explicit minimal environment and, in the
 * VM, as an unprivileged user with no sudo: no OIDC token, no host secret.
 *
 * argv: <jobdir> <timeoutSeconds> <cwd> <envJson> [uid gid]
 */
export const NODE_WRAPPER = `// harness sandbox_exec wrapper (node) v1
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync, readFileSync, existsSync, writeSync } from 'node:fs';
const [dir, T, cwd, envJson, uid, gid] = process.argv.slice(2);
const H = ${8000};
const out = openSync(dir + '/stdout', 'w'); const err = openSync(dir + '/stderr', 'w');
const opts = { cwd, env: JSON.parse(envJson), detached: true, stdio: ['ignore', out, err] };
if (uid) { opts.uid = Number(uid); opts.gid = Number(gid); }
let child;
try { child = spawn('bash', ['-l', dir + '/cmd'], opts); } catch (e) { writeSync(err, String(e)); }
let code = 127, timedOut = false, killer;
const done = (c) => {
  clearTimeout(killer);
  closeSync(out); closeSync(err);
  const clip = (p) => {
    let fd; try { fd = openSync(p, 'r'); } catch { return { bytes: 0, head: '', tail: '' }; }
    try {
      const n = fstatSync(fd).size, B = H * 4, hb = Buffer.alloc(Math.min(n, B)); readSync(fd, hb, 0, hb.length, 0);
      let tb = Buffer.alloc(0);
      if (n > B) { const s = Math.max(B, n - B); tb = Buffer.alloc(n - s); readSync(fd, tb, 0, tb.length, s); }
      if (tb.length) return { bytes: n, head: hb.toString('utf8').slice(0, H), tail: tb.toString('utf8').slice(-H) };
      const t = hb.toString('utf8');
      return { bytes: n, head: t.slice(0, H), tail: t.length > H ? t.slice(Math.max(H, t.length - H)) : '' };
    } finally { closeSync(fd); }
  };
  const r = { v: 1, exitCode: c, timedOut: c === 124, stdout: clip(dir + '/stdout'), stderr: clip(dir + '/stderr'), endedAt: Date.now() };
  writeFileSync(dir + '/result.json.tmp', JSON.stringify(r)); renameSync(dir + '/result.json.tmp', dir + '/result.json');
  report().finally(() => process.exit(c));
};
async function report() {
  if (!existsSync(dir + '/report.env')) return;
  const env = Object.fromEntries(readFileSync(dir + '/report.env', 'utf8').split('\\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, '')]; }));
  for (let i = 1; i <= 8; i++) {
    try {
      const res = await fetch(env.URL, { method: 'POST', headers: { authorization: 'Bearer ' + env.TOKEN, 'content-type': 'application/json' }, body: readFileSync(dir + '/result.json') });
      if (res.ok || [400, 401, 403, 404, 410, 413].includes(res.status)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, Math.min(i, 4) * 1000));
  }
}
if (!child) done(127);
else {
  writeFileSync(dir + '/child.pid', String(child.pid));
  const kill = (s) => { try { process.kill(-child.pid, s); } catch {} };
  killer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, Number(T) * 1000);
  process.on('SIGTERM', () => kill('SIGTERM'));
  child.on('error', () => done(127));
  child.on('exit', (c, sig) => done(timedOut ? (sig === 'SIGKILL' ? 137 : 124) : c ?? (sig === 'SIGKILL' ? 137 : 128 + 15)));
}
`;

export interface LocalSandboxOptions {
  /** The VM's sandbox name (owners name it; a function collects through the Sandbox API by it). */
  name: string;
  /** The VM session (the Sandbox API's `sessionId`): a stop and resume is a new one. */
  sessionId: string;
  /**
   * Prefix that logical paths (`/workspace`, `/tmp/harness`) are mapped
   * under. `''` in the VM; a temp dir for tests and a laptop daemon.
   */
  base?: string;
  /** Run commands as this user (the VM's unprivileged `harness-run`). Unset: the daemon's own user. */
  runAs?: { uid: number; gid: number };
  /** The commands' whole environment (default: a minimal PATH/HOME/LANG). Never the daemon's. */
  env?: Record<string, string>;
  /** The Node binary for the wrapper. Default: the daemon's. */
  node?: string;
  /**
   * Stop this whole VM (the Kill Sandbox VM crash): the daemon cannot stop
   * its own VM through the Sandbox API, so it asks the app to.
   */
  stopVm?: () => Promise<void>;
}

const MAPPED = ['/workspace', '/tmp/harness'];

/** The minimal environment model-run commands get: nothing secret. */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/home/harness-run',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    ...extra,
  };
}

/**
 * `SandboxProvider` over the daemon's own machine: the session's
 * `run_on_machine` runs with the same job format as the
 * Sandbox API path, but the wrapper is a local child process (no API hop)
 * and the workspace sync is plain filesystem calls.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly kind = 'local';
  readonly handle: LocalSandboxHandle;

  constructor(readonly options: LocalSandboxOptions) {
    this.handle = new LocalSandboxHandle(options);
  }

  get name() {
    return this.options.name;
  }

  async open(): Promise<SandboxHandle> {
    return this.handle;
  }

  invalidate(): void {}

  async inspect(owner: SandboxOwner): Promise<Inspection> {
    if (owner.sandbox !== this.options.name) return { state: 'lost', why: 'replaced' };
    if (owner.sessionId !== this.options.sessionId) return { state: 'lost', why: 'replaced' };
    const exit = await this.handle.exitOf(owner.jobDir);
    if (exit !== undefined) return { state: 'exited', exitCode: exit };
    return this.handle.alive(owner.cmdId) ? { state: 'running' } : { state: 'lost', why: 'command-missing' };
  }

  async attach(owner: SandboxOwner): Promise<SandboxHandle | 'lost'> {
    if (owner.sandbox !== this.options.name || owner.sessionId !== this.options.sessionId) return 'lost';
    return this.handle;
  }

  async stopVm(): Promise<void> {
    if (!this.options.stopVm) throw new Error('this host cannot stop its VM');
    await this.options.stopVm();
  }

  /** Kill every command this daemon started (a local "VM death"). */
  killAll(): void {
    this.handle.killAll();
  }
}

/** `pid:<n>`: a command the daemon spawned (not a Sandbox API command id). */
export const pidOf = (cmdId: string): number | undefined => {
  const m = /^pid:(\d+)$/.exec(cmdId);
  return m ? Number(m[1]) : undefined;
};

export class LocalSandboxHandle implements SandboxHandle {
  private readonly base: string;
  /** Job dirs (logical) of the commands this handle started. */
  private readonly jobs = new Map<string, string>();

  constructor(private readonly options: LocalSandboxOptions) {
    this.base = options.base ?? '';
  }

  get name() {
    return this.options.name;
  }

  /** Logical path → path on this machine. */
  map(path: string): string {
    if (!this.base) return path;
    return MAPPED.some((m) => path === m || path.startsWith(`${m}/`)) ? join(this.base, path) : path;
  }

  private async own(path: string) {
    const r = this.options.runAs;
    if (r) await chown(path, r.uid, r.gid).catch(() => {});
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', command], {
        cwd: this.map(options.cwd),
        env: this.options.env ?? scrubbedEnv(),
        ...(this.options.runAs ?? {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      });
      options.onStart?.(`pid:${child.pid}`);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
        options.onOutput?.('stdout', d.toString());
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
        options.onOutput?.('stderr', d.toString());
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? 137, stdout, stderr }));
    });
  }

  async manifest(root: string, options: ManifestOptions): Promise<Manifest> {
    const out: Manifest = new Map();
    const physical = this.map(root);
    const walk = async (dir: string, rel: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!options.skipDirs.includes(e.name)) await walk(p, r);
        } else if (e.isFile()) {
          const buf = await readFile(p).catch(() => undefined);
          if (!buf) continue;
          // Text files only: empty, or no NUL in the first 8 KiB (grep -I's rule, near enough).
          if (buf.length > 0 && buf.subarray(0, 8192).includes(0)) continue;
          out.set(`${root}/${r}`, { hash: createHash('sha256').update(buf).digest('hex'), size: buf.length });
        }
      }
    };
    await walk(physical, '');
    return out;
  }

  async writeFiles(files: { path: string; content: string }[]): Promise<void> {
    for (const f of files) {
      const p = this.map(f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content);
      if (f.path.startsWith('/workspace')) await this.own(p);
    }
  }

  async readTextFile(path: string): Promise<string | null> {
    try {
      const buf = await readFile(this.map(path));
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  async remove(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => rm(this.map(p), { force: true })));
  }

  async start(job: SandboxJob): Promise<{ cmdId: string; sessionId: string }> {
    const dir = this.map(`/tmp/harness/${job.stepId}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.mjs'), NODE_WRAPPER);
    const cwd = this.map('/workspace');
    await mkdir(cwd, { recursive: true });
    // A function lane may have run commands here as the VM's default user
    // (the remote path): take the workspace back for the command's user.
    if (this.options.runAs) spawnSync('chown', ['-R', `${this.options.runAs.uid}:${this.options.runAs.gid}`, cwd]);
    const r = this.options.runAs;
    const child = spawn(
      this.options.node ?? process.execPath,
      [join(dir, 'run.mjs'), dir, String(job.timeoutSeconds), cwd, JSON.stringify(this.options.env ?? scrubbedEnv()), ...(r ? [String(r.uid), String(r.gid)] : [])],
      // Detached and unref'd: the wrapper outlives the daemon.
      { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }
    );
    child.unref();
    const cmdId = `pid:${child.pid}`;
    this.jobs.set(cmdId, `/tmp/harness/${job.stepId}`);
    return { cmdId, sessionId: this.options.sessionId };
  }

  /** The wrapper's exit code from `result.json`, if it finished. */
  async exitOf(jobDir: string): Promise<number | undefined> {
    const job = await this.readJob(jobDir, { result: true });
    return job.result?.exitCode;
  }

  alive(cmdId: string): boolean {
    const pid = pidOf(cmdId);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async waitFor(cmdId: string, ms: number): Promise<{ exitCode: number } | undefined> {
    if (ms <= 0) return undefined;
    const deadline = Date.now() + ms;
    const dir = this.jobs.get(cmdId);
    for (;;) {
      if (dir) {
        const exit = await this.exitOf(dir);
        if (exit !== undefined) return { exitCode: exit };
      }
      // Not ours, or the wrapper died without a report: the collectors read the job dir.
      if (!this.alive(cmdId) && (!dir || (await this.exitOf(dir)) === undefined)) return undefined;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  async readJob(jobDir: string, want: JobParts = { result: true, baseline: true }): Promise<JobFiles> {
    const dir = this.map(jobDir);
    // Only regular files, never followed through a symlink, and bounded.
    const read = async (name: string, limit: number, mode: 'whole' | 'head') => {
      const p = join(dir, name);
      const st = await lstat(p).catch(() => undefined);
      if (!st?.isFile()) return undefined;
      if (mode === 'whole' && st.size > limit) return undefined;
      const fh = await open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, limit));
        await fh.read(buf, 0, buf.length, 0);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    };
    const out: JobFiles = {};
    if (want.result) {
      const text = await read('result.json', JOB_READ_LIMITS.result, 'whole');
      if (text) {
        try {
          const parsed = parseReport(JSON.parse(text));
          if (parsed) out.result = parsed;
        } catch {}
      }
    }
    if (want.baseline) {
      const text = await read('baseline.json', JOB_READ_LIMITS.baseline, 'whole');
      if (text !== undefined) out.baselineText = text;
    }
    if (want.output) {
      const so = await read('stdout', JOB_READ_LIMITS.output, 'head');
      const se = await read('stderr', JOB_READ_LIMITS.output, 'head');
      if (so !== undefined) out.stdout = so;
      if (se !== undefined) out.stderr = se;
    }
    return out;
  }

  async killCommand(target: { cmdId: string; jobDir?: string }): Promise<void> {
    if (target.jobDir) {
      const pid = Number((await readFile(join(this.map(target.jobDir), 'child.pid'), 'utf8').catch(() => '')).trim());
      if (pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      return;
    }
    await this.kill(target.cmdId);
  }

  async kill(cmdId: string): Promise<void> {
    const pid = pidOf(cmdId);
    if (pid === undefined) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  async ensureTimeout(): Promise<void> {}

  killAll(): void {
    for (const cmdId of this.jobs.keys()) {
      const pid = pidOf(cmdId);
      if (pid === undefined) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }
}
