import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import {
  announceTether,
  armTabLost,
  commitHandoff,
  currentLane,
  type DriveContext,
  type DriverOptions,
  deliver,
  durableSessions,
  EffectFailure,
  type EffectError,
  effectStreamName,
  type HandoffOutput,
  type Harness,
  type Lane,
  type LaneOptions,
  QUEUE_PREFIX,
  readJsonLines,
  serveTabTether,
  SessionLog,
  tabAnchors,
} from './index.ts';
import { hostProcess } from './testing/index.ts';

/**
 * A tab's tether (tab-lost.ts, tether.ts): the server stands behind a tab
 * driving a session's browser lane through the request the tab holds open
 * to it. Its close queues one tab-lost message, which takes the session to a
 * server lane if the tab was doing (or had yet to do) something and did not
 * come back. These are the old backstop's tab scenarios, ported.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<never>(() => {});

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

interface Script {
  model(io: { progress(c: unknown): void; signal: AbortSignal }, ctx: DriveContext): Promise<unknown>;
  tool(io: { progress(c: unknown): void; signal: AbortSignal }, ctx: DriveContext): Promise<unknown>;
  failures: EffectError[];
  requires?: Lane;
}
const script = (o: Partial<Script> = {}): Script => ({ model: async () => 'plan', tool: async () => 'ran', failures: [], ...o });

function scripted(s: Script): Harness {
  async function turn(ctx: DriveContext, id: string, text: string | undefined, placed: string[]) {
    await ctx.effect(`model:${id}`, { name: 'model', replay: 'safe', input: text, placed }, (io) => s.model(io, ctx));
    try {
      await ctx.effect(`tool:${id}`, { name: 'tool.slow', replay: 'never', input: text, ...(s.requires ? { requires: s.requires } : {}) }, (io) => s.tool(io, ctx));
    } catch (err) {
      if (!(err instanceof EffectFailure)) throw err;
      s.failures.push(err.error);
    }
  }
  return {
    name: 'scripted',
    async drive(ctx) {
      for (const e of ctx.state().effectOrder.filter((r) => r.name === 'model')) await turn(ctx, e.key.slice('model:'.length), e.input as string, []);
      for (const sub of ctx.pending()) await turn(ctx, sub.id, sub.text, [sub.id]);
    },
  };
}

interface Wake {
  to: Lane;
  handoff: HandoffOutput;
  key?: string;
}
function lanes(serves: Lane[], wakes: Wake[], extra: Partial<LaneOptions> = {}): LaneOptions {
  return {
    serves,
    settle: 'browser',
    async wake(_runId, to, handoff, opts) {
      wakes.push({ to, handoff, ...(opts?.idempotencyKey ? { key: opts.idempotencyKey } : {}) });
    },
    ...extra,
  };
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

/** Back in the browser lane, every handoff accepted (a pending one already reads as its target lane). */
const settledBack = (st: Awaited<ReturnType<ReturnType<typeof durableSessions>['inspect']>>) =>
  currentLane(st) === 'browser' && st.effectOrder.some((e) => e.name === 'handoff') && st.effectOrder.every((e) => e.name !== 'handoff' || e.status === 'completed');

/** A fake `navigator.locks` (this profile only). */
const noLocks = { request: async (_n: string, _o: unknown, cb: (l: unknown) => unknown) => cb({}) };

async function setup(s: Script) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-tab-')), recoverActiveRuns: false });
  const harness = scripted(s);
  const wakes: Wake[] = [];
  const logs: string[] = [];
  // The server: its flow route serves the function lane, and takes the browser lane over when nothing drives it.
  // Until a tab-lost callback lands, the submissions' wakes are the tab's to
  // take (it drives in page memory), so the server leaves them be.
  let open = false;
  const server = durableSessions({
    world,
    harness,
    lanes: lanes(['function'], wakes, { remote: ['browser'] }),
    log: (m) => logs.push(m),
    route: (message) => {
      if ((message as { input?: { kind?: string } }).input?.kind === 'tab-lost') open = true;
      return open ? undefined : Promise.resolve(undefined);
    },
  });
  world.registerHandler(QUEUE_PREFIX, server.handler);
  const { sessionId } = await server.start({ harness: 'scripted' });
  const tabProcess = hostProcess(world);
  const tab = (extra: Partial<DriverOptions> = {}): DriverOptions => ({
    world: tabProcess.world,
    harness,
    lanes: lanes(['browser'], wakes),
    anchors: tabAnchors({ tab: 'tab_1', profile: 'p1', locks: noLocks as never }),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { server, sessionId, tab, tabProcess, wakes, logs, inspect: () => server.inspect(sessionId) };
}

/** Open a tab's tether; `close()` is the connection going away. */
function tether(runId: string, seq = 1, epoch = 0, options: Parameters<typeof serveTabTether>[2] = {}) {
  const abort = new AbortController();
  const response = serveTabTether(world!, new Request(`https://app.example/api/hybrid/tether?runId=${runId}&tab=tab_1&epoch=${epoch}&seq=${seq}`, { signal: abort.signal }), { lostDelaySeconds: 0, ...options });
  const reader = response.body!.getReader();
  void reader.read();
  return { response, close: () => abort.abort(), reader };
}

describe('a tab that goes away mid-turn', () => {
  it('is taken over by a function when its tether closes: the model is retried there, then the session settles back', async () => {
    const s = script({ model: async (io) => (io.progress({ token: 'partial' }), forever()) });
    const { server, sessionId, tab, tabProcess, wakes, inspect } = await setup(s);
    await server.send(sessionId, 'go');
    const t = tether(sessionId);
    void deliver(tab(), sessionId);
    await until(async () => ((await inspect()).effectOrder[0]?.status === 'running' ? true : undefined));
    tabProcess.kill();
    s.model = async () => 'plan';
    const closedAt = Date.now();
    t.close();
    // The tab-lost delivery hands the session to the function lane and drives it there.
    const state = await until(async () => {
      const st = await inspect();
      return st.effectOrder.some((e) => e.name === 'tool.slow' && e.status === 'completed') && settledBack(st) ? st : undefined;
    });
    expect(Date.now() - closedAt).toBeLessThan(3000);
    const takeover = state.effectOrder.find((e) => e.name === 'handoff')!;
    expect(takeover.input).toMatchObject({ from: 'browser', to: 'function', reason: 'takeover: the tab disconnected' });
    expect(state.effectOrder.find((e) => e.name === 'model')).toMatchObject({ status: 'completed', output: 'plan', retryOf: expect.any(String) });
    expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([
      ['model', 'completed'],
      ['handoff', 'completed'],
      ['tool.slow', 'completed'],
      ['handoff', 'completed'],
    ]);
    // The handoff commits before its wake callback runs. Wait for delivery too.
    await until(async () => wakes.at(-1)?.to === 'browser' ? true : undefined);
    expect(wakes.at(-1)).toMatchObject({ to: 'browser' });
  });

  it('gives a replay:never tool the tab was running an interrupted result with its partial output', async () => {
    const s = script({ tool: async (io) => (io.progress({ stdout: 'half of it' }), forever()) });
    const { server, sessionId, tab, tabProcess, inspect } = await setup(s);
    await server.send(sessionId, 'go');
    const t = tether(sessionId);
    void deliver(tab(), sessionId);
    const tool = await until(async () => (await inspect()).effectOrder.find((e) => e.name === 'tool.slow' && e.status === 'running'));
    // Its progress has reached the log's side stream before the tab dies.
    await until(async () => ((await readJsonLines(world!, sessionId, effectStreamName(sessionId, tool.stepId))).length ? true : undefined));
    tabProcess.kill();
    t.close();
    const state = await until(async () => {
      const st = await inspect();
      return settledBack(st) && st.effectOrder.some((e) => e.name === 'tool.slow' && e.status === 'failed') ? st : undefined;
    });
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'failed', error: { interrupted: true, partial: [{ stdout: 'half of it' }] } });
    expect(s.failures).toEqual([expect.objectContaining({ interrupted: true })]);
  });

  it('fences a stale tab that keeps going after the takeover, and the new owner is not contended by it', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => (releaseTool = r));
    let entered = false;
    const s = script({ tool: async () => ((entered = true), await toolGate, 'stale result') });
    const { server, sessionId, tab, inspect, logs } = await setup(s);
    await server.send(sessionId, 'first');
    await server.send(sessionId, 'second');
    // The tab's connection drops, but the tab itself lives on (a frozen tab, a long blip).
    const t = tether(sessionId);
    const tabDrive = deliver(tab(), sessionId);
    // Its intent is durable and the tab is inside the tool (the intent lands before the tool is called).
    await until(async () => (entered && (await inspect()).effectOrder.find((e) => e.name === 'tool.slow')?.status === 'running' ? true : undefined));
    s.tool = async () => 'ran in function';
    t.close();
    await until(async () => {
      const st = await inspect();
      // The tab's tool (replay: never) comes back interrupted there; the second turn runs in full.
      return st.effectOrder.filter((e) => e.name === 'tool.slow' && e.status === 'completed').length === 1 && settledBack(st) ? st : undefined;
    });
    // The tab's tool returns: its result is refused, it learns it lost the session, and it stops.
    releaseTool();
    expect(await tabDrive).toBeUndefined();
    expect(logs).toContain('preempted');
    const state = await inspect();
    expect(state.effectOrder.find((e) => e.name === 'tool.slow' && e.input === 'first')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(state.effectOrder.find((e) => e.name === 'tool.slow' && e.input === 'second')).toMatchObject({ status: 'completed', output: 'ran in function' });
    expect(logs.some((l) => l.includes('contended'))).toBe(false);
    expect(state.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed')).toHaveLength(2);
  });

  it('lets exactly one of two racing handoffs win (a tab escalating, a takeover), and the loser neither announces nor wakes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = script({ requires: 'function', model: async () => (await gate, 'plan') });
    const { server, sessionId, tab, inspect, logs } = await setup(s);
    await server.send(sessionId, 'go');
    const tabWakes: Wake[] = [];
    const t = tether(sessionId);
    const tabDrive = deliver(tab({ lanes: lanes(['browser'], tabWakes) }), sessionId);
    await until(async () => ((await inspect()).effectOrder[0]?.status === 'running' ? true : undefined));
    t.close();
    await until(async () => (currentLane(await inspect()) !== 'browser' ? true : undefined));
    release();
    expect(await tabDrive).toBeUndefined();
    expect(tabWakes).toEqual([]);
    expect(logs).toContain('preempted');
    // The takeover announces itself on the live stream (once; the tab's losing handoff does not).
    const lanesLive = await until(async () => {
      const lines = (await readJsonLines(world!, sessionId, `${sessionId}_live`)).filter((e) => (e as { type?: string; takeover?: boolean }).type === 'lane' && (e as { takeover?: boolean }).takeover);
      return lines.length ? lines : undefined;
    });
    expect(lanesLive).toEqual([expect.objectContaining({ from: 'browser', to: 'function', takeover: true })]);
  });
});

describe('a tether that closes without the tab being gone', () => {
  it('a tab that tethers again before the callback (a blip) is not taken over', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = script({ tool: async () => (await gate, 'ran in the tab') });
    const { server, sessionId, tab, inspect, logs } = await setup(s);
    await server.send(sessionId, 'go');
    const t1 = tether(sessionId, 1, 0, { lostDelaySeconds: 1 });
    const tabDrive = deliver(tab(), sessionId);
    await until(async () => ((await inspect()).effectOrder.find((e) => e.name === 'tool.slow')?.status === 'running' ? true : undefined));
    t1.close();
    tether(sessionId, 2);
    await until(async () => (logs.includes('tab-lost: the tab tethered again') ? true : undefined), 5000);
    release();
    await tabDrive;
    const state = await inspect();
    expect(state.effectOrder.some((e) => e.name === 'handoff')).toBe(false);
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'completed', output: 'ran in the tab' });
  });

  it('a tab that finished its turn and went away leaves nothing to take over', async () => {
    const { server, sessionId, tab, inspect, logs } = await setup(script());
    await server.send(sessionId, 'go');
    const t = tether(sessionId);
    await deliver(tab(), sessionId);
    t.close();
    await until(async () => (logs.includes('tab-lost: nothing was left to do') ? true : undefined), 5000);
    expect(currentLane(await inspect())).toBe('browser');
  });

  it('a callback for an epoch the session has left does nothing', async () => {
    const { server, sessionId, inspect, logs } = await setup(script({ model: forever }));
    await server.send(sessionId, 'go');
    const log = new SessionLog(world!, sessionId);
    await log.refresh();
    await commitHandoff(log, { from: 'browser', to: 'browser', reason: 'a reload recovered it' }, 0);
    await armTabLost(world!, sessionId, { tab: 'tab_1', epoch: 0, seq: 1, delaySeconds: 0 });
    await until(async () => (logs.includes('tab-lost: the session moved on since the tether closed') ? true : undefined), 5000);
    expect((await inspect()).effectOrder.filter((e) => e.name === 'handoff')).toHaveLength(1);
  });

  it('rotates before its Function limit without queueing a callback, and says when a tab tethers', async () => {
    const { sessionId } = await setup(script());
    const queued: unknown[] = [];
    const queue = world!.queue.bind(world!);
    world!.queue = (async (...args: Parameters<typeof queue>) => (queued.push(args[1]), queue(...args))) as typeof queue;
    const t = tether(sessionId, 1, 0, { maxMs: 50 });
    let text = '';
    for (;;) {
      const { value, done } = await t.reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('event: rotate');
    t.close();
    await sleep(50);
    expect(queued).toEqual([]);
    world!.queue = queue;
    await announceTether(world!, sessionId, { tab: 'tab_1', epoch: 0, seq: 2 });
    const hints = (await readJsonLines(world!, sessionId, `${sessionId}_hints`)) as { eventType: string; tab?: string }[];
    expect(hints.filter((h) => h.eventType === 'tether' && h.tab === 'tab_1').length).toBeGreaterThanOrEqual(1);
  });
});
