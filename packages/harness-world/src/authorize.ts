/**
 * Who may use a chat route, and what one answers when nobody said.
 *
 * - A function: called before each request is served (`sessionId` is
 *   undefined when a POST is about to start a session). Throw a `Response`
 *   (401, 404) to refuse; return to let the request through.
 * - `'public'`: anyone, on purpose.
 * - Neither: open under `next dev` (any `NODE_ENV` but `production`), and in
 *   production (Vercel's production and preview deployments, `next start`)
 *   every request is refused with a 401 that says how to fix it, and the
 *   process logs the same once. A chat route runs the agent's tools and
 *   spends model credits for whoever calls it, so it is not served to
 *   everyone unless someone chose that.
 */
export type ChatAuthorize = ((request: Request, sessionId: string | undefined) => unknown) | 'public';

/** What a chat route with no `authorize` answers in production (and logs, once per process). */
export const NO_AUTHORIZE_MESSAGE =
  "durable-harness: this chat route refuses every request in production because it has no authorize. Pass chatRoute({ authorize: async (request, sessionId) => { ... } }) and throw a Response (401, 404) from it to refuse a caller, or chatRoute({ authorize: 'public' }) to serve anyone.";

const WARNED = Symbol.for('durable-harness//chat-route-no-authorize-warned');

/** A production build or server (`next build` / `next start`, every Vercel deployment): `NODE_ENV` is `production`. */
const inProduction = () => typeof process !== 'undefined' && process.env.NODE_ENV === 'production';

export interface ChatGate {
  /**
   * The 401 a route with no `authorize` answers in production, or undefined.
   * Checked first, before the request is read: every request is refused.
   */
  unconfigured(): Response | undefined;
  /** Run `authorize` for this request: its refusal (the `Response` it threw), or undefined to go on. */
  check(request: Request, sessionId: string | undefined): Promise<Response | undefined>;
}

/**
 * The gate every chat route runs (the kernel's `chatRoute`, pi-durable's).
 * Throws at once for an `authorize` that is neither a function nor `'public'`.
 */
export function chatGate(authorize: ChatAuthorize | undefined): ChatGate {
  if (authorize !== undefined && authorize !== 'public' && typeof authorize !== 'function') {
    throw new TypeError(`durable-harness: chatRoute's authorize must be a function or 'public' (got ${JSON.stringify(authorize) ?? String(authorize)})`);
  }
  return {
    unconfigured() {
      if (authorize !== undefined || !inProduction()) return undefined;
      const g = globalThis as { [WARNED]?: boolean };
      if (!g[WARNED]) {
        g[WARNED] = true;
        console.warn(`[durable-harness] ${NO_AUTHORIZE_MESSAGE}`);
      }
      return Response.json({ error: 'unauthorized', message: NO_AUTHORIZE_MESSAGE }, { status: 401 });
    },
    async check(request, sessionId) {
      if (typeof authorize !== 'function') return undefined;
      try {
        await authorize(request, sessionId);
        return undefined;
      } catch (error) {
        if (error instanceof Response) return error;
        throw error;
      }
    },
  };
}
