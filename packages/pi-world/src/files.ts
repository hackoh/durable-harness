import type { StorageWrite } from '@earendil-works/pi-durable';
import { type FileEntry, isWorkspacePath, manifestEntries } from 'harness-world-hands/tools';

/**
 * A pi-durable session's virtual workspace, as its log has it.
 *
 * pi-durable's tools reach files and commands through the `ExecutionEnv` a
 * Harness builds for each call; on a durable virtual workspace
 * (durable-harness's `virtualEnv()`), each call runs on the files as they
 * were committed, and what it changed rides on its own result: the
 * `pi.tool-result` entry's `details` holds the call's file changes under
 * `hw.workspace`, in the same commit as the result. A call a crash cut off
 * never wrote its result, so it changed nothing.
 *
 * The changes use the `hw.workspace` manifest's entries (harness-world-hands
 * files.ts): a file of at most 4 KB inline (its text, or its bytes as
 * base64), a larger one by the SHA-256 of its bytes, its content in the
 * session's blob stream (written before the result that names it); `null`
 * for a file the call removed. The session's files are the fold of every
 * result's changes, in commit order (`SessionFiles`). No Node APIs and no
 * just-bash here.
 */

/** Where a tool result's `details` keeps the file changes of its call. */
export const WORKSPACE_DETAILS_KEY = 'hw.workspace';

/** A tool call's file changes, as its result's `details[WORKSPACE_DETAILS_KEY]` holds them. */
export interface WorkspaceDelta {
  /** The files the call wrote (an `hw.workspace` entry) or removed (`null`), by path under `/workspace`. */
  files?: Record<string, FileEntry | null>;
  /**
   * An in-memory workspace's first call of a turn says which turn it was, so a
   * later call of that turn in another invocation (whose memory is empty)
   * can tell the model the files are gone.
   */
  turn?: string;
}

/** The workspace changes in a tool result's `details`, if any. */
export function deltaOf(details: unknown): WorkspaceDelta | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined;
  const delta = (details as Record<string, unknown>)[WORKSPACE_DETAILS_KEY];
  if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) return undefined;
  return delta as WorkspaceDelta;
}

/** A tool result's `details` with `delta` added (an object's keys kept; anything else under `value`). */
export function withDelta(details: unknown, delta: WorkspaceDelta): Record<string, unknown> {
  const base = details === undefined ? {} : typeof details === 'object' && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>) : { value: details };
  return { ...base, [WORKSPACE_DETAILS_KEY]: delta };
}

/**
 * The session's files: the fold of every committed tool result's changes,
 * in commit order. Paths outside `/workspace` and entries that are not
 * well-formed are left out, as the `hw.workspace` readers do.
 */
export class SessionFiles {
  /** Path to entry. */
  readonly entries = new Map<string, FileEntry>();
  /** Turns an in-memory workspace's first call reported in (`WorkspaceDelta.turn`). */
  readonly turns = new Set<string>();
  /** Rises with every change folded in. */
  version = 0;

  /** Fold in what a commit's writes changed. */
  fold(writes: readonly StorageWrite[]): void {
    for (const w of writes) {
      if (w.type !== 'entry' || w.value.kind !== 'pi.tool-result') continue;
      const message = w.value.model?.[0] as { details?: unknown } | undefined;
      const delta = deltaOf(message?.details);
      if (!delta) continue;
      if (typeof delta.turn === 'string') this.turns.add(delta.turn);
      const files = delta.files;
      if (typeof files !== 'object' || files === null) continue;
      const written: Record<string, unknown> = {};
      for (const [path, entry] of Object.entries(files)) {
        if (entry === null) {
          if (isWorkspacePath(path) && this.entries.delete(path)) this.version++;
        } else written[path] = entry;
      }
      for (const [path, entry] of manifestEntries({ value: { files: written as Record<string, FileEntry> } })) {
        this.set(path, entry);
        this.version++;
      }
    }
  }

  /**
   * Set one file, keeping the files a tree: two calls that ran side by side
   * may have made `x` a file and `x/y` a file under a directory `x`; the
   * later result wins, as the later write would on a disk.
   */
  private set(path: string, entry: FileEntry): void {
    for (let p = path.slice(0, path.lastIndexOf('/')); isWorkspacePath(p); p = p.slice(0, p.lastIndexOf('/'))) this.entries.delete(p);
    const under = `${path}/`;
    for (const other of [...this.entries.keys()]) if (other.startsWith(under)) this.entries.delete(other);
    this.entries.set(path, entry);
  }
}
