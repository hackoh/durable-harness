import { base64ToBytes, type DocSnapshot, defineDoc, type DriveContext, readBlobContents, readDoc } from 'harness-world';
import { WORKSPACE_ROOT } from './paths.ts';

/**
 * The workspace's files as the log has them, for every reader: the tools,
 * UIs, tests. Two formats:
 *
 * - **Document-backed** (`workspaceTools()`): the `hw.workspace` document, a
 *   manifest keyed by path (`FileEntry`). A file of at most 4 KB is its text,
 *   inline; a larger one is `{ n, h }` (its size and the SHA-256 of its
 *   bytes), its content in the session's blob stream (harness-world's
 *   `blobs.ts`). A file whose bytes are not UTF-8 is kept as bytes (base64,
 *   inline as `{ d }` or in the stream as `{ n, h, b: 1 }`), and a mode other
 *   than 0o644 is `m`. Each tool call's change to the manifest rides on the
 *   call's own outcome.
 * - **Legacy** (`legacyWorkspaceTools()`, and hybrid sessions): `fs` steps
 *   holding the changed files' contents, and sandbox settlements, folded in
 *   log order.
 *
 * Once a session's manifest has been written it is the whole truth, and the
 * legacy records are ignored. No Node APIs and no just-bash here.
 */

/**
 * A manifest entry: one file. Its content is one of
 *
 * - a string: its text, inline (at most `INLINE_FILE_MAX_BYTES` as a JSON string), mode 0o644;
 * - `{ t, m }`: its text, inline, with a mode other than 0o644;
 * - `{ d, m? }`: its bytes, inline, as base64 (bytes that are not UTF-8: a gzip, an image);
 * - `{ n, h, b?, m? }`: its bytes in the session's blob stream, named by their SHA-256.
 *
 * Every field but the content is optional and written only when it is not
 * the default (`m`), or advisory (`n`, `b`). The fold merges an entry's
 * fields one by one when two writers change one path in a rebase window, so
 * a reader takes the content from exactly one field, `h` before `d` before
 * `t`: always the content one writer wrote, never a mix of two.
 */
export type FileEntry = string | BlobEntry | InlineEntry;
export interface BlobEntry {
  /** The file's size in bytes (advisory: what UIs show before reading the blob). */
  n: number;
  /** SHA-256 (hex) of the file's bytes: the blob's name. */
  h: string;
  /** The bytes are not UTF-8 (the blob is stored as base64). Advisory: the blob's own line says how it is stored. */
  b?: 1;
  /** The file's mode (permission bits), when not 0o644. */
  m?: number;
}
export type InlineEntry =
  /** Text, inline, with a mode other than 0o644 (with the default mode an inline text is a plain string). */
  | { t: string; m: number }
  /** Bytes that are not UTF-8, inline, as base64. */
  | { d: string; m?: number };

/** A file's mode when its entry says none. */
export const DEFAULT_FILE_MODE = 0o644;

/** The `hw.workspace` document. */
export interface WorkspaceManifest {
  files: Record<string, FileEntry>;
}

/**
 * The document-backed workspace's manifest. `hw.` is harness-world's: write
 * it through the workspace tools, not by hand (a blob entry whose blob is not
 * in the stream fails the session that reads it). It changes on every call
 * that changes a file and can be up to 64 KB, so its live `doc` events carry
 * the revision, not the value (`live: 'revision'`): read it when you want it.
 */
export const WorkspaceDoc = defineDoc<WorkspaceManifest>({ kind: 'hw.workspace', version: 1, live: 'revision', initial: () => ({ files: {} }) });

/** Files up to this many bytes as JSON (a text's JSON string, a binary file's base64) are kept inline in the manifest (so a small edit stays inline in world-vercel's 8,000-byte event budget). */
export const INLINE_FILE_MAX_BYTES = 4096;
/** Past this many bytes of manifest, new and changed files go to blobs, however small: the rest of the 64 KB is for entries. */
export const MANIFEST_INLINE_BUDGET_BYTES = 48 * 1024;

type State_ = ReturnType<DriveContext['state']>;
type Record_ = State_['effectOrder'][number];

/** A path strictly under the workspace root, with no `.`/`..` segments. */
export function isWorkspacePath(path: string): boolean {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) return false;
  return !path.slice(WORKSPACE_ROOT.length + 1).split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export const isBlobEntry = (e: unknown): e is BlobEntry =>
  typeof e === 'object' && e !== null && typeof (e as BlobEntry).h === 'string' && /^[0-9a-f]{64}$/.test((e as BlobEntry).h);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const validMode = (m: unknown): m is number => Number.isSafeInteger(m) && (m as number) >= 0 && (m as number) <= 0o7777;

/** An entry's mode: its `m`, or 0o644. */
export const modeOf = (e: FileEntry): number => (typeof e === 'string' ? DEFAULT_FILE_MODE : (e.m ?? DEFAULT_FILE_MODE));

/**
 * One manifest value as a well-formed entry, or undefined: a string; else
 * the content from `h`, `d` or `t` (in that order, see `FileEntry`), with
 * `m` when it is a mode other than 0o644 and `n`/`b` on a blob. Fields that
 * are not the content (another writer's, after a rebase) are left out.
 */
export function normalizeEntry(entry: unknown): FileEntry | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const e = entry as Record<string, unknown>;
  const m = validMode(e.m) && e.m !== DEFAULT_FILE_MODE ? e.m : undefined;
  const mode = m !== undefined ? { m } : {};
  if (isBlobEntry(e)) return { n: typeof e.n === 'number' ? e.n : -1, h: e.h, ...(e.b === 1 ? { b: 1 as const } : {}), ...mode };
  if (typeof e.d === 'string' && BASE64.test(e.d)) return { d: e.d, ...mode };
  if (typeof e.t === 'string') return m !== undefined ? { t: e.t, m } : e.t;
  return undefined;
}

/** An entry's inline content (text, or bytes), or undefined for a blob. */
export function inlineContent(e: FileEntry): string | Uint8Array | undefined {
  if (typeof e === 'string') return e;
  if ('h' in e) return undefined;
  return 'd' in e ? base64ToBytes(e.d) : e.t;
}

/** Whether the session's workspace is document-backed: its manifest has been written. */
export function hasWorkspaceDoc(state: Pick<State_, 'docs'>): boolean {
  return (state.docs?.get(WorkspaceDoc.definition.kind)?.revision ?? 0) > 0;
}

/**
 * The manifest's well-formed entries (`normalizeEntry`), under paths in the
 * workspace root. Anything else (an app's hand edit) is left out.
 */
export function manifestEntries(snapshot: Pick<DocSnapshot<WorkspaceManifest>, 'value'>): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const files = (snapshot.value as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null) return out;
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (!isWorkspacePath(path)) continue;
    const e = normalizeEntry(entry);
    if (e !== undefined) out.set(path, e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The legacy format

/** One `fs` step's output: new contents per path, `null` for deleted. */
export interface FileChanges {
  files: Record<string, string | null>;
}

/** An `fs` step's input: the paths it changed and the tool call that changed them. */
export interface FsInput {
  paths: string[];
  /** The step id of the tool call whose work this is (absent in older logs). */
  of?: string;
  /** That step's attempt when it wrote this (for in-place retries). */
  attempt?: number;
}

/**
 * Whether an `fs` step's changes are part of the workspace. A tool's file
 * changes count once the tool call itself has an outcome. While the call is
 * still open (the process running it died after it wrote its files but
 * before it reported) or after it was released and retried (its step was
 * replaced by the retry's), they are a partial first attempt, and a retry
 * must start from the workspace as it was before that attempt.
 */
function ownerStands(state: State_, e: Record_): boolean {
  const input = e.input as FsInput | undefined;
  if (!input?.of) return true;
  const owner = state.effectOrder.find((r) => r.stepId === input.of);
  if (!owner) return false;
  if (owner.status !== 'completed' && owner.status !== 'failed') return false;
  return input.attempt === undefined || owner.attempt === input.attempt;
}

/**
 * The file changes a legacy log record makes, in log order: a completed `fs`
 * step, or an accepted `settle` step carrying what a sandbox command changed
 * (it takes effect at its intent, like the settlement itself).
 */
export function fileChangesOf(e: Record_, state?: State_): FileChanges['files'] | undefined {
  if (e.name === 'fs' && e.status === 'completed') {
    if (state && !ownerStands(state, e)) return undefined;
    return (e.output as FileChanges).files;
  }
  if (e.name === 'settle') {
    const files = (e.input as { ok?: boolean; files?: FileChanges['files'] } | undefined)?.files;
    if (!files || typeof files !== 'object') return undefined;
    // A settlement is computed from a VM the command controls: only paths
    // under the workspace root ever count, whatever it names.
    const kept = Object.fromEntries(Object.entries(files).filter(([path]) => isWorkspacePath(path)));
    return Object.keys(kept).length > 0 ? kept : undefined;
  }
  return undefined;
}

/** The legacy records' files: the fold of every `fs` step and settlement. */
export function legacyFiles(state: State_): Record<string, string> {
  const files: Record<string, string> = {};
  for (const e of state.effectOrder) {
    const changes = fileChangesOf(e, state);
    if (!changes) continue;
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Readers

/** One file, as the log has it. */
export interface WorkspaceFile {
  path: string;
  /** Its size in bytes (-1 when a blob entry does not say). */
  bytes: number;
  /** In the log itself; otherwise in the blob stream (`readWorkspace` reads it). */
  inline: boolean;
  /** The text, when it is inline text. */
  text?: string;
  /** The blob's SHA-256, when it is not inline. */
  hash?: string;
  /** Its bytes are not UTF-8 (a gzip, an image): `readWorkspace` gives them as a `Uint8Array`. */
  binary?: true;
  /** Its mode, when not 0o644 (`0o755` for a script made executable). */
  mode?: number;
}

const utf8 = new TextEncoder();

/** Every file of the workspace as of the fold, sorted by path, without fetching anything (for UIs). */
export function workspaceManifest(state: State_): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  if (hasWorkspaceDoc(state)) {
    for (const [path, entry] of manifestEntries(readDoc(state, WorkspaceDoc))) {
      const mode = modeOf(entry) !== DEFAULT_FILE_MODE ? { mode: modeOf(entry) } : {};
      if (typeof entry !== 'string' && 'h' in entry) {
        out.push({ path, bytes: entry.n, inline: false, hash: entry.h, ...(entry.b ? { binary: true as const } : {}), ...mode });
        continue;
      }
      const content = inlineContent(entry)!;
      out.push(
        typeof content === 'string'
          ? { path, bytes: utf8.encode(content).length, inline: true, text: content, ...mode }
          : { path, bytes: content.length, inline: true, binary: true, ...mode }
      );
    }
  } else {
    for (const [path, text] of Object.entries(legacyFiles(state))) out.push({ path, bytes: utf8.encode(text).length, inline: true, text });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The workspace's text files whose text is in the log, path to text
 * (synchronous, for UIs and tests). A document-backed workspace keeps files
 * over 4 KB in the blob stream, and binary files are bytes, not text: both
 * are left out here; `readWorkspace` has every file.
 */
export function filesFromState(state: State_): Record<string, string> {
  if (!hasWorkspaceDoc(state)) return legacyFiles(state);
  const files: Record<string, string> = {};
  for (const f of workspaceManifest(state)) if (f.text !== undefined) files[f.path] = f.text;
  return files;
}

/**
 * Every workspace file with its content, the large ones read from the
 * session's blob stream (hash-checked): a text file (bytes that are UTF-8)
 * as its text, a binary file as a `Uint8Array` of its bytes. Throws when a
 * blob the manifest names is not there (the World lost it).
 */
export async function readWorkspace(world: DriveContext['world'], state: State_): Promise<Record<string, string | Uint8Array>> {
  const files: Record<string, string | Uint8Array> = {};
  if (!hasWorkspaceDoc(state)) return legacyFiles(state);
  const entries = manifestEntries(readDoc(state, WorkspaceDoc));
  const wanted = [...entries.values()].some((e) => typeof e !== 'string' && 'h' in e);
  const blobs = wanted ? await readBlobContents(world, state.runId) : new Map<string, string | Uint8Array>();
  for (const [path, e] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof e === 'string' || !('h' in e)) {
      files[path] = inlineContent(e)!;
      continue;
    }
    const content = blobs.get(e.h);
    if (content === undefined) throw new Error(`harness-world-hands: ${path}'s blob ${e.h} is missing from the session's blob stream`);
    files[path] = content;
  }
  return files;
}
