import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NativeJournal } from './journal.ts';

/**
 * The working directory of a harness whose built-in tools are on: a
 * directory on the machine that drives the session. It is not in the log.
 * On a long-lived server it outlives a crash; on Vercel it is the Function's
 * `/tmp`, lost when the instance is, and a drive on another instance finds
 * none of it. A model told nothing would look for files it wrote earlier and
 * be confused, so the drive tracks which copy it has:
 *
 * - each directory gets an id when a drive first creates it, kept next to it
 *   (in the session's host directory, not in the workspace itself);
 * - the log records the id of the copy each drive used (journal stream
 *   `workspace`, written only when it changes);
 * - a drive whose copy is not the one the log names last (a fresh directory
 *   on another machine, or an older copy) says so to the model, once, with
 *   `workspaceNote`.
 */

/** The journal stream of the workspace records. */
export const WORKSPACE_STREAM = 'workspace';

/** One `workspace` record: the copy a drive used. */
export interface WorkspaceRecord {
  id: string;
  /** The directory, on that machine. */
  path: string;
  /** The copy the log named before (absent for the session's first). */
  previous?: string;
}

export interface WorkspaceState {
  /** The working directory (created). */
  path: string;
  /** This drive created the directory: it was not there. */
  created: boolean;
  /**
   * The log says the session used another copy before, so files earlier
   * turns wrote may be missing here, or older: tell the model
   * (`workspaceNote`).
   */
  moved: boolean;
}

/**
 * Open the session's working directory for a drive: create it if it is
 * missing, and record which copy this is (`marker` is a file the host keeps
 * for it, outside the directory). Call it inside the drive, before the
 * harness starts.
 */
export async function openWorkspace(journal: NativeJournal, options: { path: string; marker: string }): Promise<WorkspaceState> {
  const last = journal.records<WorkspaceRecord>(WORKSPACE_STREAM).at(-1)?.data;
  let local: { id: string; path?: string } | undefined;
  try {
    local = JSON.parse(await readFile(options.marker, 'utf8')) as { id: string; path?: string };
    if (typeof local?.id !== 'string' || (local.path && local.path !== options.path)) local = undefined;
  } catch {}
  let created = false;
  if (!local) {
    created = true;
    local = { id: randomUUID(), path: options.path };
    await mkdir(options.path, { recursive: true });
    await mkdir(dirname(options.marker), { recursive: true });
    await writeFile(options.marker, JSON.stringify(local));
  } else {
    await mkdir(options.path, { recursive: true });
  }
  const moved = !!last && last.id !== local.id;
  if (!last || moved) {
    journal.append(WORKSPACE_STREAM, { id: local.id, path: options.path, ...(last ? { previous: last.id } : {}) } satisfies WorkspaceRecord, {
      id: `workspace:${local.id}:${last?.id ?? ''}`,
    });
  }
  return { path: options.path, created, moved };
}

/** The note a drive whose working directory moved tells the model, before its first message. */
export function workspaceNote(path: string): string {
  return [
    `[Environment] This session's working directory (${path}) is a directory on the machine that runs the session, not part of its durable log.`,
    'This turn runs where that directory is not the copy earlier turns used: files written or changed before may be missing here, or older. Check before relying on them.',
  ].join(' ');
}

/** The default marker file for a host session directory. */
export const workspaceMarker = (stateDir: string) => join(stateDir, 'workspace.json');
