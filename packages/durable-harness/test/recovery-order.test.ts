import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness } from 'harness-world';
import { workflowNameFor } from 'harness-world/names';
import { afterAll, describe, expect, it } from 'vitest';
import { durableAgent, getWorld, QUEUE_PREFIX } from '../src/index.ts';

/** Per message: one `model` effect that answers `<name>:<text>`. */
function answer(name: string): Harness {
  return {
    name,
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.length;
      for (const s of ctx.pending()) {
        await ctx.effect(`model:${turn++}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => `${name}:${s.text}`);
      }
    },
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const WORKFLOW_WORLD = Symbol.for('@workflow/world//cache');

/**
 * The order queue.test.ts does not take: the Workflow SDK's World starts (and
 * re-enqueues every open run) before durable-harness's World exists, and
 * nobody gave it durable-harness's queue. Its first deliveries of a session go
 * over HTTP to the Workflow SDK's flow route, which refuses them; once
 * durable-harness makes its World, the session is recovered by it, and the
 * Workflow SDK's World's next attempt reaches durable-harness in process.
 */
describe("the Workflow SDK's World recovers before durable-harness's exists (world-local, one data directory)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'durable-harness-recovery-order-'));
  const worlds: LocalWorld[] = [];
  let server: Server | undefined;
  afterAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_WORLD];
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    for (const w of worlds) await w.close?.();
    await ((await getWorld()) as LocalWorld).close?.();
    server?.closeAllConnections();
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
  });

  it('the session comes back to durable-harness, and the Workflow SDK route sees it only until then', async () => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
    // A process that wrote a prompt and died before its wake was delivered.
    const dead = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(dead);
    const silent = new Proxy(dead, { get: (t, k) => (k === 'queue' ? async () => ({ messageId: 'msg_dropped' }) : (t as never)[k]) }) as unknown as World;
    const before = durableSessions({ world: silent, harness: answer('coexist') });
    const { sessionId } = await before.start();
    await before.send(sessionId, 'hi');

    // The app's server: the Workflow SDK's flow route, which refuses a prefix not its own (as its handler does).
    const toWorkflowRoute: string[] = [];
    server = createServer((req, res) => {
      toWorkflowRoute.push(String(req.headers['x-vqs-queue-name']));
      res.writeHead(400).end('Unhandled queue');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The Workflow SDK's World starts first, with its default recovery, and nothing registered for durable-harness's prefix.
    const workflow = createWorld({ dataDir, recoverActiveRuns: true });
    worlds.push(workflow);
    (globalThis as Record<symbol, unknown>)[WORKFLOW_WORLD] = workflow;
    await workflow.start!();
    const recovery = `${QUEUE_PREFIX}${workflowNameFor('coexist')}`;
    await until(async () => (toWorkflowRoute.includes(recovery) ? true : undefined));

    // Later, the first request that reaches an agent.
    const agent = durableAgent({ harness: answer('coexist') });
    await getWorld();
    const state = await until(async () => {
      const s = await agent.sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.status === 'completed') ? s : undefined;
    });
    expect(state.effectOrder.map((e) => e.output)).toEqual(['coexist:hi']);
    // The Workflow SDK's World retries every 5 s: its next attempt goes to durable-harness, in process.
    const seen = toWorkflowRoute.length;
    await new Promise((r) => setTimeout(r, 6_000));
    expect(toWorkflowRoute.length).toBe(seen);
    expect(toWorkflowRoute.every((q) => q === recovery)).toBe(true);
  }, 60_000);
});
