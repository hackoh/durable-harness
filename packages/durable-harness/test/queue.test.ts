import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import type { DriveContext, Harness } from 'harness-world';
import { durableSessions } from 'harness-world';
import { workflowNameFor } from 'harness-world/names';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { durableAgent, FLOW_ROUTE, flowHandler, forwardQueue, getWorld, QUEUE_PREFIX, registerQueue } from '../src/index.ts';

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

/** A stand-in World: the registration methods, recorded. */
function stub(methods: { handler?: boolean; route?: boolean; start?: boolean } = {}) {
  const calls: { kind: 'handler' | 'route'; prefix: string; path?: string }[] = [];
  const world = {
    createQueueHandler: () => async () => Response.json({ ok: true }),
    ...(methods.handler ? { registerHandler: (prefix: string) => void calls.push({ kind: 'handler', prefix }) } : {}),
    ...(methods.route ? { registerRoute: (prefix: string, path: string) => void calls.push({ kind: 'route', prefix, path }) } : {}),
    ...(methods.start ? { start: async () => {} } : {}),
  } as unknown as World;
  return { world, calls };
}

describe('registerQueue', () => {
  it("registers durable-harness's prefix in process and its route for a worker elsewhere, once per World", () => {
    const { world, calls } = stub({ handler: true, route: true, start: true });
    registerQueue(world);
    registerQueue(world);
    expect(calls).toEqual([
      { kind: 'handler', prefix: '__harness_wkf_workflow_' },
      { kind: 'route', prefix: '__harness_wkf_workflow_', path: '/.well-known/durable-harness/v1/flow' },
    ]);
    expect(FLOW_ROUTE).toBe('/.well-known/durable-harness/v1/flow');
  });

  it('takes a route of your own: an option, or DURABLE_HARNESS_FLOW_ROUTE', () => {
    const a = stub({ route: true });
    registerQueue(a.world, { route: '/api/agent/queue' });
    expect(a.calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: '/api/agent/queue' }]);
    process.env.DURABLE_HARNESS_FLOW_ROUTE = '/queue';
    try {
      const b = stub({ route: true });
      registerQueue(b.world);
      expect(b.calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: '/queue' }]);
    } finally {
      delete process.env.DURABLE_HARNESS_FLOW_ROUTE;
    }
  });

  it('takes the route flowHandler() says it is mounted at (the generated route at the Workflow SDK\'s path), on a World registered before and after', () => {
    const before = stub({ route: true });
    registerQueue(before.world);
    const mounted = flowHandler({ route: '/.well-known/workflow/v1/flow' });
    expect(typeof mounted).toBe('function');
    expect(before.calls.map((c) => c.path)).toEqual(['/.well-known/durable-harness/v1/flow', '/.well-known/workflow/v1/flow']);
    const after = stub({ route: true });
    registerQueue(after.world);
    expect(after.calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: '/.well-known/workflow/v1/flow' }]);
    // A registration with a route of its own keeps it.
    const own = stub({ route: true });
    registerQueue(own.world, { route: '/mine' });
    flowHandler({ route: '/elsewhere' });
    expect(own.calls.map((c) => c.path)).toEqual(['/mine']);
    flowHandler({ route: FLOW_ROUTE });
  });

  it('warns about a World whose worker cannot route the prefix (an older world-local or world-postgres), not about world-vercel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerQueue(stub({ start: true }).world);
    expect(warn.mock.calls.flat().join(' ')).toContain('cannot deliver durable-harness');
    warn.mockClear();
    registerQueue(stub().world);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('forwardQueue', () => {
  it("registers durable-harness's route alone, so nothing of the prefix runs in this process; a later registerQueue still adds the handler", () => {
    const { world, calls } = stub({ handler: true, route: true, start: true });
    forwardQueue(world);
    expect(calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: FLOW_ROUTE }]);
    registerQueue(world);
    expect(calls.map((c) => c.kind)).toEqual(['route', 'handler', 'route']);
  });

  it('takes the route the app mounts flowHandler() at: an option, or DURABLE_HARNESS_FLOW_ROUTE', () => {
    const a = stub({ handler: true, route: true });
    forwardQueue(a.world, { route: '/.well-known/workflow/v1/flow' });
    expect(a.calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: '/.well-known/workflow/v1/flow' }]);
    process.env.DURABLE_HARNESS_FLOW_ROUTE = '/queue';
    try {
      const b = stub({ route: true });
      forwardQueue(b.world);
      expect(b.calls).toEqual([{ kind: 'route', prefix: QUEUE_PREFIX, path: '/queue' }]);
    } finally {
      delete process.env.DURABLE_HARNESS_FLOW_ROUTE;
    }
  });

  it('keeps a route given after the default when flowHandler() later names another', () => {
    const { world, calls } = stub({ route: true });
    forwardQueue(world);
    forwardQueue(world, { route: '/.well-known/workflow/v1/flow' });
    flowHandler({ route: '/elsewhere' });
    expect(calls.map((c) => c.path)).toEqual([FLOW_ROUTE, '/.well-known/workflow/v1/flow']);
    flowHandler({ route: FLOW_ROUTE });
  });

  it('warns about a World whose worker cannot be told the route (an older world-local or world-postgres), not about world-vercel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    forwardQueue(stub({ handler: true, start: true }).world);
    expect(warn.mock.calls.flat().join(' ')).toContain('cannot deliver durable-harness');
    warn.mockClear();
    forwardQueue(stub().world);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

const WORKFLOW_WORLD = Symbol.for('@workflow/world//cache');

describe("getWorld() next to the Workflow SDK's World (world-local, one data directory)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'durable-harness-queue-'));
  const worlds: LocalWorld[] = [];
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
  });
  afterAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[WORKFLOW_WORLD];
    for (const w of worlds) await w.close?.();
    await ((await getWorld()) as LocalWorld).close?.();
  });

  it("recovers a session a dead process left, through its own prefix; the Workflow SDK's World hands it back too, and none reaches the Workflow SDK's route", async () => {
    // A process that wrote a prompt and died before its wake was delivered.
    const dead = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(dead);
    const dropped: string[] = [];
    const silent = new Proxy(dead, {
      get: (t, k) => (k === 'queue' ? async (name: string) => (dropped.push(name), { messageId: 'msg_dropped' }) : (t as never)[k]),
    }) as unknown as World;
    const before = durableSessions({ world: silent, harness: answer('coexist') });
    const { sessionId } = await before.start();
    await before.send(sessionId, 'hi');
    expect(dropped).toEqual(['__harness_wkf_workflow_session']);

    // The Workflow SDK's World in this process (as @workflow/core caches it), with its default recovery on,
    // and its flow route (the stand-in answers 400 to any prefix but its own, as the Workflow handler does).
    const workflow = createWorld({ dataDir, recoverActiveRuns: true });
    worlds.push(workflow);
    const toWorkflowRoute: string[] = [];
    workflow.registerHandler('__wkf_workflow_', async (request) => {
      toWorkflowRoute.push(request.headers.get('x-vqs-queue-name') ?? '');
      return new Response('Unhandled queue', { status: 400 });
    });
    (globalThis as Record<symbol, unknown>)[WORKFLOW_WORLD] = workflow;
    const viaWorkflow: string[] = [];
    const register = workflow.registerHandler.bind(workflow);
    workflow.registerHandler = (prefix, handler) =>
      register(prefix, async (request) => {
        viaWorkflow.push(request.headers.get('x-vqs-queue-name') ?? '');
        return handler(request);
      });

    // The app restarts: its agent, and durable-harness's World.
    const agent = durableAgent({ harness: answer('coexist') });
    const ours = await getWorld();
    expect(ours).not.toBe(workflow);
    await workflow.start!();
    const state = await until(async () => {
      const s = await agent.sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.status === 'completed') ? s : undefined;
    });
    expect(state.effectOrder.map((e) => e.output)).toEqual(['coexist:hi']);
    // The Workflow SDK's World re-enqueued the session on durable-harness's prefix and delivered it here.
    await until(async () => (viaWorkflow.length > 0 ? true : undefined));
    expect(viaWorkflow).toEqual([`${QUEUE_PREFIX}${workflowNameFor('coexist')}`]);
    expect(toWorkflowRoute).toEqual([]);
    // The run says whose it is.
    expect((await ours.runs.get(sessionId)).executionContext).toEqual({ queueNamespace: 'harness' });
  });
});
