import { Bash, InMemoryFs } from 'harness-world-hands';
import { mintResultToken } from './callback.ts';
import { clipTail, parseReport } from './sandbox-job.ts';
import {
  type ExecOptions,
  type ExecResult,
  type Inspection,
  JOB_READ_LIMITS,
  type JobFiles,
  type JobParts,
  type Manifest,
  type ManifestOptions,
  type SandboxHandle,
  type SandboxJob,
  SandboxLostError,
  type SandboxOwner,
  type SandboxProvider,
  type SandboxReport,
  sandboxNameFor,
  sha256Hex,
} from './sandbox-sync.ts';

/** A pushed report, as the wrapper would POST it. Returns the HTTP status the "endpoint" answered. */
export type FakeReportSink = (report: { url: string; token: string; body: string }) => Promise<number>;

export interface FakeSandboxOptions {
  /** Configure push: jobs get a callback URL and a real capability token. */
  push?: { url: string; secret: string };
}

/**
 * A stand-in for Vercel Sandbox: one just-bash machine per session, with its
 * own filesystem that is *not* the workspace fold, so tests exercise the
 * same sync-in / sync-out path the real sandbox takes. Persistent for the
 * provider's lifetime, which is what "named and persistent" means in a test.
 *
 * Commands run detached, the way the real wrapper runs them: `start` returns
 * at once, the command writes `result.json` (and its output files) into the
 * job dir when it exits, and, with push configured, "POSTs" its report to
 * `onReport`. Tests can hold a command, kill it, kill its wrapper, drop its
 * report, or stop its VM.
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly kind = 'fake';
  readonly machines = new Map<string, FakeSandbox>();
  /** Every command run, in order, for assertions. */
  readonly commands: { sandbox: string; command: string }[] = [];
  /** Sessions whose connection was invalidated, in order. */
  readonly invalidated: string[] = [];
  /** Commands killed with `kill`/`killCommand`, by id. */
  readonly kills: string[] = [];
  /** Machines created so far (a lost machine is replaced by a new one). */
  created = 0;
  /** Where pushed reports go (push only). */
  onReport?: FakeReportSink;
  /** Reports the wrapper attempted, with the status it got back. */
  readonly reports: { stepId: string; status: number }[] = [];
  /** Every job file a collector read, and how many bytes it got (they must stay bounded). */
  readonly jobReads: { path: string; bytes: number }[] = [];

  constructor(readonly options: FakeSandboxOptions = {}) {}

  /** The push callback, when one is configured (`run_on_machine` refuses it). */
  get callback(): FakeSandboxOptions['push'] {
    return this.options.push;
  }

  async open(sessionId: string): Promise<SandboxHandle> {
    const name = sandboxNameFor(sessionId);
    let machine = this.machines.get(name);
    if (!machine || machine.dead) {
      machine = new FakeSandbox(name, this, `sess_${name}_${this.created}`);
      machine.doomed = this.doom.get(name);
      this.doom.delete(name);
      await machine.fs.mkdir('/workspace', { recursive: true });
      this.machines.set(name, machine);
      this.created++;
    }
    return machine;
  }

  invalidate(sessionId: string): void {
    this.invalidated.push(sessionId);
  }

  async reportFor(job: { runId: string; stepId: string; sandbox: string; timeoutSeconds: number; startedAt: number }) {
    const push = this.options.push;
    if (!push) return undefined;
    const token = await mintResultToken(push.secret, {
      r: job.runId,
      s: job.stepId,
      n: job.sandbox,
      x: Math.floor(job.startedAt / 1000) + job.timeoutSeconds + 900,
    });
    return { url: push.url, token };
  }

  async inspect(owner: SandboxOwner): Promise<Inspection> {
    const machine = this.machines.get(owner.sandbox);
    if (!machine) return { state: 'lost', why: 'deleted' };
    if (machine.dead) return { state: 'lost', why: 'stopped' };
    if (machine.sessionId !== owner.sessionId) return { state: 'lost', why: 'replaced' };
    const job = machine.jobs.get(owner.cmdId);
    if (!job) return { state: 'lost', why: 'command-missing' };
    return job.exitCode === undefined ? { state: 'running' } : { state: 'exited', exitCode: job.exitCode };
  }

  async attach(owner: SandboxOwner): Promise<SandboxHandle | 'lost'> {
    const machine = this.machines.get(owner.sandbox);
    if (!machine || machine.dead || machine.sessionId !== owner.sessionId) return 'lost';
    return machine;
  }

  async stopVm(owner: SandboxOwner): Promise<void> {
    const machine = this.machines.get(owner.sandbox);
    machine?.stop();
  }

  /**
   * Make a session's machine die: before its next command starts
   * (`start`), or partway through it (`run`: the command runs, then the VM
   * is gone before it can report, with whatever it changed). The next
   * `open` gets a fresh machine, as a sandbox with nothing to resume would.
   */
  lose(sessionId: string, at: 'start' | 'run'): void {
    const name = sandboxNameFor(sessionId);
    const machine = this.machines.get(name);
    if (machine && !machine.dead) machine.doomed = at;
    else this.doom.set(name, at);
  }

  /** Make the next start of a command matching `pattern` launch it and then never return (its caller dies with it). */
  hang(pattern: string): void {
    this.hangs.add(pattern);
  }

  /** The next command matching `pattern` starts and waits until `release(pattern)` (or a kill). */
  hold(pattern: string): void {
    this.holds.set(pattern, undefined);
  }

  release(pattern: string): void {
    const waiting = this.holds.get(pattern);
    this.holds.delete(pattern);
    waiting?.();
  }

  /** Kill a job's wrapper too: it exits 137 without writing `result.json` or reporting. */
  killWrapper(cmdId: string): void {
    for (const machine of this.machines.values()) machine.jobs.get(cmdId)?.killWrapper();
  }

  /** The job a command id names, anywhere. */
  job(cmdId: string): FakeJob | undefined {
    for (const machine of this.machines.values()) {
      const job = machine.jobs.get(cmdId);
      if (job) return job;
    }
    return undefined;
  }

  private readonly doom = new Map<string, 'start' | 'run'>();
  readonly hangs = new Set<string>();
  /** pattern → release, once a command is waiting on it. */
  readonly holds = new Map<string, (() => void) | undefined>();
}

export class FakeJob {
  exitCode?: number;
  done: Promise<void>;
  private finish!: () => void;
  private unhold?: () => void;
  killed = false;
  wrapperKilled = false;

  constructor(
    readonly cmdId: string,
    readonly jobDir: string
  ) {
    this.done = new Promise((r) => (this.finish = r));
  }

  hold(): Promise<void> {
    return new Promise((r) => (this.unhold = r));
  }

  release(): void {
    this.unhold?.();
  }

  kill(): void {
    this.killed = true;
    this.release();
  }

  killWrapper(): void {
    this.wrapperKilled = true;
    this.killed = true;
    this.release();
  }

  end(exitCode?: number): void {
    this.exitCode = exitCode;
    this.finish();
  }
}

export class FakeSandbox implements SandboxHandle {
  readonly fs = new InMemoryFs();
  private readonly bash: Bash;
  doomed?: 'start' | 'run';
  dead = false;
  private cmds = 0;
  readonly jobs = new Map<string, FakeJob>();

  constructor(
    readonly name: string,
    private readonly provider: FakeSandboxProvider,
    readonly sessionId: string
  ) {
    this.bash = new Bash({ fs: this.fs, cwd: '/workspace', defenseInDepth: false });
  }

  private alive(phase: 'start' | 'run' | 'sync') {
    if (this.dead) throw new SandboxLostError({ phase, sandbox: this.name, code: 'stopped' });
  }

  /** The VM stops: every job on it dies without reporting. */
  stop(): void {
    this.dead = true;
    for (const job of this.jobs.values()) {
      job.release();
      if (job.exitCode === undefined) job.end(undefined);
    }
  }

  async kill(cmdId: string): Promise<void> {
    await this.killCommand({ cmdId });
  }

  async killCommand(target: { cmdId: string; jobDir?: string }): Promise<void> {
    // Like the real providers: a job dir names the command's process group.
    const ids = new Set<string>(target.cmdId ? [target.cmdId] : []);
    if (target.jobDir) for (const j of this.jobs.values()) if (j.jobDir === target.jobDir && j.exitCode === undefined) ids.add(j.cmdId);
    for (const id of ids) {
      this.provider.kills.push(id);
      this.jobs.get(id)?.kill();
    }
  }

  async ensureTimeout(): Promise<void> {}

  async start(job: SandboxJob): Promise<{ cmdId: string; sessionId: string }> {
    this.alive('start');
    if (this.doomed === 'start') {
      this.dead = true;
      throw new SandboxLostError({ phase: 'start', sandbox: this.name, code: 'sandbox_stopping' });
    }
    const dir = `/tmp/harness/${job.stepId}`;
    const command = (await this.fs.readFile(`${dir}/cmd`)).replace(/\n$/, '');
    const cmdId = `cmd_${this.name}_${this.cmds++}`;
    this.provider.commands.push({ sandbox: this.name, command });
    const fakeJob = new FakeJob(cmdId, dir);
    this.jobs.set(cmdId, fakeJob);
    let hung = false;
    for (const pattern of this.provider.hangs) {
      if (command.includes(pattern)) {
        this.provider.hangs.delete(pattern);
        hung = true;
      }
    }
    void this.run(fakeJob, command, dir, job);
    if (hung) return new Promise<never>(() => {});
    return { cmdId, sessionId: this.sessionId };
  }

  private async run(job: FakeJob, command: string, dir: string, spec: SandboxJob) {
    // Like the wrapper's `timeout`: a held command past its budget exits 124.
    let timedOut = false;
    for (const [pattern] of this.provider.holds) {
      if (command.includes(pattern)) {
        const waiting = job.hold();
        this.provider.holds.set(pattern, () => job.release());
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([waiting, new Promise<void>((r) => (timer = setTimeout(() => ((timedOut = true), r()), spec.timeoutSeconds * 1000)))]);
        clearTimeout(timer);
        break;
      }
    }
    if (this.dead) return;
    let result: ExecResult;
    if (job.killed) {
      result = { exitCode: 137, stdout: '', stderr: '' };
    } else if (timedOut) {
      result = { exitCode: 124, stdout: '', stderr: '' };
    } else {
      result = await this.bash.exec(command, { cwd: '/workspace' });
      if (job.killed) result = { ...result, exitCode: 137 };
    }
    if (this.doomed === 'run') {
      this.stop();
      return;
    }
    if (this.dead) return;
    await this.fs.mkdir(dir, { recursive: true });
    await this.fs.writeFile(`${dir}/stdout`, result.stdout);
    await this.fs.writeFile(`${dir}/stderr`, result.stderr);
    if (job.wrapperKilled) {
      job.end(137);
      return;
    }
    const clip = (t: string) => ({ bytes: new TextEncoder().encode(t).byteLength, head: t.slice(0, 8000), tail: clipTail(t) });
    const report: SandboxReport = {
      v: 1,
      exitCode: result.exitCode,
      timedOut: result.exitCode === 124,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      endedAt: Date.now(),
    };
    const body = JSON.stringify(report);
    await this.fs.writeFile(`${dir}/result.json`, body);
    job.end(result.exitCode);
    // The wrapper's report: retried on 409 / 5xx, like the real one.
    if (spec.report && this.provider.onReport) {
      for (let i = 0; i < 8; i++) {
        const status = await this.provider.onReport({ url: spec.report.url, token: spec.report.token, body }).catch(() => 0);
        this.provider.reports.push({ stepId: spec.stepId, status });
        if ((status >= 200 && status < 300) || [400, 401, 403, 404, 410, 413].includes(status)) break;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
  }

  async waitFor(cmdId: string, ms: number): Promise<{ exitCode: number } | undefined> {
    this.alive('run');
    const job = this.jobs.get(cmdId);
    if (!job) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    if (this.dead) throw new SandboxLostError({ phase: 'run', sandbox: this.name, code: 'stopped' });
    return job.exitCode === undefined ? undefined : { exitCode: job.exitCode };
  }

  async readJob(jobDir: string, want: JobParts = { result: true, baseline: true }): Promise<JobFiles> {
    this.alive('sync');
    // Like the real one: only what is asked for, never past the limits.
    const read = async (name: string, limit: number, truncate: boolean) => {
      const path = `${jobDir}/${name}`;
      const content = await this.fs.readFile(path).catch(() => undefined);
      if (content === undefined) return undefined;
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > limit && !truncate) {
        this.provider.jobReads.push({ path, bytes: 0 });
        return undefined;
      }
      const kept = new TextDecoder().decode(bytes.slice(0, limit));
      this.provider.jobReads.push({ path, bytes: Math.min(bytes.byteLength, limit) });
      return kept;
    };
    const out: JobFiles = {};
    if (want.result) {
      const text = await read('result.json', JOB_READ_LIMITS.result, false);
      try {
        const parsed = text ? parseReport(JSON.parse(text)) : undefined;
        if (parsed) out.result = parsed;
      } catch {}
    }
    if (want.baseline) {
      const text = await read('baseline.json', JOB_READ_LIMITS.baseline, false);
      if (text !== undefined) out.baselineText = text;
    }
    if (want.output) {
      const stdout = await read('stdout', JOB_READ_LIMITS.output, true);
      const stderr = await read('stderr', JOB_READ_LIMITS.output, true);
      if (stdout !== undefined) out.stdout = stdout;
      if (stderr !== undefined) out.stderr = stderr;
    }
    return out;
  }

  /** The old attached exec (kept for tools that still use it). */
  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    this.alive('start');
    options.onStart?.(`cmd_${this.name}_${this.cmds++}`);
    this.provider.commands.push({ sandbox: this.name, command });
    const result = await this.bash.exec(command, {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.stdout) options.onOutput?.('stdout', result.stdout);
    if (result.stderr) options.onOutput?.('stderr', result.stderr);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async manifest(root: string, options: ManifestOptions): Promise<Manifest> {
    this.alive('sync');
    const out: Manifest = new Map();
    for (const path of this.fs.getAllPaths()) {
      if (!path.startsWith(`${root}/`)) continue;
      const segments = path.slice(root.length + 1).split('/');
      if (segments.slice(0, -1).some((s) => options.skipDirs.includes(s))) continue;
      const stat = await this.fs.stat(path).catch(() => undefined);
      if (!stat?.isFile) continue;
      // Text files only, like the real manifest (`grep -I`).
      const bytes = await this.fs.readFileBuffer(path);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      out.set(path, { hash: await sha256Hex(content), size: bytes.byteLength });
    }
    return out;
  }

  async writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void> {
    this.alive('sync');
    for (const { path, content } of files) {
      await this.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
      await this.fs.writeFile(path, content);
    }
  }

  async readTextFile(path: string): Promise<string | null> {
    this.alive('sync');
    return this.fs.readFile(path).catch(() => null);
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) await this.fs.rm(path, { force: true });
  }
}
