import type { World } from '@workflow/world';
import { encodeLine, readJsonLines } from 'harness-world';
import {
  AI_GATEWAY_LANGUAGE_MODEL_ROUTE,
  CLAUDE_ROUTES,
  GatewayError,
  type GatewayLedger,
  gatewayHandler,
  type GatewayRoute,
} from 'harness-world-process';
import { runHarness, spendStreamName } from './run-tokens';

/**
 * `/api/gateway`, the tab's way to AI Gateway (its model calls; the
 * credential, the project's OIDC token, never reaches the browser). Every
 * POST is a session's, by its run token (lib/run-tokens.ts), and goes
 * through harness-process's `gatewayHandler` (docs/workspaces.md §5.5):
 *
 * - a fixed table: Pi's Messages call (`POST /v1/messages?beta=true`) and
 *   libfx's language-model call (`POST /v4/ai/language-model`), the
 *   upstream URL from the table, never from the request;
 * - the body parsed strictly (duplicate keys refused), checked against the
 *   route's schema (its keys, client tools only, no Gateway options or
 *   fallbacks, nothing the provider would run) and re-serialized; output
 *   limits clamped;
 * - the model one of this app's (`models`);
 * - a per-session budget (`sessionUsd`): each response's cost is the
 *   Gateway's own figure (an estimate at ceiling prices when it gave none),
 *   recorded in the session's `<runId>_spend` stream, which the tab may not
 *   write (`/api/world` refuses it), so the total carries across instances.
 *   A session the server World does not have (a Tab mode's, whose log is in
 *   the browser) is counted in this instance's memory only.
 *
 * At most `concurrency` requests per session at once on an instance.
 */

/** Pi's Messages call (Claude Code's route: the same path, query and headers) and libfx's language-model call. */
export const TAB_ROUTES: readonly GatewayRoute[] = Object.freeze([
  CLAUDE_ROUTES.find((r) => r.method === 'POST' && r.path === '/v1/messages')!,
  AI_GATEWAY_LANGUAGE_MODEL_ROUTE,
]);

export interface TabGatewayOptions {
  world: World | (() => Promise<World>);
  /** The run a request's token is for (undefined: no valid token). */
  runOf(request: Request): Promise<string | undefined>;
  /** The model ids a session may call. */
  models: { model: string; smallModel?: string };
  /** Each session's model spend cap, US dollars. `Infinity` turns it off. */
  sessionUsd: number;
  /** Requests in flight per session on this instance. Default 8. */
  concurrency?: number;
  credential(): Promise<string>;
  /** Default AI Gateway. Only its origin is used. */
  target?: string;
  /** Test seam for the upstream call. */
  fetch?: typeof fetch;
  /** Called with work that must finish after the response (the spend write of a cancelled response). */
  waitUntil?(work: Promise<unknown>): void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** What a refusal's code answers (the relay's mapping), with a fixed body. */
const STATUS: Record<string, number> = { bad_request: 400, forbidden: 403, budget: 403, busy: 429, upstream: 502, internal: 500 };

const errorResponse = (status: number, type: string, message?: string) =>
  Response.json({ type: 'error', error: { type, ...(message ? { message } : {}) } }, { status, headers: { 'cache-control': 'no-store' } });

export function tabGateway(options: TabGatewayOptions): (request: Request, path: string) => Promise<Response> {
  const inflight = new Map<string, number>();
  /** Spend of sessions the server World does not have, on this instance. */
  const local = new Map<string, number>();
  /** Runs the server World has (once it has one, it keeps it; a miss or a failed read is asked again next time). */
  const known = new Set<string>();
  const limit = options.concurrency ?? 8;
  const log = options.log ?? ((m: string, f?: Record<string, unknown>) => console.log(`[harness] /api/gateway ${m}`, f ?? {}));
  const world = typeof options.world === 'function' ? options.world : async () => options.world as World;

  async function ledgerFor(runId: string): Promise<GatewayLedger & { flush(): Promise<void> }> {
    const w = await world();
    if (!known.has(runId) && (await runHarness(w, runId).catch(() => null)) !== null) known.add(runId);
    if (!known.has(runId)) {
      return {
        spent: () => ({ turnUsd: 0, sessionUsd: local.get(runId) ?? 0 }),
        add: (usd) => void local.set(runId, (local.get(runId) ?? 0) + usd),
        flush: async () => {},
      };
    }
    let total = 0;
    for (const line of await readJsonLines(w, runId, spendStreamName(runId))) {
      const usd = (line as { usd?: unknown })?.usd;
      if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) total += usd;
    }
    const writes: Promise<unknown>[] = [];
    return {
      spent: () => ({ turnUsd: 0, sessionUsd: total }),
      add(usd, info) {
        total += usd;
        const line = `${encodeLine({ usd, at: Date.now(), path: info.path, ...(info.model ? { model: info.model } : {}), ...(info.estimated ? { estimated: true } : {}) })}\n`;
        writes.push(w.streams.write(runId, spendStreamName(runId), new TextEncoder().encode(line)).catch((err) => log('spend write failed', { runId, error: String(err) })));
      },
      flush: async () => {
        await Promise.all(writes);
      },
    };
  }

  return async (request, path) => {
    const runId = await options.runOf(request);
    if (!runId) return errorResponse(401, 'authentication_error', 'a session token (x-harness-run-token) is required');
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 4 << 20) return errorResponse(400, 'bad_request');
    const running = inflight.get(runId) ?? 0;
    if (running >= limit) return errorResponse(429, 'busy');
    inflight.set(runId, running + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inflight.get(runId) ?? 1) - 1;
      if (n > 0) inflight.set(runId, n);
      else inflight.delete(runId);
    };
    let ledger: Awaited<ReturnType<typeof ledgerFor>> | undefined;
    try {
      ledger = await ledgerFor(runId);
      const handler = gatewayHandler({
        routes: TAB_ROUTES,
        models: options.models,
        budget: { turnUsd: Infinity, sessionUsd: options.sessionUsd },
        ledger,
        // A tab can fetch any URL itself: a part the provider fetches by URL is no way out of anything.
        network: 'allow-all',
        credential: options.credential,
        ...(options.target ? { target: options.target } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        log: (message, fields) => log(message, { runId, ...(fields ?? {}) }),
      });
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const body = new Uint8Array(await request.arrayBuffer());
      const response = await handler({ method: request.method, path, headers, body }, request.signal);
      const iterator = response.body[Symbol.asyncIterator]();
      const done = ledger;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (!next.done) return controller.enqueue(next.value);
            // The response's cost is recorded before the body ends.
            await done.flush();
            release();
            controller.close();
          } catch (err) {
            release();
            controller.error(err);
          }
        },
        async cancel() {
          await iterator.return?.();
          release();
          const flushing = done.flush();
          if (options.waitUntil) options.waitUntil(flushing);
          else await flushing;
        },
      });
      return new Response(stream, { status: response.status, headers: { ...response.headers, 'cache-control': 'no-store' } });
    } catch (err) {
      release();
      await ledger?.flush().catch(() => {});
      if (err instanceof GatewayError) return errorResponse(STATUS[err.code] ?? 500, err.code);
      log('failed', { runId, error: String((err as Error)?.message ?? err) });
      return errorResponse(500, 'internal');
    }
  };
}
