/**
 * Pre-created sessions: one idle session per page,
 * made ahead of the first prompt, so creating the run (`run_created`,
 * `run_started`, `hook_created`: about 450 ms on world-vercel) is off the
 * time-to-first-token path. The first prompt is sent to it instead.
 *
 * At most one per harness is kept, and only for the harness this page last
 * used (so a page load costs one run, not one per harness). Spares are
 * hidden from the session list until used, and unused ones are closed by a
 * `pagehide` beacon (the server leaves any session that got a submission
 * alone).
 */
export interface Spares {
  /**
   * A ready (or in-flight) spare for `harness` (a harness, or a harness and
   * its hands: `spareKey`), now owned by the caller; undefined if none.
   */
  take(harness: string): Promise<string | undefined>;
  /** Make sure a spare for `harness` exists (in the background). */
  prime(harness: string): void;
  /** Whether `id` is an unused spare (hide it from lists). */
  hidden(id: string): boolean;
}

export function createSpares(options: {
  enabled: boolean;
  /** Where the last-used harness is remembered (localStorage). */
  key: string;
  defaultHarness: string;
  create(harness: string): Promise<string>;
  /** Called on pagehide with the unused spares' ids. */
  release?(ids: string[]): void;
}): Spares {
  const pending = new Map<string, Promise<string | undefined>>();
  const unused = new Set<string>();
  const remember = (harness: string) => {
    try {
      localStorage.setItem(options.key, harness);
    } catch {}
  };
  const prime = (harness: string) => {
    if (!options.enabled || pending.has(harness)) return;
    const p = options.create(harness).then(
      (id) => {
        unused.add(id);
        return id;
      },
      () => {
        pending.delete(harness);
        return undefined;
      }
    );
    pending.set(harness, p);
  };
  if (options.enabled) {
    let last = options.defaultHarness;
    try {
      last = localStorage.getItem(options.key) ?? last;
    } catch {}
    prime(last);
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', () => {
        if (unused.size) options.release?.([...unused]);
      });
    }
  }
  return {
    async take(harness) {
      remember(harness);
      const p = pending.get(harness);
      pending.delete(harness);
      const id = p ? await p : undefined;
      if (id) unused.delete(id);
      // The next one, once this turn is under way.
      setTimeout(() => prime(harness), 2000);
      return id;
    },
    prime,
    hidden: (id) => unused.has(id),
  };
}

/** A spare's key: its harness and, when the page chose them, its hands (a spare is made with them). */
export const spareKey = (harness: string, hands?: string) => (hands ? `${harness}|${hands}` : harness);
/** The harness and hands a spare's key names. */
export function fromSpareKey(key: string): { harness: string; hands?: string } {
  const [harness, hands] = key.split('|');
  return hands ? { harness: harness!, hands } : { harness: harness! };
}

/** `/api/sessions/release` by beacon (it survives the page going away): close the unused pre-created sessions. */
export function releaseByBeacon(ids: string[]): void {
  try {
    navigator.sendBeacon('/api/sessions/release', new Blob([JSON.stringify({ ids })], { type: 'application/json' }));
  } catch {}
}
