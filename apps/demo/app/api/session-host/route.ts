import { experimental_upgradeWebSocket } from '@vercel/functions';
import { serveOverWs, type WsLike } from 'harness-world-remote/ws';
import { worldHandler } from '@/lib/world-handler';

// One held invocation per connected tab; the tab reconnects after this.
export const maxDuration = 800;

/**
 * The session host: one WebSocket per tab carrying
 * the tab's World ops (`harness-world-remote/ws` frames around the very
 * handler `/api/world` serves), so the tab pays one held connection
 * instead of a request per op, and its stream tails are pushed down the
 * same socket. Vercel's Workflow backend has no CORS and reads auth only from a
 * header a browser WebSocket cannot set, so the tab reaches the World
 * through this relay, not directly.
 *
 * Uses `experimental_upgradeWebSocket` (Vercel Functions only). Where it is
 * unavailable (next dev, an older runtime) this answers 501 and the tab
 * stays on HTTP `/api/world`. Opt-in from the tab with `?relay=ws`.
 */
export async function GET(request: Request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ relay: 'ws', hint: 'connect with a WebSocket' }, { status: 426 });
  }
  const handler = await worldHandler();
  const baseUrl = new URL('/api/world', request.url).toString();
  try {
    return await experimental_upgradeWebSocket(async (ws) => {
      const t0 = Date.now();
      // Rotate a minute before the platform would cut the invocation off:
      // GOAWAY, finish what is in flight, close cleanly (the tab has already
      // opened the next socket).
      await serveOverWs(ws as unknown as WsLike, handler, {
        baseUrl,
        drainAfterMs: (maxDuration - 60) * 1000,
        drainTimeoutMs: 30_000,
        log: (message, fields) => console.log(`[harness] session host: ${message}`, fields ?? {}),
      });
      console.log('[harness] session host: socket closed', { ms: Date.now() - t0 });
    });
  } catch (error) {
    console.log('[harness] session host: upgrade unavailable', { error: String(error) });
    return Response.json({ error: 'WebSocket upgrade is not available here', detail: String(error) }, { status: 501 });
  }
}
