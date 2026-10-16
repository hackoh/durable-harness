import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import {
  currentLane,
  type DeliverMeta,
  type DriverOptions,
  deliver,
  durableSessions,
  type HostTool,
  type Lane,
  type LaneOptions,
  QUEUE_PREFIX,
  type SessionState,
  tabAnchors,
  tabLost,
} from 'harness-world';
import { filesFromState } from 'harness-world-hands';
import { createFxEngine } from 'libfx';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSandboxProvider, hybridFxHarness, hybridHarness, hybridTools } from './index.ts';

/**
 * Durability of hybrid sessions: a tab that dies mid-turn, whose tether's
 * close (tab-lost) takes the session to a function, for Pi and for fx.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<never>(() => {});
type World = DriverOptions['world'];

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

const textOf = (context: Context) => JSON.stringify(context.messages);

/** A process's view of the World; `kill()` is the process dying (nothing it calls returns). */
function hostProcess(base: World) {
  let dead = false;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key) {
        const value = (t as Record<string | symbol, unknown>)[key];
        if (typeof value === 'function') {
          return async (...args: unknown[]) => {
            if (dead) return forever();
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (value && typeof value === 'object' && ['events', 'streams', 'runs', 'steps', 'hooks'].includes(String(key))) {
          return wrap(value as object);
        }
        return value;
      },
    });
  return { world: wrap(base), kill: () => void (dead = true) };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
}

/** Play a delivery the way the queue does: redeliver after each `{ timeoutSeconds }` (an owner check's, here). */
async function deliverAll(options: DriverOptions, runId: string, meta: DeliverMeta = {}) {
  for (let i = 0; i < 30; i++) {
    if (!(await deliver(options, runId, meta))) return;
    await sleep(150);
  }
  throw new Error('delivery never settled');
}

/** A fake `navigator.locks`: this profile's tabs hold nothing. */
const noLocks = { request: async (_n: string, _o: unknown, cb: (l: unknown) => unknown) => cb({}) } as never;

function piSetup(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}

function laneOptions(serves: Lane[], queue: Lane[]): LaneOptions {
  return {
    serves,
    settle: 'browser',
    async wake(_runId, to) {
      queue.push(to);
    },
  };
}

// Sandbox VM loss, crashes mid-command and orphaned commands: detached.test.ts.

describe('takeover of a hybrid session whose tab went away', () => {
  /** `wait` is a tool that hangs while `hang` is on, in every lane (the tool list must match everywhere). */
  const waitTool = (state: { hang: boolean; calls: number }): HostTool<{ seconds: number }> => ({
    name: 'wait',
    description: 'Wait.',
    inputSchema: Type.Object({ seconds: Type.Number() }),
    replay: 'never',
    async execute(_input, io) {
      state.calls++;
      io.progress({ waited: 'a bit' });
      if (state.hang) await forever();
      return 'waited';
    },
  });

  async function takeover(opts: {
    harness: (lane: Lane, tools: HostTool[]) => DriverOptions['harness'];
    first: string;
  }) {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-takeover-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const waiting = { hang: true, calls: 0 };
    const tools = (lane: Lane) => [...hybridTools({ lane, sandbox: new FakeSandboxProvider() }), waitTool(waiting)];
    const queue: Lane[] = [];
    const tabOptions = (w: World, tab = 'tab_1'): DriverOptions => ({
      world: w,
      harness: opts.harness('browser', tools('browser')),
      lanes: laneOptions(['browser'], queue),
      anchors: tabAnchors({ tab, profile: 'p1', locks: noLocks }),
    });
    const server: DriverOptions = { world, harness: opts.harness('sandbox', tools('sandbox')), lanes: laneOptions(['function', 'sandbox'], queue) };
    const sessions = durableSessions({ world, harness: tabOptions(world).harness });
    const { sessionId } = await sessions.start({ harness: opts.first });
    await sessions.send(sessionId, 'wait, then answer');
    // The tab drives, and dies inside the tool.
    const tab = hostProcess(world);
    void deliver(tabOptions(tab.world), sessionId);
    await until(async () => ((await sessions.inspect(sessionId)).effectOrder.find((e) => e.name === 'tool.wait')?.status === 'running' ? true : undefined));
    await sleep(100);
    tab.kill();
    waiting.hang = false;
    // Its tether closed: the tab-lost delivery takes the session to a function and drives it there.
    const t0 = Date.now();
    await tabLost(server, sessionId, { kind: 'tab-lost', tab: 'tab_1', epoch: 0, seq: 1 }, { anchor: { k: 'msg', m: 'msg_tablost' }, attempt: 1 });
    let state: SessionState = await sessions.inspect(sessionId);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(state.effectOrder.find((e) => e.name === 'handoff')?.input).toMatchObject({ from: 'browser', to: 'function' });
    expect(currentLane(state)).toBe('browser');
    expect(state.effectOrder.find((e) => e.name === 'tool.wait')?.error?.interrupted).toBe(true);
    expect(queue).toEqual(['browser']);
    queue.length = 0;
    // Back in the tab (a fresh page): the next turn runs there.
    await sessions.send(sessionId, 'and now?');
    await deliver(tabOptions(world, 'tab_2'), sessionId);
    state = await sessions.inspect(sessionId);
    return { state, waiting };
  }

  it('Pi: the function lane finishes the turn without re-calling the model, then the tab takes the next turn', async () => {
    const { faux, model, streamFn } = piSetup([
      fauxAssistantMessage(fauxToolCall('wait', { seconds: 60 }), { stopReason: 'toolUse' }),
      (context) => fauxAssistantMessage(fauxText(textOf(context).includes('interrupted') ? 'The wait was interrupted.' : 'Waited.')),
      fauxAssistantMessage(fauxText('Back in the tab.')),
    ]);
    const { state, waiting } = await takeover({
      first: 'hybrid',
      harness: (lane, tools) => hybridHarness({ lane, model, streamFn, tools }),
    });
    expect(faux.state.callCount).toBe(3);
    expect(waiting.calls).toBe(1);
    const models = state.effectOrder.filter((e) => e.name === 'model');
    expect(models.map((m) => (m.output as { content: { text?: string }[] }).content.find((c) => c.text)?.text)).toEqual([
      undefined,
      'The wait was interrupted.',
      'Back in the tab.',
    ]);
    expect(state.effectOrder.filter((e) => e.name === 'handoff').map((e) => (e.input as { reason: string }).reason)).toEqual([
      expect.stringContaining('takeover'),
      'idle',
    ]);
  });

  it('fx: the function lane replays the turn from the tape, then the tab takes the next turn', async () => {
    type Part = Record<string, unknown>;
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
    const sse = (parts: Part[]) =>
      new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const replies: ((body: string) => Part[])[] = [
      () => [
        { type: 'tool-call', toolCallId: 'w1', toolName: 'wait', input: { seconds: 60 } },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
      ],
      (body) => [
        { type: 'text-delta', delta: body.includes('interrupted') ? 'The wait was interrupted.' : 'Waited.' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
      () => [
        { type: 'text-delta', delta: 'Back in the tab.' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
    ];
    let calls = 0;
    const gateway: typeof fetch = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
      calls++;
      const next = replies.shift();
      if (!next) throw new Error('unexpected model request');
      return sse(next(String(init?.body)));
    };
    const { state, waiting } = await takeover({
      first: 'hybrid-fx',
      harness: (lane, tools) => hybridFxHarness({ lane, createFxEngine: createFxEngine as never, apiKey: 'test', fetch: gateway, tools }),
    });
    expect(calls).toBe(3);
    expect(waiting.calls).toBe(1);
    expect(state.effectOrder.filter((e) => e.name === 'checkpoint' && e.status === 'completed')).toHaveLength(2);
    expect(state.status).toBe('running');
  });
});
