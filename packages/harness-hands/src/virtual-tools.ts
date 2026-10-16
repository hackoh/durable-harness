import type { HostTool } from 'harness-world';
import { asContent } from './doc-workspace.ts';
import { describeTool, type WorkspaceDescriptor, type WorkspaceRuntime, workspaceRuntime, type WorkspaceRuntimeOptions } from './runtime.ts';
import type { WorkspaceMachine } from './machine.ts';
import { bashResultText, resolvePath, TOOL_SPECS, WORKSPACE_ROOT } from './specs.ts';

/**
 * The harness-neutral workspace tools (`bash`, `read_file`, `write_file`,
 * `edit_file`, `list_files`) on a workspace runtime: on a durable virtual
 * workspace they are the document-backed workspace's tools, as they always
 * were; on an in-memory one, the same tools on a workspace that lasts one
 * turn (their descriptions say so). Their definitions are `TOOL_SPECS`, the
 * native baseline's too.
 */

/** A file's text, or undefined when its bytes are not UTF-8 (a binary file). */
async function textOf(m: WorkspaceMachine, path: string): Promise<{ text?: string; bytes: number }> {
  const bytes = await m.readFile(path);
  const content = asContent(bytes);
  return typeof content === 'string' ? { text: content, bytes: bytes.length } : { bytes: bytes.length };
}

/** A spec's description for this workspace: the bash spec already says where it runs; an in-memory workspace's tools say how long files last. */
const described = (description: string, durable: boolean) => (durable ? description : describeTool(description, 'file', false));

function virtualTools(runtime: WorkspaceRuntime): HostTool[] {
  // The specs say where they run (the bash spec, VIRTUAL_NOTE's facts); an in-memory workspace's add how long files last.
  const spec = <K extends keyof typeof TOOL_SPECS>(name: K) => ({ ...TOOL_SPECS[name], description: described(TOOL_SPECS[name].description, runtime.durable), described: true });
  const tool = runtime.tool;
  const bash = tool<{ command: string }>({
    ...spec('bash'),
    kind: 'shell',
    // Safe to rerun: a command only reaches the workspace, and a retry runs
    // against the workspace the first attempt saw (its edit never landed).
    mode: 'write',
    async run({ command }, m, io) {
      io.progress({ command });
      return bashResultText(await m.exec(command, { signal: io.signal }));
    },
  });
  const readFile = tool<{ path: string }>({
    ...spec('read_file'),
    mode: 'read',
    async run({ path }, m) {
      const target = resolvePath(path);
      // A binary file as text would be U+FFFD in place of its bytes: say what it is instead.
      const { text, bytes } = await textOf(m, target);
      return text ?? `(${target} is a binary file: ${bytes} bytes that are not UTF-8 text. Read it with bash, e.g. base64 or od.)`;
    },
  });
  const writeFile = tool<{ path: string; content: string }>({
    ...spec('write_file'),
    // Writing the same content twice is the same as writing it once.
    mode: 'write',
    async run({ path, content }, m) {
      const target = resolvePath(path);
      // An existing file keeps its mode, as a filesystem's write does.
      await m.writeFile(target, content);
      return `wrote ${content.length} bytes to ${target}`;
    },
  });
  const editFile = tool<{ path: string; oldText: string; newText: string }>({
    ...spec('edit_file'),
    // Safe to rerun for the same reason as bash: a retry edits the file as the
    // log has it, so an edit applied but never reported is not applied twice.
    mode: 'write',
    async run({ path, oldText, newText }, m) {
      const target = resolvePath(path);
      const { text: before } = await textOf(m, target);
      // Edited as text, a binary file would be written back with U+FFFD in place of its bytes.
      if (before === undefined) throw new Error(`${target} is a binary file (its bytes are not UTF-8 text): edit it with bash`);
      const at = before.indexOf(oldText);
      if (at === -1) throw new Error(`oldText not found in ${target}`);
      if (before.indexOf(oldText, at + 1) !== -1) throw new Error(`oldText occurs more than once in ${target}`);
      await m.writeFile(target, before.slice(0, at) + newText + before.slice(at + oldText.length));
      return `edited ${target}`;
    },
  });
  const listFiles = tool<Record<string, never>>({
    ...spec('list_files'),
    mode: 'read',
    async run(_input, m) {
      const files = (await m.walk(WORKSPACE_ROOT)).filter((e) => e.type === 'file').map((e) => e.path);
      return files.length ? files.join('\n') : '(empty workspace)';
    },
  });
  return [bash, readFile, writeFile, editFile, listFiles] as HostTool[];
}

/**
 * With durability off (`rawSessions`: no World, so no blob stream, and a
 * session that lives in memory) the durable tools keep the legacy format,
 * files in in-memory `fs` steps with no size limit, as they always did there.
 */
function orLegacyWhenRaw(tool: HostTool): HostTool {
  return {
    ...tool,
    async execute(input, io) {
      if (io.ctx.world) return tool.execute(input, io);
      const { legacyWorkspaceTools } = await import('./legacy.ts');
      return legacyWorkspaceTools().find((t) => t.name === tool.name)!.execute(input, io);
    },
  };
}

/**
 * bash, read_file, write_file, edit_file and list_files on a virtual
 * workspace (all `replay: 'safe'`): by default the document-backed one, its
 * files in the session's log; with `{ kind: 'virtual', durable: false }`,
 * one in memory that lasts a turn.
 */
export function docWorkspaceTools(workspace: WorkspaceDescriptor = { kind: 'virtual', durable: true }, options: WorkspaceRuntimeOptions = {}): HostTool[] {
  const runtime = workspaceRuntime(workspace, options);
  const tools = virtualTools(runtime);
  return runtime.durable ? tools.map(orLegacyWhenRaw) : tools;
}
