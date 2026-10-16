import { RUN_TOKEN_HEADER } from 'harness-world-remote';

/**
 * This tab's capabilities: one token per session run, from the server's
 * `POST /api/hybrid/session-token`. The tab sends a run's token on every
 * World call about that run (`/api/world`, `/api/session-host`) and on the
 * model calls it makes for it (`/api/gateway`, which keeps the session's
 * budget). The tab holds no other credential: no project OIDC token, no
 * Gateway key.
 *
 * Model calls of a tab mode whose sessions are not on the server (their
 * log is in the browser) go under the page's own run id (`page`), so the
 * proxy can still budget them.
 */
export interface RunTokens {
  /** The token for `runId`, fetched once and refreshed before it expires. */
  get(runId: string): Promise<string>;
  /** The header that carries `runId`'s token (the page's run when none is given). */
  headers(runId?: string): Promise<Record<string, string>>;
  /** The run this tab is driving right now (its model calls are that session's). */
  active?: string;
  /** A run id of this page's own, for model calls of no server session. */
  readonly page: string;
}

/** Refresh a token this long before it expires. */
const REFRESH_MS = 5 * 60_000;

const shared = new Map<string, RunTokens>();

/** The tokens of `origin`'s sessions: one set per origin in this page. */
export function runTokens(origin: string, doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)): RunTokens {
  const base = origin.replace(/\/+$/, '');
  const existing = shared.get(base);
  if (existing) return existing;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();
  async function fetchToken(runId: string): Promise<string> {
    const response = await doFetch(`${base}/api/hybrid/session-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as { token?: string; expiresAt?: number; error?: string } | null;
    if (!response.ok || typeof body?.token !== 'string') {
      throw new Error(`POST /api/hybrid/session-token for ${runId}: ${response.status} ${body?.error ?? ''}`.trim());
    }
    cache.set(runId, { token: body.token, expiresAt: body.expiresAt ?? Date.now() + 30 * 60_000 });
    return body.token;
  }
  const tokens: RunTokens = {
    page: newRunId(),
    async get(runId) {
      const held = cache.get(runId);
      if (held && held.expiresAt - Date.now() > REFRESH_MS) return held.token;
      let pending = inflight.get(runId);
      if (!pending) {
        pending = fetchToken(runId).finally(() => inflight.delete(runId));
        inflight.set(runId, pending);
      }
      // A token that is still valid serves while its refresh is out.
      if (held && held.expiresAt > Date.now()) {
        pending.catch(() => {});
        return held.token;
      }
      return pending;
    },
    async headers(runId) {
      return { [RUN_TOKEN_HEADER]: await tokens.get(runId ?? tokens.active ?? tokens.page) };
    },
  };
  shared.set(base, tokens);
  return tokens;
}

/** A run id as harness-world mints one: `wrun_` and a ULID. */
function newRunId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `wrun_${head}${[...random].map((b) => alphabet[b % 32]).join('')}`;
}
