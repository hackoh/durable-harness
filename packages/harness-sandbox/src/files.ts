/**
 * The Drive's manifest (docs/workspaces.md §8 "Files panel"): the
 * `hw.sandbox-files` document, a snapshot of the session's `/workspace` kept
 * in the log, so a UI reads it with no VM (one that stopped included). The
 * Drive is the source of truth; the manifest says what it held at `at`.
 *
 * - **Built incrementally.** A harness reports each mutating call as it ends
 *   (`DriveFiles.changed`): a live, stream-only event (`drive_files`), so a
 *   page updates mid-turn, and the paths the call named, which the next
 *   snapshot looks at first. A snapshot (`DriveFiles.snapshot`, at a turn's
 *   end) is a stat-only listing through the relay's helper (`list` and
 *   `stat`, breadth first, so the shallow paths come first), plus the text of
 *   small files: a file whose size and mtime are the previous snapshot's
 *   keeps its text without a read, and nothing is ever hashed, so a Drive
 *   holding a `node_modules` costs nothing (it is listed by name, never
 *   walked: `SKIPPED_DIRS`).
 * - **Bounded.** At most `DRIVE_MANIFEST_LIMITS.entries` (500) entries and
 *   `bytes` (48 KB) of JSON, with a file's text inline only when it is UTF-8
 *   and at most `inlineBytes` (4 KB) as JSON, within that budget; past either
 *   bound the manifest says `truncated`.
 * - **Best effort.** A snapshot gets a few seconds at most, none when the
 *   invocation is near its end, and never throws: a listing cut off by its
 *   deadline keeps the previous snapshot's entries it didn't reach, and one
 *   that fails (the link lost) leaves the document as it was.
 * - **Caught up.** The manifest counts the log's mutating tool calls it has
 *   seen (`calls`): an invocation that ended before it listed (a crash) left
 *   more calls in the log than that, and the next one lists first
 *   (`DriveFiles.catchUp`).
 *
 * A leaf (harness-world only, and types): `durable-harness/tools` reads the
 * manifest through it (`readDriveManifest`) without loading the session
 * factory, the relay link or `@vercel/sandbox`.
 */
import { defineDoc, type DriveContext, type EffectRecord, readDoc, type SessionState } from 'harness-world';

/** One path of the Drive, as the snapshot saw it. */
export interface DriveEntry {
  /** Size in bytes (a link's: its target's). */
  n: number;
  /** Last modified, ms since the epoch. */
  t: number;
  /** A directory. */
  d?: 1;
  /** A symbolic link (its target's type, size and time). */
  l?: 1;
  /** A directory listed by name only (`SKIPPED_DIRS`: a `node_modules`, a `.git`). */
  s?: 1;
  /** The file's text: UTF-8, at most `inlineBytes` as JSON, within the manifest's budget. */
  x?: string;
  /** Small, but not UTF-8 text (an image, a gzip): no text, and not read again while its size and mtime stay. */
  b?: 1;
}

/** The `hw.sandbox-files` document. */
export interface DriveManifest {
  /** When the snapshot was taken (ms since the epoch); 0 before the first. */
  at: number;
  /** The Drive it lists (`MachineRecord.driveId`), when the machine said. */
  driveId?: string;
  /** The log's mutating tool calls when it was taken (`mutatingCalls`): fewer than the log holds now, and it is behind. */
  calls: number;
  /** Path (`/workspace/...`) to entry. */
  files: Record<string, DriveEntry>;
  /** Paths left out: past the entry or byte bound, or not reached before the snapshot's deadline. */
  truncated?: true;
}

/** The manifest's bounds. */
export const DRIVE_MANIFEST_LIMITS = Object.freeze({ entries: 500, bytes: 48 * 1024, inlineBytes: 4096 });

/** Directories listed by name and never walked: a package manager's, a VCS's, a build cache's (their contents are not the agent's work, and can be huge). */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.turbo', '.cache', '.pnpm-store', '.yarn', '.venv', 'venv', '__pycache__', '.gradle', '.terraform']);

/** The name the manifest gives the Drive's root, whatever the machine's root is (the stand-in's is a temp dir). */
export const DRIVE_ROOT = '/workspace';

/** The live event a mutating call's end publishes (stream-only: nothing of it is in the log). */
export const DRIVE_FILES_EVENT = 'drive_files';

/** What `drive_files` carries: the call, and the paths it named (none for a shell command: it may have changed anything). */
export interface DriveFilesEvent {
  type: typeof DRIVE_FILES_EVENT;
  tool: string;
  callId: string;
  paths?: string[];
  t: number;
}

/**
 * The `hw.sandbox-files` document. `hw.` is harness-world's: written by the
 * sandbox tier only. Its live `doc` events carry the revision, not the
 * value (it can be 48 KB): read it when you want it.
 */
export const DRIVE_FILES_DOC = defineDoc<DriveManifest>({ kind: 'hw.sandbox-files', version: 1, live: 'revision', initial: () => ({ at: 0, calls: 0, files: {} }) });

/** One path of the Drive, as a reader gets it (`readDriveManifest`). */
export interface DriveFile {
  /** `/workspace/...`. */
  path: string;
  bytes: number;
  mtimeMs: number;
  directory?: true;
  link?: true;
  /** A directory listed by name only (`node_modules`, `.git`): its contents are not in the manifest. */
  skipped?: true;
  /** Small, but not UTF-8 text. */
  binary?: true;
  /** The text, when the manifest keeps it inline. */
  text?: string;
}

/** The Drive as of its last snapshot (`readDriveManifest`). */
export interface DriveSnapshot {
  /** When it was taken (ms since the epoch). */
  at: number;
  driveId?: string;
  /** Some paths are not in it (bounds, or a deadline). */
  truncated: boolean;
  /** Sorted by path. */
  files: DriveFile[];
}

/**
 * The session's Drive as of its last snapshot, from the log alone (no VM,
 * no World read): undefined before the first. A snapshot, not the Drive: the
 * Drive is the source of truth, and may have changed since `at`.
 */
export function readDriveManifest(state: Pick<SessionState, 'docs'>): DriveSnapshot | undefined {
  if ((state.docs?.get(DRIVE_FILES_DOC.definition.kind)?.revision ?? 0) === 0) return undefined;
  const value = readDoc(state as SessionState, DRIVE_FILES_DOC).value;
  const files: DriveFile[] = [];
  for (const [path, e] of Object.entries(value.files ?? {})) {
    if (!path.startsWith(`${DRIVE_ROOT}/`) || typeof e !== 'object' || e === null) continue;
    files.push({
      path,
      bytes: typeof e.n === 'number' ? e.n : -1,
      mtimeMs: typeof e.t === 'number' ? e.t : 0,
      ...(e.d ? { directory: true as const } : {}),
      ...(e.l ? { link: true as const } : {}),
      ...(e.s ? { skipped: true as const } : {}),
      ...(e.b ? { binary: true as const } : {}),
      ...(typeof e.x === 'string' ? { text: e.x } : {}),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { at: typeof value.at === 'number' ? value.at : 0, ...(typeof value.driveId === 'string' ? { driveId: value.driveId } : {}), truncated: value.truncated === true, files };
}

/** The log's mutating tool calls (`never`, `unsafe`): what can have changed the Drive. */
export function mutatingCalls(state: Pick<SessionState, 'effectOrder'>): number {
  return state.effectOrder.filter((e: EffectRecord) => e.name.startsWith('tool.') && e.replay !== 'safe').length;
}

/** Whether the log holds mutating calls the manifest never saw (an invocation ended before its snapshot). */
export function driveManifestBehind(state: Pick<SessionState, 'docs' | 'effectOrder'>): boolean {
  const seen = (state.docs?.get(DRIVE_FILES_DOC.definition.kind)?.revision ?? 0) > 0 ? readDoc(state as SessionState, DRIVE_FILES_DOC).value.calls : 0;
  return mutatingCalls(state) > (typeof seen === 'number' ? seen : 0);
}

// ---------------------------------------------------------------------------
// The listing

/** What a listing reads: the session machine's workspace (`RemoteMachine`), structurally. Reads only: an unfenced attach may list. */
export interface DriveReader {
  readonly root: string;
  list(dir: string): Promise<{ name: string; type: 'file' | 'directory' | 'symlink' }[]>;
  stat(path: string): Promise<{ type: 'file' | 'directory' | 'symlink'; size: number; mtimeMs: number } | undefined>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface ListDriveOptions {
  /** When the listing stops (ms since the epoch): what it didn't reach is kept from `previous`, and the manifest says `truncated`. */
  deadline: number;
  /** Paths the calls since the last snapshot named: looked at first (`/workspace/...`, relative, or under the reader's root). */
  touched?: Iterable<string>;
  /** `mutatingCalls` of the log now. */
  calls: number;
  driveId?: string;
  /** Concurrent helper calls. Default 8. */
  concurrency?: number;
  now?: () => number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
/** A manifest's fixed fields, as JSON: kept out of the entries' budget. */
const HEAD_BYTES = 160;

/** An entry's bytes in the manifest's JSON: its key, its value, the colon and a comma. */
const entryBytes = (path: string, e: DriveEntry) => byteLength(JSON.stringify(path)) + byteLength(JSON.stringify(e)) + 2;

/** The manifest key of a path the machine or a call names, or undefined for one outside the Drive. */
export function driveKey(root: string, path: string): string | undefined {
  if (typeof path !== 'string' || !path || path.includes('\0')) return undefined;
  const base = root.replace(/\/+$/, '');
  let rel: string;
  if (path === base || path === DRIVE_ROOT) rel = '';
  else if (path.startsWith(`${base}/`)) rel = path.slice(base.length + 1);
  else if (path.startsWith(`${DRIVE_ROOT}/`)) rel = path.slice(DRIVE_ROOT.length + 1);
  else if (!path.startsWith('/')) rel = path;
  else return undefined;
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return undefined;
    parts.push(seg);
  }
  return parts.length ? `${DRIVE_ROOT}/${parts.join('/')}` : undefined;
}

/** Run `work` over `items`, `n` at a time, starting none past `deadline` (a failed one is skipped); resolves with how many started, once every one of them settled. */
async function pool<T>(items: readonly T[], n: number, deadline: () => boolean, work: (item: T) => Promise<void>): Promise<number> {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !deadline()) await work(items[next++]!).catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return next;
}

/**
 * List the Drive, stat-only (see the module comment), as the next manifest:
 * `previous`'s texts reused where a file's size and mtime are unchanged,
 * `touched` paths first, then breadth first from the root, within the
 * bounds and the deadline. Throws only if the root can't be listed at all.
 */
export async function listDrive(fs: DriveReader, previous: DriveManifest | undefined, options: ListDriveOptions): Promise<DriveManifest> {
  const now = options.now ?? Date.now;
  const late = () => now() >= options.deadline;
  const n = options.concurrency ?? 8;
  const root = fs.root.replace(/\/+$/, '') || '/';
  const abs = (key: string) => `${root}${key.slice(DRIVE_ROOT.length)}`;
  const { entries: maxEntries, bytes: maxBytes, inlineBytes } = DRIVE_MANIFEST_LIMITS;

  /** Found so far, in the order they'll be kept: the touched paths, then breadth first. */
  const found = new Map<string, { type: 'file' | 'directory' | 'symlink'; skipped?: boolean }>();
  let truncated = false;
  let cut = false;
  const add = (key: string, type: 'file' | 'directory' | 'symlink', skipped?: boolean) => {
    if (found.has(key)) return true;
    if (found.size >= maxEntries) {
      truncated = true;
      return false;
    }
    found.set(key, { type, ...(skipped ? { skipped } : {}) });
    return true;
  };

  // The calls' own paths first: each one stat'ed (a path a call removed is simply gone).
  const touched = [...new Set([...(options.touched ?? [])].map((p) => driveKey(root, p)).filter((k): k is string => !!k))];
  const touchedStats = new Map<string, Awaited<ReturnType<DriveReader['stat']>>>();
  await pool(touched, n, late, async (key) => void touchedStats.set(key, await fs.stat(abs(key))));
  for (const key of touched) {
    const s = touchedStats.get(key);
    if (s) add(key, s.type);
  }

  // Breadth first from the root: names and types from `list`, never into a skipped directory.
  const first = await fs.list(root);
  let level: { key: string; names: { name: string; type: 'file' | 'directory' | 'symlink' }[] }[] = [{ key: DRIVE_ROOT, names: first }];
  while (level.length && !truncated) {
    const below: string[] = [];
    for (const { key, names } of level) {
      for (const { name, type } of [...names].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const child = `${key}/${name}`;
        const skip = type === 'directory' && SKIPPED_DIRS.has(name);
        if (!add(child, type, skip)) break;
        if (type === 'directory' && !skip) below.push(child);
      }
      if (truncated) break;
    }
    if (truncated || late()) {
      cut ||= late() && below.length > 0;
      break;
    }
    const next: typeof level = [];
    // A directory this user can't read (the Drive's lost+found) is listed but not entered; one the deadline left out cuts the listing short.
    if ((await pool(below, n, late, async (key) => void next.push({ key, names: await fs.list(abs(key)) }))) < below.length) cut = true;
    next.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    level = next;
  }

  // Sizes and times: `stat` for what the listing found (a touched path has its stat already).
  const stats = new Map(touchedStats);
  await pool(
    [...found.keys()].filter((k) => !stats.has(k)),
    n,
    late,
    async (key) => void stats.set(key, await fs.stat(abs(key)))
  );

  // The manifest, within the byte budget: every entry's metadata first (in `found`'s order), then texts while the budget lasts.
  const files: Record<string, DriveEntry> = {};
  let bytes = HEAD_BYTES;
  for (const [key, f] of found) {
    const s = stats.get(key);
    if (!s) {
      // Not stat'ed before the deadline: the previous snapshot's entry, if it had one.
      if (late() && previous?.files[key]) {
        const e = { ...previous.files[key]! };
        const cost = entryBytes(key, e);
        if (bytes + cost > maxBytes) {
          truncated = true;
          break;
        }
        files[key] = e;
        bytes += cost;
        cut = true;
      }
      continue;
    }
    const e: DriveEntry = { n: s.size, t: Math.round(s.mtimeMs), ...(s.type === 'directory' ? { d: 1 as const } : {}), ...(f.type === 'symlink' ? { l: 1 as const } : {}), ...(f.skipped ? { s: 1 as const } : {}) };
    const cost = entryBytes(key, e);
    if (bytes + cost > maxBytes) {
      truncated = true;
      break;
    }
    files[key] = e;
    bytes += cost;
  }
  // A listing the deadline cut short keeps what the previous snapshot had where it didn't reach.
  if (cut && previous) {
    for (const [key, e] of Object.entries(previous.files)) {
      if (files[key] || found.has(key)) continue;
      const cost = entryBytes(key, e);
      if (Object.keys(files).length >= maxEntries || bytes + cost > maxBytes) {
        truncated = true;
        break;
      }
      files[key] = { ...e };
      bytes += cost;
    }
  }

  // Texts: small regular files in the manifest's order (the touched ones first), while the budget lasts. A file whose size and mtime are
  // the previous snapshot's keeps its text unread; the rest are read only while they could still fit (and the deadline lasts).
  const small = Object.entries(files).filter(([, e]) => !e.d && !e.s && e.n <= inlineBytes);
  /** The previous snapshot's text for an unchanged file, `null` for an unchanged file known not to be text. */
  const kept = (key: string, e: DriveEntry): string | null | undefined => {
    const before = previous?.files[key];
    if (!before || before.n !== e.n || before.t !== e.t) return undefined;
    return typeof before.x === 'string' ? before.x : before.b ? null : undefined;
  };
  const reads: string[] = [];
  let planned = bytes;
  for (const [key, e] of small) {
    if (planned + e.n + 5 > maxBytes) break;
    planned += e.n + 5;
    if (kept(key, e) === undefined) reads.push(key);
  }
  const texts = new Map<string, string | null>();
  await pool(reads, n, late, async (key) => {
    const raw = await fs.readFile(abs(key));
    if (raw.length > inlineBytes) return;
    try {
      texts.set(key, utf8.decode(raw));
    } catch {
      texts.set(key, null);
    }
  });
  for (const [key, e] of small) {
    const known = kept(key, e);
    const x = known === undefined ? texts.get(key) : known;
    if (x === null) {
      e.b = 1;
      bytes += 6;
    }
    if (typeof x !== 'string') continue;
    // `,"x":` and the text as JSON.
    const cost = byteLength(JSON.stringify(x)) + 5;
    if (cost - 5 > inlineBytes || bytes + cost > maxBytes) continue;
    e.x = x;
    bytes += cost;
  }

  const manifest: DriveManifest = { at: now(), ...(options.driveId ? { driveId: options.driveId } : {}), calls: options.calls, files, ...(truncated || cut ? { truncated: true as const } : {}) };
  // The bound holds whatever the estimate missed: texts go first, then entries from the end.
  for (const keys = Object.keys(files); byteLength(JSON.stringify(manifest)) > maxBytes; ) {
    const withText = keys.findLast((k) => files[k]!.x !== undefined);
    if (withText) delete files[withText]!.x;
    else delete files[keys.pop()!];
    manifest.truncated = true;
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// The writer

export interface DriveFilesOptions {
  /** The longest a snapshot lists for. Default 4 s. */
  budgetMs?: number;
  /** What a snapshot leaves of the invocation (its outcome must still be written). Default 15 s. */
  marginMs?: number;
  /** The Drive's id, when the harness has it. */
  driveId?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A drive's stop conditions an effect passes on (a snapshot swallows anything else). */
const STOPPING = new Set(['Yield', 'Restart', 'Fatal', 'Unavailable']);

/**
 * One drive's writer of the Drive's manifest (`DriveFiles(ctx, machine)`):
 * `changed` as each mutating call ends, `catchUp` once attached, `snapshot`
 * at a turn's end. Built by the sandbox tier's kernel binding
 * (`KernelSandbox.files`) for a harness that runs in the session's VM.
 */
export class DriveFiles {
  readonly #ctx: DriveContext;
  readonly #fs: DriveReader;
  readonly #options: DriveFilesOptions;
  readonly #touched = new Set<string>();
  #dirty = false;
  #running: Promise<void> | undefined;

  constructor(ctx: DriveContext, machine: { readonly workspace: DriveReader }, options: DriveFilesOptions = {}) {
    this.#ctx = ctx;
    this.#fs = machine.workspace;
    this.#options = options;
  }

  /** A mutating call ended: its live event (the page updates mid-turn), and the paths it named for the next snapshot. */
  changed(call: { tool: string; callId: string; paths?: readonly string[] }): void {
    this.#dirty = true;
    const paths = (call.paths ?? []).map((p) => driveKey(this.#fs.root, p)).filter((k): k is string => !!k);
    for (const p of paths) this.#touched.add(p);
    const event: DriveFilesEvent = { type: DRIVE_FILES_EVENT, tool: call.tool, callId: call.callId, ...(paths.length ? { paths } : {}), t: Date.now() };
    this.#ctx.live(event);
  }

  /** Once attached: list first if the previous invocation ended before its snapshot (the log has calls the manifest never saw). */
  async catchUp(): Promise<void> {
    if (driveManifestBehind(this.#ctx.state())) await this.snapshot('catch-up');
  }

  /** A turn's end: list the Drive into the manifest, if a call may have changed it since. Best effort: bounded, and never throws but what stops the drive. */
  async snapshot(reason = 'turn'): Promise<void> {
    if (reason !== 'catch-up' && !this.#dirty && !driveManifestBehind(this.#ctx.state())) return;
    if (this.#running) return this.#running;
    this.#running = this.#write(reason).finally(() => (this.#running = undefined));
    return this.#running;
  }

  async #write(reason: string): Promise<void> {
    const ctx = this.#ctx;
    const log = this.#options.log ?? (() => {});
    if (ctx.signal.aborted) return;
    const left = (ctx.deadline ?? Number.POSITIVE_INFINITY) - Date.now() - (this.#options.marginMs ?? 15_000);
    const budget = Math.min(this.#options.budgetMs ?? 4_000, left);
    if (budget < 250) {
      log('drive files: no time left in the invocation for a snapshot', { reason });
      return;
    }
    const touched = [...this.#touched];
    this.#dirty = false;
    this.#touched.clear();
    try {
      await ctx.effect(`sandbox.files:${globalThis.crypto.randomUUID()}`, { name: 'sandbox.files', replay: 'safe', input: { reason, touched: touched.length } }, async (io) => {
        const start = Date.now();
        const previous = io.docs ? (io.docs.read(DRIVE_FILES_DOC).value as DriveManifest) : undefined;
        let next: DriveManifest;
        try {
          next = await listDrive(this.#fs, previous, { deadline: start + budget, touched, calls: mutatingCalls(ctx.state()), ...(this.#options.driveId ? { driveId: this.#options.driveId } : {}) });
        } catch (err) {
          // The VM went away (the link lost, the Drive gone): the last snapshot stands.
          const why = String((err as Error)?.message ?? err).slice(0, 200);
          log('drive files: the listing failed; the last snapshot stands', { reason, error: why });
          return { listed: false, error: why };
        }
        io.docs?.update(DRIVE_FILES_DOC, () => next);
        return { listed: true, entries: Object.keys(next.files).length, truncated: next.truncated === true, ms: Date.now() - start };
      });
    } catch (err) {
      if (ctx.signal.aborted || STOPPING.has((err as { name?: string })?.name ?? '')) throw err;
      // Its own failure (or the write's): the panel keeps the last snapshot. The next turn's catch-up lists again.
      log('drive files: the snapshot was not written', { reason, error: String((err as Error)?.message ?? err).slice(0, 200) });
      for (const p of touched) this.#touched.add(p);
      this.#dirty = true;
    }
  }
}
