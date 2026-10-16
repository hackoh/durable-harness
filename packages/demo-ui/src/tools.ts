/**
 * What a tool call did, in words: the transcript's tool rows show this
 * instead of the call's raw arguments (those stay in the event log and
 * behind "Show Raw"). One shape per family of tools, whatever each harness
 * calls them: Pi's and fx's `bash` / `write_file`, Claude Code's `Bash` /
 * `Write`, Codex's `shell`, OpenCode's `bash` / `write`.
 */

export type ToolKind = 'command' | 'write' | 'read' | 'edit' | 'doc' | 'other';

export interface ToolSummary {
  kind: ToolKind;
  /** The command, or the sentence ("Wrote notes.md (77 bytes)"). */
  text: string;
  /** The file it touched, relative to the session's workspace. */
  path?: string;
  /** A document tool that reads (`read_todos`): its row shows what it read. */
  reads?: boolean;
}

const COMMAND = new Set(['bash', 'shell', 'exec_command', 'run_on_machine', 'sandbox_exec', 'run_command']);
const WRITE = new Set(['write_file', 'write', 'create_file']);
const READ = new Set(['read_file', 'read', 'view']);
const EDIT = new Set(['edit_file', 'edit', 'str_replace', 'multiedit', 'apply_patch']);

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * A path as the session sees it: anything up to and including a
 * `workspace/` directory goes (the server's own path to the session's
 * workspace, or the sandbox's `/workspace`).
 */
export function workspacePath(path: string, cwd?: string): string {
  let p = path;
  if (cwd && p.startsWith(`${cwd.replace(/\/$/, '')}/`)) p = p.slice(cwd.replace(/\/$/, '').length + 1);
  const at = p.lastIndexOf('/workspace/');
  if (at >= 0) p = p.slice(at + '/workspace/'.length);
  else if (p.startsWith('workspace/')) p = p.slice('workspace/'.length);
  return p || '.';
}

/** A command as it was typed: Codex wraps each in `/bin/bash -lc '…'`. */
export function unwrapCommand(command: string): string {
  const m = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (m ? m[2]! : command).replace(/'\\''/g, "'");
}

/** Strip workspace prefixes from any absolute path inside a command or message. */
export const relativizePaths = (text: string) => text.replace(/(?:\/[\w.@+-]+)*\/workspace\//g, '');

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function toolSummary(name: string, input: unknown): ToolSummary {
  const n = name.toLowerCase();
  const args = (input ?? {}) as Record<string, unknown>;
  const cwd = str(args.cwd) ?? str(args.workdir);
  const pathArg = str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? str(args.filename);
  const path = pathArg ? workspacePath(pathArg, cwd) : undefined;
  if (COMMAND.has(n)) {
    // fx's shell nests its command in `request` ({ action: 'run', command }).
    const request = (args.request ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(args.command) ? args.command.map(String).join(' ') : (str(args.command) ?? str(args.cmd) ?? str(request.command) ?? '');
    return { kind: 'command', text: relativizePaths(unwrapCommand(raw)) };
  }
  if (WRITE.has(n) && path) {
    const content = str(args.content) ?? str(args.text) ?? '';
    return { kind: 'write', text: `Wrote ${path} (${bytes(content)} bytes)`, path };
  }
  if (READ.has(n) && path) return { kind: 'read', text: `Read ${path}`, path };
  if (EDIT.has(n) && path) return { kind: 'edit', text: `Edited ${path}`, path };
  // A document's tools (harness-world-hands docTools): read_<name>, update_<name>.
  const doc = /^(read|update)_([a-z]\w*)$/.exec(n);
  if (doc && !path) {
    const what = doc[2]!.replace(/_/g, ' ');
    if (doc[1] === 'read') return { kind: 'doc', text: `Read ${what}`, reads: true };
    const items = itemsOf(args.value);
    return { kind: 'doc', text: items ? `Set ${what}: ${items.length ? items.join(', ') : '(empty)'}` : `Updated ${what}` };
  }
  return { kind: 'other', text: compactArgs(args) };
}

/** A list document's items (`{ items: string[] }`, or that as JSON text). */
function itemsOf(value: unknown): string[] | undefined {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  const items = (v as { items?: unknown } | null)?.items;
  return Array.isArray(items) && items.every((i) => typeof i === 'string') ? (items as string[]) : undefined;
}

/** What a document read returned (`{ revision, value }`): a list's items one per line, else the JSON as it came. */
export function docText(out: string): string {
  try {
    const parsed = JSON.parse(out) as { value?: unknown };
    const items = itemsOf(parsed?.value);
    if (items) return items.length ? items.join('\n') : '(empty)';
  } catch {}
  return out;
}

/** Other tools: their arguments, short (`to: alice@example.com, amount_usd: 5`). */
export function compactArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || k === 'description') continue;
    const s = typeof v === 'string' ? relativizePaths(v) : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 80 ? `${s.slice(0, 79)}…` : s}`);
  }
  return parts.join(', ');
}

/** A shell tool's exit code, out of its result or its error ("exit code 127", "exit code: 1"). */
export function exitCode(text: string | undefined): number | undefined {
  const m = /exit(?:ed)?(?: with)? code:?\s*(-?\d+)/i.exec(text ?? '');
  return m ? Number(m[1]) : undefined;
}

/** What a tool row shows of its result: a command's output and a file it read; a write's or an edit's echo is noise. */
export const showsOutput = (kind: ToolKind) => kind === 'command' || kind === 'read' || kind === 'other';
