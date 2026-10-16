import type { Durability, Hands, Mode } from './view.ts';

/**
 * This browser's sessions (`how:mine`, newest 200): what the Sessions drawer
 * lists by default. An entry is written when this page starts a session
 * with a prompt, so pre-created spares, /compare's columns and /bench's
 * sessions never enter it. Each entry carries what reopens it as it was:
 * where it runs, its harness, its durability and the client that drives it.
 */

export interface MineEntry {
  id: string;
  mode: Mode;
  harness: string;
  durability: Durability;
  /** The client key it was started under (`server`, `server:run-ahead`, `server:pi-durable`, ...). */
  key: string;
  /** The first prompt: the session's title. */
  prompt: string;
  /** When the first prompt was sent (ms): the session's age counts from it. */
  sentAt: number;
  /** Its hands, when the page chose them. */
  hands?: Hands;
}

export const MINE_KEY = 'how:mine';
export const MINE_MAX = 200;

const MODES: Mode[] = ['server', 'tab', 'hybrid'];
const DURABILITIES: Durability[] = ['native', 'run-ahead', 'on', 'off'];

const valid = (e: unknown): e is MineEntry => {
  const x = e as Partial<MineEntry> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.harness === 'string' &&
    typeof x.key === 'string' &&
    typeof x.prompt === 'string' &&
    typeof x.sentAt === 'number' &&
    MODES.includes(x.mode as Mode) &&
    DURABILITIES.includes(x.durability as Durability)
  );
};

/**
 * An entry from before the brain-in-VM mode was retired: its sessions are
 * hybrid sessions (their home was their VM), listed under Hybrid now.
 */
const migrated = (e: unknown): unknown => {
  const x = e as (Omit<Partial<MineEntry>, 'mode'> & { mode?: string }) | null;
  if (!x || x.mode !== 'sandbox') return e;
  return { ...x, mode: 'hybrid', key: typeof x.key === 'string' ? x.key.replace(/^sandbox/, 'hybrid') : x.key };
};

export function readMine(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): MineEntry[] {
  try {
    const list = JSON.parse(storage?.getItem(MINE_KEY) ?? '[]');
    return Array.isArray(list) ? list.map(migrated).filter(valid) : [];
  } catch {
    return [];
  }
}

/** `entry` added (or moved to the front, if it is there), newest first, at most `MINE_MAX`. */
export function withEntry(list: MineEntry[], entry: MineEntry): MineEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, MINE_MAX);
}

export function writeMine(list: MineEntry[], storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(MINE_KEY, JSON.stringify(list));
  } catch {}
}

/** The first prompt as a one-line title. */
export const titleOf = (prompt: string) => prompt.replace(/\s+/g, ' ').trim();

/** The harness a first visit opens on, in every mode. */
export const FIRST_VISIT_HARNESS = 'pi';

/** The harness a mode opens with: the URL's, then what this browser chose last, then Pi. */
export const openingHarness = (fromUrl: string | undefined, stored: string | undefined): string => fromUrl ?? stored ?? FIRST_VISIT_HARNESS;
