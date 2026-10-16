import { type BlobContent, type DriveContext, type HostTool, readBlobContents, readDoc } from 'harness-world';
import { Bash, InMemoryFs } from 'just-bash';
import { monotonicFactory } from 'ulid';
import { type BlobEntry, type FileChanges, type FsInput, fileChangesOf, hasWorkspaceDoc, inlineContent, manifestEntries, modeOf, WorkspaceDoc } from './files.ts';
import { bashResultText, resolvePath, TOOL_SPECS, VIRTUAL_COMMANDS, WORKSPACE_ROOT } from './specs.ts';
import { type UnsafeToolsOptions, unsafeTools } from './unsafe.ts';

/**
 * The legacy workspace: files in `fs` steps. Each tool call that changes
 * files commits a nested `fs` step holding the changed files' contents,
 * which counts once its owner call has an outcome (files.ts, `ownerStands`).
 * Kept for hybrid sessions, whose sandbox lane applies a parked command's
 * settlement (`settle.files`) to the same fold; everything else uses the
 * document-backed workspace (doc-workspace.ts). It reads a document-backed
 * session's manifest, and refuses to write into one.
 */

const ulid = monotonicFactory();
const workspaces = new WeakMap<DriveContext, Workspace>();

function fsInput(ctx: DriveContext, paths: string[], owner: string | undefined): FsInput {
  if (!owner) return { paths };
  const attempt = ctx.state().effectOrder.find((r) => r.stepId === owner)?.attempt;
  return { paths, of: owner, ...(attempt ? { attempt } : {}) };
}

export class Workspace {
  readonly fs: InMemoryFs;
  readonly bash: Bash;

  private constructor(private readonly ctx: DriveContext) {
    this.fs = new InMemoryFs();
    // defenseInDepth patches process globals while a command runs, which
    // breaks a host serving other requests from the same process.
    this.bash = new Bash({ fs: this.fs, cwd: WORKSPACE_ROOT, commands: [...VIRTUAL_COMMANDS], defenseInDepth: false, executionLimitProfile: 'hardened' });
  }

  /** The workspace for this drive, hydrated from the log on first use. */
  static async for(ctx: DriveContext): Promise<Workspace> {
    let ws = workspaces.get(ctx);
    if (!ws) {
      ws = new Workspace(ctx);
      workspaces.set(ctx, ws);
      await ws.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
      const state = ctx.state();
      if (hasWorkspaceDoc(state)) {
        // A document-backed session: its manifest is the whole truth.
        const entries = manifestEntries(readDoc(state, WorkspaceDoc));
        const blobs = [...entries.values()].some((e) => inlineContent(e) === undefined) ? await readBlobContents(ctx.world, ctx.runId) : new Map<string, BlobContent>();
        for (const [path, e] of entries) {
          const content = inlineContent(e) ?? blobs.get((e as BlobEntry).h);
          if (content === undefined) throw new Error(`harness-world-hands: ${path}'s blob ${(e as BlobEntry).h} is missing from the session's blob stream`);
          await ws.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
          await ws.fs.writeFile(path, content);
          await ws.fs.chmod(path, modeOf(e));
        }
      } else {
        for (const e of state.effectOrder) {
          const files = fileChangesOf(e, state);
          if (files) await ws.apply(files);
        }
      }
    }
    return ws;
  }

  /** Snapshot every file under the workspace root. */
  async snapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const path of this.fs.getAllPaths()) {
      if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue;
      const stat = await this.fs.stat(path).catch(() => undefined);
      if (!stat?.isFile) continue;
      out.set(path, await this.fs.readFile(path));
    }
    return out;
  }

  /**
   * Run `fn`, then commit whatever it changed as one `fs` step. The step
   * nests inside the calling tool's step, so its files are durable before
   * the tool reports a result. `owner` is that tool call's step id: its
   * changes count only once the call has an outcome (see `ownerStands`).
   */
  async mutate<T>(fn: () => Promise<T>, owner?: string): Promise<T> {
    if (hasWorkspaceDoc(this.ctx.state())) {
      throw new Error("harness-world-hands: this session's workspace is document-backed: write it with workspaceTools(), not the legacy fs-step tools");
    }
    const before = await this.snapshot();
    const result = await fn();
    const after = await this.snapshot();
    const files: FileChanges['files'] = {};
    for (const [path, content] of after) {
      if (before.get(path) !== content) files[path] = content;
    }
    for (const path of before.keys()) {
      if (!after.has(path)) files[path] = null;
    }
    if (Object.keys(files).length > 0) {
      await this.ctx.effect(
        `fs:${ulid()}`,
        { name: 'fs', replay: 'safe', input: fsInput(this.ctx, Object.keys(files), owner) },
        async () => ({ files }) satisfies FileChanges
      );
    }
    return result;
  }

  /** Apply changes the log already holds (a settlement committed while this drive runs). */
  async apply(files: FileChanges['files']): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        await this.fs.rm(path, { force: true });
      } else {
        await this.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
        await this.fs.writeFile(path, content);
      }
    }
  }
}

const bash: HostTool<{ command: string }> = {
  ...TOOL_SPECS.bash,
  // Safe to rerun: a command only reaches the workspace, which a retry
  // rebuilds from the log without the interrupted attempt's changes (see
  // `ownerStands`), so the retry runs against exactly what the first saw.
  replay: 'safe',
  async execute({ command }, io) {
    const ws = await Workspace.for(io.ctx);
    io.progress({ command });
    const result = await ws.mutate(() => ws.bash.exec(command, { signal: io.signal }), io.stepId);
    return bashResultText(result);
  },
};

const readFile: HostTool<{ path: string }> = {
  ...TOOL_SPECS.read_file,
  replay: 'safe',
  async execute({ path }, io) {
    const ws = await Workspace.for(io.ctx);
    return ws.fs.readFile(resolvePath(path));
  },
};

const writeFile: HostTool<{ path: string; content: string }> = {
  ...TOOL_SPECS.write_file,
  // Writing the same content twice is the same as writing it once.
  replay: 'safe',
  async execute({ path, content }, io) {
    const ws = await Workspace.for(io.ctx);
    const target = resolvePath(path);
    await ws.mutate(async () => {
      await ws.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await ws.fs.writeFile(target, content);
    }, io.stepId);
    return `wrote ${content.length} bytes to ${target}`;
  },
};

const editFile: HostTool<{ path: string; oldText: string; newText: string }> = {
  ...TOOL_SPECS.edit_file,
  // Safe to rerun for the same reason as bash: a retry edits the file as the
  // log has it, so an edit applied but never reported is not applied twice.
  replay: 'safe',
  async execute({ path, oldText, newText }, io) {
    const ws = await Workspace.for(io.ctx);
    const target = resolvePath(path);
    const before = await ws.fs.readFile(target);
    const at = before.indexOf(oldText);
    if (at === -1) throw new Error(`oldText not found in ${target}`);
    if (before.indexOf(oldText, at + 1) !== -1) throw new Error(`oldText occurs more than once in ${target}`);
    await ws.mutate(() => ws.fs.writeFile(target, before.slice(0, at) + newText + before.slice(at + oldText.length)), io.stepId);
    return `edited ${target}`;
  },
};

const listFiles: HostTool<Record<string, never>> = {
  ...TOOL_SPECS.list_files,
  replay: 'safe',
  async execute(_input, io) {
    const ws = await Workspace.for(io.ctx);
    const files = [...(await ws.snapshot()).keys()].sort();
    return files.length ? files.join('\n') : '(empty workspace)';
  },
};

/**
 * The legacy workspace tools (files in `fs` steps), for hybrid sessions:
 * bash, read_file, write_file, edit_file, list_files (all `replay: 'safe'`),
 * plus the two non-idempotent example tools (`replay: 'never'`, unsafe.ts).
 */
export function legacyWorkspaceTools(options: UnsafeToolsOptions = {}): HostTool[] {
  return [bash, readFile, writeFile, editFile, listFiles, ...unsafeTools(options)];
}
