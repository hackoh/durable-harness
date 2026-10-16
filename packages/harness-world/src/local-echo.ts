import { liveStreamName, setLocalLiveTap } from './streams.ts';

/**
 * Same-process live output (see `setLocalLiveTap`): while a page drives a
 * session itself, its live lines reach the page's subscribers the moment
 * they are produced, and the copies that come back round the World's stream
 * are dropped. Only lines produced while someone listens are echoed, so a
 * stream replay of older output still comes through. An echo the stream
 * never returns (a write that failed) expires, so it cannot swallow a later
 * identical line from another process.
 */
export interface LocalEcho {
  /** Live lines this process produces for `runId`, as they are produced. */
  subscribe(runId: string, onEvent: (event: unknown) => void): () => void;
  /** Whether a line read from the stream should be delivered (false: it was already, locally). */
  fromStream(runId: string, event: unknown): boolean;
}

export const ECHO_TTL_MS = 30_000;

export function createLocalEcho(now: () => number = Date.now): LocalEcho {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const echoes = new Map<string, Map<string, number[]>>();
  const tap = (runId: string, name: string, value: unknown) => {
    if (name !== liveStreamName(runId)) return;
    const set = listeners.get(runId);
    if (!set?.size) return;
    const key = JSON.stringify(value);
    let run = echoes.get(runId);
    if (!run) echoes.set(runId, (run = new Map()));
    run.set(key, [...(run.get(key) ?? []), now()]);
    for (const fn of set) fn(JSON.parse(key));
  };
  return {
    subscribe(runId, onEvent) {
      setLocalLiveTap(tap);
      let set = listeners.get(runId);
      if (!set) listeners.set(runId, (set = new Set()));
      set.add(onEvent);
      return () => {
        set.delete(onEvent);
        if (!set.size) {
          listeners.delete(runId);
          echoes.delete(runId);
        }
      };
    },
    fromStream(runId, event) {
      const run = echoes.get(runId);
      if (!run) return true;
      const key = JSON.stringify(event);
      const at = run.get(key);
      if (!at) return true;
      const fresh = at.filter((t) => now() - t < ECHO_TTL_MS);
      if (!fresh.length) {
        run.delete(key);
        return true;
      }
      fresh.shift();
      if (fresh.length) run.set(key, fresh);
      else run.delete(key);
      return false;
    },
  };
}
