import type { HostTool } from 'harness-world';
import { Type } from 'typebox';
import type { WorkspaceMachine } from './machine.ts';
import type { WorkspaceRuntime, WorkspaceToolDef } from './runtime.ts';

/**
 * Pi's coding tools on a workspace: `read`, `bash`, `edit` and `write`, as
 * pi-coding-agent's `createCodingTools(cwd)` makes them, with their names,
 * labels, input schemas and descriptions, their 2000-line / 50 KB
 * truncation and their result texts, written on a `WorkspaceMachine`
 * instead of the disk and the processes of the machine that runs them.
 *
 * pi-coding-agent's own tools are never used: its `bash` spawns a real shell
 * with this process's environment and saves output to the host's temp
 * directory, its `read` and `edit` take host paths. What is copied from it
 * (the definitions, the truncation and the edit matching below) is from
 * `@earendil-works/pi-coding-agent` 1.0.4 (MIT), `dist/core/tools`:
 * `read.js`, `bash.js`, `edit.js`, `edit-diff.js`, `write.js`,
 * `truncate.js`. A test pins the definitions against that version
 * (test/fixtures/pi-coding-agent-1.0.4.json).
 *
 * Where these differ from pi-coding-agent, on purpose:
 *
 * - `read` reads text files only, so its description is Pi's text-file one
 *   (pi-durable's): an image is an error result saying so.
 * - `bash` gets the runtime's note on where it runs (a virtual workspace, not
 *   real Linux; or the session's sandbox VM); an in-memory workspace's tools
 *   say how long files last.
 *   stdout and stderr come back one after the other, not interleaved. A
 *   truncated output's full text is saved in the workspace's `/tmp` (only
 *   the latest), which is not part of the session's files.
 * - A command that exits nonzero, or runs past the `timeout` it was given,
 *   is an error result for Pi (`isErrorResult`) but a call that succeeded:
 *   the files it changed stay, as they would on a disk.
 * - `edit` refuses a file that is not UTF-8 text (pi-coding-agent would
 *   write it back with U+FFFD in place of its bytes).
 * - `~` is the workspace root, as `HOME` is for the commands.
 */

/** pi-coding-agent's limits: whichever is hit first. */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

/**
 * A HostTool these functions make, with two optional extras the Pi adapter
 * (harness-world-pi) uses: `prepareArguments` (pi-agent-core's, run before
 * the arguments are validated: Pi's `edit` takes `edits` as a JSON string or
 * a single edit too, as models send it), and `isErrorResult` (the call
 * succeeded, its changes are kept, but the model sees an error result).
 */
export interface PiCodingTool<Input = any> extends HostTool<Input> {
  prepareArguments?: (args: unknown) => unknown;
  isErrorResult?: (text: string) => boolean;
}

// ---------------------------------------------------------------------------
// The definitions (pi-coding-agent 1.0.4)

const readSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
  offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

const bashSchema = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
});

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
    }),
    newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
  },
  {}
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
    edits: Type.Array(replaceEditSchema, {
      description:
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    }),
  },
  {}
);

const writeSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' }),
});

/** The tools' definitions as the model sees them, before the runtime's notes. */
export const PI_TOOL_DEFINITIONS = {
  read: {
    name: 'read',
    label: 'read',
    description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    inputSchema: readSchema,
  },
  bash: {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    inputSchema: bashSchema,
  },
  edit: {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    inputSchema: editSchema,
  },
  write: {
    name: 'write',
    label: 'write',
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    inputSchema: writeSchema,
  },
} as const;

/**
 * pi-coding-agent's own tools, by name and the start of their descriptions
 * (1.0.4): what `pi()` refuses. They run on the machine that drives the
 * session (its `bash` with this process's environment).
 */
export const PI_CODING_AGENT_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  read: 'Read the contents of a file. Supports text files and images',
  bash: 'Execute a bash command in the current working directory. Returns stdout and stderr.',
  powershell: 'Execute a PowerShell command in the current working directory. Returns stdout and stderr.',
  edit: 'Edit a single file using exact text replacement.',
  write: "Write content to a file. Creates the file if it doesn't exist",
  grep: 'Search file contents for a pattern.',
  find: 'Search for files by glob pattern.',
  ls: 'List directory contents.',
});

/**
 * Whether `tool` is one of pi-coding-agent's own tools (a Pi `AgentTool`,
 * not a `HostTool`): one of its names, with its description, or with the
 * keys its `wrapToolDefinition` gives every tool it makes.
 */
export function isPiCodingAgentTool(tool: unknown): boolean {
  if (typeof tool !== 'object' || tool === null) return false;
  const t = tool as { name?: unknown; description?: unknown; parameters?: unknown; inputSchema?: unknown };
  if (typeof t.name !== 'string' || !(t.name in PI_CODING_AGENT_TOOLS) || !('parameters' in t) || 'inputSchema' in t) return false;
  if (typeof t.description === 'string' && t.description.startsWith(PI_CODING_AGENT_TOOLS[t.name]!)) return true;
  return ['constrainedSampling', 'executionMode', 'outputSchema'].every((key) => key in t);
}

// ---------------------------------------------------------------------------
// The tools

export interface PiCodingToolsOptions {
  /**
   * Where a call goes when its session has no World (durability off) and
   * `runtime` is durable: the same tools on this in-memory runtime, so the
   * files last the turn, as with `virtual({ durable: false })`. Without it,
   * such a call fails, saying so.
   */
  inMemory?: WorkspaceRuntime;
}

/** Pi's coding tools on `runtime`'s workspace: read, bash, edit, write (pi-coding-agent's `createCodingTools` order). */
export function piCodingTools(runtime: WorkspaceRuntime, options: PiCodingToolsOptions = {}): PiCodingTool[] {
  const defs = piToolDefs(runtime.root);
  const tools = defs.map(([def, extra]) => ({ ...runtime.tool(def), ...extra }) as PiCodingTool);
  const { inMemory } = options;
  if (!runtime.durable || !inMemory) return tools;
  const fallback = defs.map(([def]) => inMemory.tool(def));
  return tools.map((t, i) => ({ ...t, execute: (input, io) => (io.ctx.world ? t.execute(input, io) : fallback[i]!.execute(input, io)) }));
}

type Def = [WorkspaceToolDef<any>, Partial<PiCodingTool>];

function piToolDefs(root: string): Def[] {
  const read: WorkspaceToolDef<{ path: string; offset?: number; limit?: number }> = {
    ...PI_TOOL_DEFINITIONS.read,
    mode: 'read',
    run: ({ path, offset, limit }, m) => readText(m, root, path, offset, limit),
  };
  const bash: WorkspaceToolDef<{ command: string; timeout?: number }> = {
    ...PI_TOOL_DEFINITIONS.bash,
    kind: 'shell',
    // Safe to rerun: a command only reaches the workspace, and a retry runs
    // against the workspace the first attempt saw (its changes never landed).
    mode: 'write',
    run: ({ command, timeout }, m, io) => runBash(m, root, command, timeout, io.signal),
  };
  const edit: WorkspaceToolDef<{ path: string; edits: Edit[] }> = {
    ...PI_TOOL_DEFINITIONS.edit,
    // Safe to rerun: a retry edits the file as the log has it, so an edit
    // applied but never reported is not applied twice.
    mode: 'write',
    run: (input, m) => editFile(m, root, prepareEditArguments(input) as EditInput),
  };
  const write: WorkspaceToolDef<{ path: string; content: string }> = {
    ...PI_TOOL_DEFINITIONS.write,
    // Writing the same content twice is the same as writing it once.
    mode: 'write',
    async run({ path, content }, m) {
      // The parent directories are made by writeFile; an existing file keeps its mode.
      await m.writeFile(resolveToCwd(path, root), content);
      return `Successfully wrote to ${path}`;
    },
  };
  return [
    [read, {}],
    [bash, { isErrorResult: (text: string) => COMMAND_FAILED.test(text) }],
    [edit, { prepareArguments: prepareEditArguments }],
    [write, {}],
  ];
}

// ---------------------------------------------------------------------------
// Paths

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi-coding-agent's `resolveToCwd`, on the workspace: `~` is the workspace root, a relative path is from it. */
export function resolveToCwd(path: string, root: string): string {
  let p = path.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') return root;
  if (p.startsWith('~/')) return `${root}/${p.slice(2)}`;
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice('file://'.length));
  return p.startsWith('/') ? p : `${root}/${p}`;
}

// ---------------------------------------------------------------------------
// read

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;
/** Lossy, as `Buffer.toString('utf-8')` is: bytes that are not UTF-8 are U+FFFD. */
const lossy = new TextDecoder('utf-8');
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function readText(m: WorkspaceMachine, root: string, path: string, offset: number | undefined, limit: number | undefined): Promise<string> {
  const bytes = await m.readFile(resolveToCwd(path, root));
  const mimeType = imageMimeType(bytes);
  if (mimeType) throw new Error(`${path} is an image (${mimeType}); reading images is not supported`);
  const allLines = lossy.decode(bytes).split('\n');
  const totalFileLines = allLines.length;
  // Offset is 1-indexed.
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  let selected: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selected = allLines.slice(startLine, endLine).join('\n');
    userLimitedLines = endLine - startLine;
  } else {
    selected = allLines.slice(startLine).join('\n');
  }
  const truncation = truncateHead(selected);
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(byteLength(allLines[startLine] ?? ''));
    return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    return truncation.truncatedBy === 'lines'
      ? `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
      : `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
  }
  if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }
  return truncation.content;
}

/** pi-coding-agent's image detection (`utils/mime.js`): the image types its `read` attaches. */
function imageMimeType(b: Uint8Array): string | undefined {
  const ascii = (at: number, s: string) => s.split('').every((c, i) => b[at + i] === c.charCodeAt(0));
  const u32be = (at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
  const u32le = (at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
  const u16le = (at: number) => b[at]! | (b[at + 1]! << 8);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return b[3] === 0xf7 ? undefined : 'image/jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) {
    if (!(b.length >= 16 && u32be(8) === 13 && ascii(12, 'IHDR'))) return undefined;
    for (let at = 8; at + 8 <= b.length; ) {
      if (ascii(at + 4, 'acTL')) return undefined;
      if (ascii(at + 4, 'IDAT')) break;
      const next = at + 8 + u32be(at) + 4;
      if (next <= at || next > b.length) break;
      at = next;
    }
    return 'image/png';
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM') && b.length >= 26) {
    const declared = u32le(2);
    const pixels = u32le(10);
    const dib = u32le(14);
    if ((declared !== 0 && declared < 26) || pixels < 14 + dib || (declared !== 0 && pixels >= declared)) return undefined;
    let planes: number;
    let bits: number;
    if (dib === 12) [planes, bits] = [u16le(22), u16le(24)];
    else if (dib >= 40 && dib <= 124 && b.length >= 30) [planes, bits] = [u16le(26), u16le(28)];
    else return undefined;
    return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits) ? 'image/bmp' : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// bash

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** A bash result that is an error for the model: the status line pi-coding-agent ends it with. */
const COMMAND_FAILED = /(?:^|\n\n)Command (?:exited with code -?\d+|timed out after \S+ seconds)$/;
/** Where a truncated output's full text is saved (the latest only), in the workspace's own /tmp. */
const SPILL_DIR = '/tmp';
const SPILL_PREFIX = 'pi-bash-';

async function runBash(m: WorkspaceMachine, root: string, command: string, timeout: number | undefined, signal: AbortSignal): Promise<string> {
  if (timeout !== undefined) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds');
    if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const started = Date.now();
  const result = await m.exec(command, { cwd: root, env: { HOME: root }, signal, ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}) });
  const timedOut = timeout !== undefined && result.exitCode === 124 && Date.now() - started >= timeout * 1000 - 50;
  const stderr = timedOut ? result.stderr.replace(/(^|\n)bash: execution aborted\n?$/, '$1') : result.stderr;
  const output = result.stdout && stderr && !result.stdout.endsWith('\n') ? `${result.stdout}\n${stderr}` : result.stdout + stderr;
  const text = await formatOutput(m, output, timedOut || result.exitCode !== 0 ? '' : '(no output)');
  const status = (s: string) => `${text ? `${text}\n\n` : ''}${s}`;
  if (timedOut) return status(`Command timed out after ${timeout} seconds`);
  if (result.exitCode !== 0) return status(`Command exited with code ${result.exitCode}`);
  return text;
}

/** pi-coding-agent's bash output: the tail within the limits, and where the rest is. */
async function formatOutput(m: WorkspaceMachine, output: string, emptyText: string): Promise<string> {
  const truncation = truncateTail(output);
  let text = truncation.content || emptyText;
  if (!truncation.truncated) return text;
  const fullOutput = await spill(m, output);
  const where = fullOutput ? `Full output: ${fullOutput}` : 'The full output was too large to keep';
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n');
    const lastLineSize = formatSize(byteLength(lines[lines.length - 1] ?? ''));
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${where}]`;
  } else if (truncation.truncatedBy === 'lines') {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${where}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${where}]`;
  }
  return text;
}

/** Save a truncated output in the workspace's /tmp (outside the session's files), replacing the one before. */
async function spill(m: WorkspaceMachine, output: string): Promise<string | undefined> {
  try {
    for (const e of await m.list(SPILL_DIR).catch(() => [])) {
      if (e.type === 'file' && e.name.startsWith(SPILL_PREFIX)) await m.remove(`${SPILL_DIR}/${e.name}`, { force: true });
    }
    const path = `${SPILL_DIR}/${SPILL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.log`;
    await m.writeFile(path, output);
    return path;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// edit

interface Edit {
  oldText: string;
  newText: string;
}
interface EditInput {
  path: string;
  edits: Edit[];
}

function isSingleEdit(value: unknown): value is Edit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edit = value as Partial<Edit>;
  return typeof edit.oldText === 'string' && typeof edit.newText === 'string';
}

/** pi-coding-agent's `prepareEditArguments`: `edits` as a JSON string or one edit, and a top-level oldText/newText. */
export function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits) as unknown;
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {}
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') return args;
  const edits = Array.isArray(args.edits) ? [...(args.edits as Edit[])] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits };
}

async function editFile(m: WorkspaceMachine, root: string, input: EditInput): Promise<string> {
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  const { path, edits } = input;
  const absolutePath = resolveToCwd(path, root);
  let bytes: Uint8Array;
  try {
    bytes = await m.readFile(absolutePath);
  } catch (error) {
    // As pi-coding-agent says it (from the filesystem's error code).
    const code = (error as { code?: unknown } | undefined)?.code ?? /^(E[A-Z]+)\b/.exec(String((error as Error)?.message ?? ''))?.[1];
    throw new Error(`Could not edit file: ${path}. ${code ? `Error code: ${String(code)}` : String(error)}.`);
  }
  let raw: string;
  try {
    raw = strict.decode(bytes);
  } catch {
    throw new Error(`Could not edit file: ${path}. It is not UTF-8 text: edit it with bash.`);
  }
  // Strip a BOM before matching: the model will not include an invisible BOM in oldText.
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = bom ? raw.slice(1) : raw;
  const originalEnding = detectLineEnding(content);
  const { newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
  await m.writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding));
  return `Successfully replaced ${edits.length} block(s) in ${path}.`;
}

function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  if (lf === -1 || crlf === -1) return '\n';
  return crlf < lf ? '\r\n' : '\n';
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Normalize text for fuzzy matching: trailing whitespace per line, smart
 * quotes, Unicode dashes and special spaces to their ASCII forms.
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

const splitLinesWithEndings = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+/g) ?? [];

interface Span {
  start: number;
  end: number;
}
interface Replacement {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function getLineSpans(content: string): Span[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: Span[], replacement: Replacement): { startLine: number; endLine: number } {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex((line) => start >= line.start && start < line.end);
  if (startLine === -1) throw new Error('Replacement range is outside the base content.');
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < end) endLine++;
  if (endLine >= lines.length) throw new Error('Replacement range is outside the base content.');
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]!;
    const at = r.matchIndex - offset;
    result = result.substring(0, at) + r.newText + result.substring(at + r.matchLength);
  }
  return result;
}

/** Apply replacements matched in a normalized view of `original`, keeping the lines no replacement touches as they were. */
function applyReplacementsPreservingUnchangedLines(original: string, base: string, replacements: Replacement[]): string {
  const originalLines = splitLinesWithEndings(original);
  const baseLines = getLineSpans(base);
  if (originalLines.length !== baseLines.length) throw new Error('Cannot preserve unchanged lines because the base content has a different line count.');
  const groups: { startLine: number; endLine: number; replacements: Replacement[] }[] = [];
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = '';
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('');
    const groupStart = baseLines[group.startLine]!.start;
    const groupEnd = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(base.slice(groupStart, groupEnd), group.replacements, groupStart);
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join('');
}

/** Find `oldText` in `content`: exactly first, then in the fuzzy-normalized view. */
function fuzzyFindText(content: string, oldText: string): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const fuzzy = fuzzyContent.indexOf(fuzzyOld);
  if (fuzzy === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzy, matchLength: fuzzyOld.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

/**
 * pi-coding-agent's `applyEditsToNormalizedContent`: every edit matched
 * against the same original (LF) content, exactly or fuzzily, each unique
 * and none overlapping, then applied in reverse order.
 */
export function applyEditsToNormalizedContent(normalizedContent: string, edits: Edit[], path: string): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  const many = normalizedEdits.length > 1;
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) throw new Error(many ? `edits[${i}].oldText must not be empty in ${path}.` : `oldText must not be empty in ${path}.`);
  }
  const usedFuzzyMatch = normalizedEdits.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch);
  const base = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matched: Replacement[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const match = fuzzyFindText(base, edit.oldText);
    if (!match.found) {
      throw new Error(
        many
          ? `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
          : `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
      );
    }
    const occurrences = countOccurrences(base, edit.oldText);
    if (occurrences > 1) {
      throw new Error(
        many
          ? `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
      );
    }
    matched.push({ editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const previous = matched[i - 1]!;
    const current = matched[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }
  const newContent = usedFuzzyMatch ? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched) : applyReplacements(base, matched);
  if (normalizedContent === newContent) {
    throw new Error(
      many
        ? `No changes made to ${path}. The replacements produced identical content.`
        : `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    );
  }
  return { baseContent: normalizedContent, newContent };
}

// ---------------------------------------------------------------------------
// truncation (pi-coding-agent's truncate.js)

export interface Truncation {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const whole = (content: string, totalLines: number, totalBytes: number): Truncation => ({
  content,
  truncated: false,
  truncatedBy: null,
  totalLines,
  totalBytes,
  outputLines: totalLines,
  outputBytes: totalBytes,
  lastLinePartial: false,
  firstLineExceedsLimit: false,
});

/** Keep the first lines within the limits, never a partial line. */
export function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): Truncation {
  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return whole(content, totalLines, totalBytes);
  if (byteLength(lines[0]!) > maxBytes) {
    return { content: '', truncated: true, truncatedBy: 'bytes', totalLines, totalBytes, outputLines: 0, outputBytes: 0, lastLinePartial: false, firstLineExceedsLimit: true };
  }
  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = byteLength(lines[i]!) + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    out.push(lines[i]!);
    bytes += lineBytes;
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines';
  const kept = out.join('\n');
  return { content: kept, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: out.length, outputBytes: byteLength(kept), lastLinePartial: false, firstLineExceedsLimit: false };
}

/** Keep the last lines within the limits; the last line alone may be cut (from its end). */
export function truncateTail(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): Truncation {
  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return whole(content, totalLines, totalBytes);
  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!;
    const lineBytes = byteLength(line) + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (out.length === 0) {
        const cut = truncateStringToBytesFromEnd(line, maxBytes);
        out.unshift(cut);
        bytes = byteLength(cut);
        lastLinePartial = true;
      }
      break;
    }
    out.unshift(line);
    bytes += lineBytes;
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines';
  const kept = out.join('\n');
  return { content: kept, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: out.length, outputBytes: byteLength(kept), lastLinePartial, firstLineExceedsLimit: false };
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = utf8.encode(str);
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  // A character's start, not a continuation byte.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return lossy.decode(buf.subarray(start));
}
