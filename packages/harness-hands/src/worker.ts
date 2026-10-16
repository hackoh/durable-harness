import { type MachineOp, machineOps } from './machine.ts';

/**
 * The worker threads a virtual workspace's shell runs in, one session to a
 * worker.
 *
 * A worker is leased to one session: the files and the shell of that
 * session's workspaces live in it, and no other session's ever do. When the
 * lease ends (the session's workspaces were freed, it sat idle, another
 * session needed the room, or its command ran past its time limit) the
 * worker is terminated, never handed on: the next lease, for that session or
 * another, gets a fresh one. A just-bash bug that let a command out of the
 * shell would find only its own session's files in that realm, and an empty
 * `process.env`: each worker starts with `env: {}`, no `execArgv`, a heap
 * limit, and just-bash's defense-in-depth on with its process-lifetime
 * hardening (in a realm of its own both are safe to turn on).
 *
 * A command holds its session's worker, not the thread serving every other
 * session. One that runs past its time limit (its machine's `timeoutMs`,
 * which just-bash enforces itself when the command yields), or keeps running
 * after its call was cancelled (the invocation ran out of time, the session
 * moved), ends the worker: its call fails with a definite error, and the
 * session's machines on it are lost, so their owners make them again from
 * their record (the document-backed workspace from the log, the in-memory
 * one from its copy, runtime.ts). Nothing of another session is touched.
 *
 * Admission: the pool holds at most `maxWorkers` workers, and the memory
 * they may use (each worker's heap limit plus the bytes its workspaces may
 * hold) stays within a share of the instance's memory. A session that needs
 * a worker when there is no room takes the one leased to the session idle
 * the longest (never one with a call running); when every worker is running
 * a call, it waits for one, in turn, and past `admitWaitMs` fails with "the
 * instance is busy".
 *
 * Node's modules are reached through `process.getBuiltinModule`, so no
 * bundler sees an import of them; the worker runs `machineOps`' source text,
 * and finds just-bash on its own (`justBashEntry`).
 */

/** How a machine's operations reach just-bash: a worker leased to its session, or this realm. */
export interface Channel {
  readonly kind: 'worker' | 'process';
  /** Bumped when the machines it held are gone (its worker ended). */
  generation(): number;
  /** `limitMs`: how long the call may take before the worker is ended (exec: the command's limit plus a grace). */
  call(op: MachineOp, args: unknown[], signal?: AbortSignal, limitMs?: number): Promise<any>;
  /** A machine holding up to `bytes` was made on it (`1`), or freed (`-1`). */
  count?(delta: 1 | -1, bytes: number): void;
  /** Run `fn` with the channel marked in use: its worker is not taken from it meanwhile. */
  hold?<T>(fn: () => Promise<T>): Promise<T>;
}

/** The pool's limits. */
export interface WorkerPoolOptions {
  /** The most workers at once (each leased to one session, or one kept ready). */
  maxWorkers: number;
  /** The memory the workers may use: their heap limits plus the bytes their workspaces may hold. */
  memoryBytes: number;
  /** A lease with no call this long ends (its worker is terminated). */
  idleMs: number;
  /** How long a call waits for a worker when every one is running a call, before "the instance is busy". */
  admitWaitMs: number;
}

/** A worker's heap limit (its old generation): a command that needs more ends that worker only. */
export const WORKER_HEAP_MB = 128;
/** What a worker costs besides its workspaces' bytes, for admission: its heap limit and a little more (its young generation, code). */
const WORKER_COST_BYTES = (WORKER_HEAP_MB + 32) * 1024 * 1024;
/** The share of the instance's memory the workers may use. */
const MEMORY_SHARE = 0.5;
/** At most this many workers, however much memory the instance has. */
const MAX_WORKERS = 16;
/** The bytes a workspace may hold by default (`MACHINE_DEFAULTS.maxBytes`), for the default pool size. */
const DEFAULT_WORKSPACE_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 60_000;
const ADMIT_WAIT_MS = 10_000;
/** A lease used this recently is not taken for another session (its owner is between a machine's creation and its first call). */
const EVICT_GUARD_MS = 500;
/** How long a lease whose last machine was freed waits for another before it ends. */
const LINGER_MS = 1_000;
/** How long past its limit a command may run before its worker is ended. */
export const KILL_GRACE_MS = 500;
/** How long a cancelled command has to stop on its own before its worker is ended. */
export const ABORT_GRACE_MS = 300;
/** A filesystem operation this long: the worker is stuck. */
const OP_LIMIT_MS = 30_000;

const gone = () => Object.assign(new Error("this workspace's files are gone: the shell it ran in was restarted"), { code: 'EGONE' });
const restarted = () => Object.assign(new Error("the workspace's shell was restarted while this call ran: try the call again"), { code: 'EGONE' });

/** Why a cancelled command was stopped, from its signal's reason. */
export function stoppedError(reason: unknown): Error {
  const r = reason as { code?: unknown; message?: unknown; reason?: unknown } | undefined;
  if (r && typeof r.code === 'string' && typeof r.message === 'string') return Object.assign(new Error(r.message), { code: r.code });
  if (r?.reason === 'budget') {
    return Object.assign(new Error('the command was stopped: this invocation of the session ran out of time'), { code: 'EINTR' });
  }
  return Object.assign(new Error('the command was stopped: its call was cancelled'), { code: 'EINTR' });
}

// ---------------------------------------------------------------------------
// Node, without an import a bundler would follow

export type NodeModules = { worker: any; module: any; url: any; fs: any; path: any; os: any; process: any };

/** Node's modules; undefined where there is no Node (a browser tab, a Cloudflare Worker). */
export function nodeModules(): NodeModules | undefined {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => any; versions?: { node?: string } } }).process;
  if (typeof p?.getBuiltinModule !== 'function' || typeof p.versions?.node !== 'string') return undefined;
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'Cloudflare-Workers') return undefined;
  try {
    const worker = p.getBuiltinModule('node:worker_threads');
    if (typeof worker?.Worker !== 'function') return undefined;
    const [module, url, fs, path, os] = ['node:module', 'node:url', 'node:fs', 'node:path', 'node:os'].map((id) => p.getBuiltinModule!(id));
    return { worker, module, url, fs, path, os, process: p };
  } catch {
    return undefined;
  }
}

/**
 * just-bash's ESM entry as a file path, found the ways a bundled or
 * unbundled app can: resolved from here, the app's directory or its entry
 * script; else (a bundler that renamed the package, as Turbopack's externals
 * do) from the stack of an error just-bash throws, which names the file this
 * process loaded it from.
 */
export async function justBashEntry(node: NodeModules, onlyFromStack = false): Promise<string | undefined> {
  const existing = (found: unknown): string | undefined => {
    if (typeof found !== 'string') return undefined;
    const file = found.startsWith('file:') ? node.url.fileURLToPath(found) : found;
    // The require condition's entry: its ESM sibling is the one an app's trace keeps.
    const esm = file.replace(/index\.cjs$/, 'index.js');
    if (node.fs.existsSync(esm)) return esm;
    return node.fs.existsSync(file) ? file : undefined;
  };
  const tries: (() => unknown)[] = onlyFromStack
    ? []
    : [
        () => (import.meta as unknown as Record<string, (s: string) => string>)['resolve']?.('just-bash'),
        () => node.module.createRequire(import.meta.url).resolve('just-bash'),
        () => node.module.createRequire(node.path.join(node.process.cwd(), 'package.json')).resolve('just-bash'),
        () => (node.process.argv[1] ? node.module.createRequire(node.path.resolve(node.process.argv[1])).resolve('just-bash') : undefined),
      ];
  for (const attempt of tries) {
    try {
      const file = existing(attempt());
      if (file) return file;
    } catch {}
  }
  try {
    const jb = await import('just-bash');
    new jb.Bash({ executionLimitProfile: 'none' as never });
  } catch (err) {
    const at = String((err as Error)?.stack ?? '').match(/(file:\/\/[^\s()]*?|\/[^\s()]*?)\/dist\/bundle\/[^\s():]+\.c?js/);
    if (at) return existing(`${at[1]}/dist/bundle/index.js`);
  }
  return undefined;
}

/** A worker's source: a CommonJS script that runs `machineOps` on just-bash, one message per call. */
function workerSource(): string {
  return `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
// A transpiler that keeps function names (esbuild's keepNames) wraps them in this helper.
var __name = (target) => target;
const machineOps = (${machineOps.toString()});
const running = new Map();
// The realm is this worker's alone: defense-in-depth on, with the hardening that cannot be undone.
const DEFENSE = { enabled: true, processLifetimeIntrinsicHardening: true };
let jb;
let ops;
const ready = (async () => {
  jb = workerData.entry.endsWith('.cjs') ? require(workerData.entry) : await import(workerData.url);
  ops = machineOps(jb, { defenseInDepth: DEFENSE, profile: workerData.profile, limits: workerData.limits });
  if (workerData.warm) {
    // A worker kept ready for the next session: load and compile what a first call needs, on a machine of no session.
    await ops.create('warm', { root: '/workspace', maxBytes: 1 << 20, maxFileBytes: 1 << 20, timeoutMs: 10000, commands: workerData.commands });
    await ops.writeFile('warm', 'w/a.txt', 'a\\n');
    await ops.exec('warm', workerData.warm, {});
    await ops.checkpoint('warm');
    await ops.diff('warm', { unlink: true });
    await ops.walk('warm');
    ops.dispose('warm');
  }
})();
const fail = (e) => ({ message: String((e && e.message) || e), code: e && e.code, name: e && e.name });
parentPort.on('message', async (msg) => {
  if (msg.abort !== undefined) { const c = running.get(msg.abort); if (c) c.abort(); return; }
  const { id, op, args } = msg;
  try {
    await ready;
    let value;
    if (op === 'exec') {
      const controller = new AbortController();
      running.set(id, controller);
      value = await ops.exec(args[0], args[1], args[2], controller.signal);
    } else if (op === 'probe') value = { env: Object.keys(process.env), defense: jb.DefenseInDepthBox.getInstance(DEFENSE).getStatus() };
    else value = await ops[op](...args);
    parentPort.postMessage({ id, value });
  } catch (e) {
    parentPort.postMessage({ id, error: fail(e) });
  } finally {
    running.delete(id);
  }
});
ready.then(() => parentPort.postMessage({ ready: true }), (e) => parentPort.postMessage({ fatal: fail(e) }));
`;
}

/** How the workers run just-bash: `normal` counts (a deadline bounds a command's time), `hardened` sizes (a worker's memory stays within its heap). */
export interface WorkerShell {
  profile: 'normal' | 'hardened';
  limits: Record<string, number>;
  /** The commands its shells have (`VIRTUAL_COMMANDS`). */
  commands: readonly string[];
}

/** What a worker kept ready runs first, so a session's first calls on it do not pay for loading and compiling them. */
const WARM_UP = "cd w && cat a.txt | grep a | sed s/a/b/ | awk '{print $1}' | sort | uniq | wc -l; ls -la; mkdir -p d; printf x > d/f; head -1 d/f; tail -1 d/f; echo $((1+1)) | tr 2 3; find . -name '*.txt' | xargs wc -c; jq -n 1; rm -rf d";

// ---------------------------------------------------------------------------
// A lease: one worker, one session

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timers: ReturnType<typeof setTimeout>[];
  off?: () => void;
}

let leaseSeq = 0;

/** A worker thread leased to one session (or kept ready for the next one), and the calls in flight on it. */
export class WorkerLease implements Channel {
  readonly kind = 'worker' as const;
  readonly id = ++leaseSeq;
  /** The session it serves; undefined while it is kept ready. */
  session: unknown;
  /** Live machines on it, and the bytes they may hold. */
  machines = 0;
  bytes = 0;
  /** Why it ended (undefined while it runs). */
  endedBy: string | undefined;
  /** Resolves when its thread has exited. */
  readonly exited: Promise<void>;
  /** Why its thread could not start, when it could not. */
  failure: string | undefined;
  lastUsed = Date.now();
  private holds = 0;
  private seq = 0;
  private worker: any;
  private readonly started: Promise<boolean>;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private exit!: () => void;

  constructor(
    private readonly pool: WorkerPool,
    node: NodeModules,
    entry: string,
    shell: WorkerShell,
    /** Kept ready for the next session: warm it up as it starts. */
    warm = false
  ) {
    this.exited = new Promise<void>((resolve) => (this.exit = resolve));
    this.started = new Promise<boolean>((resolve) => {
      let ready = false;
      const settle = (ok: boolean, why?: string) => {
        if (!ok) this.failure ??= why ?? 'the worker exited before it started';
        resolve(ok);
      };
      let worker: any;
      try {
        worker = new node.worker.Worker(workerSource(), {
          eval: true,
          env: {},
          execArgv: [],
          workerData: {
            entry,
            url: node.url.pathToFileURL(entry).href,
            profile: shell.profile,
            limits: shell.limits,
            ...(warm ? { warm: WARM_UP, commands: shell.commands } : {}),
          },
          resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
        });
      } catch (err) {
        this.endedBy = 'failed';
        this.exit();
        settle(false, String((err as Error)?.message ?? err));
        return;
      }
      this.worker = worker;
      worker.on('message', (msg: any) => {
        if (msg.ready) {
          ready = true;
          // An idle worker never keeps the process alive (after the listeners: a 'message' listener refs its port).
          if (!this.busy) worker.unref();
          settle(true);
          return;
        }
        if (msg.fatal) {
          this.end('failed');
          settle(false, msg.fatal.message);
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.done(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error.code ? { code: msg.error.code } : {}));
        else p.resolve(msg.value);
      });
      worker.on('error', (err: { message?: string; code?: string }) => {
        if (!ready) {
          this.end('failed');
          settle(false, String(err?.message ?? err));
          return;
        }
        // Out of memory: the command running on it is the cause.
        const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
        const culprit = oom ? Object.assign(new Error('the command ran out of memory, so it was stopped'), { code: 'ENOMEM' }) : undefined;
        this.end(oom ? 'out of memory' : `failed (${String(err?.message ?? err)})`, culprit);
      });
      worker.on('exit', () => {
        if (!ready) settle(false);
        this.end('exited');
        this.exit();
      });
      // Referenced while it starts (someone waits for it); once started, only while a call runs (`touch`).
    });
  }

  get ended(): boolean {
    return this.endedBy !== undefined;
  }

  /** Its thread's id (tests: a new lease is a new thread). */
  get threadId(): number | undefined {
    return this.worker?.threadId;
  }

  /** A call in flight, or its owner holding it (`hold`). */
  get busy(): boolean {
    return this.pending.size > 0 || this.holds > 0;
  }

  generation(): number {
    return this.ended ? 1 : 0;
  }

  /** Whether its thread started. */
  start(): Promise<boolean> {
    return this.started;
  }

  count(delta: 1 | -1, bytes: number): void {
    this.machines = Math.max(0, this.machines + delta);
    this.bytes = Math.max(0, this.bytes + delta * bytes);
    if (this.machines === 0 && delta === -1) this.idle(LINGER_MS, true);
  }

  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.holds++;
    this.touch();
    try {
      return await fn();
    } finally {
      this.holds--;
      this.touch();
    }
  }

  async call(op: MachineOp, args: unknown[], signal?: AbortSignal, limitMs?: number): Promise<any> {
    if (this.ended) throw gone();
    if (!(await this.started)) throw new Error(`harness-world-hands: the workspace's shell could not start: ${this.failure}`);
    if (this.ended) throw gone();
    // A call cancelled before it starts never starts.
    if (signal?.aborted) throw stoppedError(signal.reason);
    const worker = this.worker;
    const id = ++this.seq;
    this.touch();
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, timers: [] };
      this.pending.set(id, p);
      // A call in flight keeps the process alive until its answer.
      if (this.pending.size === 1) worker.ref();
      const limit = limitMs ?? OP_LIMIT_MS;
      p.timers.push(
        setTimeout(() => {
          // Still running past its limit (which just-bash enforces itself when the command yields): end the worker.
          const message =
            op === 'exec'
              ? `the command ran past its time limit (${(limit - KILL_GRACE_MS) / 1000} s), so it was stopped`
              : 'the workspace stopped answering, so its shell was stopped';
          this.end('timed out', Object.assign(new Error(message), { code: 'ETIMEDOUT' }), id);
        }, limit)
      );
      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          worker.postMessage({ abort: id });
          // A command that never yields cannot see the abort: end its worker.
          p.timers.push(setTimeout(() => this.end('cancelled', stoppedError(signal.reason), id), ABORT_GRACE_MS));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        p.off = () => signal.removeEventListener('abort', onAbort);
      }
      for (const t of p.timers) (t as { unref?: () => void }).unref?.();
      try {
        worker.postMessage({ id, op, args });
      } catch (err) {
        this.done(id);
        reject(err);
      }
    });
  }

  private done(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    for (const t of p.timers) clearTimeout(t);
    p.off?.();
    this.pending.delete(id);
    this.touch();
  }

  private touch(): void {
    this.lastUsed = Date.now();
    if (!this.busy) {
      this.worker?.unref();
      const released = this.machines === 0 && this.session !== undefined;
      this.idle(released ? LINGER_MS : this.pool.options.idleMs, released);
      this.pool.poke();
    } else if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** End the lease after `ms` with nothing running (`linger`: its last machine was freed, unless another is made meanwhile). */
  idle(ms: number, linger = false): void {
    if (this.ended) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.busy) return;
      if (linger && this.machines > 0) return this.idle(this.pool.options.idleMs);
      this.end(linger ? 'released' : 'idle');
    }, ms);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /**
   * End the lease: terminate its worker (never reused), fail every call in
   * flight (`culprit`'s with its own error, the others "try again"), and
   * free its room in the pool. Its machines are lost.
   */
  end(why: string, culprit?: Error, culpritId?: number): void {
    if (this.ended) return;
    this.endedBy = why;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [id, p] of [...this.pending]) {
      this.done(id);
      p.reject(culprit && (culpritId === undefined || culpritId === id) ? culprit : restarted());
    }
    this.machines = 0;
    this.bytes = 0;
    void this.worker?.terminate().catch(() => {});
    this.pool.ended(this);
  }
}

// ---------------------------------------------------------------------------
// The pool

/** What a pool holds now (tests, diagnostics). */
export interface PoolStats {
  maxWorkers: number;
  memoryBytes: number;
  /** Leases by session: machines, the bytes they may hold, and whether a call runs. */
  leases: { session: unknown; machines: number; bytes: number; busy: boolean }[];
  /** A worker kept ready for the next lease. */
  ready: boolean;
  /** Calls waiting for a worker. */
  waiting: number;
  /** Workers started, and ended, since the pool was made. */
  started: number;
  ended: number;
}

/** The process's workers, leased one per session. */
export class WorkerPool {
  private readonly leases = new Map<unknown, WorkerLease>();
  private readonly acquiring = new Map<unknown, Promise<WorkerLease | undefined>>();
  /** A started worker kept ready for the next lease, and one starting. */
  private spare: WorkerLease | undefined;
  private sparing: WorkerLease | undefined;
  private readonly waiters = new Set<() => void>();
  private startedCount = 0;
  private endedCount = 0;
  private everStarted = false;
  /** Why no worker could start here, when none ever could. */
  failure: string | undefined;

  constructor(
    private readonly node: NodeModules,
    private readonly entry: string,
    private readonly shell: WorkerShell,
    readonly options: WorkerPoolOptions
  ) {}

  /** The worker leased to `session` (a new lease when it has none), for a machine that may hold `bytes`; undefined when no worker can start here. */
  acquire(session: unknown, bytes: number, signal?: AbortSignal): Promise<WorkerLease | undefined> {
    const held = this.leases.get(session);
    if (held && !held.ended) return Promise.resolve(held);
    let p = this.acquiring.get(session);
    if (!p) {
      p = this.admit(session, bytes, signal).finally(() => this.acquiring.delete(session));
      this.acquiring.set(session, p);
    }
    return p;
  }

  private async admit(session: unknown, bytes: number, signal?: AbortSignal): Promise<WorkerLease | undefined> {
    const until = Date.now() + this.options.admitWaitMs;
    for (;;) {
      if (signal?.aborted) throw stoppedError(signal.reason);
      if (this.room(bytes)) {
        const lease = await this.take(session);
        if (!lease || !lease.ended) return lease;
        continue;
      }
      const victim = this.victim();
      if (victim) {
        victim.end('taken for another session');
        continue;
      }
      if (Date.now() >= until) {
        throw Object.assign(new Error('the instance is busy: every workspace shell on it is running a command. Try the call again.'), { code: 'EBUSY' });
      }
      await this.wait(Math.min(100, until - Date.now()), signal);
    }
  }

  /** The memory the workers use (their heap limits and their workspaces' bytes), and how many run. */
  private load(): { workers: number; bytes: number } {
    let workers = 0;
    let bytes = 0;
    for (const lease of this.leases.values()) {
      workers++;
      bytes += WORKER_COST_BYTES + lease.bytes;
    }
    for (const lease of [this.spare, this.sparing]) {
      if (lease) {
        workers++;
        bytes += WORKER_COST_BYTES;
      }
    }
    return { workers, bytes };
  }

  /** Whether a new lease for a machine of `bytes` fits (the ready worker, or a new one). */
  private room(bytes: number): boolean {
    const { workers, bytes: used } = this.load();
    if (this.spare) return used + bytes <= this.options.memoryBytes || workers === 1;
    // One lease always fits in an empty pool, whatever its workspace asks for.
    if (workers === 0) return true;
    return workers < this.options.maxWorkers && used + WORKER_COST_BYTES + bytes <= this.options.memoryBytes;
  }

  /** The lease to take for another session: the one idle the longest, with nothing running and not just used. */
  private victim(): WorkerLease | undefined {
    if (this.sparing && !this.spare) {
      // A worker still starting for no one yet: let it go first.
      const s = this.sparing;
      this.sparing = undefined;
      s.end('not needed');
      return undefined;
    }
    const now = Date.now();
    let best: WorkerLease | undefined;
    for (const lease of this.leases.values()) {
      if (lease.busy || now - lease.lastUsed < EVICT_GUARD_MS) continue;
      if (!best || lease.lastUsed < best.lastUsed) best = lease;
    }
    return best;
  }

  /**
   * Lease the ready worker, or a new one, to `session`. Undefined when no
   * worker has ever started here (this realm runs the shell instead); once
   * one has, a worker that cannot start fails the call.
   */
  private async take(session: unknown): Promise<WorkerLease | undefined> {
    let lease = this.spare;
    this.spare = undefined;
    if (!lease) {
      lease = this.newLease();
      lease.session = session;
      this.leases.set(session, lease);
      if (!(await lease.start())) {
        if (this.leases.get(session) === lease) this.leases.delete(session);
        if (!this.everStarted) {
          this.failure = lease.failure;
          return undefined;
        }
        throw Object.assign(new Error(`the workspace's shell could not start (${lease.failure}): try the call again`), { code: 'EAGAIN' });
      }
    } else {
      lease.session = session;
      this.leases.set(session, lease);
    }
    this.everStarted = true;
    this.prewarm();
    return lease;
  }

  private newLease(warm = false): WorkerLease {
    this.startedCount++;
    return new WorkerLease(this, this.node, this.entry, this.shell, warm);
  }

  /** Start a worker for the next lease, when there is room for one. */
  private prewarm(): void {
    if (this.spare || this.sparing) return;
    const { workers, bytes } = this.load();
    if (workers >= this.options.maxWorkers || bytes + WORKER_COST_BYTES > this.options.memoryBytes) return;
    const lease = (this.sparing = this.newLease(true));
    void lease.start().then((ok) => {
      if (this.sparing !== lease) return;
      this.sparing = undefined;
      if (!ok || lease.ended) return;
      this.spare = lease;
      lease.idle(this.options.idleMs);
    });
  }

  /** A lease ended: its room is free. */
  ended(lease: WorkerLease): void {
    this.endedCount++;
    if (this.leases.get(lease.session) === lease) this.leases.delete(lease.session);
    if (this.spare === lease) this.spare = undefined;
    if (this.sparing === lease) this.sparing = undefined;
    this.poke();
  }

  /** Room may have freed (a lease ended, a call finished): waiting calls look again. */
  poke(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  stats(): PoolStats {
    return {
      maxWorkers: this.options.maxWorkers,
      memoryBytes: this.options.memoryBytes,
      leases: [...this.leases.values()].map((l) => ({ session: l.session, machines: l.machines, bytes: l.bytes, busy: l.busy })),
      ready: this.spare !== undefined,
      waiting: this.waiters.size,
      started: this.startedCount,
      ended: this.endedCount,
    };
  }

  /** End every lease (tests: as a watchdog would). */
  endAll(): void {
    for (const lease of [...this.leases.values(), this.spare, this.sparing]) lease?.end('restarted');
  }

  /** The lease `session` holds now. */
  leaseOf(session: unknown): WorkerLease | undefined {
    return this.leases.get(session);
  }
}

/** The instance's memory: its container's limit where Node knows it, else the machine's. */
function instanceMemory(node: NodeModules): number {
  const constrained = typeof node.process.constrainedMemory === 'function' ? Number(node.process.constrainedMemory()) : 0;
  const total = Number(node.os.totalmem?.() ?? 0);
  // constrainedMemory() is a huge number when there is no limit.
  return constrained > 0 && (total === 0 || constrained < total) ? constrained : total;
}

/** The pool's limits on this instance, unless set (`configureWorkers`). */
export function defaultPoolOptions(node: NodeModules): WorkerPoolOptions {
  const memoryBytes = Math.floor(instanceMemory(node) * MEMORY_SHARE);
  const fits = Math.floor(memoryBytes / (WORKER_COST_BYTES + DEFAULT_WORKSPACE_BYTES));
  return { maxWorkers: Math.max(2, Math.min(MAX_WORKERS, fits)), memoryBytes, idleMs: IDLE_MS, admitWaitMs: ADMIT_WAIT_MS };
}
