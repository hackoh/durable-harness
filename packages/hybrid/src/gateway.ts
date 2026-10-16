/**
 * AI Gateway from a tab (or a Sandbox VM), direct or through a proxy.
 *
 * `gatewayFetch` sends a model request straight to
 * `https://ai-gateway.vercel.sh` when it has credentials (`tokens`), and
 * through the app's proxy otherwise (`proxyBase`), or when the Gateway
 * rejects the token, or when a browser blocks the request (CORS).
 *
 * The demo hands a tab no credentials (its `/api/token`, which gave out the
 * project OIDC token, is gone): every tab request goes through the proxy,
 * `/api/gateway`, with the session's run token in `proxyHeaders`, and the
 * proxy checks the body and the session's budget (docs/workspaces.md §8).
 *
 * Nothing here is browser- or Node-specific.
 */

export const GATEWAY_URL = 'https://ai-gateway.vercel.sh';

/** Credentials for direct requests (a token source's). */
export interface DirectCredentials {
  /** A token the Gateway accepts (a project OIDC token, minted by a Function). */
  token: string;
  /** Seconds since the epoch, read from the JWT (never assumed). */
  exp?: number;
  iat?: number;
  /** The Vercel environment that minted it: every lane of a session shares one tenant. */
  environment?: string;
  deploymentId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  gateway?: string;
  /** Same-origin relays for the World (the tab cannot reach Vercel's Workflow backend itself). */
  relay?: Record<string, string>;
}

/** The claims of a JWT, without verifying it (the Gateway and the World's backend do that). */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
          )
        : Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `exp`/`iat` of a token, in seconds, if it has them. */
export function tokenTimes(token: string): { exp?: number; iat?: number } {
  const c = jwtClaims(token);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const exp = num(c?.exp);
  const iat = num(c?.iat);
  return { ...(exp !== undefined ? { exp } : {}), ...(iat !== undefined ? { iat } : {}) };
}

/**
 * The request headers AI Gateway's CORS preflight allows (its
 * `access-control-allow-headers`), plus the CORS-safelisted ones. A browser
 * refuses a cross-origin request carrying any other header, and the Anthropic
 * SDK pi-ai uses adds `x-stainless-*` and
 * `anthropic-dangerous-direct-browser-access`, so direct requests from a tab
 * drop everything outside this list.
 */
export const GATEWAY_CORS_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'authorization',
  'ai-gateway-auth-method',
  'ai-gateway-protocol-version',
  'ai-model-id',
  'ai-language-model-id',
  'ai-language-model-specification-version',
  'ai-image-model-specification-version',
  'ai-embedding-model-specification-version',
  'ai-language-model-streaming',
  'ai-reporting-tags',
  'ai-reporting-user',
  'http-referer',
  'x-title',
  'x-ai-gateway-api-key',
  'x-api-key',
  'anthropic-beta',
  'anthropic-version',
  'idempotency-key',
  'x-vercel-ai-gateway-team',
  'x-vercel-gateway-extended-time',
  'x-session-id',
  'x-session-affinity',
]);

/** `headers` with the credential set to `token`, and (for a browser) only what the Gateway's CORS allows. */
export function directHeaders(headers: HeadersInit | undefined, token: string, cors = true): Headers {
  const out = new Headers();
  for (const [key, value] of new Headers(headers)) {
    if (!cors || GATEWAY_CORS_HEADERS.has(key.toLowerCase())) out.set(key, value);
  }
  out.set('authorization', `Bearer ${token}`);
  out.set('x-api-key', token);
  return out;
}

export interface TokenSource {
  /**
   * Credentials good for at least `minTtlMs`, fetching or refreshing them if
   * needed. Undefined when direct tokens are off (the route answered 404) or
   * cannot be fetched right now: callers use the proxy then.
   */
  get(options?: { force?: boolean }): Promise<DirectCredentials | undefined>;
  /** The last credentials, without waiting. */
  peek(): DirectCredentials | undefined;
  /** True once the token route said direct tokens are off. */
  readonly unavailable: boolean;
  close(): void;
}

export interface TokenSourceOptions {
  /** Fetch fresh credentials; resolve `undefined` when direct tokens are off (404). */
  fetch(): Promise<DirectCredentials | undefined>;
  now?: () => number;
  /** Refresh this long before `exp`. Default 10 min. */
  refreshBeforeMs?: number;
  /** A token closer than this to `exp` is not handed out. Default 60 s. */
  minTtlMs?: number;
  /** Refresh in the background at `exp − refreshBeforeMs`. Default true. */
  background?: boolean;
  onError?(error: unknown): void;
}

/** A cached, self-refreshing token (refresh time comes from the JWT's `exp`). */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const now = options.now ?? Date.now;
  const refreshBefore = options.refreshBeforeMs ?? 10 * 60_000;
  const minTtl = options.minTtlMs ?? 60_000;
  let current: DirectCredentials | undefined;
  let inflight: Promise<DirectCredentials | undefined> | undefined;
  let unavailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const expMs = (c: DirectCredentials) => {
    const exp = c.exp ?? tokenTimes(c.token).exp;
    return exp === undefined ? Number.POSITIVE_INFINITY : exp * 1000;
  };
  const usable = (c: DirectCredentials | undefined, ttl: number) => !!c && expMs(c) - now() > ttl;

  function schedule(c: DirectCredentials) {
    if (options.background === false || closed) return;
    if (timer) clearTimeout(timer);
    const left = expMs(c) - now();
    const at = left - refreshBefore;
    if (!Number.isFinite(at)) return;
    // Already inside the refresh window (the route handed back a token that
    // expires soon): try again at a gentle pace instead of spinning.
    const delay = at > 0 ? at : Math.min(60_000, Math.max(5_000, left / 4));
    timer = setTimeout(() => void refresh().catch(() => {}), delay);
    (timer as { unref?: () => void }).unref?.();
  }

  function refresh(): Promise<DirectCredentials | undefined> {
    inflight ??= (async () => {
      try {
        const got = await options.fetch();
        if (!got) {
          unavailable = true;
          current = undefined;
          return undefined;
        }
        const times = tokenTimes(got.token);
        current = { ...times, ...got, ...(got.exp === undefined && times.exp !== undefined ? { exp: times.exp } : {}) };
        schedule(current);
        return current;
      } catch (error) {
        options.onError?.(error);
        // Keep serving a token that is still valid; the next get retries.
        if (usable(current, 5_000)) return current;
        return undefined;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    get unavailable() {
      return unavailable;
    },
    peek: () => current,
    async get(opts) {
      if (unavailable || closed) return undefined;
      if (!opts?.force && usable(current, minTtl)) return current;
      return refresh();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export type GatewayRoute = 'direct' | 'proxy';

export interface GatewayStatus {
  /** What the next request will try first. */
  route: GatewayRoute;
  /** Why it is not direct, when it is not. */
  reason?: string;
  /** What served the last request. */
  last?: GatewayRoute;
}

export interface GatewayFetchOptions {
  /** Direct credentials. Without them every request uses the proxy. */
  tokens?: TokenSource;
  /** The proxy's base, e.g. `https://app/api/gateway`. Without it every request goes direct. */
  proxyBase?: string;
  /** Headers added to every proxied request, read per request (a session's run token for the demo's proxy). Never sent direct. */
  proxyHeaders?: () => HeadersInit | Promise<HeadersInit>;
  /** Force one route (`?gateway=proxy` in the demo, for A/B benchmarks). Default `auto`. */
  mode?: 'auto' | GatewayRoute;
  fetch?: typeof fetch;
  gateway?: string;
  /** Drop headers outside the Gateway's CORS allow-list. Default true (harmless outside a browser). */
  cors?: boolean;
  /** After a direct failure, use the proxy this long before trying direct again. Default 60 s. */
  cooldownMs?: number;
  /**
   * Give up on a direct request that has not produced response headers in
   * this long and send it through the proxy instead (or, forced direct, send
   * it direct once more). Nothing was answered yet, so resending is safe.
   * Default 12 s (a Messages stream's headers take about 1 s). On production
   * about one direct request from a browser in 40 never got a response at all,
   * which the model client would otherwise wait out for minutes. 0 disables it.
   */
  headersTimeoutMs?: number;
  now?: () => number;
  onRoute?(event: { route: GatewayRoute; url: string; reason?: string }): void;
}

export type GatewayFetch = typeof fetch & {
  status(): GatewayStatus;
  /**
   * Check that a direct request would be accepted (CORS preflight and the
   * token), and open the connection to the Gateway early. A failed probe
   * sends requests to the proxy.
   */
  warm(): Promise<{ ok: boolean; ms: number; reason?: string }>;
};

const isAbort = (err: unknown, signal?: AbortSignal | null) =>
  !!signal?.aborted || (err instanceof Error && err.name === 'AbortError');

/**
 * A `fetch` for model requests: anything under the Gateway URL goes direct
 * with a fresh token, or through the proxy (see the module comment); any
 * other URL passes through untouched.
 */
export function gatewayFetch(options: GatewayFetchOptions): GatewayFetch {
  const gateway = (options.gateway ?? GATEWAY_URL).replace(/\/+$/, '');
  const base = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const cooldown = options.cooldownMs ?? 60_000;
  const headersTimeout = options.headersTimeoutMs ?? 12_000;
  const mode = options.mode ?? 'auto';
  const proxyBase = options.proxyBase?.replace(/\/+$/, '');
  let brokenUntil = 0;
  let brokenReason: string | undefined;
  let last: GatewayRoute | undefined;

  const directPossible = () =>
    mode !== 'proxy' && !!options.tokens && !options.tokens.unavailable && (mode === 'direct' || now() >= brokenUntil);
  const reasonNotDirect = () =>
    mode === 'proxy'
      ? 'forced to the proxy'
      : !options.tokens
        ? 'no token source'
        : options.tokens.unavailable
          ? 'direct tokens are off'
          : now() < brokenUntil
            ? brokenReason
            : undefined;
  const breakDirect = (reason: string) => {
    brokenUntil = now() + cooldown;
    brokenReason = reason;
  };
  const note = (route: GatewayRoute, url: string, reason?: string) => {
    last = route;
    options.onRoute?.({ route, url, ...(reason ? { reason } : {}) });
  };

  async function viaProxy(url: string, init: RequestInit, reason?: string): Promise<Response> {
    if (!proxyBase) throw new Error(`no route to AI Gateway: ${reason ?? 'no credentials'}`);
    note('proxy', url, reason);
    if (!options.proxyHeaders) return base(proxyBase + url.slice(gateway.length), init);
    const headers = new Headers(init.headers);
    new Headers(await options.proxyHeaders()).forEach((value, key) => headers.set(key, value));
    return base(proxyBase + url.slice(gateway.length), { ...init, headers });
  }

  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    if (!url.startsWith(`${gateway}/`)) return base(input, init);
    // A body we may send twice (a retry with a fresh token, or the proxy
    // after a blocked direct attempt): read a stream once.
    let body = init?.body ?? (request ? await request.clone().arrayBuffer() : undefined);
    if (body && typeof body !== 'string' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof URLSearchParams)) {
      body = await new Response(body as BodyInit).arrayBuffer();
    }
    const merged: RequestInit = {
      ...(request ? { method: request.method, headers: request.headers, signal: request.signal } : {}),
      ...init,
      ...(body !== undefined && body !== null ? { body } : {}),
    };
    if (!directPossible()) return viaProxy(url, merged, reasonNotDirect());

    let creds = await options.tokens!.get().catch(() => undefined);
    if (!creds) {
      if (mode === 'direct') throw new Error('AI Gateway direct: no token');
      return viaProxy(url, merged, options.tokens!.unavailable ? 'direct tokens are off' : 'no token');
    }
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const token = creds.token;
      try {
        response = await withHeadersTimeout(
          (signal) => base(url, { ...merged, signal, headers: directHeaders(merged.headers, token, options.cors ?? true) }),
          merged.signal ?? undefined,
          headersTimeout
        );
      } catch (err) {
        if (err instanceof HeadersTimeout) {
          stalls++;
          // One stalled request says little about the next: no cooldown.
          if (proxyBase && mode !== 'direct') return viaProxy(url, merged, err.message);
          if (stalls < 2) {
            attempt--;
            continue;
          }
          throw err;
        }
        if (isAbort(err, merged.signal) || mode === 'direct' || !proxyBase) throw err;
        // Blocked (CORS) or unreachable: nothing was answered, so the proxy can take it.
        breakDirect(`direct request failed: ${err instanceof Error ? err.message : String(err)}`);
        return viaProxy(url, merged, brokenReason);
      }
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        // The token may have expired or been revoked: once more with a fresh one.
        await response.body?.cancel().catch(() => {});
        const fresh = await options.tokens!.get({ force: true }).catch(() => undefined);
        if (fresh) {
          creds = fresh;
          continue;
        }
      } else if ((response.status === 401 || response.status === 403) && mode !== 'direct' && proxyBase) {
        await response.body?.cancel().catch(() => {});
        breakDirect(`AI Gateway rejected the token (${response.status})`);
        return viaProxy(url, merged, brokenReason);
      }
      note('direct', url);
      return response;
    }
  }) as GatewayFetch;

  fn.status = () => {
    const reason = directPossible() ? undefined : reasonNotDirect();
    return { route: directPossible() ? 'direct' : 'proxy', ...(reason ? { reason } : {}), ...(last ? { last } : {}) };
  };

  fn.warm = async () => {
    const t0 = now();
    if (!directPossible()) return { ok: false, ms: 0, reason: reasonNotDirect() ?? 'direct unavailable' };
    const creds = await options.tokens!.get().catch(() => undefined);
    if (!creds) return { ok: false, ms: now() - t0, reason: options.tokens!.unavailable ? 'direct tokens are off' : 'no token' };
    const probe = await probeGateway(creds.token, { fetch: base, gateway });
    if (!probe.ok && mode !== 'direct') breakDirect(`probe failed: ${probe.reason}`);
    return probe;
  };
  return fn;
}

class HeadersTimeout extends Error {
  constructor(ms: number) {
    super(`AI Gateway sent no response headers within ${ms} ms`);
    this.name = 'HeadersTimeout';
  }
}

/**
 * `start(signal)`, aborted (and rejected with `HeadersTimeout`) when it has
 * not resolved within `ms`. `signal` also follows the caller's `outer`
 * signal, before and after the headers arrive (it keeps governing the body).
 */
async function withHeadersTimeout(
  start: (signal: AbortSignal) => Promise<Response>,
  outer: AbortSignal | undefined,
  ms: number
): Promise<Response> {
  const controller = new AbortController();
  const follow = () => controller.abort(outer?.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener('abort', follow, { once: true });
  if (!(ms > 0)) return start(controller.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new HeadersTimeout(ms));
  }, ms);
  try {
    return await start(controller.signal);
  } catch (err) {
    if (timedOut) throw new HeadersTimeout(ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Would a direct model request be accepted? A preflighted `OPTIONS` of the
 * Messages endpoint (CORS) and an authenticated read of the model catalog
 * (the token), in parallel. Also opens the connection a first model call
 * would otherwise pay for.
 */
export async function probeGateway(
  token: string,
  options: { fetch?: typeof fetch; gateway?: string; now?: () => number } = {}
): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const gateway = (options.gateway ?? GATEWAY_URL).replace(/\/+$/, '');
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const t0 = now();
  try {
    const [preflight, models] = await Promise.all([
      doFetch(`${gateway}/v1/messages`, {
        method: 'OPTIONS',
        headers: directHeaders({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, token),
      }),
      doFetch(`${gateway}/coding-agent/v1/models`, { headers: directHeaders({ accept: 'application/json' }, token) }),
    ]);
    await Promise.all([preflight.body?.cancel().catch(() => {}), models.body?.cancel().catch(() => {})]);
    const ms = Math.round(now() - t0);
    if (!preflight.ok) return { ok: false, ms, reason: `OPTIONS /v1/messages ${preflight.status}` };
    if (!models.ok) return { ok: false, ms, reason: `GET /coding-agent/v1/models ${models.status}` };
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, ms: Math.round(now() - t0), reason: err instanceof Error ? err.message : String(err) };
  }
}
