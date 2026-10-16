/**
 * Keeping the daemon's OIDC token fresh. The runtime token
 * lives about 2 h; a VM kept alive longer (sandbox_exec's timeout extensions,
 * a keepalive) would otherwise send every World write and Gateway call with
 * an expired token while `/wake` still answered 202.
 *
 * - Push: whoever wakes the daemon (`wakeHostLane`, `startHost`'s reuse path)
 *   sends `POST /token` with its own fresh token when the daemon's `tokenExp`
 *   is less than `PUSH_BEFORE_MS` away.
 * - Pull: the daemon fetches one itself at exp - `PULL_BEFORE_MS` from
 *   `${APP_ORIGIN}/api/token?vm=&bootId=`, authenticated with its secret.
 */

export const PUSH_BEFORE_MS = 30 * 60_000;
export const PULL_BEFORE_MS = 10 * 60_000;

/** Whether a daemon whose token expires at `exp` (unix seconds) should be pushed a fresh one. */
export function tokenNeedsPush(exp: number | undefined, now = Date.now()): boolean {
  return typeof exp === 'number' && exp * 1000 - now < PUSH_BEFORE_MS;
}

/** Whether a token that expires at `exp` (unix seconds) is already expired. */
export function tokenExpired(exp: number | undefined, now = Date.now()): boolean {
  return typeof exp === 'number' && exp * 1000 <= now;
}

/** `POST /token` to a daemon. */
export async function pushToken(
  url: string,
  secret: string,
  token: string,
  doFetch: typeof fetch = fetch
): Promise<{ ok: boolean; tokenExp?: number }> {
  const res = await doFetch(`${url}/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(3000),
  });
  const body = (await res.json().catch(() => ({}))) as { tokenExp?: number };
  return { ok: res.ok, ...(typeof body.tokenExp === 'number' ? { tokenExp: body.tokenExp } : {}) };
}

/** The daemon's pull: `GET ${appOrigin}/api/token?vm=&bootId=` with its secret. */
export async function pullToken(o: { appOrigin: string; vm: string; bootId: string; secret: string; fetch?: typeof fetch }): Promise<string> {
  const q = new URLSearchParams({ vm: o.vm, bootId: o.bootId });
  const res = await (o.fetch ?? fetch)(`${o.appOrigin}/api/token?${q}`, {
    headers: { authorization: `Bearer ${o.secret}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /api/token answered ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('GET /api/token returned no token');
  return body.token;
}

export interface TokenPullOptions {
  tokenExp(): number | undefined;
  setToken(token: string): void;
  pull(): Promise<string>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?(): void } | unknown;
  /** Retry after a failed pull (default 60 s). */
  retryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Schedule the pull at exp - 10 min, re-reading `tokenExp()` when it fires (a
 * push may have moved it), and retry a failed pull every minute.
 */
export function startTokenPull(o: TokenPullOptions): { stop(): void } {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    const t = setTimer(() => void tick(), Math.max(0, ms)) as { unref?(): void } | undefined;
    t?.unref?.();
  };
  const tick = async () => {
    if (stopped) return;
    const exp = o.tokenExp();
    const due = exp === undefined ? now() : exp * 1000 - PULL_BEFORE_MS;
    if (due > now()) return schedule(due - now());
    try {
      o.setToken(await o.pull());
      const next = o.tokenExp();
      const ms = next === undefined ? 0 : next * 1000 - PULL_BEFORE_MS - now();
      // A pulled token that is itself near expiry: try again in a minute, not in a loop.
      schedule(ms > 0 ? ms : (o.retryMs ?? 60_000));
    } catch (err) {
      o.log?.('token pull failed', { error: String(err) });
      schedule(o.retryMs ?? 60_000);
    }
  };
  void tick();
  return {
    stop() {
      stopped = true;
    },
  };
}
