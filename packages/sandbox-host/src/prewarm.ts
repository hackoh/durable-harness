/**
 * Pre-warming policy: the pure decisions behind the
 * pool VM a tab warms at page load, the keepalive on each turn, and the cost
 * caps. No Sandbox API calls here: the app passes in how to count warm VMs.
 *
 * - **Pool keys.** A tab mints `pool-<random>` and the app names the VM after
 *   it (not after a session), so a pool VM can become the VM of whichever
 *   session the tab opens next. It is single-use: a fresh workspace per
 *   session, nothing left over from another conversation.
 * - **Team cap**: at most `cap` warm VMs of this app. Counting them is
 *   a Sandbox API list (~200 ms), so the count is cached for `countTtlMs`
 *   and this instance's own admissions since are added on top. Beyond the
 *   cap pre-warming degrades to on-demand (the session's own VM on attach).
 *   A failed count admits: the cap bounds cost, it must not take the lane
 *   down.
 * - **Keepalive**: extend a VM's timeout at most once per
 *   `keepaliveEveryMs` per VM, so a busy session costs one Sandbox call per
 *   five minutes, not one per turn.
 * - **Claims**: a pool key is handed to one session. A second session asking
 *   for the same key (a duplicated request, two instances of one tab's code)
 *   is refused here and gets its own VM instead.
 */

export interface PrewarmPolicyOptions {
  /** Most warm VMs of this app across the team (20). */
  cap?: number;
  /** How many of this app's VMs are warm now (`VercelSandboxProvider.countWarm`). */
  countWarm(): Promise<number>;
  /** How long a count is trusted (default 15 s). */
  countTtlMs?: number;
  /** Least time between two keepalives of one VM (default 5 min). */
  keepaliveEveryMs?: number;
  now?: () => number;
}

export interface Admission {
  ok: boolean;
  /** Warm VMs counted (plus this instance's admissions since the count). */
  warm: number;
  cap: number;
  /** The count could not be taken; admitted anyway. */
  uncounted?: boolean;
}

export interface PrewarmPolicy {
  /** Whether one more pool VM may be warmed now (counts it if so). */
  admit(): Promise<Admission>;
  /** Whether `vm` is due a keepalive now (records it if so). */
  keepaliveDue(vm: string): boolean;
  /** Forget a keepalive (it failed: the next turn should try again). */
  keepaliveFailed(vm: string): void;
  /**
   * Hand pool `key` to session `runId`. True for the first session to ask
   * and again for that same session; false for any other.
   */
  claim(key: string, runId: string): boolean;
  /** The session a pool key went to, if any. */
  claimedBy(key: string): string | undefined;
}

export const DEFAULT_CAP = 20;
export const KEEPALIVE_EVERY_MS = 5 * 60_000;
/** A kept-alive VM has at least this long left (its idle teardown,: stop after 10 min without a turn). */
export const KEEPALIVE_MIN_LEFT_MS = 10 * 60_000;

export { isPoolKey, newPoolKey, poolVmName } from 'harness-world-hybrid/prewarm-pool';

export function createPrewarmPolicy(options: PrewarmPolicyOptions): PrewarmPolicy {
  const cap = options.cap ?? DEFAULT_CAP;
  const ttl = options.countTtlMs ?? 15_000;
  const every = options.keepaliveEveryMs ?? KEEPALIVE_EVERY_MS;
  const now = options.now ?? Date.now;
  let counted: { at: number; warm: number } | undefined;
  let since = 0;
  let counting: Promise<number | undefined> | undefined;
  const kept = new Map<string, number>();
  const claims = new Map<string, string>();

  const count = async (): Promise<number | undefined> => {
    if (counted && now() - counted.at < ttl) return counted.warm;
    counting ??= options.countWarm().then(
      (warm) => {
        counted = { at: now(), warm };
        since = 0;
        return warm;
      },
      () => undefined
    );
    try {
      return await counting;
    } finally {
      counting = undefined;
    }
  };

  return {
    async admit() {
      const warm = await count();
      if (warm === undefined) return { ok: true, warm: since++, cap, uncounted: true };
      const total = warm + since;
      if (total >= cap) return { ok: false, warm: total, cap };
      since++;
      return { ok: true, warm: total + 1, cap };
    },
    keepaliveDue(vm) {
      const last = kept.get(vm);
      if (last !== undefined && now() - last < every) return false;
      kept.set(vm, now());
      // Bounded: a long-lived instance forgets VMs it has not seen in a while.
      if (kept.size > 512) for (const [k, at] of kept) if (now() - at > every) kept.delete(k);
      return true;
    },
    keepaliveFailed(vm) {
      kept.delete(vm);
    },
    claim(key, runId) {
      const owner = claims.get(key);
      if (owner) return owner === runId;
      claims.set(key, runId);
      if (claims.size > 1024) claims.delete(claims.keys().next().value!);
      return true;
    },
    claimedBy: (key) => claims.get(key),
  };
}
