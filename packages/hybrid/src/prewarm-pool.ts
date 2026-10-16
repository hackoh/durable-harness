/**
 * A tab's pool VM: one fresh VM, its daemon up and
 * no session attached, warmed at page load so the next session the tab opens
 * (a new one, or an existing one whose own VM has stopped) attaches in one
 * `/attach` instead of booting or resuming a VM on its first machine tool.
 *
 * The VM is named after a key the tab mints (`pool-<random>`), not after a
 * session, and each pool VM goes to exactly one session: a fresh workspace
 * per session. Taking it tops the slot up again a little later, so a tab
 * holds at most one unassigned pool VM. Pure state: the page
 * passes in how to warm, keep alive and release.
 */

const POOL_KEY = /^pool-[a-z0-9]{8,40}$/;

/** Whether `key` is a tab-minted pool key (the release route only ever deletes VMs named for these). */
export function isPoolKey(key: unknown): key is string {
  return typeof key === 'string' && POOL_KEY.test(key);
}

/** A fresh pool key. */
export function newPoolKey(random: () => string = () => crypto.randomUUID()): string {
  return `pool-${random().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24)}`;
}

/**
 * The VM a pool key boots: what `VercelSandboxProvider.open(key)` names it
 * (`sandboxNameFor`, repeated here so callers need not load the provider; a
 * test pins the two together).
 */
export function poolVmName(key: string, prefix = 'hybrid'): string {
  return `${prefix}-${key}`.slice(0, 63).replace(/-+$/, '');
}

/** How a warm request ended: `cap` (team cap, retried later), `off` (no hosts on this deployment: the slot turns itself off). */
export type PoolWarmResult = 'ok' | 'cap' | 'off' | 'error';

export interface PoolTake {
  key: string;
  /** Warm already (its daemon answered); otherwise still booting. */
  ready: boolean;
  /** Settles when the boot does: whether the VM is warm. */
  warm: Promise<boolean>;
}

export interface PoolSlot {
  /** Hand the pool VM (warm or still booting) to a session, or undefined if there is none. */
  take(): PoolTake | undefined;
  /** Make sure one pool VM is warming or warm (page load, composer focus). */
  prime(): void;
  /** Composer focus: keep the pool VM alive (throttled), or warm a new one if it stopped. */
  touch(): void;
  /** Keys of pool VMs no session took (for the `pagehide` release). */
  unused(): string[];
  /** Whether the slot is still on (off once the deployment said it has no hosts). */
  enabled(): boolean;
}

export interface PoolSlotOptions {
  enabled: boolean;
  warm(key: string): Promise<PoolWarmResult>;
  /** Keep the VM alive; resolves to its status (`running`, `stopped`, `absent`, ...), undefined if unknown. */
  keepalive?(key: string): Promise<string | undefined>;
  /** Delay before topping the slot up after a take (default 5 s, off the taking turn's path). */
  topUpMs?: number;
  /** Least time between two keepalives (default 4 min; the server throttles at 5). */
  keepaliveEveryMs?: number;
  /** After a `cap` answer, least time before asking again (default 60 s). */
  capRetryMs?: number;
  now?: () => number;
  newKey?: () => string;
  schedule?: (fn: () => void, ms: number) => void;
}

interface Current {
  key: string;
  at: number;
  ready: boolean;
  failed: boolean;
  warm: Promise<boolean>;
}

export function createPoolSlot(options: PoolSlotOptions): PoolSlot {
  const now = options.now ?? Date.now;
  const newKey = options.newKey ?? (() => newPoolKey());
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const topUpMs = options.topUpMs ?? 5000;
  const keepEvery = options.keepaliveEveryMs ?? 4 * 60_000;
  const capRetryMs = options.capRetryMs ?? 60_000;
  let on = options.enabled;
  let current: Current | undefined;
  let lastKeep = 0;
  let capUntil = 0;
  const minted: string[] = [];
  const taken = new Set<string>();

  const prime = () => {
    if (!on || current || now() < capUntil) return;
    const key = newKey();
    minted.push(key);
    const entry: Current = { key, at: now(), ready: false, failed: false, warm: Promise.resolve(false) };
    entry.warm = options.warm(key).then(
      (result) => {
        if (result === 'ok') {
          entry.ready = true;
          entry.at = now();
          lastKeep = now();
          return true;
        }
        entry.failed = true;
        if (result === 'off') on = false;
        if (result === 'cap') capUntil = now() + capRetryMs;
        if (current === entry) current = undefined;
        return false;
      },
      () => {
        entry.failed = true;
        if (current === entry) current = undefined;
        return false;
      }
    );
    current = entry;
  };

  return {
    take() {
      const entry = current;
      if (!entry || entry.failed) return undefined;
      current = undefined;
      taken.add(entry.key);
      schedule(prime, topUpMs);
      return { key: entry.key, ready: entry.ready, warm: entry.warm };
    },
    prime,
    touch() {
      if (!on) return;
      if (!current) return prime();
      const entry = current;
      if (!entry.ready || !options.keepalive || now() - lastKeep < keepEvery) return;
      lastKeep = now();
      void options.keepalive(entry.key).then(
        (status) => {
          // It stopped (the tab sat idle past its timeout) or is gone: warm a
          // fresh one rather than resume this one (a fresh boot is ~2 s, a
          // resume ~8 s).
          if (status && status !== 'running' && current === entry) {
            current = undefined;
            prime();
          }
        },
        () => {}
      );
    },
    unused: () => minted.filter((k) => !taken.has(k)),
    enabled: () => on,
  };
}
