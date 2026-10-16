import { Bash, InMemoryFs } from 'just-bash';
import { bashResultText, resolvePath, TOOL_SPECS, UNSAFE_CONFIRM_MS, type UnsafeToolName, unsafeResultText, VIRTUAL_COMMANDS, WORKSPACE_ROOT } from './specs.ts';

/**
 * The plain workspace and its tools, with nothing recorded: just-bash on an
 * in-memory filesystem. The native baseline (`./native`) runs Pi and fx on
 * these, and the eve agent (`apps/demo/agent/tools`) runs eve on the same
 * ones, so every lane sends the model the same tool definitions and runs the
 * same tool code. Only just-bash and the specs: no harness, no World.
 */

/** A plain workspace: just-bash on an in-memory filesystem, nothing recorded. */
export class NativeWorkspace {
  readonly fs = new InMemoryFs();
  readonly bash = new Bash({ fs: this.fs, cwd: WORKSPACE_ROOT, commands: [...VIRTUAL_COMMANDS], defenseInDepth: false, executionLimitProfile: 'hardened' });

  static async from(files: Record<string, string> = {}): Promise<NativeWorkspace> {
    const ws = new NativeWorkspace();
    await ws.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await ws.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
      await ws.fs.writeFile(path, content);
    }
    return ws;
  }

  async files(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const path of this.fs.getAllPaths()) {
      if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue;
      const stat = await this.fs.stat(path).catch(() => undefined);
      if (stat?.isFile) out[path] = await this.fs.readFile(path);
    }
    return out;
  }
}

/** The workspace tools, harness-neutral: `execute` returns the text the model sees. */
export interface NativeTool {
  name: string;
  label: string;
  description: string;
  inputSchema: object;
  execute(input: any, signal?: AbortSignal): Promise<string>;
}

export function nativeTools(ws: NativeWorkspace): NativeTool[] {
  return [
    {
      ...TOOL_SPECS.bash,
      execute: async ({ command }, signal) => bashResultText(await ws.bash.exec(command, signal ? { signal } : {})),
    },
    { ...TOOL_SPECS.read_file, execute: async ({ path }) => ws.fs.readFile(resolvePath(path)) },
    {
      ...TOOL_SPECS.write_file,
      execute: async ({ path, content }) => {
        const target = resolvePath(path);
        await ws.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
        await ws.fs.writeFile(target, content);
        return `wrote ${content.length} bytes to ${target}`;
      },
    },
    {
      ...TOOL_SPECS.edit_file,
      execute: async ({ path, oldText, newText }) => {
        const target = resolvePath(path);
        const before = await ws.fs.readFile(target);
        const at = before.indexOf(oldText);
        if (at === -1) throw new Error(`oldText not found in ${target}`);
        if (before.indexOf(oldText, at + 1) !== -1) throw new Error(`oldText occurs more than once in ${target}`);
        await ws.fs.writeFile(target, before.slice(0, at) + newText + before.slice(at + oldText.length));
        return `edited ${target}`;
      },
    },
    {
      ...TOOL_SPECS.list_files,
      execute: async () => {
        const files = Object.keys(await ws.files()).sort();
        return files.length ? files.join('\n') : '(empty workspace)';
      },
    },
    ...(['unsafe_send_email', 'unsafe_make_payment'] as const).map((name) => nativeUnsafe(name)),
  ];
}

/**
 * The unsafe example tools, native: same spec and the same confirmation
 * wait, so a comparison stays fair. Nothing is durable here, so there is
 * no ledger: a crash simply loses the session.
 */
function nativeUnsafe(name: UnsafeToolName): NativeTool {
  return {
    ...TOOL_SPECS[name],
    execute: async (input, signal) => {
      const ref = `${name === 'unsafe_send_email' ? 'msg' : 'pay'}_${Math.random().toString(36).slice(2, 12)}`;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, UNSAFE_CONFIRM_MS);
        signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()));
      });
      return unsafeResultText(name, input, ref);
    },
  };
}
