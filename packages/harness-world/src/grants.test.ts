import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import {
  announceTether,
  type DriverOptions,
  deliver,
  durableSessions,
  EffectFailure,
  type HandoffOutput,
  type Harness,
  type Lane,
  type LaneOptions,
  SessionLog,
  tabAnchors,
  tabLost,
  vercelAnchors,
} from './index.ts';
import { stepNameFor } from './names.ts';
import { hostProcess, leasedWorld } from './testing/index.ts';

/**
 * A delivery that holds a grant (its own message redelivered, a
 * continuation, a tab's tether callback) is the only one that may take the
 * work it was granted. On Vercel nothing else ever comes back for work
 * anchored to a message that acked: every later delivery finds it covered.
 * So no path may ack such a delivery with that work still open, or the
 * session is wedged for good.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<never>(() => {});

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
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

/** One turn: a model step, then two tool calls at once, one of which needs `needs` (an escalation). */
function parallel(needs: Lane, sibling: () => Promise<string>): Harness {
  return {
    name: 'parallel',
    async drive(ctx) {
      const placed = ctx.pending().map((x) => x.id);
      if (!placed.length && !ctx.state().effects.has('model:0')) return;
      await ctx.effect('model:0', { name: 'model', replay: 'safe', input: null, placed }, async () => 'two tools');
      await Promise.all([
        ctx.effect('tool:sibling', { name: 'tool.sibling', replay: 'never', input: null }, sibling).catch((err) => {
          if (!(err instanceof EffectFailure)) throw err;
        }),
        ctx.effect('tool:far', { name: 'tool.far', replay: 'safe', input: null, requires: needs }, async () => 'far'),
      ]);
    },
  };
}

const idle: Harness = { name: 'idle', async drive() {} };

async function heldIntent(sessionId: string, m: string) {
  const log = new SessionLog(world!, sessionId);
  await log.refresh();
  await log.write({
    eventType: 'step_started',
    correlationId: 'step_held0000000000000000000000',
    eventData: { stepName: stepNameFor('tool.x'), input: encode({ key: 'held', replay: 'safe', input: null, epoch: 0, drv: 'drv_x', anchor: { k: 'msg', m } }) },
  });
}

describe('in this process', () => {
  it('a continuation that lands while another drive of the session runs here waits for it, then takes over what it was handed', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness: idle });
    const { sessionId } = await sessions.start({ harness: 'idle' });
    // A drive under msg_x gave its delivery up with this still running, and sent a continuation.
    await heldIntent(sessionId, 'msg_x');
    const logs: string[] = [];
    const server: DriverOptions = { world, harness: idle, anchors: vercelAnchors(), log: (m) => logs.push(m) };
    // Another delivery of the session (msg_d) is driving here when the continuation lands.
    let admitted!: () => void;
    const inAdmit = new Promise<void>((r) => (admitted = r));
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    const d = deliver({ ...server, admit: async () => (admitted(), await gate, { admit: true }) }, sessionId, { anchor: { k: 'msg', m: 'msg_d' } });
    await inAdmit;
    let continued = false;
    const c = deliver(server, sessionId, { anchor: { k: 'msg', m: 'msg_c' }, continues: 'msg:msg_x' }).then(() => (continued = true));
    await sleep(50);
    // It neither acked nor folded itself into msg_d's rerun.
    expect(continued).toBe(false);
    expect(logs).toContain('wait: this session drives here; a delivery with a grant runs after it');
    letGo();
    await Promise.all([d, c]);
    const state = await sessions.inspect(sessionId);
    expect(state.effects.get('held')?.status).toBe('pending');
    expect(state.effectOrder.find((e) => e.name === 'recover')?.input).toMatchObject({ continues: 'msg:msg_x' });
  });

  it('a redelivery that lands here while another drive runs waits for it too (its own message is its grant)', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness: idle });
    const { sessionId } = await sessions.start({ harness: 'idle' });
    await heldIntent(sessionId, 'msg_x');
    const server: DriverOptions = { world, harness: idle, anchors: vercelAnchors() };
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    const d = deliver({ ...server, admit: async () => (await gate, { admit: true }) }, sessionId, { anchor: { k: 'msg', m: 'msg_d' } });
    await sleep(20);
    const again = deliver(server, sessionId, { anchor: { k: 'msg', m: 'msg_x' }, attempt: 2 });
    await sleep(20);
    letGo();
    await Promise.all([d, again]);
    expect((await sessions.inspect(sessionId)).effects.get('held')?.status).toBe('pending');
  });

  it('a delivery with a grant that is not admitted passes the grant on to the wake it leaves', async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    world = base;
    const leased = leasedWorld(base);
    const sessions = durableSessions({ world: leased, harness: idle });
    const { sessionId } = await sessions.start({ harness: 'idle' });
    await heldIntent(sessionId, 'msg_x');
    await deliver({ world: leased, harness: idle, anchors: vercelAnchors(), admit: async () => ({ admit: false, reason: 'busy' }) }, sessionId, {
      anchor: { k: 'msg', m: 'msg_c' },
      continues: 'msg:msg_x',
    });
    const sent = leased.broker.sent().map((m) => (m.payload as { input?: { continues?: string } }).input);
    expect(sent).toContainEqual(expect.objectContaining({ continues: 'msg:msg_x' }));
  });
});

describe('two grants for one anchor', () => {
  it('a redelivery and a continuation of the same message, racing in two processes: one recovery wins, the other stands down', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    let runs = 0;
    const harness: Harness = {
      name: 'idle',
      async drive(ctx) {
        // Re-request the released intent once, like a harness resuming its turn.
        if (ctx.state().effects.get('held')?.status === 'pending') {
          await ctx.effect('held', { name: 'tool.x', replay: 'safe', input: null }, async () => (runs++, await sleep(20), 'ran'));
        }
      },
    };
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({ harness: 'idle' });
    await heldIntent(sessionId, 'msg_x');
    const logs: string[] = [];
    const a = hostProcess(world);
    const b = hostProcess(world);
    const opts = (w: LocalWorld, who: string): DriverOptions => ({ world: w, harness, anchors: vercelAnchors(), log: (m) => logs.push(`${who} ${m}`) });
    await Promise.all([
      deliver(opts(a.world as LocalWorld, 'a'), sessionId, { anchor: { k: 'msg', m: 'msg_x' }, attempt: 2 }),
      deliver(opts(b.world as LocalWorld, 'b'), sessionId, { anchor: { k: 'msg', m: 'msg_c' }, continues: 'msg:msg_x' }),
    ]);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.filter((e) => e.name === 'recover')).toHaveLength(1);
    expect(state.effects.get('held')).toMatchObject({ status: 'completed', output: 'ran' });
    expect(runs).toBe(1);
    expect(state.effectOrder.filter((e) => e.status === 'running')).toEqual([]);
  });
});

describe('an escalation whose drive dies while its sibling runs', () => {
  it("its message's redelivery, landing in a lane it does not serve, still closes the sibling; the next lane finishes the turn", async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    const harness = parallel('sandbox', forever);
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    const wakes: Wake[] = [];
    const fnProcess = hostProcess(world);
    const fn = (w: LocalWorld): DriverOptions => ({ world: w, harness, lanes: { ...lanes(['function'], wakes), initial: 'function' }, anchors: vercelAnchors() });
    // The function lane drives under msg_f; tool:far escalates to the sandbox lane.
    void deliver(fn(fnProcess.world as LocalWorld), sessionId, { anchor: { k: 'msg', m: 'msg_f' } });
    await until(async () => (wakes.some((w) => w.to === 'sandbox') ? true : undefined));
    // The function instance dies with tool:sibling running; its message comes back.
    fnProcess.kill();
    await deliver(fn(world), sessionId, { anchor: { k: 'msg', m: 'msg_f' }, attempt: 2 });
    let state = await sessions.inspect(sessionId);
    expect(state.effects.get('tool:sibling')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    // And the sandbox lane was woken again for what is left.
    expect(wakes.filter((w) => w.to === 'sandbox').length).toBeGreaterThanOrEqual(2);
    const box: DriverOptions = { world, harness, lanes: lanes(['sandbox'], wakes), anchors: vercelAnchors() };
    await deliver(box, sessionId, { anchor: { k: 'msg', m: 'msg_box' } });
    state = await sessions.inspect(sessionId);
    expect(state.effects.get('tool:far')).toMatchObject({ status: 'completed', output: 'far' });
    expect(state.effectOrder.filter((e) => e.status === 'running')).toEqual([]);
  });

  async function tabSetup() {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-grants-')), recoverActiveRuns: false });
    let finishSibling!: (v: string) => void;
    const harness = parallel('function', () => new Promise<string>((r) => (finishSibling = r)));
    const wakes: Wake[] = [];
    const logs: string[] = [];
    const server: DriverOptions = { world, harness, lanes: lanes(['function'], wakes, { remote: ['browser'] }), anchors: vercelAnchors(), log: (m) => logs.push(m) };
    const sessions = durableSessions({ ...server, world });
    const { sessionId } = await sessions.start({ harness: 'parallel' });
    await sessions.send(sessionId, 'go');
    const tabProcess = hostProcess(world);
    const noLocks = { request: async (_n: string, _o: unknown, cb: (l: unknown) => unknown) => cb({}) };
    const tab = deliver(
      { world: tabProcess.world, harness, lanes: lanes(['browser'], wakes), anchors: tabAnchors({ tab: 'tab_1', profile: 'p1', locks: noLocks as never }) },
      sessionId
    );
    await until(async () => (wakes.some((w) => w.to === 'function') ? true : undefined));
    // The function lane's own wake: the sibling is still the tab's.
    await deliver(server, sessionId, { anchor: { k: 'msg', m: 'msg_fn1' } });
    expect(logs).toContain('skip: open work is held elsewhere');
    return { sessions, sessionId, server, tab, tabProcess, logs, finish: () => finishSibling('sibling done') };
  }

  it("a tab that died: its tether's callback hands the sibling over, and the function lane finishes the turn", async () => {
    const { sessions, sessionId, server, tabProcess, logs } = await tabSetup();
    tabProcess.kill();
    await tabLost(server, sessionId, { kind: 'tab-lost', tab: 'tab_1', epoch: 0, seq: 1 }, { anchor: { k: 'msg', m: 'msg_lost' }, attempt: 1 });
    const state = await sessions.inspect(sessionId);
    expect(logs).toContain('tab-lost: handing over what the tab left running');
    expect(state.effects.get('tool:sibling')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(state.effects.get('tool:far')).toMatchObject({ status: 'completed', output: 'far' });
    expect(state.effectOrder.filter((e) => e.status === 'running')).toEqual([]);
  });

  it('a tab that tethered again (a blip) keeps its sibling: the callback takes nothing', async () => {
    const { sessions, sessionId, server, tab, finish } = await tabSetup();
    await announceTether(world!, sessionId, { tab: 'tab_1', epoch: 0, seq: 2 });
    await tabLost(server, sessionId, { kind: 'tab-lost', tab: 'tab_1', epoch: 0, seq: 1 }, { anchor: { k: 'msg', m: 'msg_lost' }, attempt: 1 });
    expect((await sessions.inspect(sessionId)).effects.get('tool:sibling')?.status).toBe('running');
    finish();
    await tab;
    expect((await sessions.inspect(sessionId)).effects.get('tool:sibling')).toMatchObject({ status: 'completed', output: 'sibling done' });
  });
});
