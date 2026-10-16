import type { World } from '@workflow/world';
import { JsonLinesWriter, tailJsonLines } from './streams.ts';

/**
 * Live hints ("Reads become subscriptions").
 *
 * Every process that commits an event another process waits for (a
 * submission's `hook_received`, a handoff, a lane settling back) also writes
 * a small hint line to `<runId>_hints`. Whoever would otherwise poll the log
 * for it (a driver's inbox poll, a tab watching a session that is away)
 * tails that stream and refreshes when a hint arrives, keeping a slow poll
 * only as a fallback. A hint carries no state: the log stays the truth, a
 * hint only says "read it now", so a lost, duplicated or early hint is
 * harmless (the reader refreshes and finds what it finds).
 *
 * A dedicated stream rather than `live`: `live` carries every text delta,
 * and a driver tailing it would download its own output back.
 *
 * Within one process hints also go through an in-process bus, so a
 * submission and the drive it wakes in the same Function (the drive route)
 * do not wait for a stream round trip.
 */
export interface Hint {
  type: 'hint';
  /**
   * What was committed: `hook_received` (a submission), `handoff`,
   * `recover` (a delivery took the session over), `settle`. Or `tether`: a
   * tab (re)connected its tether while driving (tab-lost.ts).
   */
  eventType: string;
  /** The slot the commit landed at, when known. */
  slot?: number;
  /** The submission id, for `hook_received`. */
  id?: string;
  /** For handoffs: the lane the session moved to. */
  to?: string;
  /** For `handoff` and `recover`: the session's epoch after it. A drive of an older epoch stops. */
  epoch?: number;
  /** For `tether`: the tab. */
  tab?: string;
}

export const hintsStreamName = (runId: string) => `${runId}_hints`;

type Listener = (hint: Hint) => void;

/** Process-wide: one bus however many copies of this module a bundler made. */
const BUS_KEY = Symbol.for('harness-world.hints');
const bus = (): Map<string, Set<Listener>> => {
  const g = globalThis as { [BUS_KEY]?: Map<string, Set<Listener>> };
  g[BUS_KEY] ??= new Map();
  return g[BUS_KEY];
};

const writers = new WeakMap<World, Map<string, JsonLinesWriter>>();

/**
 * Publish a hint: to this process's listeners now, and to the hints stream
 * (fire and forget; returns the write so a caller about to exit can await it).
 */
export function publishHint(world: World, runId: string, hint: Omit<Hint, 'type'>): Promise<void> {
  const line: Hint = { type: 'hint', ...hint };
  for (const listener of bus().get(runId) ?? []) {
    try {
      listener(line);
    } catch {}
  }
  let perWorld = writers.get(world);
  if (!perWorld) writers.set(world, (perWorld = new Map()));
  let writer = perWorld.get(runId);
  if (!writer) perWorld.set(runId, (writer = new JsonLinesWriter(world, runId, hintsStreamName(runId))));
  writer.write(line);
  return writer.flush();
}

export interface WatchHintsOptions {
  signal: AbortSignal;
  /** Tail the stream too (hints from other processes). Default true. */
  stream?: boolean;
  /** Where to start tailing; default: the stream's current end. */
  startIndex?: number;
}

/**
 * Call `listener` for every hint on `runId` from now on, from this process
 * and (unless `stream: false`) from any other, until `signal` aborts. A tail
 * that ends or fails is reopened after a short pause.
 */
export function watchHints(world: World, runId: string, listener: Listener, options: WatchHintsOptions): void {
  const { signal } = options;
  if (signal.aborted) return;
  const listeners = bus();
  let set = listeners.get(runId);
  if (!set) listeners.set(runId, (set = new Set()));
  set.add(listener);
  signal.addEventListener(
    'abort',
    () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
    },
    { once: true }
  );
  if (options.stream === false) return;
  void (async () => {
    let start = options.startIndex ?? (await streamEnd(world, runId));
    let backoffMs = 1000;
    while (!signal.aborted) {
      let got = false;
      try {
        for await (const value of tailJsonLines(world, runId, hintsStreamName(runId), { startIndex: start, signal })) {
          if (signal.aborted) return;
          got = true;
          if ((value as Hint)?.type === 'hint') listener(value as Hint);
        }
      } catch {}
      if (signal.aborted) return;
      backoffMs = got ? 1000 : Math.min(backoffMs * 2, 10_000);
      await new Promise((r) => setTimeout(r, backoffMs));
      if (signal.aborted) return;
      // Reopen at the end (the tail does not say how many chunks it read,
      // so there is no exact resume point). If the stream grew since this
      // tail opened, one of those chunks may have been missed: read once.
      const end = await streamEnd(world, runId);
      if (end > start) listener({ type: 'hint', eventType: 'reconnect' });
      start = end;
    }
  })();
}

async function streamEnd(world: World, runId: string): Promise<number> {
  try {
    return (await world.streams.getInfo(runId, hintsStreamName(runId))).tailIndex + 1;
  } catch {
    return 0; // Nothing written yet.
  }
}
