import {
  type BlobContent,
  blobStreamName,
  bytesToBase64,
  decodeLine,
  type DriveContext,
  encodeLine,
  type HostTool,
  readBlobContents,
  sha256Hex,
  writeBlob,
} from 'harness-world';
import { asContent, untouched } from './doc-workspace.ts';
import { DEFAULT_FILE_MODE, type FileEntry, INLINE_FILE_MAX_BYTES, inlineContent, isWorkspacePath, MANIFEST_INLINE_BUDGET_BYTES, modeOf, normalizeEntry } from './files.ts';
import { FX_SCHEMAS, FX_TOOL_NAMES, fxDescription, type FxToolName } from './fx-specs.ts';
import { createMachine, type Isolation, type MachineOptions, type VirtualMachine } from './isolation.ts';
import type { FileBytes, WorkspaceMachine } from './machine.ts';
import { type FxAcquire, type FxMachineRecord, FxSandbox } from './fx-sandbox.ts';
import { type CallMode, describeTool, TurnWorkspaces, WORKSPACE_TOOL, type WorkspaceDescriptor, type WorkspaceRuntime, workspaceRuntime, type WorkspaceRuntimeOptions } from './runtime.ts';
import { WORKSPACE_ROOT } from './paths.ts';
import { SANDBOX_NOTE } from './sandbox-runtime.ts';

/**
 * libfx's kernel tools on a workspace: `read_file`, `glob_files`,
 * `grep_files`, `edit_file`, `write_file` and `shell`, with fx's names and
 * input schemas (fx-specs.ts), its descriptions with the reviewed edits, and
 * its output formats (`<path>…<content>` numbered reads, `[glob]`/`[grep]`
 * listings, `wrote <path> (<n> bytes)`, the shell's JSON snapshot). Every
 * command and path the model picks goes to the workspace's machine
 * (machine.ts): on a virtual workspace just-bash on an in-memory filesystem,
 * in a worker leased to the session; on a sandbox the session's VM, its
 * files on the session's Drive. Nothing reaches the disk, processes or
 * environment of the machine that runs the agent; a path outside
 * `/workspace` is refused.
 *
 * Two adapters over the same tool code:
 *
 * - `fxHostTools(workspace)`: `HostTool`s for the kernel's fx harness
 *   (harness-world-fx): the workspace runtime's (runtime.ts), so a durable
 *   workspace is the session's `hw.workspace` document and each call's
 *   change commits with its outcome; given a sandbox runtime
 *   (sandbox-runtime.ts' `sandboxRuntime`), the same tools in the session's
 *   VM, attached in the pre-intent phase with the drive's own fence.
 * - `fxAgentTools(workspace, { world })`: libfx host tools for libfx's own
 *   durable agent (`createFxAgent`), whose sessions have no kernel and no
 *   documents. A durable workspace records each call that may change files
 *   in a World stream of the session's run (`<sessionId>_fxws`): the call's
 *   changed files (small ones inline, the rest in the session's blob
 *   stream), its output, keyed by libfx's `executionId`. A call libfx runs
 *   again after a crash (every tool is `idempotent: true`) finds its record
 *   and returns the same output without running again; a call cut off before
 *   it recorded reruns on the files as they were before it. An in-memory
 *   workspace keeps its files in this process only. On a sandbox
 *   (fx-sandbox.ts) the calls run in the session's VM, armed with the epoch
 *   of the libfx lease the call's worker holds.
 */

// ---------------------------------------------------------------------------
// The tool code, on a machine

/** A call's outcome: the text the model sees, and whether it is an error. */
export interface FxResult {
  text: string;
  isError?: true;
  /** The call ran (a command that exited non-zero): what it changed stays, though it is an error. */
  ran?: true;
}

const ok = (text: string): FxResult => ({ text });
const fail = (text: string): FxResult => ({ text, isError: true });

/** One fx tool: its name, whether it may change files, and its code on the machine. */
export interface FxToolDef {
  name: FxToolName;
  /** `shell` for the tool that runs commands (its description says where they run). */
  kind: 'shell' | 'file';
  mode: CallMode;
  run(input: unknown, machine: WorkspaceMachine): Promise<FxResult>;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const MiB = 1024 * 1024;
/** fx's caps (tool_dispatch.zig defaults, read_file.zig, write_file.zig, grep_files.zig, glob_pattern.zig). */
const LIMITS = {
  readLines: 400,
  lineLength: 2000,
  readSnapshotBytes: 10 * MiB,
  readOutputBytes: 256 * 1024,
  listEntries: 100,
  contentBytes: 4 * MiB,
  patternBytes: 4096,
  contextLines: 5,
  contextFileBytes: 200 * 1024,
  shellOutputBytes: 64 * 1024,
};

/** fx's model-safe text: valid UTF-8 with no NUL. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  const content = asContent(bytes);
  return typeof content === 'string' ? content : undefined;
}

/** fx's structured tool failure (`tool_result_errors.zig`). */
function failure(tool: string, message: string, details: Record<string, string>, suggestion?: string): FxResult {
  return fail(JSON.stringify({ error: { type: 'tool_execution_failed', tool_name: tool, message, details, ...(suggestion ? { suggestion } : {}) } }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

interface Target {
  abs: string;
  /** Relative to the workspace root (`.` for the root): how fx shows a path. */
  rel: string;
}

/**
 * A path the model gave: relative to `/workspace`, or absolute under it.
 * Anything else (`~/...`, an absolute path elsewhere, a `../` out of it) is
 * refused, as fx's permission policy refuses an external path it was not
 * allowed: a virtual workspace has nothing outside its root.
 */
function target(tool: string, field: string, raw: unknown, { optional = false } = {}): Target | FxResult {
  if (raw === undefined && optional) return { abs: WORKSPACE_ROOT, rel: '.' };
  if (typeof raw !== 'string') return fail(`${tool} field "${field}" must be a string`);
  const path = raw.trim();
  if (path === '') return fail(`${tool} field "${field}" must not be empty`);
  const abs = path.startsWith('~') ? undefined : normalize(path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`);
  if (!abs || (abs !== WORKSPACE_ROOT && !isWorkspacePath(abs))) {
    return failure(tool, `${tool} refused a path outside the workspace`, { field, path: raw }, 'Paths are workspace-relative, or absolute under /workspace.');
  }
  return { abs, rel: abs === WORKSPACE_ROOT ? '.' : abs.slice(WORKSPACE_ROOT.length + 1) };
}
const refused = (t: Target | FxResult): t is FxResult => 'text' in t;

/** An optional integer field: undefined, or a value at least `min`. */
function integer(tool: string, field: string, value: unknown, min: number): number | undefined | FxResult {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    return fail(`${tool} field "${field}" must be a ${min > 0 ? 'positive' : 'non-negative'} integer`);
  }
  return value;
}
const isResult = (v: unknown): v is FxResult => isRecord(v) && typeof v.text === 'string';

// read_file ------------------------------------------------------------------

async function readFile(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  if (!isRecord(input)) return fail('read_file arguments must be an object');
  const t = target('read_file', 'path', input.path);
  if (refused(t)) return t;
  const start = integer('read_file', 'start_line', input.start_line, 1);
  if (isResult(start)) return start;
  const count = integer('read_file', 'line_count', input.line_count, 1);
  if (isResult(count)) return count;
  const startLine = start ?? 1;
  const lineCount = Math.min(count ?? LIMITS.readLines, LIMITS.readLines);
  const stat = await m.stat(t.abs);
  if (!stat) {
    return failure('read_file', 'read_file failed', { field: 'path', path: t.abs, error: 'FileNotFound' }, 'Run glob_files to discover matching paths, or check the path relative to the workspace.');
  }
  if (stat.type !== 'file') {
    return failure('read_file', 'read_file requires a regular file', { field: 'path', path: t.abs, error: 'NotRegularFile' }, 'Use glob_files to inspect directory contents, then choose a regular file.');
  }
  const bytes = await m.readFile(t.abs);
  const complete = bytes.length <= LIMITS.readSnapshotBytes;
  const text = textOf(complete ? bytes : bytes.subarray(0, LIMITS.readSnapshotBytes));
  if (text === undefined) return ok(`<path>${t.rel}</path>\n<content>binary or non-utf8 file omitted (${bytes.length} bytes)</content>`);

  // The lines fx keeps: from start_line, at most line_count, each clipped, within the output budget.
  const records: { n: number; text: string }[] = [];
  let total = 0;
  let truncated = false;
  let stop = false;
  let width = 1;
  let budget = 0;
  for (let at = 0, n = 1; at < text.length; n++) {
    const end = text.indexOf('\n', at);
    const line = text.slice(at, end === -1 ? text.length : end);
    total = n;
    if (!stop && n >= startLine) {
      if (records.length >= lineCount) {
        truncated = stop = true;
      } else {
        const digits = String(n).length;
        if (digits > width) {
          budget += records.length * (digits - width);
          width = digits;
        }
        const clipped = line.length > LIMITS.lineLength ? `${line.slice(0, LIMITS.lineLength)}... (line truncated)` : line;
        const rendered = budget + width + 1 + byteLength(clipped) + 1;
        if (rendered > LIMITS.readOutputBytes) {
          truncated = stop = true;
        } else {
          if (clipped !== line) truncated = true;
          records.push({ n, text: clipped });
          budget = rendered;
        }
      }
    }
    if (end === -1) break;
    at = end + 1;
  }
  let out = `<path>${t.rel}</path>\n<content>\n`;
  const last = records.at(-1);
  if (last) {
    const w = String(last.n).length;
    for (const r of records) out += `${r.n}${' '.repeat(w - String(r.n).length)}\t${r.text}\n`;
  } else if (total > 0 && startLine > total) {
    out += `... [start_line ${startLine} is beyond end of file; total lines ${total}]\n`;
  }
  const whole = !truncated && startLine === 1 && records.length === total;
  if ((!whole || !complete) && (records.length > 0 || truncated)) {
    out += complete
      ? `... [showing ${records.length} of ${total} lines; use start_line/line_count to read more.]\n`
      : `... [showing ${records.length} of at least ${total} lines; file snapshot was capped before EOF.]\n`;
  }
  return ok(`${out}</content>`);
}

// write_file, edit_file -------------------------------------------------------

async function writeFile(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  if (!isRecord(input)) return fail('write_file arguments must be an object');
  const t = target('write_file', 'path', input.path);
  if (refused(t)) return t;
  if (typeof input.content !== 'string') return fail('write_file field "content" must be a string');
  const content = input.content;
  if (byteLength(content) > LIMITS.contentBytes) return fail('write_file failed: content exceeds the 4 MiB preparation limit');
  const stat = await m.stat(t.abs);
  if (stat && stat.type !== 'file') return fail('file mutation preparation failed: target is not a regular file');
  if (stat && textOf(await m.readFile(t.abs)) === content) return ok(`No changes to ${t.rel}; it already contains the requested content`);
  // An existing file keeps its mode, as a filesystem's write does.
  await m.writeFile(t.abs, content);
  return ok(`wrote ${t.rel} (${byteLength(content)} bytes)`);
}

async function editFile(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  if (!isRecord(input)) return fail('edit_file arguments must be an object');
  const t = target('edit_file', 'path', input.path);
  if (refused(t)) return t;
  for (const field of ['old_string', 'new_string'] as const) {
    if (typeof input[field] !== 'string') return fail(`edit_file field "${field}" must be a string`);
  }
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  if (oldString === newString) return fail('edit_file failed: old_string and new_string are identical');
  const stat = await m.stat(t.abs);
  if (!stat) return fail('file mutation preparation failed: approved filesystem identity changed');
  if (stat.type !== 'file') return fail('file mutation preparation failed: target is not a regular file');
  const bytes = await m.readFile(t.abs);
  if (bytes.length > LIMITS.contentBytes) return fail('file mutation preparation failed: preimage exceeds the 4 MiB preparation limit');
  const before = textOf(bytes);
  if (before === undefined) return fail('file mutation preparation failed: unable to read the approved preimage');
  let occurrences = 0;
  if (oldString !== '') for (let at = before.indexOf(oldString); at !== -1; at = before.indexOf(oldString, at + oldString.length)) occurrences++;
  if (occurrences === 0) {
    return fail('edit_file failed: old_string not found in file. Re-read the file to see its current contents; if the change is already applied, do not retry this edit.');
  }
  if (occurrences > 1) return fail(`edit_file failed: old_string is not unique (found ${occurrences} occurrences), provide more context`);
  const at = before.indexOf(oldString);
  const after = before.slice(0, at) + newString + before.slice(at + oldString.length);
  if (byteLength(after) > LIMITS.contentBytes) return fail('edit_file failed: postimage exceeds the 4 MiB preparation limit');
  await m.writeFile(t.abs, after);
  return ok(`edited ${t.rel} (${byteLength(after)} bytes)`);
}

// glob_files, grep_files --------------------------------------------------------

/**
 * fx's glob (`glob_pattern.zig`): `*` and `?` within a segment, `**` for any
 * number of segments, nothing else special; a pattern without `/` matches a
 * path's basename.
 */
export function globMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('/')) return segmentMatches(pattern, path.slice(path.lastIndexOf('/') + 1));
  const segments = pattern.split('/').filter((s, i, all) => s !== '' || i < all.length - 1);
  const parts = path === '' ? [] : path.split('/');
  // previous[i]: the first i pattern segments match the candidate segments seen so far.
  let previous = segments.map(() => false).concat(false);
  previous[0] = true;
  for (let i = 0; i < segments.length; i++) previous[i + 1] = previous[i]! && segments[i] === '**';
  for (const part of parts) {
    const current = segments.map(() => false).concat(false);
    for (let i = 0; i < segments.length; i++) {
      current[i + 1] = segments[i] === '**' ? current[i]! || previous[i + 1]! : previous[i]! && segmentMatches(segments[i]!, part);
    }
    previous = current;
  }
  return previous[segments.length]!;
}

function segmentMatches(pattern: string, candidate: string): boolean {
  let p = 0;
  let c = 0;
  let starP = -1;
  let starC = 0;
  while (c < candidate.length) {
    if (p < pattern.length) {
      if (pattern[p] === '*') {
        while (p < pattern.length && pattern[p] === '*') p++;
        if (p === pattern.length) return true;
        starP = p;
        starC = c;
        continue;
      }
      if (pattern[p] === '?' || pattern[p] === candidate[c]) {
        if (candidate[c] === '/') return false;
        p++;
        c++;
        continue;
      }
    }
    if (starP === -1) return false;
    starC++;
    c = starC;
    p = starP;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** The files under a search root (or the root itself when it is a file), relative to it, sorted. */
async function candidates(m: WorkspaceMachine, root: Target): Promise<{ file?: string; files: string[] } | undefined> {
  const stat = await m.stat(root.abs);
  if (!stat) return undefined;
  if (stat.type === 'file') return { file: root.rel, files: [] };
  const prefix = root.abs === '/' ? '/' : `${root.abs}/`;
  const files = (await m.walk(root.abs)).filter((e) => e.type === 'file' && e.path.startsWith(prefix)).map((e) => e.path.slice(prefix.length));
  return { files: files.sort() };
}

/** A path under the search root, as fx shows it: relative to the workspace root. */
const shown = (root: Target, relative: string) => (root.rel === '.' ? relative : `${root.rel}/${relative}`);

async function globFiles(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  if (!isRecord(input)) return fail('glob_files arguments must be an object');
  if (typeof input.pattern !== 'string') return fail('glob_files field "pattern" must be a string');
  const pattern = input.pattern;
  if (byteLength(pattern) > LIMITS.patternBytes) return fail(`glob_files field "pattern" must be at most ${LIMITS.patternBytes} bytes`);
  const mode = input.mode ?? 'matches';
  if (mode !== 'matches' && mode !== 'count') return fail('glob_files field "mode" must be matches or count');
  const root = target('glob_files', 'path', input.path, { optional: true });
  if (refused(root)) return root;
  const found = await candidates(m, root);
  if (!found) return fail(`Unable to resolve glob search root: ${String(input.path)} (FileNotFound)`);
  const matches: string[] = [];
  let count = 0;
  let truncated = false;
  if (found.file !== undefined) {
    if (globMatches(pattern, found.file.slice(found.file.lastIndexOf('/') + 1))) {
      count = 1;
      matches.push(found.file);
    }
  } else {
    for (const relative of found.files) {
      if (!globMatches(pattern, relative)) continue;
      count++;
      if (mode === 'count') continue;
      if (matches.length >= LIMITS.listEntries) {
        truncated = true;
        break;
      }
      matches.push(shown(root, relative));
    }
  }
  if (mode === 'count') return ok(`[glob] count ${count} matches for ${pattern}\n`);
  if (matches.length === 0) return ok(`[glob] no matches for ${pattern}\n`);
  let out = `[glob] ${matches.length} matches for ${pattern}\n`;
  for (const match of matches) out += ` - ${match}\n`;
  if (truncated) out += `... truncated to first ${LIMITS.listEntries} matches\n`;
  return ok(out);
}

const clip = (line: string) => (line.length > LIMITS.lineLength ? `${line.slice(0, LIMITS.lineLength)}...` : line);

async function grepFiles(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  if (!isRecord(input)) return fail('grep_files arguments must be an object');
  if (typeof input.pattern !== 'string' || input.pattern === '') return fail('grep_files field "pattern" must be a non-empty string');
  const pattern = input.pattern;
  const mode = input.mode ?? 'matches';
  if (mode !== 'matches' && mode !== 'files_with_matches' && mode !== 'count') return fail('grep_files field "mode" must be matches, files_with_matches or count');
  if (input.include !== undefined && typeof input.include !== 'string') return fail('grep_files field "include" must be a string');
  const include = input.include as string | undefined;
  if (include !== undefined && byteLength(include) > LIMITS.patternBytes) return fail(`grep_files field "include" must be at most ${LIMITS.patternBytes} bytes`);
  if (input.case_insensitive !== undefined && typeof input.case_insensitive !== 'boolean') return fail('grep_files field "case_insensitive" must be a boolean');
  const headLimit = integer('grep_files', 'head_limit', input.head_limit, 1);
  if (isResult(headLimit)) return headLimit;
  const offset = integer('grep_files', 'offset', input.offset, 0);
  if (isResult(offset)) return offset;
  const context = integer('grep_files', 'context_lines', input.context_lines, 0);
  if (isResult(context)) return context;
  const root = target('grep_files', 'path', input.path, { optional: true });
  if (refused(root)) return root;
  const found = await candidates(m, root);
  if (!found) return fail(`Unable to stat search root: ${root.abs} (FileNotFound)`);
  const fold = input.case_insensitive === true ? (s: string) => s.toLowerCase() : (s: string) => s;
  const needle = fold(pattern);
  const files = found.file !== undefined ? [found.file] : found.files.map((f) => shown(root, f));
  const matches: { path: string; n: number; line: string; lines: string[] }[] = [];
  for (const path of files) {
    if (include !== undefined && !globMatches(include, root.rel === '.' || found.file !== undefined ? path : path.slice(root.rel.length + 1))) continue;
    const text = textOf(await m.readFile(`${WORKSPACE_ROOT}/${path}`));
    if (text === undefined) continue;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((line, i) => {
      if (fold(line).includes(needle)) matches.push({ path, n: i + 1, line, lines });
    });
  }
  if (mode === 'count') return ok(`[grep] count ${matches.length} matching lines in ${new Set(matches.map((x) => x.path)).size} files for ${pattern}\n`);
  const limit = Math.min(headLimit ?? LIMITS.listEntries, LIMITS.listEntries);
  const from = offset ?? 0;
  if (mode === 'files_with_matches') {
    const paths = [...new Set(matches.map((x) => x.path))];
    const start = Math.min(from, paths.length);
    const end = Math.min(start + limit, paths.length);
    let out: string;
    if (paths.length === 0) out = `[grep] no files with matches for ${pattern}\n`;
    else if (end === start) out = `[grep] no files with matches for ${pattern} at offset ${from} (${paths.length} total files)\n`;
    else {
      out = start === 0 && end === paths.length ? `[grep] ${end - start} files with matches for ${pattern}\n` : `[grep] ${end - start} files with matches for ${pattern} (showing ${start + 1}-${end} of ${paths.length})\n`;
      for (const path of paths.slice(start, end)) out += ` - ${path}\n`;
    }
    if (end < paths.length) out += `... more files available; use offset ${end} to continue\n`;
    return ok(out);
  }
  const around = Math.min(context ?? 0, LIMITS.contextLines);
  const start = Math.min(from, matches.length);
  const end = Math.min(start + limit, matches.length);
  let out: string;
  if (matches.length === 0) out = `[grep] no matches for ${pattern}\n`;
  else if (end === start) out = `[grep] no matches for ${pattern} at offset ${from} (${matches.length} total matches)\n`;
  else {
    out = start === 0 && end === matches.length ? `[grep] ${end - start} matches for ${pattern}\n` : `[grep] ${end - start} matches for ${pattern} (showing ${start + 1}-${end} of ${matches.length})\n`;
    for (const match of matches.slice(start, end)) {
      const contextOk = around > 0 && match.lines.join('\n').length <= LIMITS.contextFileBytes;
      if (contextOk) for (let n = Math.max(1, match.n - around); n < match.n; n++) out += `   ${match.path}:${n}- ${clip(match.lines[n - 1]!)}\n`;
      out += ` - ${match.path}:${match.n}: ${clip(match.line)}\n`;
      if (contextOk) for (let n = match.n + 1; n <= Math.min(match.lines.length, match.n + around); n++) out += `   ${match.path}:${n}- ${clip(match.lines[n - 1]!)}\n`;
    }
  }
  if (end < matches.length) out += `... more matches available; use offset ${end} to continue\n`;
  return ok(out);
}

// shell ------------------------------------------------------------------------

const PARSE_GUIDANCE =
  'The shell could not parse this command (unmatched quote or syntax error), so nothing executed. Rewrite the command with corrected quoting or escaping and submit the full corrected command instead of rerunning the same text.';
const USAGE_GUIDANCE =
  'The command exited with a usage error (missing or invalid arguments). Rebuild the command with the required arguments explicitly set, then submit the corrected command instead of rerunning it unchanged.';

/** fx's retry guidance for a failed command (shell.zig `failureRetryGuidance`). */
function guidance(exitCode: number, output: string): string | null {
  if (exitCode === 0) return null;
  const lines = output.split('\n').map((l) => l.trim());
  const shellError = (l: string) => {
    const colon = l.indexOf(':');
    if (colon <= 0 || l.slice(0, colon).includes(' ')) return false;
    return ['zsh', 'bash', 'sh', 'dash'].includes(l.slice(0, colon).split('/').pop()!);
  };
  if (lines.some((l) => shellError(l) && /unmatched|syntax error|parse error|unterminated quoted string/i.test(l))) return PARSE_GUIDANCE;
  if (lines.filter(Boolean).slice(0, 4).some((l) => /^usage:/i.test(l))) return USAGE_GUIDANCE;
  return null;
}

/** Output a terminal can show: NUL and other control bytes (not tab, newline, carriage return or escape) as `\xNN`. */
const terminalSafe = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** Head and tail of `text` within `max` characters, with a marker between. */
function bounded(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = '\n... output omitted ...\n';
  const keep = max - marker.length;
  const head = Math.ceil(keep / 2);
  return { text: text.slice(0, head) + marker + text.slice(text.length - (keep - head)), truncated: true };
}

async function shell(input: unknown, m: WorkspaceMachine): Promise<FxResult> {
  const request = isRecord(input) ? input.request : undefined;
  if (!isRecord(request)) return fail('shell requires object field "request"');
  const action = request.action;
  if (action === 'interact' || action === 'stop') {
    const id = typeof request.session_id === 'string' ? request.session_id : '';
    return fail(`no shell has session_id ${JSON.stringify(id)}: every command here completes in its run call and nothing keeps running; files are on /workspace`);
  }
  if (action !== 'run') return fail('shell request.action must be run, interact or stop');
  if (typeof request.command !== 'string' || request.command.trim() === '') return fail('shell request.command must be a non-empty string');
  const command = request.command;
  if (byteLength(command) > 64 * 1024) return fail('shell request.command must be at most 65536 bytes');
  const timeout = integer('shell', 'timeout_ms', request.timeout_ms, 1);
  if (isResult(timeout)) return timeout;
  const cwd = target('shell', 'cwd', request.cwd, { optional: true });
  if (refused(cwd)) return cwd;
  if (cwd.abs !== WORKSPACE_ROOT && (await m.stat(cwd.abs))?.type !== 'directory') return fail(`shell request.cwd is not a directory: ${cwd.abs}`);
  const started = Date.now();
  const result = await m.exec(command, { ...(cwd.abs !== WORKSPACE_ROOT ? { cwd: cwd.abs } : {}), ...(timeout !== undefined ? { timeoutMs: timeout } : {}) });
  const output = bounded(terminalSafe(result.stdout + result.stderr), LIMITS.shellOutputBytes);
  const timedOut = timeout !== undefined && result.exitCode === 124;
  const text = JSON.stringify({
    session_id: null,
    state: 'completed',
    backend: m.isolation === 'sandbox' ? 'sandbox' : 'virtual',
    persistence: 'none',
    output_truncated: output.truncated,
    output_incomplete: false,
    output_terminal_safe: true,
    full_output_handle: null,
    exit_code: result.exitCode,
    signal: null,
    termination_indeterminate: false,
    duration_ms: Date.now() - started,
    accepted_bytes: null,
    error: timedOut ? 'TimeoutExpired' : null,
    retry_guidance: guidance(result.exitCode, result.stdout + result.stderr),
    output_delta: output.text,
  });
  return result.exitCode === 0 ? ok(text) : { text, isError: true, ran: true };
}

/** The six tools' code, in fx's advertisement order. */
export const FX_TOOL_DEFS: readonly FxToolDef[] = Object.freeze(
  FX_TOOL_NAMES.map((name): FxToolDef => {
    const run = { read_file: readFile, glob_files: globFiles, grep_files: grepFiles, edit_file: editFile, write_file: writeFile, shell }[name];
    return { name, kind: name === 'shell' ? 'shell' : 'file', mode: name === 'edit_file' || name === 'write_file' || name === 'shell' ? 'write' : 'read', run };
  })
);

// ---------------------------------------------------------------------------
// For the kernel: HostTools on the workspace runtime

/**
 * fx's tools as `HostTool`s for the kernel's fx harness (harness-world-fx),
 * on `workspace` (default the durable virtual workspace): `replay: 'safe'`,
 * each call's change committed with its outcome. A call that fails having
 * changed nothing (a missing file, an `old_string` not found) is an error
 * result; a command that ran and exited non-zero is a result whose JSON says
 * its exit code, keeping what it changed.
 *
 * Or on a runtime: `sandboxRuntime(kernelSandbox(acquire, load))` puts them
 * in the session's own Vercel Sandbox (each with the runtime's pre-intent
 * phase and drive-end hook, which harness-world-fx runs; `read_file`,
 * `glob_files` and `grep_files` `safe`, the rest `never`).
 */
export function fxHostTools(workspace: WorkspaceDescriptor | WorkspaceRuntime = { kind: 'virtual', durable: true }, options: WorkspaceRuntimeOptions = {}): HostTool[] {
  const runtime = isRuntime(workspace) ? workspace : workspaceRuntime(workspace, options);
  return FX_TOOL_DEFS.map((def) =>
    runtime.tool<unknown>({
      name: def.name,
      description: fxDescription(def.name),
      kind: def.kind,
      inputSchema: FX_SCHEMAS[def.name],
      mode: def.mode,
      async run(input, machine) {
        const result = await def.run(input, machine);
        if (result.isError && !result.ran) throw new Error(result.text);
        return result.text;
      },
    })
  ) as HostTool[];
}

const isRuntime = (w: WorkspaceDescriptor | WorkspaceRuntime): w is WorkspaceRuntime => typeof (w as Partial<WorkspaceRuntime>).tool === 'function';

// ---------------------------------------------------------------------------
// For libfx's own agent

/** What libfx gives a host tool's `execute()` beside its input (libfx's `FxToolContext`). */
export interface FxCallContext {
  signal?: AbortSignal;
  executionId: string;
  sessionId: string;
  context?: unknown;
}

/** A libfx host tool (libfx's `FxHostTool`). */
export interface FxAgentTool {
  name: FxToolName;
  description: string;
  inputSchema: object;
  /** On a virtual workspace (its calls are recorded by `executionId`); never on a sandbox, so libfx stores each call's intent first. */
  idempotent: boolean;
  writes?: true;
  execute(input: unknown, context: FxCallContext): Promise<string | FxRichResult>;
  /** The workspace-tool brand (runtime.ts), so Claude Code and Codex can refuse these. */
  readonly [WORKSPACE_TOOL]: true;
}

/** libfx's typed result, for an error result returned rather than thrown. */
export interface FxRichResult {
  type: 'libfx.tool-result';
  text: string;
  images: never[];
  isError: true;
}

type World = DriveContext['world'];

export interface FxAgentToolsOptions {
  /**
   * The World the agent's sessions live in, where a durable workspace keeps
   * its records: resolved on the first call that needs it.
   */
  world?: () => World | Promise<World>;
  /** Where the shell runs (tests): default `auto`. */
  isolation?: Isolation;
  /**
   * For a sandbox workspace: the sandbox tier's `acquireMachine` (the
   * session factory durable-harness's `sandbox()` resolves to), called with
   * the epoch of the call's libfx lease as its fencing token.
   */
  acquire?: FxAcquire<FxMachineRecord>;
}

/** What the model is told about an in-memory workspace for libfx's agent: libfx says nothing of turns to a tool, so this is all it can promise. */
export const FX_MEMORY_NOTE = 'Files are kept in memory on the server running this session, not with the session: do not count on them after this turn, and they are gone if the session moves to another server.';

/** The name of a session's record stream (in its run). */
export const fxWorkspaceStreamName = (sessionId: string) => `${sessionId}_fxws`;

/** What libfx names its sessions' runs. */
export const LIBFX_WORKFLOW = 'libfx/session';

/** One call's record in `<sessionId>_fxws`: what it changed, and what it returned. */
export interface FxWorkspaceRecord {
  v: 1;
  executionId: string;
  tool: string;
  output: string;
  isError?: true;
  /** When it was recorded (ms). */
  at: number;
  /** The files it changed: an `hw.workspace` entry (files.ts), or null for a file it removed. */
  files: Record<string, FileEntry | null>;
}

/**
 * fx's tools for libfx's own durable agent (`createFxAgent`) on `workspace`:
 * see the module comment. Every tool is `idempotent: true`; the ones that
 * may change files are `writes: true`, so libfx runs them one at a time.
 * Each carries the workspace-tool brand, as `runtime.tool()`'s do.
 */
export function fxAgentTools(workspace: WorkspaceDescriptor, options: FxAgentToolsOptions = {}): FxAgentTool[] {
  if (workspace.kind === 'sandbox') return fxSandboxAgentTools(options);
  if (workspace.kind !== 'virtual') throw new Error(`harness-world-hands: fx tools take a virtual or a sandbox workspace, not ${String((workspace as { kind?: unknown }).kind)}`);
  const durable = workspace.durable !== false;
  const machine: MachineOptions = {
    root: WORKSPACE_ROOT,
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(workspace.maxBytes !== undefined ? { maxBytes: workspace.maxBytes } : {}),
    ...(workspace.maxFileBytes !== undefined ? { maxFileBytes: workspace.maxFileBytes } : {}),
    ...(workspace.timeoutMs !== undefined ? { timeoutMs: workspace.timeoutMs } : {}),
  };
  let store: FxStore;
  if (durable) {
    const world = options.world;
    if (!world) throw new TypeError('harness-world-hands: a durable fx workspace needs the World its sessions live in');
    store = new FxRecords(world, machine);
  } else {
    store = new FxMemory(machine);
  }
  return agentTools(store, true, (def) => {
    const base = fxDescription(def.name);
    return durable ? describeTool(base, def.kind, true) : `${describeTool(base, def.kind, true)} ${FX_MEMORY_NOTE}`;
  });
}

/**
 * fx's tools for libfx's agent on the session's Vercel Sandbox (fx-sandbox.ts):
 * `idempotent: false`, so libfx stores each call's intent before it runs it
 * (which names the worker, and so the token) and never runs a call a crash
 * cut off again (on a Drive it may have half-run: libfx tells the model).
 */
function fxSandboxAgentTools(options: FxAgentToolsOptions): FxAgentTool[] {
  const { acquire, world } = options;
  if (!acquire) throw new TypeError("harness-world-hands: fx tools on a sandbox need the sandbox tier's acquireMachine");
  if (!world) throw new TypeError('harness-world-hands: fx tools on a sandbox need the World the sessions live in (libfx keeps its lease there)');
  const store = new FxSandbox(world, acquire, (w, sessionId) => checkSession(w, sessionId, SANDBOX_SESSION_HINT));
  return agentTools(store, false, (def) => (def.kind === 'shell' ? `${fxDescription(def.name).trimEnd()} ${SANDBOX_NOTE}` : fxDescription(def.name)));
}

/** The six libfx host tools over `store`, in fx's order, each with the workspace-tool brand. */
function agentTools(store: FxStore, idempotent: boolean, describe: (def: FxToolDef) => string): FxAgentTool[] {
  return FX_TOOL_DEFS.map((def) => ({
    name: def.name,
    description: describe(def),
    inputSchema: FX_SCHEMAS[def.name],
    idempotent,
    ...(def.mode === 'write' ? { writes: true as const } : {}),
    [WORKSPACE_TOOL]: true as const,
    async execute(input: unknown, context: FxCallContext) {
      if (!isRecord(context) || typeof context.sessionId !== 'string' || typeof context.executionId !== 'string') {
        throw new TypeError(`harness-world-hands: ${def.name} is a libfx host tool: libfx calls it with { sessionId, executionId }`);
      }
      const result = await store.call(def, input, context);
      return result.isError ? { type: 'libfx.tool-result' as const, text: result.text, images: [], isError: true as const } : result.text;
    },
  }));
}

interface FxStore {
  call(def: FxToolDef, input: unknown, context: FxCallContext): Promise<FxResult>;
}

/** Run `fn` after every earlier call queued on `key`. */
function serialized(queues: Map<string, Promise<unknown>>, key: string, fn: () => Promise<FxResult>): Promise<FxResult> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** A call libfx cut off (its turn was cancelled, the function's deadline): nothing it changed is kept or recorded. */
const cutOff = (signal: AbortSignal | undefined) =>
  signal?.aborted ? Object.assign(new Error('this call was cut off before it finished, so nothing it changed was kept'), { cause: signal.reason, code: 'EINTR' }) : undefined;

// The in-memory workspace -----------------------------------------------------

/**
 * In memory, per session in this process: a session's files last while this
 * process runs it (up to `MAX_SESSIONS` sessions, the least recently used
 * freed first, and one idle for `IDLE_MS` is freed). libfx calls a tool with
 * the session's `context`: when an app passes a new `context` per turn
 * (`agent.session(id, { context })`), a turn with another one starts with an
 * empty workspace.
 */
class FxMemory implements FxStore {
  private static readonly MAX_SESSIONS = 256;
  private static readonly IDLE_MS = 15 * 60_000;
  private readonly turns: TurnWorkspaces;
  private readonly scopes = new Map<string, { scope: object; timer?: ReturnType<typeof setTimeout> }>();

  constructor(options: MachineOptions) {
    this.turns = new TurnWorkspaces(options);
  }

  async call(def: FxToolDef, input: unknown, context: FxCallContext): Promise<FxResult> {
    const sessionId = context.sessionId;
    let entry = this.scopes.get(sessionId);
    if (entry) this.scopes.delete(sessionId);
    entry ??= { scope: {} };
    this.scopes.set(sessionId, entry);
    clearTimeout(entry.timer);
    for (const [id, old] of this.scopes) {
      if (this.scopes.size <= FxMemory.MAX_SESSIONS) break;
      this.forget(id, old);
    }
    const scope = entry;
    const turn = JSON.stringify(context.context ?? null);
    try {
      return await this.turns.call(
        scope.scope,
        turn,
        def.mode,
        async (machine) => {
          const result = await def.run(input, machine);
          const cut = cutOff(context.signal);
          if (cut) throw cut;
          // A call that failed having changed nothing changed nothing here either.
          if (result.isError && !result.ran && def.mode === 'write') await machine.rollback();
          return result;
        },
        { session: sessionId, ...(context.signal ? { signal: context.signal } : {}) }
      );
    } finally {
      if (this.scopes.get(sessionId) === scope) {
        scope.timer = setTimeout(() => this.forget(sessionId, scope), FxMemory.IDLE_MS);
        (scope.timer as { unref?: () => void }).unref?.();
      }
    }
  }

  private forget(sessionId: string, entry: { scope: object; timer?: ReturnType<typeof setTimeout> }) {
    clearTimeout(entry.timer);
    if (this.scopes.get(sessionId) === entry) this.scopes.delete(sessionId);
    this.turns.release(entry.scope);
  }
}

// The durable workspace: per-call records in a World stream ----------------------

/** Whether a World read failed only because the stream is not there yet. */
async function missingStream(world: World, runId: string, name: string): Promise<boolean> {
  return !(await world.streams.list(runId).catch(() => [name])).includes(name);
}

/** Every record of the session, in order; `chunks` is how many chunks the stream had. */
export async function readFxRecords(world: World, sessionId: string): Promise<{ records: FxWorkspaceRecord[]; chunks: number }> {
  const name = fxWorkspaceStreamName(sessionId);
  const records: FxWorkspaceRecord[] = [];
  let chunks = 0;
  let buffer = '';
  let cursor: string | undefined;
  const decoder = new TextDecoder();
  for (;;) {
    let page: Awaited<ReturnType<World['streams']['getChunks']>>;
    try {
      page = await world.streams.getChunks(sessionId, name, cursor ? { cursor } : {});
    } catch (err) {
      // No stream yet is no records; any other failed read must not pass for an empty workspace.
      if (chunks === 0 && (await missingStream(world, sessionId, name))) return { records: [], chunks: 0 };
      throw err;
    }
    for (const chunk of page.data) {
      buffer += decoder.decode(chunk.data, { stream: true });
      chunks++;
    }
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  for (const line of buffer.split('\n')) {
    if (!line) continue;
    const value = decodeLine(line) as Partial<FxWorkspaceRecord> | null;
    if (value && typeof value.executionId === 'string' && typeof value.output === 'string' && isRecord(value.files)) records.push(value as FxWorkspaceRecord);
  }
  return { records, chunks };
}

/** The files a session's records leave (path to entry), and each call's first record by `executionId`. */
export function foldFxRecords(records: readonly FxWorkspaceRecord[]): { entries: Map<string, FileEntry>; done: Map<string, FxWorkspaceRecord> } {
  const entries = new Map<string, FileEntry>();
  const done = new Map<string, FxWorkspaceRecord>();
  for (const record of records) {
    // A call's first record is its outcome: a second one (another worker that ran it too) changes nothing.
    if (done.has(record.executionId)) continue;
    done.set(record.executionId, record);
    for (const [path, value] of Object.entries(record.files)) {
      if (!isWorkspacePath(path)) continue;
      if (value === null) entries.delete(path);
      else {
        const entry = normalizeEntry(value);
        if (entry !== undefined) entries.set(path, entry);
      }
    }
  }
  return { entries, done };
}

/**
 * A session's workspace as its records leave it: every file's content (text,
 * or bytes when it is not UTF-8) and mode, and the records. For a UI's files
 * panel; the tools never need it.
 */
export async function readFxWorkspace(world: World, sessionId: string): Promise<{ files: Map<string, { content: BlobContent; mode: number }>; records: FxWorkspaceRecord[] }> {
  const { records } = await readFxRecords(world, sessionId);
  const { entries } = foldFxRecords(records);
  const files = new Map<string, { content: BlobContent; mode: number }>();
  let blobs: Map<string, BlobContent> | undefined;
  for (const [path, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let content = inlineContent(entry);
    if (content === undefined) {
      blobs ??= await readBlobContents(world, sessionId);
      content = blobs.get((entry as { h: string }).h);
    }
    if (content !== undefined) files.set(path, { content, mode: modeOf(entry) });
  }
  return { files, records };
}

const contentKey = (e: FileEntry): string => (typeof e === 'string' ? `t${e}` : 'h' in e ? `h${e.h}` : 'd' in e ? `d${e.d}` : `t${e.t}`);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One session's workspace in this process: its machine, kept equal to what its records leave. */
class FxSession {
  /** What the machine holds: path to the content key and mode it was synced or written from. */
  held = new Map<string, { content: string; mode: number }>();
  blobs = new Map<string, BlobContent>();
  entries = new Map<string, FileEntry>();
  done = new Map<string, FxWorkspaceRecord>();
  /** Chunks of the record stream folded into `entries`. */
  chunks = -1;
  machine?: VirtualMachine;
  checked = false;
}

class FxRecords implements FxStore {
  private readonly sessions = new Map<string, FxSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private world?: Promise<World>;

  constructor(
    private readonly worldOf: () => World | Promise<World>,
    private readonly options: MachineOptions
  ) {}

  call(def: FxToolDef, input: unknown, context: FxCallContext): Promise<FxResult> {
    return serialized(this.queues, context.sessionId, () => this.run(def, input, context));
  }

  private session(sessionId: string): FxSession {
    let s = this.sessions.get(sessionId);
    if (s) this.sessions.delete(sessionId);
    s ??= new FxSession();
    this.sessions.set(sessionId, s);
    // A bounded number of sessions keep a machine in this process; the others rebuild from their records.
    for (const [id, old] of this.sessions) {
      if (this.sessions.size <= 64) break;
      old.machine?.dispose();
      this.sessions.delete(id);
    }
    return s;
  }

  private async run(def: FxToolDef, input: unknown, context: FxCallContext): Promise<FxResult> {
    const world = await (this.world ??= Promise.resolve().then(this.worldOf).catch((err) => {
      this.world = undefined;
      throw err;
    }));
    const sessionId = context.sessionId;
    const s = this.session(sessionId);
    if (!s.checked) {
      await checkSession(world, sessionId);
      s.checked = true;
    }
    await this.refresh(world, sessionId, s);
    // libfx ran this call before (a crash came after its record, before libfx stored its result): the same outcome, not a second run.
    const done = s.done.get(context.executionId);
    if (done) return done.isError ? { text: done.output, isError: true } : { text: done.output };
    if (!s.machine || s.machine.lost) {
      s.machine?.dispose();
      s.machine = await createMachine({ ...this.options, session: sessionId, ...(context.signal ? { signal: context.signal } : {}) });
      s.held.clear();
    }
    const machine = s.machine;
    return machine.hold(async () => {
      await this.sync(world, sessionId, s, machine);
      const m = machine.during(context.signal);
      if (def.mode === 'read') return def.run(input, m);
      await machine.checkpoint();
      let result: FxResult;
      let diff: [string, Uint8Array | null, number][];
      try {
        result = await def.run(input, m);
        const cut = cutOff(context.signal);
        if (cut) throw cut;
        if (result.isError && !result.ran) {
          await machine.rollback();
          diff = [];
        } else {
          // The records hold no links: after a call, a link to a file is a copy of it, any other link is gone.
          diff = await machine.diff({ unlink: true });
        }
      } catch (err) {
        await this.rollback(machine);
        throw untouched(err, machine);
      }
      try {
        const record = await this.record(world, sessionId, s, def.name, context.executionId, result, diff);
        // Our own record is the stream's next chunk unless another writer's came first (then the next call reads them all).
        s.chunks = s.chunks >= 0 ? s.chunks + 1 : -1;
        this.apply(s, record);
      } catch (err) {
        await this.rollback(machine);
        throw err;
      }
      await machine.release().catch(() => {});
      return result;
    });
  }

  private async rollback(machine: VirtualMachine): Promise<void> {
    try {
      await machine.rollback();
      await machine.release();
    } catch {
      machine.dispose();
    }
  }

  /** Fold the records written since this process last read them (by this process's own calls, or another's). */
  private async refresh(world: World, sessionId: string, s: FxSession): Promise<void> {
    const name = fxWorkspaceStreamName(sessionId);
    if (s.chunks >= 0) {
      const info = await world.streams.getInfo(sessionId, name).catch(async (err) => {
        if (await missingStream(world, sessionId, name)) return { tailIndex: -1 };
        throw err;
      });
      if (info.tailIndex + 1 === s.chunks) return;
    }
    const { records, chunks } = await readFxRecords(world, sessionId);
    const { entries, done } = foldFxRecords(records);
    s.entries = entries;
    s.done = done;
    s.chunks = chunks;
  }

  private apply(s: FxSession, record: FxWorkspaceRecord): void {
    if (s.done.has(record.executionId)) return;
    s.done.set(record.executionId, record);
    for (const [path, entry] of Object.entries(record.files)) {
      if (entry === null) {
        s.entries.delete(path);
        s.held.delete(path);
      } else {
        s.entries.set(path, entry);
        s.held.set(path, { content: contentKey(entry), mode: modeOf(entry) });
      }
    }
  }

  /** Make the machine hold exactly what the records leave (one round trip). */
  private async sync(world: World, sessionId: string, s: FxSession, machine: VirtualMachine): Promise<void> {
    const changed = [...s.entries].filter(([path, e]) => {
      const held = s.held.get(path);
      return held?.content !== contentKey(e) || held.mode !== modeOf(e);
    });
    const removes = [...s.held.keys()].filter((path) => !s.entries.has(path));
    if (changed.some(([path, e]) => typeof e !== 'string' && 'h' in e && !s.blobs.has(e.h) && s.held.get(path)?.content !== contentKey(e))) {
      for (const [h, content] of await readBlobContents(world, sessionId)) s.blobs.set(h, content);
    }
    const writes: FileBytes[] = [];
    const chmods: [string, number][] = [];
    for (const [path, e] of changed) {
      const mode = modeOf(e);
      if (s.held.get(path)?.content === contentKey(e)) {
        chmods.push([path, mode]);
        continue;
      }
      const content = inlineContent(e) ?? s.blobs.get((e as { h: string }).h);
      if (content === undefined) throw new Error(`harness-world-hands: ${path}'s blob ${(e as { h: string }).h} is missing from ${blobStreamName(sessionId)}`);
      writes.push([path, typeof content === 'string' ? encoder.encode(content) : content, mode]);
    }
    if (writes.length || removes.length || chmods.length) await machine.apply(writes, removes, chmods);
    for (const path of removes) s.held.delete(path);
    for (const [path, e] of changed) s.held.set(path, { content: contentKey(e), mode: modeOf(e) });
  }

  /** Write the call's record: its changed files' blobs first (anything over 4 KB, or past the record's inline budget), then the record. */
  private async record(world: World, sessionId: string, s: FxSession, tool: string, executionId: string, result: FxResult, diff: [string, Uint8Array | null, number][]): Promise<FxWorkspaceRecord> {
    const files: Record<string, FileEntry | null> = {};
    let inline = 0;
    for (const [path, bytes, mode] of [...diff].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!bytes) {
        files[path] = null;
        continue;
      }
      let text: string | undefined;
      try {
        text = strictUtf8.decode(bytes);
      } catch {}
      const m = mode !== DEFAULT_FILE_MODE ? { m: mode } : {};
      const entry: FileEntry = text !== undefined ? (mode === DEFAULT_FILE_MODE ? text : { t: text, m: mode }) : { d: bytesToBase64(bytes), ...m };
      const size = byteLength(JSON.stringify(entry));
      if (size <= INLINE_FILE_MAX_BYTES && inline + size <= MANIFEST_INLINE_BUDGET_BYTES) {
        files[path] = entry;
        inline += size;
        continue;
      }
      const content: BlobContent = text ?? bytes;
      const h = await sha256Hex(content);
      if (!s.blobs.has(h)) await writeBlob(world, sessionId, content, { hash: h });
      s.blobs.set(h, content);
      files[path] = { n: bytes.length, h, ...(text === undefined ? { b: 1 as const } : {}), ...m };
    }
    const record: FxWorkspaceRecord = { v: 1, executionId, tool, output: result.text, ...(result.isError ? { isError: true as const } : {}), at: Date.now(), files };
    await world.streams.write(sessionId, fxWorkspaceStreamName(sessionId), encoder.encode(`${encodeLine(record)}\n`));
    return record;
  }
}

/**
 * A durable fx workspace keeps its records in the session's run, so the
 * session must be libfx's run in this World: an agent on `memory()` has none
 * (use `virtual({ durable: false })`), and an agent whose sessions live in
 * another World needs that World passed as `world`.
 */
const VIRTUAL_SESSION_HINT =
  "fxTools(virtual()) keeps the workspace's files in the session's run, in the World the agent keeps its sessions in: pass that World as fxTools(virtual(), { world }), or use virtual({ durable: false }) for files kept in memory (an agent on libfx's memory() durability has no run to keep them in)";
const SANDBOX_SESSION_HINT =
  "fxTools(sandbox()) arms the session's sandbox with the lease libfx keeps in the session's run, in the World the agent keeps its sessions in: pass that World as fxTools(sandbox(), { world }) (an agent on libfx's memory() durability has no run, and no lease to fence a sandbox with)";

async function checkSession(world: World, sessionId: string, hint = VIRTUAL_SESSION_HINT): Promise<void> {
  if (!/^wrun_[0-9A-Za-z]{10,64}$/.test(sessionId)) throw new TypeError(`durable-harness/fx: session ${JSON.stringify(sessionId)} is not a World run: ${hint}`);
  let run: { workflowName?: string };
  try {
    run = await world.runs.get(sessionId, { resolveData: 'none' });
  } catch (err) {
    if ((err as { name?: unknown } | undefined)?.name === 'WorkflowRunNotFoundError') throw new TypeError(`durable-harness/fx: session ${sessionId} is not a run in this World: ${hint}`);
    throw err;
  }
  if (run.workflowName !== LIBFX_WORKFLOW) throw new TypeError(`durable-harness/fx: ${sessionId} is a ${String(run.workflowName)} run, not a libfx session`);
}

