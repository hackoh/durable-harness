import type { Capability, HostTool, HostToolIO, SessionState } from 'harness-world';
import { DocWorkspace, untouched } from './doc-workspace.ts';
import { createMachine, type Isolation, type MachineOptions, type VirtualMachine } from './isolation.ts';
import type { WorkspaceMachine } from './machine.ts';
import { WORKSPACE_ROOT } from './paths.ts';

/**
 * A workspace's runtime: what each harness's workspace tools are written
 * on, from the workspace descriptor an app passes (durable-harness's
 * `virtual({ durable })` here; `sandbox(opts)` in sandbox-runtime.ts).
 *
 * A tool gets a `WorkspaceMachine` (the files and the shell, machine.ts) for
 * the call, and returns the text the model sees; the runtime decides where
 * the files come from and where they go:
 *
 * - `virtual({ durable: true })`: the document-backed workspace
 *   (doc-workspace.ts): the files are the session's `hw.workspace` manifest
 *   and blob stream, synced in before the call, and what a `write` call
 *   changed is committed with its outcome. They last across turns and
 *   machines.
 * - `virtual({ durable: false })`: an in-memory workspace per turn: nothing
 *   is written to the log, and it is cleared when the next turn starts. A
 *   turn picked up again by a new drive (another invocation, after a crash
 *   or a yield) starts from an empty workspace, and the first call that
 *   sees this says so in its result (`RESET_NOTE`).
 *
 * The tool line for a harness stays thin: its tools' names, schemas and
 * descriptions (copied from the harness's own), and their code on the
 * machine, through `runtime.tool()` (or `runtime.run()` inside a tool of its
 * own). The runtime adds the sentence about where the tools run to each
 * description (`describe`), and a system-prompt snippet (`instructions`).
 */

/**
 * A workspace descriptor, as durable-harness's `Workspace` is (structural:
 * this package does not import it). A virtual one's limits, when it has
 * them, are its machine's (`MACHINE_DEFAULTS` otherwise).
 */
export type WorkspaceDescriptor =
  | { kind: 'virtual'; durable: boolean; maxBytes?: number; maxFileBytes?: number; timeoutMs?: number }
  | { kind: 'sandbox' };

/** Whether a call only reads the workspace, or may change it (`write`: a durable workspace commits what it changed). */
export type CallMode = 'read' | 'write';

/** The sentence every shell tool's description gets: where it runs. */
export const VIRTUAL_NOTE = 'It runs in a virtual workspace, not real Linux: no network, no package installs, no real processes.';
/** The sentence every tool of an in-memory workspace gets. */
export const EPHEMERAL_NOTE = 'Files last until the end of this turn.';
/** What the first call of a turn picked up again by a new drive says, before its result, when the in-memory workspace was reset. */
export const RESET_NOTE =
  "(Note: this turn was interrupted and picked up again, so its workspace, which is kept in memory for one turn, was reset: files written earlier in this turn are gone.)";

/**
 * Marks every tool a workspace runtime makes (`runtime.tool()`): the
 * workspace tool sets (each harness's line, the generic `workspaceTools`).
 * Registered, so two copies of the package agree. Claude Code and Codex
 * refuse them: in their VM they use their own tools (docs/workspaces.md
 * §3.3).
 */
export const WORKSPACE_TOOL: unique symbol = Symbol.for('durable-harness.workspace-tool') as never;

/** Whether `tool` came from a workspace runtime (`WORKSPACE_TOOL`). */
export function isWorkspaceTool(tool: unknown): boolean {
  return typeof tool === 'object' && tool !== null && (tool as { [WORKSPACE_TOOL]?: unknown })[WORKSPACE_TOOL] === true;
}

/** A tool on the workspace, for `runtime.tool()`. */
export interface WorkspaceToolDef<Input> {
  name: string;
  label?: string;
  /** The harness's own description; the runtime adds where it runs (`describe`). */
  description: string;
  /** `shell` for the tool that runs commands, `file` (default) for the others. */
  kind?: 'shell' | 'file';
  /** The description already says where the tool runs: use it as it is. */
  described?: boolean;
  inputSchema: object;
  needs?: Capability[];
  mode: CallMode | ((input: Input) => CallMode);
  /** The call on the machine: the text the model sees. Throw for an error result. */
  run(input: Input, machine: WorkspaceMachine, io: HostToolIO): Promise<string>;
}

export interface WorkspaceRuntime {
  readonly workspace: WorkspaceDescriptor;
  readonly root: string;
  /** Files last across turns (in the session's log), or until the end of the turn (in memory). */
  readonly durable: boolean;
  /** A system-prompt snippet: what the workspace is, and how long its files last. */
  readonly instructions: string;
  /** A native description, plus where the tool runs: `shell` gets `VIRTUAL_NOTE`; an in-memory workspace's tools `EPHEMERAL_NOTE`. */
  describe(description: string, kind?: 'shell' | 'file'): string;
  /**
   * Run one tool call on the workspace as the call sees it, one call at a
   * time per workspace. Returns `work`'s text; a reset note, when there is
   * one, comes first (on a thrown error too).
   */
  run(io: HostToolIO, mode: CallMode, work: (machine: WorkspaceMachine) => Promise<string>): Promise<string>;
  /** A `HostTool` on the workspace (`replay: 'safe'`: a call only reaches the workspace, and a rerun sees what the first attempt saw). */
  tool<Input>(def: WorkspaceToolDef<Input>): HostTool<Input>;
}

export interface WorkspaceRuntimeOptions {
  /** Where just-bash runs (tests): `auto` (default) is the isolated worker where one can start. */
  isolation?: Isolation;
}

/** The runtime for `workspace` (default: a durable virtual workspace). */
export function workspaceRuntime(workspace: WorkspaceDescriptor = { kind: 'virtual', durable: true }, options: WorkspaceRuntimeOptions = {}): WorkspaceRuntime {
  if (workspace.kind !== 'virtual') {
    throw new Error(`harness-world-hands: workspaceRuntime() takes virtual(); a ${String(workspace.kind)} workspace's runtime is sandboxRuntime()`);
  }
  const durable = workspace.durable !== false;
  const machine: MachineOptions = {
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(workspace.maxBytes !== undefined ? { maxBytes: workspace.maxBytes } : {}),
    ...(workspace.maxFileBytes !== undefined ? { maxFileBytes: workspace.maxFileBytes } : {}),
    ...(workspace.timeoutMs !== undefined ? { timeoutMs: workspace.timeoutMs } : {}),
  };
  const run: WorkspaceRuntime['run'] = durable
    ? async (io, mode, work) => {
        if (!io.ctx.world) {
          throw new Error(
            "harness-world-hands: a durable workspace keeps its files in the session's World, and this session has none (durability off): use virtual({ durable: false })"
          );
        }
        const signal = callSignal(io);
        return DocWorkspace.run(io, mode, (ws) => work(ws.machine.during(signal)), machine, signal);
      }
    : (io, mode, work) => runEphemeral(io, mode, machine, work);
  const runtime: WorkspaceRuntime = {
    workspace,
    root: WORKSPACE_ROOT,
    durable,
    instructions: workspaceInstructions(durable),
    describe: (description, kind = 'file') => describeTool(description, kind, durable),
    run,
    tool<Input>(def: WorkspaceToolDef<Input>): HostTool<Input> {
      ephemeralNames.add(def.name);
      return {
        name: def.name,
        ...(def.label ? { label: def.label } : {}),
        description: def.described ? def.description : runtime.describe(def.description, def.kind),
        inputSchema: def.inputSchema,
        replay: 'safe',
        ...(def.needs ? { needs: def.needs } : {}),
        execute: (input, io) => run(io, typeof def.mode === 'function' ? def.mode(input) : def.mode, (machine) => def.run(input, machine, io)),
        [WORKSPACE_TOOL]: true,
      } as HostTool<Input>;
    },
  };
  return runtime;
}

/**
 * A call's cancellation: its own signal, and its drive's (the invocation out
 * of time, the session moved). A command still running then is stopped, so
 * the call ends with a definite outcome within the invocation.
 */
function callSignal(io: HostToolIO): AbortSignal | undefined {
  const signals = [io.signal, (io.ctx as { signal?: AbortSignal } | undefined)?.signal].filter((s): s is AbortSignal => s instanceof AbortSignal);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/** The system-prompt snippet for a virtual workspace. */
export function workspaceInstructions(durable: boolean): string {
  const base = `Your workspace tools work in a virtual workspace at ${WORKSPACE_ROOT}, not real Linux: no network, no package installs, no real processes.`;
  return durable
    ? `${base} Its files are kept with the session: they last across turns.`
    : `${base} Its files are kept in memory: files last until the end of this turn, so put anything worth keeping in your reply.`;
}

/** A description plus where the tool runs. */
export function describeTool(description: string, kind: 'shell' | 'file', durable: boolean): string {
  const notes = [kind === 'shell' ? VIRTUAL_NOTE : undefined, durable ? undefined : EPHEMERAL_NOTE].filter(Boolean);
  return notes.length ? `${description.trimEnd()} ${notes.join(' ')}` : description;
}

// ---------------------------------------------------------------------------
// The in-memory workspace

/**
 * In-memory workspaces that last a turn: one machine per `scope` (an object
 * that lives as long as what it scopes: a drive's `DriveContext`, an agent's
 * session object), replaced by an empty one when the turn changes, and freed
 * with it. What `virtual({ durable: false })` runs on; also for tool code
 * that is not a `HostTool` (an `ExecutionEnv`, OpenCode's `Environment`, a
 * libfx tool), with its own scope and turn.
 *
 * A machine is on the worker leased to its session (`session`: default the
 * scope's `runId`, else the scope). Each call that may change files runs on
 * a checkpoint: a call that throws (a command past its time limit, a
 * cancelled call) is rolled back, so it leaves nothing behind. On a worker,
 * each call's changes are copied here as well (one diff per call), so a
 * machine lost with its worker (its lease went idle, or a command ran past
 * its limit) is made again with the files of the calls that finished.
 */
export class TurnWorkspaces {
  private readonly slots = new WeakMap<object, { turn: string | undefined; machine: Promise<VirtualMachine>; copy: Map<string, [Uint8Array, number]> }>();
  private readonly queues = new WeakMap<object, Promise<unknown>>();
  /** Calls queued or running, per scope. */
  private readonly active = new WeakMap<object, number>();
  /** Each session's newest scope (a drive): a newer one frees the older one's machine. */
  private readonly newest = new Map<unknown, WeakRef<object>>();

  constructor(private readonly options: MachineOptions = {}) {}

  /**
   * Run `work` on `scope`'s workspace for `turn`, after every earlier call
   * of `scope` (one at a time). `fresh`: the workspace was just made for
   * this turn, empty (this scope's first call in the turn). `signal`: the
   * call's cancellation (its commands stop then).
   */
  call<T>(
    scope: object,
    turn: string | undefined,
    mode: CallMode,
    work: (machine: VirtualMachine, fresh: boolean) => Promise<T>,
    options: { session?: unknown; signal?: AbortSignal } = {}
  ): Promise<T> {
    return this.exclusive(scope, async () => {
      const session = options.session ?? (scope as { runId?: unknown }).runId ?? scope;
      const create = () => createMachine({ ...this.options, session, ...(options.signal ? { signal: options.signal } : {}) });
      let slot = this.slots.get(scope);
      let fresh = false;
      if (!slot || slot.turn !== turn) {
        slot?.machine.then((m) => m.dispose(), () => {});
        // The session's earlier scope in this process (its last drive) is over: free its machine.
        const before = this.newest.get(session)?.deref();
        if (before && before !== scope && !this.active.get(before)) this.release(before);
        this.newest.set(session, new WeakRef(scope));
        if (this.newest.size > 256) for (const [key, ref] of this.newest) if (!ref.deref()) this.newest.delete(key);
        slot = { turn, machine: create(), copy: new Map() };
        this.slots.set(scope, slot);
        fresh = true;
      }
      const current = slot;
      let machine = await current.machine.catch(() => (current.machine = create()));
      if (machine.lost) {
        current.machine = create();
        machine = await current.machine;
        await machine.apply([...current.copy].map(([path, [bytes, fileMode]]) => [path, bytes, fileMode] as [string, Uint8Array, number]), []);
      }
      const held = machine;
      return held.hold(async () => {
        const writes = mode === 'write';
        if (writes) await held.checkpoint();
        let result: T;
        try {
          result = await work(held.during(options.signal), fresh);
        } catch (err) {
          // Cut off or failed: back to the checkpoint (a machine lost with its worker is remade from the copy).
          if (writes && !held.lost) {
            try {
              await held.rollback();
              await held.release();
            } catch {
              held.dispose();
            }
          }
          throw untouched(err, held);
        }
        // In this realm a machine is never lost: nothing to copy.
        if (writes && !held.lost) {
          try {
            if (held.isolation === 'worker') {
              for (const [path, bytes, fileMode] of await held.diff()) {
                if (bytes) current.copy.set(path, [bytes, fileMode]);
                else current.copy.delete(path);
              }
            }
            await held.release();
          } catch {}
        }
        return result;
      });
    });
  }

  private exclusive<T>(scope: object, fn: () => Promise<T>): Promise<T> {
    this.active.set(scope, (this.active.get(scope) ?? 0) + 1);
    const run = (this.queues.get(scope) ?? Promise.resolve()).then(fn, fn).finally(() => this.active.set(scope, (this.active.get(scope) ?? 1) - 1));
    this.queues.set(scope, run.catch(() => {}));
    return run;
  }

  /** Free `scope`'s machine now (its turn ended); the next call starts empty. */
  release(scope: object): void {
    const slot = this.slots.get(scope);
    if (!slot) return;
    this.slots.delete(scope);
    slot.machine.then((m) => m.dispose(), () => {});
  }
}

/** The in-memory workspaces of every runtime, by their machines' options. */
const turnWorkspaces = new Map<string, TurnWorkspaces>();
/** Every workspace tool's name (`runtime.tool()`, and each tool that called `run()`): the log's `tool.<name>` steps are its calls. */
const ephemeralNames = new Set<string>();

function runEphemeral(io: HostToolIO, mode: CallMode, machineOptions: MachineOptions, work: (machine: WorkspaceMachine) => Promise<string>): Promise<string> {
  const key = JSON.stringify(machineOptions);
  let workspaces = turnWorkspaces.get(key);
  if (!workspaces) turnWorkspaces.set(key, (workspaces = new TurnWorkspaces(machineOptions)));
  const state = io.ctx.state();
  const own = io.stepId ? state.effectOrder.find((e) => e.stepId === io.stepId)?.name : undefined;
  if (own?.startsWith('tool.')) ephemeralNames.add(own.slice('tool.'.length));
  const position = turnOf(state, io.stepId);
  const signal = callSignal(io);
  const options = { session: io.ctx.runId, ...(signal ? { signal } : {}) };
  return workspaces.call(io.ctx, position.turn, mode, async (machine, fresh) => {
    // A new drive in a turn whose earlier calls ran in another one: their files are gone.
    const note = fresh && earlierCalls(io.ctx.state(), position, io.stepId, ephemeralNames) ? RESET_NOTE : undefined;
    try {
      const text = await work(machine);
      return note ? `${note}\n\n${text}` : text;
    } catch (err) {
      if (!note) throw err;
      throw Object.assign(new Error(`${note}\n\n${err instanceof Error ? err.message : String(err)}`), err instanceof Error && 'code' in err ? { code: (err as { code: unknown }).code } : {});
    }
  }, options);
}

/** Where a call stands in its turn. */
export interface TurnPosition {
  /** The submission the turn started with (undefined: the log places none). */
  turn: string | undefined;
  /** The index in `effectOrder` of the turn's first step. */
  start: number;
  /** The call's own index (the end of `effectOrder` when it is not there). */
  at: number;
}

/**
 * The turn a step belongs to, as Agent Runs counts turns: the last
 * prompt or follow-up placed at or before it (a steer joins the open turn).
 */
export function turnOf(state: SessionState, stepId?: string): TurnPosition {
  const order = state.effectOrder;
  const found = stepId ? order.findIndex((e) => e.stepId === stepId) : -1;
  const at = found === -1 ? order.length : found;
  const byId = new Map(state.submissions.map((s) => [s.id, s]));
  for (let i = Math.min(at, order.length - 1); i >= 0; i--) {
    const e = order[i]!;
    if (state.superseded.has(e.stepId)) continue;
    for (let j = e.placed.length - 1; j >= 0; j--) {
      const s = byId.get(e.placed[j]!);
      if (!s || s.kind === 'steer' || s.text === undefined) continue;
      const start = order.findIndex((r) => !state.superseded.has(r.stepId) && r.placed.includes(s.id));
      return { turn: s.id, start, at };
    }
  }
  return { turn: undefined, start: 0, at };
}

/** Whether the turn has a workspace call before this one whose result the model saw. */
function earlierCalls(state: SessionState, position: TurnPosition, stepId: string | undefined, names: Set<string>): boolean {
  for (let i = position.start; i < position.at && i < state.effectOrder.length; i++) {
    const e = state.effectOrder[i]!;
    if (e.stepId === stepId || state.superseded.has(e.stepId)) continue;
    if (!e.name.startsWith('tool.') || !names.has(e.name.slice('tool.'.length))) continue;
    if (e.status === 'completed' || e.status === 'failed') return true;
  }
  return false;
}
