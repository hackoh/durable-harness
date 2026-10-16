/**
 * world-postgres for the tests: it delivers its queue over HTTP, to the
 * app's flow route (`WORKFLOW_LOCAL_BASE_URL`), so this serves one on
 * loopback and hands every request to `handler` (set once the sessions
 * exist). Needs `WORKFLOW_POSTGRES_URL`, with the World's migrations run.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { World } from '@workflow/world';

export async function postgresWorld() {
  const served: { handler?: (req: Request) => Promise<Response> } = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (!served.handler) return void res.writeHead(503).end();
    const response = await served.handler(new Request(`http://localhost${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { createWorld } = await import('@workflow/world-postgres');
  const world = createWorld() as unknown as World & { close?: () => Promise<void> };
  return {
    world,
    serve: (handler: (req: Request) => Promise<Response>) => void (served.handler = handler),
    close: async () => {
      await world.close?.();
      await new Promise((r) => server.close(r));
    },
  };
}
