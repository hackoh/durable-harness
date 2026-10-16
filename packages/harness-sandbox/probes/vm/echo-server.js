// The probes' server inside a VM (Bun; the universal image has it). Echoes
// WebSocket messages, streams SSE, echoes a streamed request body. It returns
// header names only, never values. Listens on PORT (default 3000), on every
// interface by default, so a probe can reach it through the port ingress or from
// another VM. HOST=127.0.0.1 keeps it on loopback (the model port's case).
const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  port,
  hostname: process.env.HOST ?? '0.0.0.0',
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') return Response.json({ ok: true, port, headerNames: [...req.headers.keys()].sort() });
    if (url.pathname === '/sse') {
      let i = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (i >= 8) return c.close();
            await Bun.sleep(250);
            c.enqueue(new TextEncoder().encode(`data: ${i++} ${Date.now()}\n\n`));
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } }
      );
    }
    if (url.pathname === '/duplex') {
      const reader = req.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(c) {
            const { done, value } = await reader.read();
            if (done) return c.close();
            c.enqueue(value);
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } }
      );
    }
    return new Response('not found', { status: 404 });
  },
  // Bun's maximum; the ingress's own idle limit is what a probe measures.
  websocket: { idleTimeout: 960, sendPings: false, message(ws, msg) { ws.send(msg); } },
});
console.log(`probe server listening on ${port}`);
