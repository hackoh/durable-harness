import type { WorkspaceMachine } from 'harness-world-hands/runtime';

/**
 * Where OpenCode's own tools run: OpenCode's execution-plane seam,
 * `@opencode/Environment` (`{ files, spawner }`), which every built-in
 * (shell, read, write, edit, patch, glob, grep) reaches files and processes
 * through, replaced by a session's workspace (docs/workspaces.md §4.5).
 *
 * - `files`: the workspace's files (`WorkspaceMachine`), so OpenCode's own
 *   tool code reads and writes them unmodified.
 * - `spawner`: commands run on the workspace's shell, never on this
 *   machine: `<shell> -c <script>` runs the script there; ripgrep (OpenCode's
 *   glob and grep) runs the workspace's `rg`, with the flags it lacks
 *   adapted (`rgArgs`); anything else runs as a command of the workspace
 *   (an unknown one exits 127). Each command's environment is built here
 *   from a fixed allowlist (`commandEnv`): what OpenCode passes (this
 *   process's whole environment, spread) is ignored.
 *
 * The workspace a call sees is the one the drive opened for it: the drive
 * runs each built-in call inside the workspace runtime's `run` (one at a
 * time per session), and puts that call's machine in the session's
 * `WorkspaceSlot` for as long as the call runs. Outside a call there is no
 * machine, and the files and the spawner fail.
 *
 * No OpenCode import here: host.ts builds the layers from its modules.
 */

/** OpenCode's own tools a session can have (`builtins`). */
export const OPENCODE_TOOLS = ['shell', 'read', 'write', 'edit', 'patch', 'glob', 'grep'] as const;
export type OpenCodeTool = (typeof OPENCODE_TOOLS)[number];

/** The built-ins that only read: a call never changes the workspace. */
export const OPENCODE_READ_TOOLS: readonly OpenCodeTool[] = ['read', 'glob', 'grep'];

/** The workspace's root: OpenCode's working directory for every session. */
export const WORKSPACE_ROOT = '/workspace';

/** The permission action each built-in asks for (OpenCode's own: write, edit and patch all ask `edit`). */
export const PERMISSION_OF: Record<OpenCodeTool, string> = {
  shell: 'shell',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  patch: 'edit',
  glob: 'glob',
  grep: 'grep',
};

/**
 * The machine of the built-in call that runs now, for OpenCode's
 * Environment: set by the drive for the length of one call.
 */
export class WorkspaceSlot {
  private current: WorkspaceMachine | undefined;

  /** The call's machine; throws outside a call. */
  machine(): WorkspaceMachine {
    if (!this.current) throw Object.assign(new Error('the workspace is reachable only from a tool call'), { code: 'ENOWORKSPACE' });
    return this.current;
  }

  /** Run `work` with `machine` as the call's, then clear it. */
  async with<T>(machine: WorkspaceMachine, work: () => Promise<T>): Promise<T> {
    this.current = machine;
    try {
      return await work();
    } finally {
      if (this.current === machine) this.current = undefined;
    }
  }
}

/**
 * The only variables a command gets: OpenCode's own markers (it sets them
 * for every shell command), fixed values, never this process's. The
 * session id only when it looks like one.
 */
export function commandEnv(requested: Record<string, string | undefined> | undefined): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color', OPENCODE_TERMINAL: '1', AGENT: '1', OPENCODE: '1', AI_AGENT: 'opencode' };
  const session = requested?.OPENCODE_SESSION_ID;
  if (typeof session === 'string' && /^ses_[A-Za-z0-9_-]{1,200}$/.test(session)) env.OPENCODE_SESSION_ID = session;
  return env;
}

/** The variable names a command can see (`commandEnv`'s keys). */
export const COMMAND_ENV_KEYS = ['TERM', 'OPENCODE_TERMINAL', 'AGENT', 'OPENCODE', 'AI_AGENT', 'OPENCODE_SESSION_ID'] as const;

/**
 * OpenCode's ripgrep arguments, for the workspace's `rg`: it has no
 * `--no-config` (there is no config to read) or `--no-messages`, and takes
 * the pattern after `--` as `-e`.
 */
export function rgArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--no-config' || a === '--no-messages') continue;
    if (a === '--') {
      const pattern = args[i + 1];
      if (pattern !== undefined) out.push('-e', pattern);
      out.push(...args.slice(i + 2));
      break;
    }
    out.push(a);
  }
  return out;
}

/** Shells whose `-c <script>` runs as a script on the workspace's shell. */
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** How the spawner runs one command on the workspace. */
export type Invocation =
  | { kind: 'script'; script: string }
  | { kind: 'command'; name: string; args: string[] };

/** What `<command> <args>` becomes on the workspace. */
export function invocationOf(command: string, args: readonly string[]): Invocation {
  const name = command.split(/[\\/]/).pop() ?? command;
  if (SHELLS.has(name) && args[0] === '-c' && typeof args[1] === 'string') return { kind: 'script', script: args[1] };
  if (name === 'rg') return { kind: 'command', name, args: rgArgs(args) };
  return { kind: 'command', name, args: [...args] };
}

/**
 * The edits to OpenCode's own tool definitions the model sees: what does not
 * hold on a workspace (each listed, so a version bump that changes the
 * native text is caught by the boot-and-tools test).
 */
export const DESCRIPTION_EDITS: { tool: OpenCodeTool; from: RegExp; to: string }[] = [
  // ShellSelect names the host's platform and shell; commands run on the workspace's bash.
  { tool: 'shell', from: /Commands run on [^.]+ using [^.]+\./, to: 'Commands run on Linux using bash.' },
  // The full output stays on the machine that drives the session, out of the workspace's reach.
  { tool: 'shell', from: /When output is large, the full result is saved to a file and a truncated preview is returned\./, to: 'When output is large, a truncated preview is returned.' },
  // No background commands: a command ends with its call (the session may move between calls).
  {
    tool: 'shell',
    from: / ?Commands accept an optional timeout, background commands have no timeout by default\. Background commands return immediately, and you will be notified when they complete\./,
    to: ' Commands accept an optional timeout.',
  },
];

/** A tool definition as OpenCode's `context` hook sees it. */
export interface ModelTool {
  description: string;
  input: Record<string, unknown>;
}

/**
 * OpenCode's definition of a built-in, as the model sees it on a workspace:
 * the native description with `DESCRIPTION_EDITS` applied and the
 * workspace's note (`note`: where it runs, how long files last), and
 * shell's `background` parameter removed.
 */
export function workspaceTool(name: OpenCodeTool, tool: ModelTool, note: string): ModelTool {
  let description = tool.description;
  for (const edit of DESCRIPTION_EDITS) if (edit.tool === name) description = description.replace(edit.from, edit.to);
  if (note) description = `${description.trimEnd()} ${note}`;
  let input = tool.input;
  if (name === 'shell') {
    const properties = { ...((input.properties as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    delete properties.background;
    if (properties.timeout?.description)
      properties.timeout = { ...properties.timeout, description: String(properties.timeout.description).replace(/ Background commands have no timeout by default\./, '') };
    input = { ...input, properties, ...(Array.isArray(input.required) ? { required: (input.required as string[]).filter((r) => r !== 'background') } : {}) };
  }
  return { description, input };
}

/** "full output saved to <a path on this machine>" in a result: the path is out of the workspace's reach. */
export const SAVED_OUTPUT = /; full output saved to [^\]\n]+\]/g;
/** The same notice, without the path. */
export const SAVED_OUTPUT_REPLACEMENT = '; the rest is not shown]';
