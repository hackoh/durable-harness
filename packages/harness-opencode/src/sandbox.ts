import { type DriveContext, type HostToolIO, Unavailable, Yield } from 'harness-world';
import type { ExecOptions, WorkspaceMachine } from 'harness-world-hands/runtime';
import { type AcquireMachine, Mutex, type SessionMachine, toolKey } from 'harness-world-process';
import { WORKSPACE_ROOT, type WorkspaceSlot } from './environment.ts';

/**
 * OpenCode's own tools in the session's Vercel Sandbox (docs/workspaces.md
 * §5.6): OpenCode's core stays in the drive, and each built-in call's files
 * and commands go to the session's VM, its `/workspace` on the Drive
 * (`SessionMachine.workspace`, harness-world-sandbox's `RemoteMachine`).
 *
 * - **Lazy.** The VM is attached on the first built-in call of a drive, so a
 *   turn that runs none boots none. The attach is the kernel's
 *   (`attachInDrive`: a `sandbox.attach` fact with the drive's fencing token
 *   read inside it, the `hw.sandbox` record), in the call's **pre-intent
 *   phase**: before the call's intent is written. An attach that fails or is
 *   busy makes the call "not run: the sandbox is starting, try again", a
 *   definite outcome (the model may call again), never an interrupted call;
 *   one that stops the drive (preempted, superseded, `Unavailable` such as a
 *   spent `vmSeconds` budget, a lost link past its re-attaches) stops it.
 * - **Durable, not transactional.** The Drive keeps what a call wrote, even a
 *   call a crash cut off, so the calls that change files or run commands
 *   (write, edit, patch, shell) are `replay: 'never'`: one cut off is
 *   reported as "may or may not have taken effect", never run again by
 *   itself. Each write reaches the Drive (`FSYNC`) before its outcome is
 *   recorded. Read, glob and grep are `safe`.
 * - **One call at a time**, each on the attach's machine (in the session's
 *   `WorkspaceSlot` for the length of the call), its commands stopped when the
 *   call or the drive is.
 * - **Lost files.** When the session's Drive is not the one its log knew,
 *   the first call that completes says so before its result, and the record
 *   is told it was said (`acknowledgeNotes`, with the call's outcome).
 *
 * The attach fact comes from harness-world-sandbox/cli, loaded on the first
 * attach only (it loads neither the session factory nor `@vercel/sandbox`;
 * the acquire loads the factory), so a session without a sandbox loads none
 * of the tier.
 */

/** The sentence OpenCode's shell description gets on a sandbox: where it runs, and what a cut-off command means. */
export const SANDBOX_SHELL_NOTE = "It runs in this session's own sandbox, a Linux VM; a command that was cut off (the session moved, or ran out of time) may have partly run.";

/** The system-prompt snippet for a sandbox. */
export const SANDBOX_INSTRUCTIONS = `Your workspace tools work in this session's own sandbox, a Linux VM, at ${WORKSPACE_ROOT}. Its files are kept with the session: they last across turns. A call that was cut off may have partly run.`;

/** A built-in call that did not run: the session's sandbox could not be attached for it. Nothing reached the VM. */
export class NotRun extends Error {
  readonly code = 'ENOTRUN';
  constructor(cause?: unknown) {
    super('not run: the sandbox is starting, try again', cause !== undefined ? { cause } : undefined);
    this.name = 'NotRun';
  }
}

/** The log's own stop conditions (and the kernel's), which a "not run" outcome would hide: they stop the drive. */
const STOPPING = new Set(['Fatal', 'Restart', 'LogFenced', 'LogSuperseded', 'InBandSupersededError', 'Parked', 'EffectInterrupted', 'SandboxLost']);

/**
 * Whether an attach failure stops the drive rather than the call: any yield
 * but `contended` (the factory's refusal to arm a fresh VM with an unfenced
 * token is `superseded`; `preempted` writes nothing more), `Unavailable` (no
 * fencing token, the VM-time budget, a CLI downgrade), the log's stop
 * conditions, and a link lost more often than an invocation re-attaches
 * (`SandboxLost`: a transport error, so the next delivery takes over).
 */
export function stopsTheDrive(err: unknown): boolean {
  if (err instanceof Yield) return err.reason !== 'contended';
  if (err instanceof Unavailable) return true;
  const name = (err as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && STOPPING.has(name);
}

/** The parts of the sandbox tier a drive uses (the kernel's attach fact, the `hw.sandbox` record), loaded on the first attach. */
type SandboxTier = Pick<typeof import('harness-world-sandbox/cli'), 'attachInDrive' | 'acknowledgeNotes' | 'SANDBOX_DOC'>;
let tier: Promise<SandboxTier> | undefined;
function sandboxTier(): Promise<SandboxTier> {
  tier ??= import('harness-world-sandbox/cli');
  tier.catch(() => (tier = undefined));
  return tier;
}

/**
 * One call's view of the attach's machine: its commands also stop when the
 * call or the drive is stopped (a command still running then ends with a
 * definite outcome within the invocation).
 */
class CallMachine implements WorkspaceMachine {
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

/** One drive's built-in calls on the session's sandbox. Build one per `drive(ctx)`. */
export class SandboxCalls {
  private session: SessionMachine | undefined;
  private pending: Promise<SessionMachine> | undefined;
  /** Calls whose pre-intent attach failed: the reason, recorded as the call's outcome before it can run. */
  private readonly notRun = new Map<string, NotRun>();
  private readonly serial = new Mutex();
  /** The attach's notes reached the model in this drive (and the record was told). */
  private told = false;
  private closed = false;

  constructor(
    private readonly ctx: DriveContext,
    private readonly acquire: AcquireMachine,
    private readonly slot: WorkspaceSlot,
    /** What the model hears besides OpenCode's result (by call id): the lost-files note. */
    private readonly outcome: Map<string, { note?: string; failed?: string }>
  ) {}

  /** The attached machine, attaching now if there is none (or its link was lost). One attach at a time. */
  private attach(): Promise<SessionMachine> {
    if (this.closed) return Promise.reject(new Error('the drive is over'));
    const s = this.session;
    if (s && !s.signal.aborted && !s.workspace.lost) return Promise.resolve(s);
    if (this.pending) return this.pending;
    const pending = (async () => {
      // A lost machine is closed (best effort) before it is replaced.
      this.session = undefined;
      if (s) void s.close().catch(() => {});
      const { attachInDrive } = await sandboxTier();
      const machine = await attachInDrive(this.ctx, this.acquire);
      if (machine.workspace.root !== WORKSPACE_ROOT) {
        void machine.close().catch(() => {});
        throw new Unavailable(`harness-world-opencode: the session's sandbox has its files at ${machine.workspace.root}, not ${WORKSPACE_ROOT}, where OpenCode works`);
      }
      if (this.closed) {
        void machine.close().catch(() => {});
        throw new Error('the drive is over');
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

  /**
   * The pre-intent phase of a built-in call, before its intent is written:
   * attach the session's VM. A failure that stops the drive stops it (and
   * rejects); any other makes the call "not run" (`around` records it as the
   * call's outcome). Returns that reason, if any. A call the log already
   * answers attaches nothing.
   */
  async prepare(callId: string): Promise<NotRun | undefined> {
    if (this.ctx.isMemoized(toolKey(callId))) return undefined;
    try {
      await this.attach();
      this.notRun.delete(callId);
      return undefined;
    } catch (err) {
      if (this.ctx.signal.aborted) throw this.ctx.signal.reason ?? err;
      if (stopsTheDrive(err)) {
        this.ctx.halt?.(err);
        throw err;
      }
      const reason = err instanceof NotRun ? err : new NotRun(err);
      this.notRun.set(callId, reason);
      return reason;
    }
  }

  /**
   * A built-in call's effect body (`BuiltinCalls`' `around`): "not run" when
   * its attach failed or the link was lost since (before the call runs);
   * otherwise the call, alone, on the attach's machine. What it wrote is on
   * the Drive before it returns (`RemoteMachine` flushes each write).
   */
  async around(call: { callId: string }, run: () => Promise<string>, io: HostToolIO): Promise<string> {
    const failed = this.notRun.get(call.callId);
    if (failed) {
      this.notRun.delete(call.callId);
      throw failed;
    }
    return this.serial.run(async () => {
      const session = this.session;
      if (!session || session.signal.aborted || session.workspace.lost) throw new NotRun(new Error('the link to the sandbox was lost before the call ran'));
      const stop = AbortSignal.any([io.signal, this.ctx.signal]);
      const note = !this.told && session.notes.length ? session.notes.join('\n') : undefined;
      if (note) this.outcome.set(call.callId, { note });
      const text = await this.slot.with(new CallMachine(session.workspace, stop), run);
      if (note) {
        // Said with this call's result: the record is told, in the same outcome (only the loss the note named: one recorded since is told too).
        const { acknowledgeNotes, SANDBOX_DOC } = await sandboxTier();
        const key = session.notesKey;
        io.docs?.update(SANDBOX_DOC, (record) => acknowledgeNotes(record ?? {}, key));
        this.told = true;
        return `${note}\n\n${text}`;
      }
      return text;
    });
  }

  /** The drive is over: close the attach's machine (its commands are killed; the VM and the Drive stay). */
  async close(): Promise<void> {
    this.closed = true;
    const s = this.session;
    this.session = undefined;
    // An attach still pending closes what it gets (`closed`).
    await s?.close().catch(() => {});
  }
}
