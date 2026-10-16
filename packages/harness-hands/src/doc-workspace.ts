import {
  type BlobContent,
  blobStreamName,
  bytesToBase64,
  DocTooLarge,
  type DocsIO,
  type DriveContext,
  Fatal,
  type HostToolIO,
  readBlobContents,
  sha256Hex,
  writeBlob,
} from 'harness-world';
import {
  type BlobEntry,
  DEFAULT_FILE_MODE,
  type FileEntry,
  INLINE_FILE_MAX_BYTES,
  inlineContent,
  legacyFiles,
  MANIFEST_INLINE_BUDGET_BYTES,
  manifestEntries,
  modeOf,
  WorkspaceDoc,
} from './files.ts';
import { createMachine, type MachineOptions, type VirtualMachine } from './isolation.ts';
import type { FileBytes, WorkspaceMachine } from './machine.ts';
import { WORKSPACE_ROOT } from './paths.ts';

/**
 * The workspace tools on documents.
 *
 * The workspace is a machine (just-bash on an in-memory filesystem, in an
 * isolated worker where one can run: isolation.ts) per drive, kept equal to
 * the `hw.workspace` manifest (files.ts) as each tool call sees it. A call
 * that changes files commits the change as one edit of the manifest, through
 * `io.docs`: the edit rides on the call's own outcome, so a call that throws
 * or never reports (a crash) changed nothing, and its retry starts from the
 * workspace the first attempt saw. Files over 4 KB go to the session's blob
 * stream (written inside the call, before it returns); the manifest names
 * them by hash. Files are bytes with a mode: bytes that are not UTF-8 are
 * kept as bytes (base64), and a mode other than 0o644 is in the entry, so a
 * gzip or a script made executable is the same file on the next drive. The
 * manifest has no symbolic links: after a call, a link to a file is a copy
 * of it and any other link is gone, in this drive's filesystem as in the
 * next one's.
 *
 * Calls on one workspace run one at a time (the filesystem is shared), and
 * each starts from the manifest as it pinned it, so the filesystem never
 * holds what the log does not: a call that failed is rolled back, and an
 * edit that landed meanwhile (another call's, an app's `updateDoc`) is
 * synced in before the next call runs.
 *
 * just-bash is loaded when the first workspace tool runs, so importing the
 * tools costs nothing for an app that never calls one. The machine is on
 * the worker leased to the session (isolation.ts, worker.ts). A machine
 * whose worker ended (its lease was idle, or a command ran past its time
 * limit) lost its files: the next call makes a new one and syncs it from the
 * manifest, as a fresh drive would. A call cut off that way fails, and
 * commits nothing.
 */

const NO_DOCS =
  "harness-world-hands: the workspace tools keep their files in the session's documents, and this harness adapter does not pass the kernel's io.docs to its tools (pass the effect's io through, e.g. with hostToolIO)";

const workspaces = new WeakMap<DriveContext, Promise<DocWorkspace>>();
/** Each session's newest workspace in this process (a drive's): the next drive of the session takes its machine over. */
const newest = new Map<string, WeakRef<DocWorkspace>>();
const utf8 = new TextEncoder();
/** Strict: bytes that are not UTF-8 throw (they are a binary file), and a leading BOM is kept. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const toBytes = (c: BlobContent): Uint8Array => (typeof c === 'string' ? utf8.encode(c) : c);
const bytesOf = (text: string) => utf8.encode(text).length;
/** A blob entry's share of the manifest, for the inline budget. */
const BLOB_ENTRY_BYTES = JSON.stringify({ n: 1_000_000, h: '0'.repeat(64) }).length;

/** A file as the filesystem holds it: its text (bytes that are UTF-8) or its bytes, and its mode. */
export interface FileData {
  content: BlobContent;
  mode: number;
}

/** What the filesystem holds for a path: the entry's content (its text, base64 or blob hash), and its mode. */
interface Held {
  content: string;
  mode: number;
}
const contentKey = (e: FileEntry): string =>
  typeof e === 'string' ? `t${e}` : 'h' in e ? `h${e.h}` : 'd' in e ? `d${e.d}` : `t${e.t}`;

/** The bytes of a file the filesystem read, as text when they are UTF-8. */
export function asContent(bytes: Uint8Array): BlobContent {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return bytes;
  }
}

/**
 * A call's error, saying that the workspace is as it was before the call
 * when the call was cut off with its machine (a command past its time limit,
 * cancelled, out of memory): its changes went with the worker.
 */
export function untouched(err: unknown, machine: WorkspaceMachine): unknown {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (!(err instanceof Error) || !machine.lost || !['ETIMEDOUT', 'EINTR', 'ENOMEM', 'EGONE'].includes(code as string)) return err;
  return Object.assign(new Error(`${err.message}. Nothing it changed was kept: the workspace is as it was before this call.`), { code });
}

/** A file's entry when it is kept inline: a string (text, mode 0o644), `{ t, m }`, or `{ d, m? }` (bytes, base64). */
function inlineEntry(f: FileData): FileEntry {
  const mode = f.mode !== DEFAULT_FILE_MODE ? { m: f.mode } : {};
  if (typeof f.content !== 'string') return { d: bytesToBase64(f.content), ...mode };
  return f.mode === DEFAULT_FILE_MODE ? f.content : { t: f.content, m: f.mode };
}

/**
 * How large a file is inline, against `INLINE_FILE_MAX_BYTES`: the bytes of
 * its text as a JSON string (what the manifest and the call's outcome hold:
 * a text of control characters, such as a tar's NUL padding, is six times
 * its size there), or its base64.
 */
const inlineSize = (f: FileData) => (typeof f.content === 'string' ? bytesOf(JSON.stringify(f.content)) - 2 : Math.ceil(f.content.length / 3) * 4);
const byteLength = (c: BlobContent) => (typeof c === 'string' ? bytesOf(c) : c.length);

interface Base {
  entries: Map<string, FileEntry>;
  /** The manifest was never written: `entries` are the legacy records' files (all text), converted on the first write. */
  legacy: boolean;
}

export class DocWorkspace {
  /** What the filesystem holds, path to the entry it was synced or written from. */
  private held = new Map<string, Held>();
  /** Blob contents by hash: read from the stream or written by this drive (every one is in the stream). */
  private blobs = new Map<string, BlobContent>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Calls queued or running. */
  private calls = 0;
  /** Its machine went to the session's next drive: a call of this drive makes one of its own. */
  private handedOn = false;

  private constructor(
    readonly ctx: DriveContext,
    /** The files and the shell (replaced when its worker was restarted). */
    public machine: VirtualMachine,
    private readonly options: MachineOptions
  ) {}

  /**
   * The workspace for this drive, on its session's worker: the machine the
   * session's previous drive in this process left (synced on each call, as
   * every machine is), or a new one, empty.
   */
  static for(ctx: DriveContext, options: MachineOptions = {}): Promise<DocWorkspace> {
    let ws = workspaces.get(ctx);
    if (!ws) {
      ws = (async () => {
        const previous = newest.get(ctx.runId)?.deref();
        let next: DocWorkspace;
        if (previous && previous.ctx !== ctx && previous.ctx.world === ctx.world && previous.calls === 0 && !previous.handedOn && !previous.machine.lost) {
          // That drive is over: its machine, and what it knows the machine holds, carry on here.
          next = new DocWorkspace(ctx, previous.machine, options);
          next.held = previous.held;
          next.blobs = previous.blobs;
          previous.held = new Map();
          previous.handedOn = true;
        } else {
          next = new DocWorkspace(ctx, await createMachine({ ...options, root: WORKSPACE_ROOT, session: ctx.runId }), options);
        }
        newest.set(ctx.runId, new WeakRef(next));
        if (newest.size > 256) for (const [runId, ref] of newest) if (!ref.deref()) newest.delete(runId);
        return next;
      })();
      workspaces.set(ctx, ws);
      ws.catch(() => workspaces.delete(ctx));
    }
    return ws;
  }

  /**
   * Run one tool call on the workspace as the call sees it. `write`: what
   * `work` changed is committed with the call's outcome (one edit of the
   * manifest); a throw rolls the filesystem back and commits nothing.
   * `signal`: the call's cancellation (a machine made for it stops waiting
   * for a worker then).
   */
  static async run<T>(io: HostToolIO, mode: 'read' | 'write', work: (ws: DocWorkspace) => Promise<T>, options?: MachineOptions, signal?: AbortSignal): Promise<T> {
    const docs = io.docs;
    if (!docs) throw new Error(NO_DOCS);
    const ws = await DocWorkspace.for(io.ctx, options);
    return ws.exclusive(() => ws.call(docs, mode, work, signal));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.calls++;
    const run = this.queue.then(fn, fn).finally(() => this.calls--);
    this.queue = run.catch(() => {});
    return run;
  }

  private async call<T>(docs: DocsIO, mode: 'read' | 'write', work: (ws: DocWorkspace) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.handedOn || this.machine.lost) {
      this.handedOn = false;
      // Its worker ended (or its machine went to a later drive): a new machine, synced from the manifest as on a fresh drive.
      this.machine = await createMachine({ ...this.options, root: WORKSPACE_ROOT, session: this.ctx.runId, ...(signal ? { signal } : {}) });
      this.held.clear();
    }
    // Its session's worker stays its own for the whole call.
    return this.machine.hold(() => this.onMachine(docs, mode, work));
  }

  private async onMachine<T>(docs: DocsIO, mode: 'read' | 'write', work: (ws: DocWorkspace) => Promise<T>): Promise<T> {
    const base = this.baseOf(docs);
    await this.sync(base.entries);
    if (mode === 'read') return work(this);
    await this.machine.checkpoint();
    let result: T;
    let diff: [string, Uint8Array | null, number][];
    try {
      result = await work(this);
      // The manifest has no links: after a call, a link to a file is a copy of it, any other link is gone.
      diff = await this.machine.diff({ unlink: true });
    } catch (err) {
      await this.rollback();
      throw untouched(err, this.machine);
    }
    const changes = new Map<string, FileData | null>();
    for (const [path, bytes, fileMode] of diff) changes.set(path, bytes ? { content: asContent(bytes), mode: fileMode } : null);
    if (changes.size > 0) {
      try {
        await this.commit(docs, base, changes);
      } catch (err) {
        await this.rollback();
        throw err;
      }
    }
    await this.machine.release().catch(() => {});
    return result;
  }

  /** Put the filesystem back to the call's checkpoint (a call that failed changed nothing); a machine that cannot is replaced. */
  private async rollback(): Promise<void> {
    try {
      await this.machine.rollback();
      await this.machine.release();
    } catch {
      this.machine.dispose();
    }
  }

  /** The manifest as this call pinned it; before it was ever written, the legacy records' files. */
  private baseOf(docs: DocsIO): Base {
    const snap = docs.read(WorkspaceDoc);
    if (snap.revision > 0) return { entries: manifestEntries(snap), legacy: false };
    const legacy = legacyFiles(this.ctx.state());
    return { entries: new Map(Object.entries(legacy)), legacy: Object.keys(legacy).length > 0 };
  }

  /** Make the filesystem hold exactly `entries`: their content and their mode (one round trip to the machine). */
  private async sync(entries: Map<string, FileEntry>): Promise<void> {
    const changed = [...entries].filter(([path, e]) => {
      const held = this.held.get(path);
      return held?.content !== contentKey(e) || held.mode !== modeOf(e);
    });
    const removes = [...this.held.keys()].filter((path) => !entries.has(path));
    const missing = changed.flatMap(([path, e]) =>
      typeof e !== 'string' && 'h' in e && !this.blobs.has(e.h) && this.held.get(path)?.content !== contentKey(e) ? [[path, e.h] as const] : []
    );
    if (missing.length) await this.loadBlobs(missing);
    const writes: FileBytes[] = [];
    const chmods: [string, number][] = [];
    for (const [path, e] of changed) {
      const mode = modeOf(e);
      if (this.held.get(path)?.content === contentKey(e)) chmods.push([path, mode]);
      else writes.push([path, toBytes(inlineContent(e) ?? this.blobs.get((e as BlobEntry).h)!), mode]);
    }
    await this.machine.apply(writes, removes, chmods);
    for (const path of removes) this.held.delete(path);
    for (const [path, e] of changed) this.held.set(path, { content: contentKey(e), mode: modeOf(e) });
  }

  /** Read the blob stream for blobs the manifest names; one it does not hold fails the session. */
  private async loadBlobs(missing: (readonly [string, string])[]): Promise<void> {
    for (const [h, content] of await readBlobContents(this.ctx.world, this.ctx.runId)) this.blobs.set(h, content);
    const lost = missing.find(([, h]) => !this.blobs.has(h));
    if (lost) {
      // The call that named it wrote it before its outcome: the World lost data, and no retry can bring it back.
      const err = new Fatal(`harness-world-hands: ${lost[0]}'s blob ${lost[1]} is missing from ${blobStreamName(this.ctx.runId)}`);
      this.ctx.halt?.(err);
      throw err;
    }
  }

  /**
   * Commit `changes` (path to the file now, null for deleted) as one edit of
   * the manifest: small files inline (text, or bytes as base64) while the
   * manifest has room, blobs (written now) for the rest. A session whose
   * manifest was never written converts here: its legacy files and the
   * changes become the whole manifest.
   */
  private async commit(docs: DocsIO, base: Base, changes: Map<string, FileData | null>): Promise<void> {
    // The files whose entries to compute: the changed ones, or every file on a conversion.
    const fresh = new Map<string, FileData>();
    if (base.legacy) {
      for (const [path, e] of base.entries) if (!changes.has(path)) fresh.set(path, { content: inlineContent(e)!, mode: modeOf(e) });
    }
    for (const [path, file] of changes) if (file) fresh.set(path, file);
    const next = new Map<string, FileEntry>(base.legacy ? [] : base.entries);
    for (const [path, file] of changes) if (!file) next.delete(path);
    for (const [path, file] of fresh) next.set(path, inlineEntry(file));
    const toBlob = new Set<string>();
    const candidates: { path: string; saves: number }[] = [];
    for (const [path, file] of fresh) {
      if (inlineSize(file) > INLINE_FILE_MAX_BYTES) toBlob.add(path);
      else candidates.push({ path, saves: bytesOf(JSON.stringify(next.get(path))) - BLOB_ENTRY_BYTES });
    }
    // Over the inline budget with every small file inline: the largest of them go to blobs.
    const placeholder: BlobEntry = { n: 1_000_000, h: '0'.repeat(64) };
    let size = bytesOf(JSON.stringify({ files: Object.fromEntries([...next].map(([p, e]) => [p, toBlob.has(p) ? placeholder : e])) }));
    for (const c of candidates.sort((a, b) => b.saves - a.saves)) {
      if (size <= MANIFEST_INLINE_BUDGET_BYTES || c.saves <= 0) break;
      toBlob.add(c.path);
      size -= c.saves;
    }
    // Still over the budget: the largest files already inline move to blobs
    // too, so the manifest keeps its room for entries. (Otherwise files that
    // took the inline budget early stay in it for good, and the workspace is
    // full at about 160 files instead of about 500.)
    const moved = new Map<string, BlobEntry>();
    if (size > MANIFEST_INLINE_BUDGET_BYTES) {
      const resident = [...next]
        .filter(([path, e]) => !fresh.has(path) && inlineContent(e) !== undefined)
        .map(([path, e]) => ({ path, file: { content: inlineContent(e)!, mode: modeOf(e) }, saves: bytesOf(JSON.stringify(e)) - BLOB_ENTRY_BYTES }))
        .filter((c) => c.saves > 0)
        .sort((a, b) => b.saves - a.saves);
      for (const c of resident) {
        if (size <= MANIFEST_INLINE_BUDGET_BYTES) break;
        moved.set(c.path, await this.toBlob(base, c.file));
        size -= c.saves;
      }
    }
    const entries = new Map<string, FileEntry>();
    for (const [path, file] of fresh) entries.set(path, toBlob.has(path) ? await this.toBlob(base, file) : next.get(path)!);
    try {
      docs.update(WorkspaceDoc, (draft) => {
        if (base.legacy) {
          const files: Record<string, FileEntry> = {};
          for (const path of next.keys()) files[path] = entries.get(path)!;
          return { files };
        }
        draft.files ??= {};
        for (const [path, file] of changes) {
          if (file === null) delete draft.files[path];
          else draft.files[path] = entries.get(path)!;
        }
        for (const [path, e] of moved) draft.files[path] = e;
      });
    } catch (err) {
      if (err instanceof DocTooLarge) {
        throw new Error(
          `the workspace is full: its manifest would be ${err.bytes.toLocaleString('en-US')} bytes for ${next.size} files, over the ${err.limit.toLocaleString('en-US')}-byte limit. Delete files, or give the agent a Sandbox for real work.`
        );
      }
      throw err;
    }
    for (const [path, file] of changes) if (file === null) this.held.delete(path);
    for (const [path, e] of [...entries, ...moved]) this.held.set(path, { content: contentKey(e), mode: modeOf(e) });
  }

  /** `file`'s blob entry, its blob written to the stream first (before the outcome that names it) unless it is there already. */
  private async toBlob(base: Base, file: FileData): Promise<BlobEntry> {
    const h = await sha256Hex(file.content);
    if (!this.blobs.has(h) && !this.named(base, h)) await writeBlob(this.ctx.world, this.ctx.runId, file.content, { hash: h });
    this.blobs.set(h, file.content);
    return {
      n: byteLength(file.content),
      h,
      ...(typeof file.content !== 'string' ? { b: 1 as const } : {}),
      ...(file.mode !== DEFAULT_FILE_MODE ? { m: file.mode } : {}),
    };
  }

  /** Whether the manifest already names blob `h` (so it is in the stream). */
  private named(base: Base, h: string): boolean {
    for (const e of base.entries.values()) if (typeof e !== 'string' && 'h' in e && e.h === h) return true;
    return false;
  }

  /** Every file under the workspace root, sorted. */
  async paths(): Promise<string[]> {
    return (await this.machine.walk(WORKSPACE_ROOT)).filter((e) => e.type === 'file').map((e) => e.path);
  }
}
