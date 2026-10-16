import type { Context } from '@earendil-works/chord';
import { withContextValue, withoutAbortSignal } from '@earendil-works/chord/context';
import {
  defineDoc,
  defineExtension,
  type DocumentReader,
  type EnvTarget,
  type Extension,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { CodingTools as PiCodingTools } from '@earendil-works/pi-durable/tools';
import { type BlobContent, base64ToBytes, bytesToBase64, readBlobContents, sha256Hex, writeBlob } from 'harness-world';
import { asContent, type CallMode, createMachine, type FileBytes, type MachineOptions, TurnWorkspaces, type VirtualMachine, type WorkspaceMachine } from 'harness-world-hands/runtime';
import { type FileEntry, INLINE_FILE_MAX_BYTES, isWorkspacePath, WORKSPACE_ROOT } from 'harness-world-hands/tools';
import { MachineEnv } from './env.ts';
import { type WorkspaceDelta, withDelta } from './files.ts';
import { STORAGE_PROBE, type WorldStorage } from './storage.ts';

/**
 * A virtual workspace for pi-durable (durable-harness's `virtualEnv()`):
 * Pi's own tools (`CodingTools`) on a just-bash machine in a worker leased to
 * the session, never on the Function's disk, processes or environment.
 *
 * pi-durable builds an environment for every tool call
 * (`HarnessOptions.env(target, context)`), and its `EnvTarget` names the
 * conversation, not the call: an environment cannot tell which call it
 * serves, and a storage cannot tell which call a commit settles (the Session
 * hands it a context derived from the call's, whose one per-call value, the
 * abort signal, it replaces). So the tools themselves bind each call: the
 * `CodingTools` here are pi-durable's own (the same names, schemas,
 * descriptions and code), each wrapped so that the call runs on a view of the
 * workspace of its own:
 *
 * - durable (`virtual()`): the call runs on the files as committed; what it
 *   changed goes into its result's `details` (`hw.workspace`, files.ts),
 *   which lands in the same commit as the result, and the machine goes back
 *   to the committed files. Parallel calls each commit their own changes; a
 *   call a crash cut off never wrote its result, so it changed nothing. A
 *   call the machine cut off (past its time limit, its worker gone) changes
 *   nothing either and fails, saying so. Outside these tools (pi-durable's
 *   own `CodingTools`, a tool of the app's) the workspace is read-only, and a
 *   write says which import to use.
 * - in memory (`virtual({ durable: false })`): the same tools on an
 *   in-memory workspace for the turn (the root conversation's run), cleared
 *   when the next run starts or the session moves to another invocation; the
 *   first result of each turn tells the model so (`MEMORY_NOTE`), and, when
 *   the turn moved, that its earlier files are gone (`MOVED_NOTE`).
 *
 * The session is the Harness's World storage (`STORAGE_PROBE`): a durable
 * workspace needs one; an in-memory one uses it when there is one.
 */

/** What the first tool result of each turn says on an in-memory workspace. */
export const MEMORY_NOTE = 'Files are in memory only. They are cleared at the end of every turn and may be cleared sooner if the session moves to another machine.';
/** What it adds when the turn moved to another invocation after earlier calls of it. */
export const MOVED_NOTE = 'The in-memory workspace was cleared because the session moved; files written earlier this turn are gone.';

/** The import a write outside the wrapped tools names. */
export const CODING_TOOLS_IMPORT = "import { CodingTools } from 'durable-harness/pi-durable'";

const READ_ONLY = `this workspace commits each tool call's file changes with its result, through durable-harness's CodingTools: install them instead of @earendil-works/pi-durable/tools' (${CODING_TOOLS_IMPORT}). Outside them it is read-only`;

/** A durable workspace needs the session's World: without a World storage under the Harness, this is what a call says. */
export const NO_WORLD =
  "durable-harness: a durable virtual workspace keeps its files in the session's World, and this Harness's storage is not a World storage: open it on openWorldStorage() from durable-harness/pi-durable, or use virtualEnv(virtual({ durable: false }))";

/** Inline content of one call's changes past this many bytes goes to the blob stream, so its result stays a size the log takes. */
const DELTA_INLINE_BUDGET = 32 * 1024;
const DEFAULT_MODE = 0o644;

/** How `virtualEnv()` runs its workspace. */
export interface VirtualEnvConfig {
  /** Each call's changes commit with its result (true), or the files are in memory for the turn (false). */
  durable: boolean;
  /** The machine's limits and where its shell runs. */
  machine: MachineOptions;
}

/** `HarnessOptions.env`'s type. */
export type EnvBuilder = (target: EnvTarget, context: Context) => Promise<ExecutionEnv>;

// ---------------------------------------------------------------------------
// The session

/** Read by nobody's tools and written by nothing: a read of it reaches the storage on every call. */
const PROBE_DOC = defineDoc<Record<string, never>>({ kind: 'durable-harness.storage-probe', version: 1, scope: 'session', initial: () => ({}) });

const sessions = new WeakMap<object, WorldStorage>();

/** The World storage under the Harness `read` is (an `EnvTarget.read`), or undefined when it is another storage. */
export async function storageOf(read: DocumentReader, context: Context): Promise<WorldStorage | undefined> {
  const known = sessions.get(read);
  if (known) return known;
  let found: WorldStorage | undefined;
  const probe = withContextValue(STORAGE_PROBE, (storage: WorldStorage) => (found ??= storage), withoutAbortSignal(context));
  await read.snapshot(PROBE_DOC, probe).catch(() => undefined);
  if (found) sessions.set(read, found);
  return found;
}

/** The working directory for a conversation's agent `cwd`: under `/workspace`, else the root. */
export function cwdOf(cwd: string | undefined): string {
  return cwd && (cwd === WORKSPACE_ROOT || isWorkspacePath(cwd.replace(/\/+$/, ''))) ? cwd.replace(/\/+$/, '') : WORKSPACE_ROOT;
}

/** The turn an in-memory workspace lasts: the root conversation's run, by the submission that started it. */
async function turnOf(read: DocumentReader, context: Context): Promise<string | undefined> {
  const live = await read.snapshot(LiveDoc, ROOT_CONVERSATION_ID, withoutAbortSignal(context)).catch(() => undefined);
  const first = (live as { run?: { inputs?: unknown[] } } | undefined)?.run?.inputs?.[0];
  return first === undefined ? undefined : String(first);
}

// ---------------------------------------------------------------------------
// A call's binding

const BINDING = Symbol.for('pi-world.workspace-binding');

/** What a wrapped tool's call ran to: its outcome, the changes it made (durable), the notes for the model and what its result's `details` add. */
export interface Ran<T> {
  outcome: { ok: true; value: T } | { ok: false; error: unknown };
  delta?: WorkspaceDelta;
  notes?: ToolDiagnostic[];
  /** Keys the result's `details` carry besides the tool's own (the sandbox's `hw.sandbox`). */
  details?: Record<string, unknown>;
}

/** How an environment's operations reach the machine: the call's own view while a wrapped tool runs, else `bare`. */
export abstract class Binding {
  protected bound: { machine: WorkspaceMachine; mode: CallMode } | undefined;
  protected cutoff: Error | undefined;

  /** Run a wrapped tool's call (`inner`) on a view of the workspace of its own (`read`: one that changes nothing). */
  abstract run<T>(inner: () => Promise<T>, signal: AbortSignal | undefined, mode: CallMode): Promise<Ran<T>>;
  /** An operation outside a wrapped tool's call. */
  protected abstract bare<T>(mode: CallMode, work: (m: WorkspaceMachine) => Promise<T>): Promise<T>;

  readonly access = {
    use: <T>(mode: CallMode, work: (m: WorkspaceMachine) => Promise<T>): Promise<T> => {
      const bound = this.bound;
      if (!bound) return this.bare(mode, work);
      if (mode === 'write' && bound.mode === 'read') return Promise.reject(Object.assign(new Error('durable-harness: this call only reads the workspace'), { code: 'EACCES' }));
      return work(bound.machine);
    },
  };

  /** The call's operation the machine cut off, if any. */
  cutOff(error: Error): void {
    this.cutoff ??= error;
  }

  /** Run `inner` with the operations on `machine`: a tool error is its outcome; a cut-off (or a cancelled call) throws. */
  protected async on<T>(machine: WorkspaceMachine, mode: CallMode, inner: () => Promise<T>, signal: AbortSignal | undefined): Promise<Ran<T>['outcome']> {
    this.bound = { machine, mode };
    this.cutoff = undefined;
    try {
      return { ok: true, value: await inner() };
    } catch (error) {
      if (this.cutoff || signal?.aborted || machine.lost) throw error;
      return { ok: false, error };
    } finally {
      this.bound = undefined;
    }
  }
}

function readOnly(): Error {
  return Object.assign(new Error(`durable-harness: ${READ_ONLY}`), { code: 'EACCES' });
}

class DurableBinding extends Binding {
  constructor(private readonly files: DurableFiles) {
    super();
  }

  async run<T>(inner: () => Promise<T>, signal: AbortSignal | undefined, mode: CallMode): Promise<Ran<T>> {
    const { value, delta } = await this.files.call(signal, mode, (m) => this.on(m, mode, inner, signal));
    return { outcome: value, ...(delta ? { delta } : {}) };
  }

  protected bare<T>(mode: CallMode, work: (m: WorkspaceMachine) => Promise<T>): Promise<T> {
    if (mode === 'write') return Promise.reject(readOnly());
    return this.files.read(work);
  }
}

class MemoryBinding extends Binding {
  constructor(
    private readonly workspaces: TurnWorkspaces,
    private readonly scope: object,
    private readonly turn: string | undefined,
    private readonly session: unknown,
    private readonly storage: WorldStorage | undefined
  ) {
    super();
  }

  async run<T>(inner: () => Promise<T>, signal: AbortSignal | undefined, mode: CallMode): Promise<Ran<T>> {
    const options = { session: this.session, ...(signal ? { signal } : {}) };
    return this.workspaces.call(
      this.scope,
      this.turn,
      mode,
      async (machine, fresh) => {
        // The first call of the turn here: the model hears where its files are, and whether the turn's earlier ones are gone.
        const moved = fresh && this.turn !== undefined && this.storage?.files.turns.has(this.turn);
        const notes: ToolDiagnostic[] = fresh ? [...(moved ? [{ severity: 'warn' as const, code: 'workspace_moved', message: MOVED_NOTE }] : []), { severity: 'info', code: 'workspace', message: MEMORY_NOTE }] : [];
        const outcome = await this.on(machine, mode, inner, signal);
        return { outcome, notes, ...(fresh && this.turn !== undefined ? { delta: { turn: this.turn } } : {}) };
      },
      options
    );
  }

  protected bare<T>(mode: CallMode, work: (m: WorkspaceMachine) => Promise<T>): Promise<T> {
    if (mode === 'write') return Promise.reject(readOnly());
    return this.workspaces.call(this.scope, this.turn, 'read', (m) => work(m), { session: this.session });
  }
}

/** An environment of `virtualEnv()`'s, with the binding its wrapped tools use. */
function bindingOf(env: ExecutionEnv | undefined): Binding | undefined {
  return (env as { [BINDING]?: Binding } | undefined)?.[BINDING];
}

export function envOn(id: string, cwd: string, binding: Binding, options: { transactional?: boolean } = {}): ExecutionEnv {
  const env = new MachineEnv({ id, cwd, access: binding.access, onCutOff: (error) => binding.cutOff(error), ...options });
  Object.defineProperty(env, BINDING, { value: binding });
  return env;
}

// ---------------------------------------------------------------------------
// virtualEnv()

const durableFiles = new WeakMap<WorldStorage, Map<string, DurableFiles>>();
const memoryWorkspaces = new Map<string, TurnWorkspaces>();
const memoryIds = new WeakMap<object, string>();
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** `HarnessOptions.env` for a virtual workspace (see the module comment). */
export function virtualEnvBuilder(config: VirtualEnvConfig): EnvBuilder {
  const key = JSON.stringify(config.machine);
  return async (target, context) => {
    const storage = await storageOf(target.read, context);
    const cwd = cwdOf(target.cwd);
    if (config.durable) {
      if (!storage) throw new Error(NO_WORLD);
      let byKey = durableFiles.get(storage);
      if (!byKey) durableFiles.set(storage, (byKey = new Map()));
      let files = byKey.get(key);
      if (!files) byKey.set(key, (files = new DurableFiles(storage, config.machine)));
      return envOn(`virtual:${storage.sessionId}`, cwd, new DurableBinding(files));
    }
    let workspaces = memoryWorkspaces.get(key);
    if (!workspaces) memoryWorkspaces.set(key, (workspaces = new TurnWorkspaces(config.machine)));
    // One workspace per open Harness (an invocation of the session) and turn: a new invocation starts empty.
    const scope = target.read;
    let id = memoryIds.get(scope);
    if (!id) memoryIds.set(scope, (id = `virtual:${storage?.sessionId ?? newId()}:memory:${newId().slice(0, 8)}`));
    const turn = await turnOf(target.read, context);
    return envOn(id, cwd, new MemoryBinding(workspaces, scope, turn, storage?.sessionId ?? scope, storage));
  };
}

// ---------------------------------------------------------------------------
// The tools

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether this process is a Vercel Function. */
function onFunction(): boolean {
  return !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VERCEL;
}

/** pi-durable's `NodeExecutionEnv`'s id: the real disk and processes of the machine it runs on. */
export const NODE_ENV_ID = 'node:local';

/** What a tool says to a `NodeExecutionEnv` on a Function. */
export const HOST_ENV_REFUSED =
  "durable-harness: NodeExecutionEnv runs the model's commands and files on this Function's own disk and processes, with its environment, where every session on the instance can reach them: use env: virtualEnv() or env: sandboxEnv() from durable-harness/pi-durable";

/**
 * A pi-durable tool that runs each call on a view of the virtual workspace
 * of its own (see the module comment): the same tool for the model (name,
 * schema, description), its changes committed with its result. On an
 * environment that is not `virtualEnv()`'s, the tool runs as it is, except
 * on a `NodeExecutionEnv` in a Vercel Function, which it refuses.
 */
export function bindTool<T extends ToolRegistration>(tool: T, mode: CallMode = tool.name === 'read' ? 'read' : 'write'): T {
  const execute = async (args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    const binding = bindingOf(api.env);
    if (!binding) {
      if (api.env?.id === NODE_ENV_ID && onFunction()) throw new Error(HOST_ENV_REFUSED);
      return tool.execute(args as never, api as never, context);
    }
    // Details the tool reports along the way are its result's details when it returns none: keep them under the changes.
    let reported: unknown;
    const inner: ToolExecutionApi = {
      ...api,
      details: (value, detailsContext) => {
        reported = value;
        return api.details(value, detailsContext);
      },
    };
    // Cut off (a cancelled invocation, a machine past its limit): nothing changed; the error is the call's outcome.
    const ran = await binding.run(() => tool.execute(args as never, inner as never, context), context.abortSignal, mode);
    for (const note of ran.notes ?? []) api.diagnostic(note);
    const extra = (details: unknown) => {
      const withChanges = ran.delta ? withDelta(details, ran.delta) : details;
      if (!ran.details) return withChanges;
      const base = withChanges === undefined ? {} : typeof withChanges === 'object' && withChanges !== null && !Array.isArray(withChanges) ? withChanges : { value: withChanges };
      return { ...base, ...ran.details };
    };
    if (ran.outcome.ok) {
      const value = ran.outcome.value as ToolExecutionResult;
      if (!ran.delta && !ran.details) return value;
      return { ...value, details: extra(value.details !== undefined ? value.details : reported) as never };
    }
    // A tool error (a command that exited nonzero, an edit that did not match): its changes stand, as on a disk.
    if (!ran.delta && !ran.details) throw ran.outcome.error;
    return {
      isError: true,
      details: extra(reported) as never,
      diagnostics: [{ severity: 'error', code: 'tool_error', message: errorText(ran.outcome.error) }],
    };
  };
  return { ...tool, execute } as T;
}

/**
 * pi-durable's `CodingTools` (read, write, edit, bash: its own names,
 * schemas, descriptions and code), each call bound to the virtual workspace
 * (`bindTool`). Install it instead of `@earendil-works/pi-durable/tools`'
 * with `virtualEnv()`.
 */
export const CodingTools: Extension = defineExtension({ name: PiCodingTools.name, tools: (PiCodingTools.tools ?? []).map((tool) => bindTool(tool)) });

// ---------------------------------------------------------------------------
// The durable workspace of one session in this process

/** An entry's mode. */
const modeOf = (e: FileEntry): number => (typeof e === 'string' ? DEFAULT_MODE : (e.m ?? DEFAULT_MODE));
/** What a machine holds for an entry: its content (text, base64 or blob hash) and mode. */
const keyOf = (e: FileEntry): string =>
  `${modeOf(e)}:${typeof e === 'string' ? `t${e}` : 'h' in e ? `h${e.h}` : 'd' in e ? `d${e.d}` : `t${e.t}`}`;
const utf8 = new TextEncoder();
/** How large a file is inline: its text as a JSON string, or its base64. */
const inlineSize = (c: BlobContent) => (typeof c === 'string' ? utf8.encode(JSON.stringify(c)).length - 2 : Math.ceil(c.length / 3) * 4);

function inlineEntry(content: BlobContent, mode: number): FileEntry {
  const m = mode !== DEFAULT_MODE ? { m: mode } : {};
  if (typeof content !== 'string') return { d: bytesToBase64(content), ...m };
  return mode === DEFAULT_MODE ? content : { t: content, m: mode };
}

const gone = () => Object.assign(new Error("this workspace's files are gone: the shell it ran in was restarted while the call ran, so nothing it changed was kept"), { code: 'EGONE' });

/**
 * A session's durable workspace in this process: a machine kept equal to
 * the committed files (`WorldStorage.files`), one call at a time. A call runs
 * on a checkpoint of them; its changes come back as a delta (large files
 * written to the session's blob stream first), and the machine goes back to
 * the checkpoint, so it never holds what the log does not: the delta is the
 * session's once its result commits, and the next call syncs it in.
 */
class DurableFiles {
  private machine: VirtualMachine | undefined;
  /** What the machine holds, path to `keyOf` the entry it was synced from. */
  private readonly held = new Map<string, string>();
  private readonly blobs = new Map<string, BlobContent>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: WorldStorage,
    private readonly options: MachineOptions
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private drop(): void {
    this.machine?.dispose();
    this.machine = undefined;
    this.held.clear();
  }

  /** The machine, holding the committed files. */
  private async synced(signal?: AbortSignal): Promise<VirtualMachine> {
    let m = this.machine;
    if (!m || m.lost) {
      this.drop();
      m = this.machine = await createMachine({ ...this.options, session: this.storage.sessionId, ...(signal ? { signal } : {}) });
    }
    const want = this.storage.files.entries;
    const removes = [...this.held.keys()].filter((p) => !want.has(p));
    const changed = [...want].filter(([p, e]) => this.held.get(p) !== keyOf(e));
    const missing = changed.filter(([, e]) => typeof e !== 'string' && 'h' in e && !this.blobs.has(e.h));
    if (missing.length) for (const [h, c] of await readBlobContents(this.storage.world, this.storage.sessionId)) this.blobs.set(h, c);
    const writes: FileBytes[] = [];
    for (const [path, e] of changed) {
      let content: BlobContent | undefined;
      if (typeof e === 'string') content = e;
      else if ('h' in e) content = this.blobs.get(e.h);
      else content = 'd' in e ? base64ToBytes(e.d) : e.t;
      if (content === undefined) throw new Error(`pi-world: ${path}'s blob ${(e as { h: string }).h} is missing from the session's blob stream`);
      writes.push([path, typeof content === 'string' ? utf8.encode(content) : content, modeOf(e)]);
    }
    try {
      await m.apply(writes, removes);
    } catch (error) {
      this.drop();
      throw error;
    }
    for (const p of removes) this.held.delete(p);
    for (const [p, e] of changed) this.held.set(p, keyOf(e));
    return m;
  }

  /** A read outside a call, on the committed files. */
  read<T>(work: (m: WorkspaceMachine) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const m = await this.synced();
      return m.hold(() => work(m));
    });
  }

  /** One call on a checkpoint of the committed files: its value, and what it changed. Throws (changing nothing) when `run` throws. */
  call<T>(signal: AbortSignal | undefined, mode: CallMode, run: (m: WorkspaceMachine) => Promise<T>): Promise<{ value: T; delta?: WorkspaceDelta }> {
    return this.exclusive(async () => {
      const m = await this.synced(signal);
      return m.hold(async () => {
        if (mode === 'read') return { value: await run(m.during(signal)) };
        await m.checkpoint();
        let value: T;
        try {
          value = await run(m.during(signal));
        } catch (error) {
          await this.restore(m);
          throw error;
        }
        if (m.lost) {
          this.drop();
          throw gone();
        }
        let delta: WorkspaceDelta | undefined;
        try {
          delta = await this.encode(await m.diff({ unlink: true }));
        } finally {
          await this.restore(m);
        }
        return { value, ...(delta ? { delta } : {}) };
      });
    });
  }

  /** Back to the checkpoint (the committed files), or a new machine next time. */
  private async restore(m: VirtualMachine): Promise<void> {
    if (m.lost) return this.drop();
    try {
      await m.rollback();
      await m.release();
    } catch {
      this.drop();
    }
  }

  /** A call's changes as `hw.workspace` entries: small files inline, the rest in the blob stream (written now, before the result names them). */
  private async encode(diff: [string, Uint8Array | null, number][]): Promise<WorkspaceDelta | undefined> {
    const files: Record<string, FileEntry | null> = {};
    let inline = 0;
    for (const [path, bytes, mode] of diff) {
      if (!isWorkspacePath(path)) continue;
      if (!bytes) {
        files[path] = null;
        continue;
      }
      const content = asContent(bytes);
      const size = inlineSize(content);
      if (size <= INLINE_FILE_MAX_BYTES && inline + size <= DELTA_INLINE_BUDGET) {
        inline += size;
        files[path] = inlineEntry(content, mode);
        continue;
      }
      const h = await sha256Hex(content);
      if (!this.blobs.has(h)) {
        await writeBlob(this.storage.world, this.storage.sessionId, content, { hash: h });
        this.blobs.set(h, content);
      }
      files[path] = { n: bytes.length, h, ...(typeof content !== 'string' ? { b: 1 as const } : {}), ...(mode !== DEFAULT_MODE ? { m: mode } : {}) };
    }
    return Object.keys(files).length ? { files } : undefined;
  }
}
