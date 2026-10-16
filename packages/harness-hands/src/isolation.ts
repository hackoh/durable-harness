import { type ExecOptions, type ExecResult, type FileBytes, type MachineOp, machineOps, type WalkEntry, type WorkspaceMachine } from './machine.ts';
import { VIRTUAL_COMMANDS, WORKSPACE_ROOT } from './paths.ts';
import {
  type Channel,
  defaultPoolOptions,
  justBashEntry,
  KILL_GRACE_MS,
  nodeModules,
  stoppedError,
  type PoolStats,
  type WorkerLease,
  WorkerPool,
  type WorkerPoolOptions,
  type WorkerShell,
} from './worker.ts';

/**
 * Where just-bash runs: a worker thread leased to the machine's session
 * (worker.ts), or this realm.
 *
 * On Node, a machine's files and shell live in a worker leased to its
 * session alone (`session`: machines of one session share it, machines of
 * two sessions never do), started with an empty environment and just-bash's
 * defense-in-depth on. A command holds that worker, not the thread serving
 * every session; one still running past its time limit, or after its call
 * was cancelled, ends the worker, and its session's machines on it are lost
 * (their owners make them again from their record, runtime.ts).
 *
 * Anywhere a worker cannot start (a browser tab, a Cloudflare Worker, a
 * bundle that cannot find just-bash for it), the machine runs here, with
 * defense-in-depth off and the hardened profile. Node's modules are reached
 * through `process.getBuiltinModule`, so no bundler sees an import of them.
 */

export type Isolation = 'auto' | 'worker' | 'process';

/** A machine's limits. */
export interface MachineLimits {
  /** The most bytes its files may hold: a write past it fails ("the workspace is full"). */
  maxBytes: number;
  /** The largest single file. */
  maxFileBytes: number;
  /** A command's wall-clock limit: just-bash stops it there, and a worker still running it shortly after is ended. */
  timeoutMs: number;
}

/** The limits a machine gets unless its workspace says otherwise (durable-harness's `virtual()` always says). */
export const MACHINE_DEFAULTS: Readonly<MachineLimits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
});

export interface MachineOptions extends Partial<MachineLimits> {
  /** Default `/workspace`. */
  root?: string;
  /** `auto` (default): a worker where one can start, else this realm. */
  isolation?: Isolation;
  /**
   * The session the machine belongs to (its run id): its machines share one
   * worker, and no other session's machine is ever on it. Default: a
   * session of its own (a worker for this machine alone).
   */
  session?: unknown;
  /** Stop waiting for a worker (every one busy) when this aborts. */
  signal?: AbortSignal;
}

const MiB = 1024 * 1024;

/**
 * How a worker runs just-bash: the `normal` profile's counts (loops and
 * commands: a real script's), with the `hardened` profile's sizes, so one
 * command's output, strings and input stay within its worker's heap and a
 * tool result stays a size the log and the model can take. The command's
 * time is bounded by its deadline, at which the worker ends.
 */
const WORKER_SHELL: WorkerShell = {
  profile: 'normal',
  commands: VIRTUAL_COMMANDS,
  limits: {
    maxSourceBytes: 8 * MiB,
    maxStringLength: 10 * MiB,
    maxHeredocSize: 10 * MiB,
    maxOutputSize: 10 * MiB,
    maxLiveBytes: 64 * MiB,
    maxInputBytes: 32 * MiB,
    maxArrayElements: 100_000,
    maxArchiveBytes: 128 * MiB,
    maxArchiveCompressedBytes: 64 * MiB,
    maxArchiveEntryBytes: 64 * MiB,
    maxWorkerMessageBytes: 16 * MiB,
  },
};

const gone = () => Object.assign(new Error("this workspace's files are gone: the shell it ran in was restarted"), { code: 'EGONE' });

/**
 * Call `fn` once `ms` have passed by the clock. A timer alone can fire early:
 * it counts from the event loop's last turn, not from when it was set, so a
 * deadline set late in a long turn would stop a command short of its time.
 */
function afterMs(ms: number, fn: () => void): () => void {
  const due = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (wait: number) => {
    timer = setTimeout(() => {
      const left = due - Date.now();
      if (left > 0) arm(left);
      else fn();
    }, wait);
  };
  arm(ms);
  return () => clearTimeout(timer);
}

/** Frees a machine nobody holds any more (where the runtime has finalizers). */
const released =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<{ channel: Channel; id: string; gen: number; bytes: number }>(({ channel, id, gen, bytes }) => {
        if (channel.generation() !== gen) return;
        channel.count?.(-1, bytes);
        channel.call('dispose', [id]).catch(() => {});
      })
    : undefined;

/** A workspace machine on just-bash: the interface, plus the transaction operations the document-backed workspace uses. */
export class VirtualMachine implements WorkspaceMachine {
  private disposed = false;

  constructor(
    readonly id: string,
    readonly root: string,
    readonly limits: Readonly<MachineLimits>,
    private readonly channel: Channel,
    private readonly gen: number
  ) {
    released?.register(this, { channel, id, gen, bytes: limits.maxBytes }, this);
  }

  get isolation(): string {
    return this.channel.kind;
  }

  get lost(): boolean {
    return this.disposed || this.channel.generation() !== this.gen;
  }

  private call(op: MachineOp, args: unknown[], signal?: AbortSignal, limitMs?: number): Promise<any> {
    if (this.lost) return Promise.reject(gone());
    return this.channel.call(op, [this.id, ...args], signal, limitMs);
  }

  /**
   * Run `fn` with this machine's worker held: no other session's call takes
   * it meanwhile (a lease idle between two calls can be). The runtime holds
   * it for a whole tool call.
   */
  hold<T>(fn: () => Promise<T>): Promise<T> {
    return this.channel.hold && !this.lost ? this.channel.hold(fn) : fn();
  }

  /**
   * This machine, for one tool call: every command it runs is also stopped
   * when `signal` (the call's cancellation) aborts, and then fails, as a
   * definite outcome ("this invocation of the session ran out of time"),
   * whether just-bash stopped it or its worker had to be ended.
   */
  during(signal: AbortSignal | undefined): VirtualMachine {
    if (!signal) return this;
    return new Proxy(this, {
      get(target, prop) {
        if (prop === 'exec') {
          return async (command: string, options: ExecOptions = {}) => {
            const result = await target.exec(command, { ...options, signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal });
            if (signal.aborted) throw stoppedError(signal.reason);
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * Run a command. A command past the machine's time limit fails
   * (`ETIMEDOUT`), whether just-bash stopped it (and said so) or its worker
   * was ended; one past its own `timeoutMs` exits 124, as `timeout` does (or
   * fails the same way when it would not stop). A `timeoutMs` at or past the
   * machine's limit is the machine's limit: one deadline, never two racing.
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { signal, timeoutMs, ...rest } = options;
    const limit = this.limits.timeoutMs;
    let stop = signal;
    let clear: (() => void) | undefined;
    if (timeoutMs !== undefined && timeoutMs < limit) {
      // A deadline of its own, stopped as a cancellation is (and said as a time limit).
      const deadline = new AbortController();
      clear = afterMs(timeoutMs, () =>
        deadline.abort(Object.assign(new Error(`the command ran past its time limit (${timeoutMs / 1000} s), so it was stopped`), { code: 'ETIMEDOUT' }))
      );
      stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    }
    try {
      const { limited, ...result }: ExecResult & { limited?: true } = await this.call('exec', [command, rest], stop, limit + KILL_GRACE_MS);
      // just-bash stopped it at the machine's own limit: the same failure as a worker ended there.
      if (limited) throw Object.assign(new Error(`the command ran past its time limit (${limit / 1000} s), so it was stopped`), { code: 'ETIMEDOUT' });
      return result;
    } finally {
      clear?.();
    }
  }
  readFile(path: string): Promise<Uint8Array> {
    return this.call('readFile', [path]);
  }
  writeFile(path: string, content: string | Uint8Array, options: { mode?: number; append?: boolean } = {}): Promise<void> {
    return this.call('writeFile', [path, content, options]);
  }
  stat(path: string) {
    return this.call('stat', [path]);
  }
  lstat(path: string) {
    return this.call('lstat', [path]);
  }
  list(dir: string) {
    return this.call('list', [dir]);
  }
  walk(dir?: string): Promise<WalkEntry[]> {
    return this.call('walk', [dir ?? this.root]);
  }
  mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.call('mkdir', [path, options]);
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    return this.call('remove', [path, options]);
  }
  rename(from: string, to: string): Promise<void> {
    return this.call('rename', [from, to]);
  }
  symlink(target: string, path: string): Promise<void> {
    return this.call('symlink', [target, path]);
  }
  readlink(path: string): Promise<string> {
    return this.call('readlink', [path]);
  }
  realpath(path: string): Promise<string> {
    return this.call('realpath', [path]);
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.call('chmod', [path, mode]);
  }

  /** Every regular file under the root (links followed). */
  snapshot(): Promise<FileBytes[]> {
    return this.call('snapshot', []);
  }
  /** Remove `removes`, write `writes`, set `chmods`, with the file size cap off (the machine is made to hold a record): one round trip. */
  apply(writes: FileBytes[], removes: string[], chmods: [string, number][] = []): Promise<void> {
    if (writes.length === 0 && removes.length === 0 && chmods.length === 0) return Promise.resolve();
    return this.call('apply', [writes, removes, chmods]);
  }
  /** Remember the files under the root, for `diff` and `rollback`. */
  checkpoint(): Promise<void> {
    return this.call('checkpoint', []);
  }
  /** What changed since the checkpoint (`null` bytes: removed); `unlink` makes links copies first. */
  diff(options: { unlink?: boolean } = {}): Promise<[string, Uint8Array | null, number][]> {
    return this.call('diff', [options]);
  }
  rollback(): Promise<void> {
    return this.call('rollback', []);
  }
  release(): Promise<void> {
    return this.call('release', []);
  }

  dispose(): void {
    if (this.disposed) return;
    const live = !this.lost;
    this.disposed = true;
    released?.unregister(this);
    if (!live) return;
    this.channel.count?.(-1, this.limits.maxBytes);
    this.channel.call('dispose', [this.id]).catch(() => {});
  }
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/**
 * A machine on just-bash: on the worker leased to its session (when one can
 * start, or `isolation: 'worker'`), or in this realm. Rejects with `EBUSY`
 * when every worker the instance has room for is running a call for longer
 * than a call waits.
 */
export async function createMachine(options: MachineOptions = {}): Promise<VirtualMachine> {
  const root = options.root ?? WORKSPACE_ROOT;
  const isolation = options.isolation ?? 'auto';
  const limits: MachineLimits = {
    maxBytes: options.maxBytes ?? MACHINE_DEFAULTS.maxBytes,
    maxFileBytes: Math.min(options.maxFileBytes ?? MACHINE_DEFAULTS.maxFileBytes, options.maxBytes ?? MACHINE_DEFAULTS.maxBytes),
    timeoutMs: options.timeoutMs ?? MACHINE_DEFAULTS.timeoutMs,
  };
  const session = options.session ?? {};
  const id = newId();
  for (let attempt = 0; ; attempt++) {
    let channel: Channel | undefined;
    if (isolation !== 'process') {
      channel = await workerLease(session, limits.maxBytes, options.signal);
      if (!channel && isolation === 'worker') throw new Error(`harness-world-hands: just-bash cannot run in a worker here: ${workerFailure ?? 'no worker threads'}`);
    }
    channel ??= await localChannel();
    const gen = channel.generation();
    try {
      await channel.call('create', [id, { root, ...limits, commands: VIRTUAL_COMMANDS }]);
    } catch (err) {
      // Its lease ended as it was made (its worker was taken or stopped): once more, on a new one.
      if ((err as { code?: string }).code === 'EGONE' && attempt === 0) continue;
      throw err;
    }
    channel.count?.(1, limits.maxBytes);
    return new VirtualMachine(id, root, Object.freeze(limits), channel, gen);
  }
}

/** Where a new machine would run: `worker` or `process`. */
export async function machineIsolation(): Promise<'worker' | 'process'> {
  return (await workerPool()) ? 'worker' : 'process';
}

// ---------------------------------------------------------------------------
// In this realm

let local: Promise<Channel> | undefined;
function localChannel(): Promise<Channel> {
  local ??= (async () => {
    const jb = await import('just-bash');
    // defense-in-depth patches this realm's globals while a command runs,
    // which breaks a host serving other requests from the same process; and
    // nothing here can stop a command that never yields, so the hardened
    // profile caps its counts too.
    const ops = machineOps(jb, { defenseInDepth: false, profile: 'hardened' });
    return {
      kind: 'process' as const,
      generation: () => 0,
      call: async (op: MachineOp, args: unknown[], signal?: AbortSignal) =>
        op === 'exec' ? ops.exec(args[0] as string, args[1] as string, args[2] as object, signal) : (ops[op] as (...a: unknown[]) => unknown)(...args),
    };
  })();
  local.catch(() => (local = undefined));
  return local;
}

// ---------------------------------------------------------------------------
// In workers

/** Why a worker could not start, once none could (then every machine runs in this realm). */
let workerFailure: string | undefined;
let warned = false;

/** The process's workers, shared by every copy of this module that speaks the same messages. */
const SHARED = Symbol.for('harness-world-hands//just-bash-workers@2');

/** The process's pool; null where no worker can run. */
function workerPool(): Promise<WorkerPool | null> {
  const g = globalThis as { [SHARED]?: Promise<WorkerPool | null> };
  g[SHARED] ??= (async () => {
    const node = nodeModules();
    if (!node) return null;
    const entry = await justBashEntry(node);
    if (!entry) {
      fallBack('just-bash was not found where a worker could load it');
      return null;
    }
    return new WorkerPool(node, entry, WORKER_SHELL, defaultPoolOptions(node));
  })();
  return g[SHARED];
}

/** The worker leased to `session`; undefined when no worker can run here. */
async function workerLease(session: unknown, bytes: number, signal?: AbortSignal): Promise<WorkerLease | undefined> {
  const pool = await workerPool();
  if (!pool) return undefined;
  const lease = await pool.acquire(session, bytes, signal);
  if (lease) return lease;
  // No worker ever started here: every machine runs in this realm from now on.
  fallBack(pool.failure ?? 'unknown');
  (globalThis as { [SHARED]?: Promise<WorkerPool | null> })[SHARED] = Promise.resolve(null);
  return undefined;
}

function fallBack(why: string): void {
  workerFailure ??= why;
  if (warned) return;
  warned = true;
  console.warn(`[harness-world-hands] the workspace's shell runs in this process, not in an isolated worker: ${why}`);
}

/** For tests: a fresh worker's environment (its keys) and defense-in-depth status; undefined without workers. */
export async function probeWorker(): Promise<{ env: string[]; defense: Record<string, unknown> } | undefined> {
  const session = {};
  const lease = await workerLease(session, 0);
  if (!lease) return undefined;
  try {
    return await lease.call('probe' as MachineOp, []);
  } finally {
    lease.end('probed');
  }
}

/** For tests: end every worker as its watchdog would (every machine on it is lost); the next call starts another. */
export async function restartWorkers(): Promise<void> {
  (await workerPool())?.endAll();
}

/** For tests and diagnostics: what the pool holds now; undefined without workers. */
export async function workerStats(): Promise<PoolStats | undefined> {
  return (await workerPool())?.stats();
}

/** For tests: the lease `session` holds now. */
export async function leaseOf(session: unknown): Promise<WorkerLease | undefined> {
  return (await workerPool())?.leaseOf(session);
}

/** For tests: change the pool's limits; returns the ones it had. */
export async function configureWorkers(options: Partial<WorkerPoolOptions>): Promise<WorkerPoolOptions | undefined> {
  const pool = await workerPool();
  if (!pool) return undefined;
  const before = { ...pool.options };
  Object.assign(pool.options, options);
  return before;
}

/** For tests: where a worker would load just-bash from, with `resolve` failing as it does in a bundle that renamed it. */
export function findJustBash(options: { unresolvable?: boolean } = {}): Promise<string | undefined> {
  const node = nodeModules();
  if (!node) return Promise.resolve(undefined);
  const fails = () => {
    throw new Error('not resolvable');
  };
  return justBashEntry(options.unresolvable ? { ...node, module: { createRequire: () => ({ resolve: fails }) } } : node, options.unresolvable);
}
