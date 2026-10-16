import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { isAlive } from 'harness-world/anchor';
import { Unavailable, Yield } from 'harness-world';
import type { ProcessHostLike, ProcessLike } from './environment.ts';

/**
 * The process host: where a process harness's child runs. One child per
 * session and drive, in its own process group, with an explicit environment,
 * in a per-session directory, recorded in a pidfile so the next drive on this
 * machine kills a child a dead drive left running before it resumes the
 * session (a child outlives a parent killed with SIGKILL: it is not in the
 * parent's group, and nothing else stops it).
 *
 * POSIX only (process groups, signals).
 */

/**
 * A child that did not start, told apart: a binary that is not on this
 * machine (or cannot run here) is `Unavailable`, which fails the turn
 * instead of having the queue redeliver into the same error (see
 * harness-world's unavailable.ts). Node says `spawn <command> ENOENT` for a
 * missing working directory too, so ENOENT counts only when the binary
 * itself is missing; anything else is the error as it was.
 */
export function spawnFailure(err: unknown, command: string, cwd: string): unknown {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? (/\bUnknown system error -8\b/.test(e?.message ?? '') ? 'ENOEXEC' : undefined);
  const named = command.includes('/');
  if (code === 'ENOENT') {
    if (!existsSync(cwd)) return err;
    if (named && existsSync(command)) return err;
    return new Unavailable(`${command} is not on this machine (spawn ENOENT)`, { code: 'binary_missing', cause: err });
  }
  if ((code === 'EACCES' || code === 'ENOEXEC') && existsSync(cwd) && (!named || existsSync(command))) {
    const why = code === 'EACCES' ? 'is not executable' : 'is not a binary this machine can run';
    return new Unavailable(`${command} ${why} (spawn ${code})`, { code: 'binary_unusable', cause: err });
  }
  return err;
}

/** Where session directories go by default. */
export function defaultRoot(): string {
  if (process.env.HARNESS_PROCESS_ROOT) return resolve(process.env.HARNESS_PROCESS_ROOT);
  // Vercel Functions: only /tmp is writable, and HOME may be read-only.
  if (process.env.VERCEL) return join(tmpdir(), 'harness-sessions');
  return resolve('.sessions');
}

/** A session's directory and the parts of it a child gets. */
export interface SessionDir {
  /** `<root>/<runId>`: the child's default cwd. */
  path: string;
  /** The child's `HOME` (a CLI's config and session files land here, not in the user's home). */
  home: string;
  /** The child's `TMPDIR`. */
  tmp: string;
  /** The host's own files (the pidfile). */
  state: string;
  /**
   * The group registry: one file per process group a shell under this
   * session registered itself in (named by the group id), so what a tool
   * started is killed with the child (see `ProcessHost`). Under `tmp`, which
   * a harness's own sandbox lets its commands write.
   */
  groups: string;
}

/** What the pidfile records about a running child. */
export interface PidRecord {
  pid: number;
  /** A random token in the child's environment (`HARNESS_PROCESS_TOKEN`): proves a pid is still ours on Linux. */
  token: string;
  argv: string[];
  startedAt: number;
  /** Other process groups to kill with it (tools that left the child's group). */
  groups: number[];
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  /**
   * The child's environment, on top of `PATH`, `HOME` (the session's home)
   * and `TMPDIR` (the session's tmp). Nothing else of this process's
   * environment is inherited: pass every variable the child needs, and no
   * secret it does not.
   */
  env?: Record<string, string | undefined>;
  /** Default: the session directory. */
  cwd?: string;
  /** Kill the child's whole group when this aborts (pass `ctx.signal`). */
  signal?: AbortSignal;
  /** Default `pipe` (kept as `stderrTail()`). */
  stderr?: 'pipe' | 'inherit' | 'ignore';
  /**
   * Runs after a stale child is killed and before this one starts, with the
   * session claimed: rebuild the harness's native session files here (from
   * the journal), so no other drive of this host can start a child, and no
   * stale one can write, in between.
   */
  prepare?: (dir: SessionDir) => Promise<void> | void;
  /**
   * Start a watchdog (`watchParent`) that kills the child's group, and every
   * group its tools registered, within about a second of this process
   * dying. A SIGKILL of the drive (a crash, a chaos drill) reaches neither
   * otherwise: the child is in a group of its own, and a command a tool
   * started outlives it. Default false.
   */
  watchdog?: boolean;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A running child on this machine: a `ProcessLike` (its stdio, `alive`, `kill`), plus what only this host has (the `ChildProcess`, its pid, adopted groups). */
export interface HostedProcess extends ProcessLike {
  readonly pid: number;
  readonly child: ChildProcess;
  /** Resolves when the child exits (never rejects). */
  readonly exited: Promise<Exit>;
  /** Whether the child is still running. */
  alive(): boolean;
  /** Kill the child's process group and every adopted group. Default SIGKILL. */
  kill(signal?: NodeJS.Signals): void;
  /** Record another process group (a tool that left the child's group) to kill with this one, now and on the next resume. */
  adopt(pgid: number): Promise<void>;
  /** Write one line to the child's stdin (a value is sent as JSON). False once stdin is closed. */
  send(line: unknown): boolean;
  /** Close the child's stdin. */
  end(): void;
  /** The child's stdout, line by line. One reader per process. */
  lines(): AsyncIterable<string>;
  /** The last few KB of stderr (with `stderr: 'pipe'`). */
  stderrTail(): string;
}

const PIDFILE = 'pid.json';
const STDERR_KEEP = 8192;

/**
 * Sourced by every shell a child starts under the session's environment
 * (`BASH_ENV` for non-interactive bash, `ENV` for an interactive sh, and the
 * session home's `.bashrc`, `.bash_profile`, `.profile` and `.zshenv` for
 * login and interactive shells and every zsh): it records the shell's
 * process group in `HARNESS_PROCESS_GROUPS`. A harness's built-in shell
 * tools (Claude Code's Bash, Codex's shell, OpenCode's shell) start each
 * command in a process group of its own, which a kill of the child's group
 * does not reach, and which outlives the child: the registry is how the
 * host still finds and kills them. It also turns job control off, so a
 * command's processes stay in the registered group. POSIX sh, no fork on
 * Linux (`/proc`), `ps` elsewhere; it never changes the shell's positional
 * parameters.
 */
export const GROUP_REGISTRY_SCRIPT = `# harness-world-process: register this shell's process group (see ProcessHost).
if [ -n "\${HARNESS_PROCESS_GROUPS:-}" ] && [ -d "\$HARNESS_PROCESS_GROUPS" ]; then
  _hwg=
  if [ -r "/proc/\$\$/stat" ]; then
    read -r _hws < "/proc/\$\$/stat"
    _hws=\${_hws##*") "}; _hws=\${_hws#* }; _hws=\${_hws#* }; _hwg=\${_hws%% *}
  else
    _hwg=\$( (ps -o pgid= -p \$\$ | tr -d ' ') 2>/dev/null )
  fi
  # No group id (a sandbox that refuses \`ps\`, as Codex's macOS one does): the pid, for the host to resolve.
  case "\$_hwg" in ''|*[!0-9]*) _hwf="pid-\$\$" ;; *) _hwf=\$_hwg ;; esac
  [ -e "\$HARNESS_PROCESS_GROUPS/\$_hwf" ] || date +%s > "\$HARNESS_PROCESS_GROUPS/\$_hwf" 2>/dev/null
  unset _hwg _hws _hwf
  # No job control: a command stays in this shell's group, the one registered. Claude Code's shell
  # snapshot writes \`set -o monitor\` whatever its state (it matches "on" in \`set -o\`'s output) and is
  # sourced after this file, so bash also turns it off again before each command (a DEBUG trap);
  # without that, each of its commands ran in a group of its own that outlived a crash.
  case \$- in *m*) set +m 2>/dev/null ;; esac
  if [ -n "\${BASH_VERSION:-}" ]; then trap 'case \$- in *m*) set +m ;; esac' DEBUG; fi
fi
`;

/** The session home's shell startup files that source the registry script. */
const STARTUP_FILES = ['.bashrc', '.bash_profile', '.profile', '.zshenv'];

export interface ProcessHostOptions {
  /** Where session directories go. Default `defaultRoot()`. */
  root?: string;
  /** How long a stale child gets to disappear after its SIGKILL before the new one starts. Default 2000 ms. */
  killWaitMs?: number;
}

export class ProcessHost implements ProcessHostLike {
  readonly root: string;
  private readonly killWaitMs: number;
  /** The child each session's current drive in this host runs. */
  private readonly active = new Map<string, HostedProcess>();
  /** Sessions a `spawn` is starting a child for (claimed before its first await). */
  private readonly starting = new Set<string>();

  constructor(options: ProcessHostOptions = {}) {
    // `turbopackIgnore` (here and below): a session's files are made at run time, not the app's to
    // ship. Turbopack's trace of a route that loads this module otherwise takes the whole project,
    // or from node_modules every file of durable-harness.
    this.root = resolve(/* turbopackIgnore: true */ options.root ?? defaultRoot());
    this.killWaitMs = options.killWaitMs ?? 2000;
  }

  /** The session's directory, created if it is missing. */
  async dir(runId: string): Promise<SessionDir> {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`harness-world-process: not a run id: ${runId}`);
    const path = join(this.root, runId);
    const tmp = join(path, 'tmp');
    const dir = { path, home: join(path, 'home'), tmp, state: join(path, '.harness'), groups: join(tmp, '.harness-groups') };
    await Promise.all([dir.home, dir.tmp, dir.state, dir.groups].map((d) => mkdir(d, { recursive: true })));
    // The default root is `.sessions` in the app's directory: keep the sessions' files (homes, CLI
    // transcripts, working directories) out of the app's git.
    if (!this.ignored && basename(this.root) === '.sessions') {
      this.ignored = true;
      await writeFile(join(this.root, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    }
    return dir;
  }
  private ignored = false;

  /** Write the registry script and the startup files that source it into the session's home (idempotent). */
  private async registry(dir: SessionDir): Promise<string> {
    const script = join(dir.state, 'groups.sh');
    if ((await readFile(script, 'utf8').catch(() => '')) !== GROUP_REGISTRY_SCRIPT) await writeFile(script, GROUP_REGISTRY_SCRIPT);
    const line = `[ -r ${shellQuote(script)} ] && . ${shellQuote(script)}`;
    await Promise.all(
      STARTUP_FILES.map(async (name) => {
        const file = join(/* turbopackIgnore: true */ dir.home, name);
        const text = await readFile(/* turbopackIgnore: true */ file, 'utf8').catch(() => undefined);
        if (text === undefined) await writeFile(file, `${line}\n`);
        else if (!text.includes(line)) await appendFile(file, `\n${line}\n`);
      })
    );
    return script;
  }

  /**
   * Kill every process group the session's shells registered (see
   * `GROUP_REGISTRY_SCRIPT`) that is still alive and still ours, and clear
   * the registry. A harness calls it when its drive ends: a process a tool
   * started does not outlive the drive. Returns the groups it killed.
   */
  async killGroups(runId: string): Promise<number[]> {
    const dir = await this.dir(runId);
    return killRegistered(dir.groups, runId);
  }

  /** Remove the session's directory (after `killStale`). The next `dir()` starts empty. */
  async reset(runId: string): Promise<void> {
    await this.killStale(runId);
    await rm(join(this.root, runId), { recursive: true, force: true });
  }

  /** The pidfile's record, if a child was started here and has not exited cleanly. */
  async pidRecord(runId: string): Promise<PidRecord | undefined> {
    const dir = await this.dir(runId);
    try {
      return JSON.parse(await readFile(join(dir.state, PIDFILE), 'utf8')) as PidRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * Kill-before-resume: SIGKILL the process group of a child a previous drive
   * started here and never saw exit, and every group it adopted, then wait
   * (briefly) for them to go. A pid that now belongs to another process is
   * left alone (see `identity`). Returns the groups it killed.
   *
   * A child that a drive of this same host still runs is not stale: two
   * deliveries of one session can overlap (the queue delivers a wake while
   * the last turn's drive winds down), and the kernel settles which one
   * owns the session at its next write. Killing the other's child first
   * would lose its turn, so this throws `Yield('contended')` instead (the
   * delivery is retried in a moment).
   */
  async killStale(runId: string): Promise<number[]> {
    if (this.busy(runId)) throw new Yield('contended', 2);
    return this.killStaleUnclaimed(runId);
  }

  /** Whether a drive of this host runs (or is starting) the session's child. */
  busy(runId: string): boolean {
    return this.starting.has(runId) || !!this.active.get(runId)?.alive();
  }

  private async killStaleUnclaimed(runId: string): Promise<number[]> {
    const dir = await this.dir(runId);
    const file = join(dir.state, PIDFILE);
    const record = await this.pidRecord(runId);
    if (!record) return killRegistered(dir.groups, runId);
    const killed: number[] = [];
    // A leader that is gone leaves its group id reserved while any member
    // lives (no new pid can take it), so a live group is still ours then. A
    // live leader is checked first: its pid may have been reused.
    const own = isAlive(record.pid) ? identity(record) : 'gone';
    if (own !== 'mismatch' && groupAlive(record.pid)) {
      killGroup(record.pid, 'SIGKILL');
      killed.push(record.pid);
    }
    for (const g of record.groups) {
      if (g !== record.pid && groupAlive(g)) {
        killGroup(g, 'SIGKILL');
        killed.push(g);
      }
    }
    // The groups its tools' shells registered: a command that outlived the dead drive.
    killed.push(...killRegistered(dir.groups, runId));
    const deadline = Date.now() + this.killWaitMs;
    while (killed.some(groupAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await rm(file, { force: true });
    return killed;
  }

  /**
   * Start the session's child: claim the session in this host (or throw
   * `Yield('contended')`, see `killStale`), kill a stale child, run
   * `prepare`, spawn.
   */
  async spawn(runId: string, options: SpawnOptions): Promise<HostedProcess> {
    if (this.busy(runId)) throw new Yield('contended', 2);
    this.starting.add(runId);
    try {
      await this.killStaleUnclaimed(runId);
      const dir = await this.dir(runId);
      await options.prepare?.(dir);
      return await this.start(runId, dir, options);
    } finally {
      this.starting.delete(runId);
    }
  }

  private async start(runId: string, dir: SessionDir, options: SpawnOptions): Promise<HostedProcess> {
    const token = randomUUID();
    const registry = await this.registry(dir);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: dir.home,
      TMPDIR: dir.tmp,
      SHELL: defaultShell(),
      BASH_ENV: registry,
      ENV: registry,
    };
    for (const [k, v] of Object.entries(options.env ?? {})) if (v !== undefined) env[k] = v;
    env.HARNESS_PROCESS_SESSION = runId;
    env.HARNESS_PROCESS_TOKEN = token;
    env.HARNESS_PROCESS_GROUPS = dir.groups;
    const args = options.args ?? [];
    const cwd = options.cwd ?? dir.path;
    const child: ChildProcess = spawn(options.command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      // Its own process group (setsid): a kill reaches everything it starts
      // that stays in the group, and nothing reaches it from ours.
      detached: true,
      stdio: ['pipe', 'pipe', options.stderr ?? 'pipe'],
    });
    await new Promise<void>((ok, fail) => {
      child.once('spawn', ok);
      child.once('error', (err) => fail(spawnFailure(err, options.command, cwd)));
    });
    const pid = child.pid!;
    const record: PidRecord = { pid, token, argv: [options.command, ...args], startedAt: Date.now(), groups: [] };
    const file = join(dir.state, PIDFILE);
    await writeFile(file, JSON.stringify(record));

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.stdin?.on('error', () => {}); // EPIPE after the child died: `send` reports it.
    const exited = new Promise<Exit>((done) => {
      child.once('exit', (code, signal) => {
        // A child that exited is no longer stale: the next drive need not kill it.
        void readFile(file, 'utf8')
          .then(async (t) => {
            if ((JSON.parse(t) as PidRecord).token === token) await rm(file, { force: true });
          })
          .catch(() => {})
          .finally(() => done({ code, signal }));
      });
    });
    const groups = new Set<number>([pid]);
    const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
      for (const g of groups) killGroup(g, signal);
      // And what its tools' shells started in groups of their own.
      if (signal === 'SIGKILL') killRegistered(dir.groups, runId);
    };
    const watchdog = options.watchdog ? watchParent(pid, { registry: dir.groups }) : undefined;
    void exited.then(() => {
      // The child is gone: its tools' groups go too (a clean exit included), then the watchdog.
      killRegistered(dir.groups, runId);
      watchdog?.kill();
    });
    const onAbort = () => kill();
    if (options.signal?.aborted) kill();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    void exited.then(() => options.signal?.removeEventListener('abort', onAbort));
    let rl: Interface | undefined;
    const hosted: HostedProcess = {
      pid,
      child,
      exited,
      alive: () => child.exitCode === null && child.signalCode === null && isAlive(pid),
      kill,
      async adopt(pgid) {
        groups.add(pgid);
        record.groups = [...groups].filter((g) => g !== pid);
        await writeFile(file, JSON.stringify(record));
      },
      send(line) {
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
        stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        return true;
      },
      end: () => child.stdin?.end(),
      lines() {
        if (!child.stdout) throw new Error('harness-world-process: the child has no stdout pipe');
        rl ??= createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
        return rl;
      },
      stderrTail: () => stderr,
    };
    this.active.set(runId, hosted);
    void exited.then(() => {
      if (this.active.get(runId) === hosted) this.active.delete(runId);
    });
    return hosted;
  }
}

/** Whether a process with this pid exists (a zombie counts): harness-world's, which the kernel's anchor verdicts use too. */
export { isAlive } from 'harness-world/anchor';

/** Whether a process group with this id has any member. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {}
}

/**
 * Whether the pidfile's pid is still the child it recorded, before anything
 * kills it: on Linux, the token in `/proc/<pid>/environ`; elsewhere, the
 * command line and start time `ps` reports (macOS does not show another
 * process's environment). `unknown` when neither can be read; the caller then
 * kills only if the pid still leads a process group, as the child did.
 */
export function identity(record: PidRecord): 'match' | 'mismatch' | 'unknown' {
  if (!isAlive(record.pid)) return 'mismatch';
  if (existsSync('/proc/self/environ')) {
    try {
      const env = readFileSync(`/proc/${record.pid}/environ`, 'utf8').split('\0');
      return env.includes(`HARNESS_PROCESS_TOKEN=${record.token}`) ? 'match' : 'mismatch';
    } catch {
      return 'unknown';
    }
  }
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'etime=,command=', '-p', String(record.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
  if (!out) return 'mismatch';
  const [etime = '', ...rest] = out.split(/\s+/);
  const command = rest.join(' ');
  const startedAt = Date.now() - elapsedSeconds(etime) * 1000;
  // `ps` reports whole seconds.
  if (Math.abs(startedAt - record.startedAt) > 3000) return 'mismatch';
  // `ps` escapes what it cannot print (a newline is `\012`): compare the plain arguments.
  let at = 0;
  for (const arg of record.argv.filter((a) => /^[\x20-\x7e]*$/.test(a))) {
    const i = command.indexOf(arg, at);
    if (i < 0) return 'mismatch';
    at = i + arg.length;
  }
  return 'match';
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = clock!.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/** The shell a child's tools get by default: bash where there is one (its startup files register its group), else sh. */
export function defaultShell(): string {
  for (const sh of ['/bin/bash', '/usr/bin/bash']) if (existsSync(/* turbopackIgnore: true */ sh)) return sh;
  return '/bin/sh';
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** This process's own process group (never killed through the registry). */
export const ownGroup: number = (() => {
  try {
    if (existsSync('/proc/self/stat')) {
      const rest = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1)!.split(' ');
      return Number(rest[2]);
    }
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 2000 }).trim());
  } catch {
    return -1;
  }
})();

/**
 * Kill the live groups in a registry (one file per group id, holding the
 * registration time in seconds) that are still the session's, and remove
 * every entry. A group whose leader is gone while members live is ours (its
 * id stays reserved while it has members); a live leader is checked first
 * (`/proc/<pid>/environ` names the session on Linux; elsewhere its start
 * time is the registration's).
 */
export function killRegistered(registry: string, runId: string): number[] {
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const name of names) {
    const file = join(registry, name);
    // `<pgid>`, or `pid-<pid>` from a shell that could not read its group: resolved here, while it lives.
    const byPid = /^pid-(\d+)$/.exec(name);
    const pgid = byPid ? (isAlive(Number(byPid[1])) ? (groupOf(Number(byPid[1])) ?? -1) : -1) : /^\d+$/.test(name) ? Number(name) : -1;
    if (pgid <= 1 || pgid === ownGroup || pgid === process.pid) {
      rmSync(file, { force: true });
      continue;
    }
    if (groupAlive(pgid) && registeredIsOurs(byPid ? Number(byPid[1]) : pgid, runId, file)) {
      killGroup(pgid, 'SIGKILL');
      killed.push(pgid);
    }
    rmSync(file, { force: true });
  }
  return killed;
}

/** The process group of a live pid (`/proc` on Linux, else `ps`), or undefined. */
export function groupOf(pid: number): number | undefined {
  try {
    if (existsSync('/proc/self/stat')) {
      const rest = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
      return Number(rest[2]) || undefined;
    }
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a registered process (a group leader, or the shell that registered by pid) is still the session's. */
function registeredIsOurs(pgid: number, runId: string, file: string): boolean {
  if (!isAlive(pgid)) return true;
  if (existsSync('/proc/self/environ')) {
    try {
      // During exec, Linux can expose the new process before its environment
      // is readable. A shell commonly execs its last command just after
      // registering. Retry only an empty read; a populated foreign environment
      // still rejects the group, and persistent emptiness proves no ownership.
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; attempt < 5; attempt++) {
        const env = readFileSync(`/proc/${pgid}/environ`, 'utf8');
        if (env) return env.split('\0').includes(`HARNESS_PROCESS_SESSION=${runId}`);
        if (attempt < 4) Atomics.wait(pause, 0, 0, 1);
      }
      return false;
    } catch {}
  }
  let at: number;
  try {
    at = Number(readFileSync(file, 'utf8').trim()) * 1000;
  } catch {
    return false;
  }
  try {
    const etime = execFileSync('ps', ['-o', 'etime=', '-p', String(pgid)], { encoding: 'utf8', timeout: 2000 }).trim();
    if (!etime) return false;
    return Math.abs(Date.now() - elapsedSeconds(etime) * 1000 - at) <= 5000;
  } catch {
    // No way to tell: only a recent registration.
    return Date.now() - at < 3_600_000;
  }
}

export interface WatchOptions {
  /** The process to watch. Default this one. */
  parent?: number;
  /** A group registry (`SessionDir.groups`) whose groups die with it too. */
  registry?: string;
}

/**
 * The watchdog: a `sh` loop in a process (and group) of its own that, within
 * about a second of `parent` dying, kills the process group `pgid` and every
 * group in `registry`. It leaves by itself once there is nothing left to
 * kill (the group is gone and no registered group is alive), and holds no
 * pipe of the child's and no environment. POSIX `sh`; if it cannot start,
 * the next drive on this machine still kills them (the pidfile, the registry).
 */
export function watchParent(pgid: number, options: WatchOptions = {}): ChildProcess {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const watcher = spawn('/bin/sh', ['-c', WATCH, 'harness-world-process-watch', String(options.parent ?? process.pid), String(pgid), options.registry ?? '', String(ownGroup)], {
    detached: true,
    stdio: 'ignore',
    env: env as NodeJS.ProcessEnv,
  });
  watcher.on('error', () => {});
  watcher.unref();
  return watcher;
}

// No `--` before a group id: dash (Debian's and Ubuntu's `/bin/sh`) reads it as a
// pid ("Illegal number"). `sleep 1 || exit`: with no `sleep` on PATH it leaves
// (the pidfile and the registry still cover the groups) rather than spin.
const WATCH = [
  'P=$1; C=$2; R=$3; S=$4',
  // The group of a pid (a `pid-<pid>` entry): /proc on Linux, else ps.
  'pg() { if [ -r "/proc/$1/stat" ]; then read -r s < "/proc/$1/stat"; s=${s##*") "}; s=${s#* }; s=${s#* }; echo "${s%% *}"; else ps -o pgid= -p "$1" 2>/dev/null | tr -d " "; fi; }',
  'groups() { [ -n "$R" ] && [ -d "$R" ] || return 0; for f in "$R"/*; do g=${f##*/}; case "$g" in pid-*) g=$(pg "${g#pid-}");; esac; case "$g" in ""|*[!0-9]*) continue;; esac; [ "$g" = "$S" ] && continue; [ "$g" -gt 1 ] && echo "$g"; done; }',
  'live() { kill -0 "-$C" 2>/dev/null && return 0; for g in $(groups); do kill -0 "-$g" 2>/dev/null && return 0; done; return 1; }',
  'while kill -0 "$P" 2>/dev/null; do live || exit 0; sleep 1 || exit 0; done',
  'kill -9 "-$C" 2>/dev/null; for g in $(groups); do kill -9 "-$g" 2>/dev/null; done',
].join('\n');
