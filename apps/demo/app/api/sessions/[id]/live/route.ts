import { liveStreamName, tailJsonLines } from 'harness-world/streams';
import { getWorld } from '@/lib/world';

export const maxDuration = 800;

/** How long the tail may sit with undelivered chunks before it re-opens its read (see `tailJsonLines`). */
const QUIET_MS = 1500;
/** A transport keepalive comment this often, so proxies do not cut an idle connection (nobody judges its silence). */
const KEEPALIVE_MS = 15_000;

/**
 * Server-sent events from the session's `live` World stream.
 *
 * The World read underneath is capped (world-vercel ends a live read
 * after 2 minutes) and can miss a wakeup: the tail re-opens it at the next
 * chunk either way and says so with a `{ type: 'stream', name: 'resumed' }`
 * event, so the page can tell a transport hiccup from harness latency. If
 * the browser's own connection drops, `retry: 250` brings it back quickly;
 * it replays from `?from` and the client skips what it already has.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const start = Number(new URL(request.url).searchParams.get('from') ?? 0);
  // The World alone: this route needs no harness, so its first request on a
  // new instance does not evaluate pi-ai, libfx and the hybrid stack.
  const world = await getWorld();
  const encoder = new TextEncoder();
  // Ends the tail when the page goes away: the stream is cancelled, or the
  // request aborts, whichever comes first. A tail left reading would hold
  // this invocation (and poll the World) until its duration limit.
  const done = new AbortController();
  const abort = () => done.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          open = false;
          abort();
        }
      };
      // A comment first: EventSource ignores it, and a fetch reader (the
      // benchmark) learns the subscription is attached.
      send('retry: 250\n: ready\n\n');
      const keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS);
      try {
        for await (const event of tailJsonLines(world, id, liveStreamName(id), {
          startIndex: start,
          signal: done.signal,
          quietMs: QUIET_MS,
          onResume: (info) => send(`data: ${JSON.stringify({ type: 'stream', name: 'resumed', t: Date.now(), ...info })}\n\n`),
        })) {
          if (!open) break;
          send(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch {}
      clearInterval(keepalive);
      request.signal.removeEventListener('abort', abort);
      if (open) {
        open = false;
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      open = false;
      abort();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'content-encoding': 'identity', 'x-accel-buffering': 'no' },
  });
}
