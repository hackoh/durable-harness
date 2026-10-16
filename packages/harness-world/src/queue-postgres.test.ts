import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { World } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, QUEUE_PREFIX, recoverSessions } from './index.ts';
import { workflowNameFor } from './names.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * The kernel's queue on world-postgres, delivered per prefix (vercel/workflow
 * #4835): a job keeps its prefix and the route its producer registered, so a
 * worker in another process, one with no handler for the kernel's prefix
 * (the Workflow SDK's, say), delivers it over HTTP to the kernel's route,
 * never to the Workflow SDK's flow route. Runs when `WORKFLOW_POSTGRES_URL`
 * names a database with the World's migrations applied.
 */

const url = process.env.WORKFLOW_POSTGRES_URL;
const ROUTE = '/.well-known/durable-harness/v1/flow';

const answer: Harness = {
  name: 'pg-answer',
  async drive(ctx: DriveContext) {
    let turn = ctx.state().effectOrder.length;
    for (const s of ctx.pending()) {
      await ctx.effect(`model:${turn++}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => `re: ${s.text}`);
    }
  },
};

type Routable = World & { registerRoute(prefix: string, path: string): void; close?: () => Promise<void> };

let server: Server | undefined;
const worlds: Routable[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

/** An HTTP front for the app: records each request's path, queue name and run, and hands it to `handler`. */
async function front(handler: () => (r: Request) => Promise<Response>) {
  const seen: { path: string; queue: string; runId?: string }[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let runId: string | undefined;
    try {
      runId = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { runId?: string }).runId;
    } catch {}
    seen.push({ path: String(req.url), queue: headers.get('x-vqs-queue-name') ?? '', ...(runId ? { runId } : {}) });
    const response = String(req.url).startsWith(ROUTE)
      ? await handler()(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }))
      : new Response('Unhandled queue', { status: 400 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!url)("the kernel's queue on world-postgres", () => {
  it("a job the kernel's World enqueued is delivered by another World's worker to the kernel's route, not the Workflow SDK's", async () => {
    const { createWorld } = await import('@workflow/world-postgres');
    const jobPrefix = `hw_queue_${ulid().toLowerCase()}_`;
    let sessions: ReturnType<typeof durableSessions> | undefined;
    const http = await front(() => sessions!.handler);
    process.env.WORKFLOW_LOCAL_BASE_URL = http.base;
    try {
      // The kernel's World: it registers its route and never starts a worker here.
      const kernel = createWorld({ connectionString: url!, jobPrefix }) as unknown as Routable;
      worlds.push(kernel);
      kernel.registerRoute(QUEUE_PREFIX, ROUTE);
      sessions = durableSessions({ world: kernel, harness: answer });
      // Another World on the database (another process: the Workflow SDK's), whose worker runs, with nothing registered for the kernel's prefix.
      const theirs = createWorld({ connectionString: url!, jobPrefix }) as unknown as Routable;
      worlds.push(theirs);
      await theirs.start?.();

      const { sessionId } = await sessions.start();
      await sessions.send(sessionId, 'hi');
      const state = await until(async () => {
        const s = await sessions!.inspect(sessionId);
        return s.effectOrder.some((e) => e.status === 'completed') ? s : undefined;
      });
      expect(state.effectOrder.map((e) => e.output)).toEqual(['re: hi']);
      // Only this session's deliveries: the other World's start() also re-enqueues every active run on the
      // database (another test's, its own), and with no route of its own those go to the flow route.
      const ours = () => http.seen.filter((d) => d.runId === sessionId);
      expect(ours().length).toBeGreaterThan(0);
      for (const d of ours()) {
        expect(d.path).toBe(ROUTE);
        expect(d.queue.startsWith(QUEUE_PREFIX)).toBe(true);
      }

      // A restart's recovery on the kernel's prefix goes the same way.
      const before = ours().length;
      expect(await recoverSessions(kernel)).toBeGreaterThanOrEqual(1);
      await until(async () => (ours().slice(before).some((d) => d.queue === `${QUEUE_PREFIX}${workflowNameFor('pg-answer')}`) ? true : undefined));
      expect(ours().every((d) => d.path === ROUTE)).toBe(true);
    } finally {
      delete process.env.WORKFLOW_LOCAL_BASE_URL;
    }
  }, 60_000);
});
