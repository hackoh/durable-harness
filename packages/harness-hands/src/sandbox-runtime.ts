import { type Doc, type DriveContext, type HostTool, type HostToolIO, Unavailable } from 'harness-world';
import type { ExecOptions, WorkspaceMachine } from './machine.ts';
import { type CallMode, WORKSPACE_TOOL, type WorkspaceRuntime, type WorkspaceToolDef } from './runtime.ts';
import { WORKSPACE_ROOT } from './paths.ts';

/**
 * A workspace runtime on the session's own Vercel Sandbox (`sandbox()`,
 * docs/workspaces.md §5.6): the same `runtime.tool()` tools as on a virtual
 * workspace, their files on the session's Drive at `/workspace` and their
 * commands in the session's VM (`SessionMachine.workspace`, the sandbox
 * tier's `RemoteMachine`), for a kernel harness whose core stays in the
 * Function (Pi).
 *
 * - **Lazy.** The VM is attached on the first call of a drive that reaches
 *   the workspace, so a turn that runs none boots none. The attach is the
 *   kernel's (`attachInDrive`: a `sandbox.attach` fact, with the drive's own
 *   fencing token read inside it, and the `hw.sandbox` record), once per
 *   drive, again after a lost link.
 * - **Pre-intent.** Each tool carries `beforeIntent(ctx)`, which a harness
 *   runs before it writes the call's intent (harness-world-pi does): it
 *   attaches there, so an attach that fails or is busy makes the call
 *   "not run" (`NotRun`, a definite outcome: the model may call again),
 *   never an interrupted call; one that stops the drive (preempted,
 *   superseded, `Unavailable` such as a spent `vmSeconds` budget, a link lost
 *   past its re-attaches) stops it (`ctx.halt`). A harness that doesn't run
 *   the phase gets the same outcomes, the attach inside the call's intent.
 * - **Durable, not transactional.** The Drive keeps what a call wrote, even
 *   a call a crash cut off, so a tool that may change files or run commands
 *   (`mode: 'write'`) is `replay: 'never'`: one cut off comes back
 *   interrupted, "may have taken effect", never run again by itself. Each
 *   write reaches the Drive (`FSYNC`) before its call's outcome is recorded
 *   (the machine flushes each one). A `read` tool is `safe`.
 * - **One call at a time** per drive, each on the attach's machine, its
 *   commands stopped when the call or the drive is.
 * - **Lost files.** When the session's Drive is not the one its log knew,
 *   the first call of the drive that completes says so before its result,
 *   and the record is told it was said, with that call's outcome.
 * - **Closed at the drive's end** (`afterDrive(ctx)`, which the harness
 *   calls), or once no call ran on it for `IDLE_CLOSE_MS` (a harness that
 *   doesn't call it): the machine's commands are killed and its link
 *   closed; the VM and the Drive stay, and a later call attaches again.
 *
 * The sandbox tier (harness-world-sandbox, `@vercel/sandbox`) is the
 * caller's to load (`kernelSandbox`), on the first attach, so this package
 * does not depend on it.
 */

/** What the runtime uses of an attached machine: harness-world-process' `SessionMachine`, structurally. */
export interface AttachedMachine {
  /** The session's `/workspace`, as files and commands. */
  readonly workspace: WorkspaceMachine;
  /** What the model must be told about this attach (the files were lost). */
  readonly notes: readonly string[];
  /** What `notes` describe (the new Drive's id), so the acknowledgement clears exactly them. */
  readonly notesKey?: string;
  /** Aborted when the link to the VM is lost. */
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export interface SandboxRuntimeOptions {
  /** Attach the session's machine for `ctx`'s drive (the kernel's `attachInDrive`). */
  attach(ctx: DriveContext): Promise<AttachedMachine>;
  /** Inside the effect of the call whose result told the model the machine's notes (`key`, its `notesKey`): tell the record so (`acknowledgeNotes`). */
  told(io: HostToolIO, key: string | undefined): void | Promise<void>;
}

/** The parts of harness-world-sandbox `kernelSandbox` uses (its exports, structurally). */
export interface KernelSandboxTier<Acquire, Record extends object> {
  attachInDrive(ctx: DriveContext, acquire: Acquire): Promise<AttachedMachine>;
  acknowledgeNotes(record: Record, key?: string): Record;
  readonly SANDBOX_DOC: Doc<Record>;
}

/**
 * The runtime options for a kernel drive: `acquire` (the descriptor's
 * `AcquireMachine`) through the kernel's `attachInDrive`, the notes
 * acknowledged on the `hw.sandbox` document. `load` loads the sandbox tier
 * (`() => import('harness-world-sandbox/cli')`, which loads neither the
 * factory nor `@vercel/sandbox`: `acquire` does), on the first attach only.
 */
export function kernelSandbox<Acquire, Record extends object>(acquire: Acquire, load: () => Promise<KernelSandboxTier<Acquire, Record>>): SandboxRuntimeOptions {
  let tier: Promise<KernelSandboxTier<Acquire, Record>> | undefined;
  const loaded = () => {
    const t = (tier ??= load());
    t.catch(() => {
      if (tier === t) tier = undefined;
    });
    return t;
  };
  return {
    attach: async (ctx) => (await loaded()).attachInDrive(ctx, acquire),
    async told(io, key) {
      const { acknowledgeNotes, SANDBOX_DOC } = await loaded();
      io.docs?.update(SANDBOX_DOC, (record) => acknowledgeNotes(record, key));
    },
  };
}

/** The sentence a shell tool's description gets on a sandbox: where it runs, and what a cut-off command means. */
export const SANDBOX_NOTE = "It runs in this session's own sandbox, a Linux VM; a command that was cut off (the session moved, or ran out of time) may have partly run.";

/** The system-prompt snippet for a sandbox. */
export const SANDBOX_INSTRUCTIONS = `Your workspace tools work in this session's own sandbox, a Linux VM, at ${WORKSPACE_ROOT}. Its files are kept with the session: they last across turns. A call that was cut off may have partly run.`;

/** How long a drive's machine stays attached with no call on it, when the harness never says the drive ended (`afterDrive`). */
export const IDLE_CLOSE_MS = 60_000;

/**
 * A call that did not run: the session's sandbox could not be attached for
 * it. Nothing reached the VM. Busy or still starting (`Yield('contended')`:
 * the factory's answer to anything that passes, a 429 or a 5xx included):
 * "not run: the sandbox is starting, try again". Anything else says what
 * failed (a missing project link, a refused credential), so the model is
 * not told to retry what no retry fixes.
 */
export class NotRun extends Error {
  readonly code = 'ENOTRUN';
  constructor(cause?: unknown) {
    const busy = cause === undefined || (cause as { name?: unknown }).name === 'Yield';
    const reason = busy ? '' : String((cause as Error)?.message ?? cause).replace(/\s+/g, ' ').slice(0, 300);
    super(busy ? 'not run: the sandbox is starting, try again' : `not run: the sandbox could not be attached (${reason})`, cause !== undefined ? { cause } : undefined);
    this.name = 'NotRun';
  }
}

/**
 * What a tool of a runtime may carry for the harness that calls it, beside
 * its `HostTool` fields (harness-world-pi runs both):
 *
 * - `beforeIntent(ctx)`: the call's pre-intent phase, before its intent is
 *   written (skipped for a call the log already answers). Resolves with an
 *   error the call fails with at once, without running (`NotRun`), or
 *   nothing; rejects when the drive must stop (it was halted).
 * - `afterDrive(ctx)`: the drive is over (every tool of a runtime shares
 *   one; calling it more than once is harmless).
 */
export interface PhasedTool {
  beforeIntent?(ctx: DriveContext): Promise<Error | undefined>;
  afterDrive?(ctx: DriveContext): Promise<void>;
}

/** The kernel's and the log's stop conditions (by name: two copies of a package agree), which a "not run" outcome would hide. */
const STOPPING = new Set(['Unavailable', 'Fatal', 'Restart', 'LogFenced', 'LogSuperseded', 'InBandSupersededError', 'Parked', 'EffectInterrupted', 'SandboxLost']);

/**
 * Whether an attach failure stops the drive rather than the call: any
 * yield but `contended` (an unfenced drive can't arm a fresh VM:
 * `superseded`; `preempted` writes nothing more), `Unavailable` (no fencing
 * token, the VM-time budget, a CLI downgrade), the log's stop conditions,
 * and a link lost more often than an invocation re-attaches (`SandboxLost`,
 * a transport error: the next delivery takes over).
 */
export function stopsTheDrive(err: unknown): boolean {
  const e = err as { name?: unknown; reason?: unknown } | undefined;
  if (e?.name === 'Yield') return e.reason !== 'contended';
  return typeof e?.name === 'string' && STOPPING.has(e.name);
}

/** One call's view of the attach's machine: its commands also stop when the call or the drive is stopped (`stop`). */
export class CallMachine implements WorkspaceMachine {
  constructor(
    private readonly machine: WorkspaceMachine,
    private readonly stop: AbortSignal
  ) {}
  get root() {
    return this.machine.root;
  }
  get isolation() {
    return this.machine.isolation;
  }
  get lost() {
    return this.machine.lost;
  }
  exec(command: string, options: ExecOptions = {}) {
    return this.machine.exec(command, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.stop]) : this.stop });
  }
  readFile(path: string) {
    return this.machine.readFile(path);
  }
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number; append?: boolean }) {
    return this.machine.writeFile(path, content, options);
  }
  stat(path: string) {
    return this.machine.stat(path);
  }
  lstat(path: string) {
    return this.machine.lstat(path);
  }
  list(dir: string) {
    return this.machine.list(dir);
  }
  walk(dir?: string) {
    return this.machine.walk(dir);
  }
  mkdir(path: string, options?: { recursive?: boolean }) {
    return this.machine.mkdir(path, options);
  }
  remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.machine.remove(path, options);
  }
  rename(from: string, to: string) {
    return this.machine.rename(from, to);
  }
  symlink(target: string, path: string) {
    return this.machine.symlink(target, path);
  }
  readlink(path: string) {
    return this.machine.readlink(path);
  }
  realpath(path: string) {
    return this.machine.realpath(path);
  }
  chmod(path: string, mode: number) {
    return this.machine.chmod(path, mode);
  }
  /** The attach's machine is the drive's to close, never one call's. */
  dispose(): void {}
}

/** One drive's calls on the session's sandbox. */
class SandboxDrive {
  private session: AttachedMachine | undefined;
  private pending: Promise<AttachedMachine> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Calls queued or running, and the timer that closes an idle machine. */
  private active = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** The attach's notes reached the model in this drive (and the record was told). */
  private told = false;
  private closed = false;

  constructor(
    private readonly ctx: DriveContext,
    private readonly options: SandboxRuntimeOptions
  ) {}

  /** The attached machine, attaching now if there is none (or its link was lost). One attach at a time. */
  attach(): Promise<AttachedMachine> {
    if (this.closed) return Promise.reject(new Error('harness-world-hands: the drive is over'));
    clearTimeout(this.idle);
    const s = this.session;
    if (s && !s.signal.aborted && !s.workspace.lost) return Promise.resolve(s);
    if (this.pending) return this.pending;
    const pending = (async () => {
      // A lost machine is closed (best effort) before it is replaced.
      this.session = undefined;
      if (s) void s.close().catch(() => {});
      const machine = await this.options.attach(this.ctx);
      if (machine.workspace.root !== WORKSPACE_ROOT) {
        void machine.close().catch(() => {});
        throw new Unavailable(`harness-world-hands: the session's sandbox has its files at ${machine.workspace.root}, not ${WORKSPACE_ROOT}, where its tools work`);
      }
      if (this.closed) {
        void machine.close().catch(() => {});
        throw new Error('harness-world-hands: the drive is over');
      }
      this.session = machine;
      return machine;
    })();
    this.pending = pending;
    const clear = () => {
      if (this.pending === pending) this.pending = undefined;
    };
    pending.then(clear, clear);
    return pending;
  }

  /** Attach, as a call's outcome: `NotRun` for a failure that leaves the drive going; the drive halted (and rejects) for one that stops it. */
  async attachOrNotRun(): Promise<AttachedMachine | NotRun> {
    try {
      return await this.attach();
    } catch (err) {
      if (this.ctx.signal.aborted) throw this.ctx.signal.reason ?? err;
      if (stopsTheDrive(err)) {
        this.ctx.halt?.(err);
        throw err;
      }
      return err instanceof NotRun ? err : new NotRun(err);
    }
  }

  /** A call on the attach's machine, after every earlier call of this drive. */
  run(io: HostToolIO, work: (machine: WorkspaceMachine) => Promise<string>): Promise<string> {
    this.active++;
    clearTimeout(this.idle);
    const call = this.queue.then(async () => {
      const session = await this.attachOrNotRun();
      if (session instanceof NotRun) throw session;
      const stop = AbortSignal.any([io.signal, this.ctx.signal]);
      const note = !this.told && session.notes.length ? session.notes.join('\n') : undefined;
      const text = await work(new CallMachine(session.workspace, stop));
      if (!note) return text;
      // Said with this call's result: the record is told, in the same outcome.
      await this.options.told(io, session.notesKey);
      this.told = true;
      return `${note}\n\n${text}`;
    });
    this.queue = call
      .catch(() => {})
      .finally(() => {
        if (--this.active > 0 || this.closed) return;
        // Nothing ran on it for a while: let the link go (a later call attaches again).
        this.idle = setTimeout(() => {
          const s = this.session;
          this.session = undefined;
          void s?.close().catch(() => {});
        }, IDLE_CLOSE_MS);
        (this.idle as { unref?: () => void }).unref?.();
      });
    return call;
  }

  /** The drive is over: close the attach's machine (its commands are killed; the VM and the Drive stay). */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idle);
    const s = this.session;
    this.session = undefined;
    // An attach still pending closes what it gets (`closed`).
    await s?.close().catch(() => {});
  }
}

/**
 * The runtime on the session's sandbox (see the module comment). Its tools
 * are `runtime.tool()`'s, each with `beforeIntent` and `afterDrive`
 * (`PhasedTool`) and the replay a sandbox needs: `never` for a call that may
 * change files or run commands, `safe` for one that only reads.
 */
export function sandboxRuntime(options: SandboxRuntimeOptions): WorkspaceRuntime {
  const drives = new WeakMap<DriveContext, SandboxDrive>();
  const driveOf = (ctx: DriveContext) => {
    let d = drives.get(ctx);
    if (!d) drives.set(ctx, (d = new SandboxDrive(ctx, options)));
    return d;
  };
  const beforeIntent = async (ctx: DriveContext): Promise<Error | undefined> => {
    const r = await driveOf(ctx).attachOrNotRun();
    return r instanceof NotRun ? r : undefined;
  };
  const afterDrive = async (ctx: DriveContext): Promise<void> => {
    const d = drives.get(ctx);
    drives.delete(ctx);
    await d?.close();
  };
  const describe = (description: string, kind: 'shell' | 'file' = 'file') => (kind === 'shell' ? `${description.trimEnd()} ${SANDBOX_NOTE}` : description);
  const run: WorkspaceRuntime['run'] = (io, _mode, work) => driveOf(io.ctx).run(io, work);
  const runtime: WorkspaceRuntime = {
    workspace: { kind: 'sandbox' },
    root: WORKSPACE_ROOT,
    durable: true,
    instructions: SANDBOX_INSTRUCTIONS,
    describe,
    run,
    tool<Input>(def: WorkspaceToolDef<Input>): HostTool<Input> {
      const mode = (input: Input): CallMode => (typeof def.mode === 'function' ? def.mode(input) : def.mode);
      return {
        name: def.name,
        ...(def.label ? { label: def.label } : {}),
        description: def.described ? def.description : describe(def.description, def.kind),
        inputSchema: def.inputSchema,
        // On a Drive a cut-off call may have half-run: only a call that reads is safe to run again.
        replay: def.mode === 'read' ? 'safe' : 'never',
        ...(def.needs ? { needs: def.needs } : {}),
        execute: (input, io) => run(io, mode(input), (machine) => def.run(input, machine, io)),
        beforeIntent,
        afterDrive,
        [WORKSPACE_TOOL]: true,
      } as HostTool<Input> & PhasedTool;
    },
  };
  return runtime;
}
