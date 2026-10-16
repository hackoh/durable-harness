import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DriveContext,
  type DriverOptions,
  deliver,
  durableSessions,
  type Harness,
  Parked,
  QUEUE_PREFIX,
  SessionLog,
  settleParked,
  type Settlement,
  vercelAnchors,
  wakeAfterSettle,
} from './index.ts';
import { stepNameFor } from './names.ts';
import { hostProcess } from './testing/index.ts';

/**
 * The invariants that replace every liveness decision: one
 * anchor per drive; a drive lets go only when nothing it opened is still
 * open (closed, released, fenced, or parked and detached); and the log
 * orders a parker letting go against a settlement, so exactly one of them
 * takes it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

const settlement = (value: string): Settlement => ({ by: 'push', at: Date.now(), ok: true, value });

/**
 * Per prompt: a `tool.job` that parks (an owner outside the drive has it),
 * stays attached for `graceMs` waiting for a settlement, then lets go.
 */
function parking(graceMs: number, seen: string[]): Harness {
  return {
    name: 'parking',
    async drive(ctx: DriveContext) {
      // Every prompt: a finished job replays from the log, an unfinished one is re-entered.
      for (const s of ctx.state().submissions.filter((x) => x.kind === 'prompt')) {
        if (ctx.isMemoized(`job:${s.id}`)) continue;
        const out = await ctx.effect(`job:${s.id}`, { name: 'tool.job', replay: 'never', input: s.text, placed: [s.id] }, async (io) => {
          if (io.settlement) {
            seen.push(`reentered:${io.settlement.ok ? io.settlement.value : 'failed'}`);
            return io.settlement.ok ? io.settlement.value : 'failed';
          }
          await io.park({ kind: 'job' });
          seen.push('parked');
          const end = Date.now() + graceMs;
          while (Date.now() < end) {
            await ctx.refresh();
            const r = ctx.state().effectOrder.find((e) => e.stepId === io.stepId);
            if (r?.settlement?.ok) {
              seen.push(`inline:${r.settlement.value}`);
              return r.settlement.value;
            }
            await sleep(20);
          }
          throw new Parked();
        });
        seen.push(`result:${String(out)}`);
      }
    },
  };
}

async function setup(harness: Harness) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-inv-')), recoverActiveRuns: false });
  const sessions = durableSessions({ world, harness });
  const { sessionId } = await sessions.start({});
  return { sessions, sessionId, inspect: () => sessions.inspect(sessionId) };
}

describe('parked steps: attached until detached, ordered by the log', () => {
  it('a parker whose grace runs out detaches before it lets go; a settlement after that wakes a drive, which re-enters the step', async () => {
    const seen: string[] = [];
    const harness = parking(100, seen);
    const { sessions, sessionId, inspect } = await setup(harness);
    await sessions.send(sessionId, 'go');
    await deliver({ world: world!, harness }, sessionId);
    let state = await inspect();
    const job = state.effectOrder.find((e) => e.name === 'tool.job')!;
    expect(job).toMatchObject({ status: 'running', detached: true });
    expect(state.effectOrder.find((e) => e.name === 'detach')).toMatchObject({ status: 'completed' });
    // The owner reports: detached, so the settler wakes a drive.
    const log = new SessionLog(world!, sessionId);
    await log.refresh();
    expect(await settleParked(log, job, settlement('42'))).toBe('won');
    const woken: string[] = [];
    world!.registerHandler(QUEUE_PREFIX, async () => (woken.push('wake'), Response.json({})));
    expect(await wakeAfterSettle({ world: world!, harness }, log.state, job)).toBe(true);
    await deliver({ world: world!, harness }, sessionId);
    state = await inspect();
    expect(state.effectOrder.find((e) => e.name === 'tool.job')).toMatchObject({ status: 'completed', output: '42' });
    expect(seen).toEqual(['parked', 'reentered:42', 'result:42']);
  });

  it('a settlement that lands while the parker is attached is taken inline, and wakes nothing', async () => {
    const seen: string[] = [];
    const harness = parking(3000, seen);
    const { sessions, sessionId, inspect } = await setup(harness);
    await sessions.send(sessionId, 'go');
    const driving = deliver({ world: world!, harness }, sessionId);
    await until(async () => (seen.includes('parked') ? true : undefined));
    const log = new SessionLog(world!, sessionId);
    await log.refresh();
    const job = log.state.effectOrder.find((e) => e.name === 'tool.job')!;
    expect(await settleParked(log, job, settlement('7'))).toBe('won');
    expect(await wakeAfterSettle({ world: world!, harness }, log.state, job)).toBe(false);
    await driving;
    expect(seen).toEqual(['parked', 'inline:7', 'result:7']);
    expect((await inspect()).effectOrder.some((e) => e.name === 'detach')).toBe(false);
  });

  it("a settlement that beats the parker's detach: the detach is inert, and the parker takes the settlement itself", async () => {
    const seen: string[] = [];
    const harness = parking(50, seen);
    const dir = await mkdtemp(join(tmpdir(), 'hw-inv-'));
    world = createWorld({ dataDir: dir, recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({});
    await sessions.send(sessionId, 'go');
    // The settle commits just before the parker's detach does.
    const create = world.events.create.bind(world.events);
    let raced = false;
    world.events.create = (async (runId: string, req: CreateEventRequest, params?: unknown) => {
      const name = (req as { eventData?: { stepName?: string } }).eventData?.stepName;
      if (!raced && req.eventType === 'step_started' && name === stepNameFor('detach')) {
        raced = true;
        const log = new SessionLog(world!, runId);
        await log.refresh();
        const job = log.state.effectOrder.find((e) => e.name === 'tool.job')!;
        expect(await settleParked(log, job, settlement('raced'))).toBe('won');
        // The settler sees the step still attached: it wakes nothing.
        expect(await wakeAfterSettle({ world: world!, harness }, log.state, job)).toBe(false);
      }
      return create(runId, req, params as never);
    }) as typeof world.events.create;
    await deliver({ world, harness }, sessionId);
    const state = await sessions.inspect(sessionId);
    expect(raced).toBe(true);
    expect(state.effectOrder.find((e) => e.name === 'tool.job')).toMatchObject({ status: 'completed', output: 'raced' });
    expect(seen).toEqual(['parked', 'reentered:raced', 'result:raced']);
  });

  it("an attached parked step is its parker's open work: another process's delivery leaves it alone", async () => {
    const seen: string[] = [];
    const harness = parking(2000, seen);
    const { sessions, sessionId, inspect } = await setup(harness);
    await sessions.send(sessionId, 'go');
    const a = hostProcess(world!);
    const logs: string[] = [];
    const opts: DriverOptions = { world: world!, harness, anchors: vercelAnchors(), log: (m) => logs.push(m) };
    const driving = deliver({ ...opts, world: a.world }, sessionId, { anchor: { k: 'msg', m: 'msg_parker' } });
    await until(async () => (seen.includes('parked') ? true : undefined));
    await deliver(opts, sessionId, { anchor: { k: 'msg', m: 'msg_other' } });
    expect(logs).toContain('skip: open work is held elsewhere');
    expect((await inspect()).effectOrder.some((e) => e.name === 'detach')).toBe(false);
    await driving;
    expect((await inspect()).effectOrder.find((e) => e.name === 'tool.job')).toMatchObject({ detached: true });
  });

  it("a parker that died attached: its own message's redelivery detaches the step (fenced) and lets the owner have it", async () => {
    const seen: string[] = [];
    const harness = parking(60_000, seen);
    const { sessions, sessionId, inspect } = await setup(harness);
    await sessions.send(sessionId, 'go');
    const a = hostProcess(world!);
    void deliver({ world: a.world, harness, anchors: vercelAnchors() }, sessionId, { anchor: { k: 'msg', m: 'msg_parker' } });
    await until(async () => (seen.includes('parked') ? true : undefined));
    a.kill();
    await deliver({ world: world!, harness, anchors: vercelAnchors() }, sessionId, { anchor: { k: 'msg', m: 'msg_parker' }, attempt: 2 });
    const state = await inspect();
    expect(state.effectOrder.find((e) => e.name === 'recover')).toBeDefined();
    expect(state.effectOrder.find((e) => e.name === 'tool.job')).toMatchObject({ status: 'running', detached: true });
  });
});

describe('a drive lets go only when nothing it opened is open', () => {
  it('a submission committed while a harness that did not wait for its effect finished up is not lost to a covered ack', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    // Starts its effect, and returns without waiting for it.
    const careless: Harness = {
      name: 'careless',
      async drive(ctx) {
        for (const s of ctx.pending()) {
          void ctx
            .effect(`work:${s.id}`, { name: 'tool.work', replay: 'safe', input: s.text, placed: [s.id] }, async () => {
              ran.push(s.text ?? '');
              if (ran.length === 1) await gate;
              return 'ok';
            })
            .catch(() => {});
        }
      },
    };
    const { sessions, sessionId, inspect } = await setup(careless);
    await sessions.send(sessionId, 'one');
    const a = hostProcess(world!);
    const logs: string[] = [];
    const opts: DriverOptions = { world: world!, harness: careless, anchors: vercelAnchors(), log: (m) => logs.push(m) };
    const driving = deliver({ ...opts, world: a.world }, sessionId, { anchor: { k: 'msg', m: 'msg_a' } });
    await until(async () => (ran.length ? true : undefined));
    // A second submission, and its wake's delivery in another process: it finds `one` running, and acks.
    await sessions.send(sessionId, 'two');
    await deliver(opts, sessionId, { anchor: { k: 'msg', m: 'msg_b' } });
    expect(logs).toContain('skip: open work is held elsewhere');
    release();
    await driving;
    // The drive that held `one` saw `two` before it let go.
    expect(ran).toEqual(['one', 'two']);
    const state = await inspect();
    expect([...state.effects.values()].filter((e) => e.name === 'tool.work').map((e) => e.status)).toEqual(['completed', 'completed']);
  });

  it('a released intent the harness never asks for again does not spin the drive', async () => {
    const harness: Harness = { name: 'forgetful', async drive() {} };
    const { sessionId, inspect } = await setup(harness);
    const log = new SessionLog(world!, sessionId);
    await log.refresh();
    const { encode } = await import('./codec.ts');
    await log.write({
      eventType: 'step_started',
      correlationId: 'step_rel00000000000000000000000',
      eventData: { stepName: stepNameFor('tool.x'), input: encode({ key: 'forgotten', replay: 'safe', input: null, epoch: 0 }) },
    });
    await log.write({ eventType: 'step_retrying', correlationId: 'step_rel00000000000000000000000', eventData: { stepName: stepNameFor('tool.x'), error: encode({ message: 'released' }) } } as CreateEventRequest);
    const logs: string[] = [];
    await deliver({ world: world!, harness, log: (m) => logs.push(m) }, sessionId);
    expect(logs).toContain('idle with work the harness did not take');
    expect((await inspect()).effects.get('forgotten')?.status).toBe('pending');
  });

  it('a hung write makes the drive give its delivery up: it fences itself, and a continuation carries on', async () => {
    const harness: Harness = {
      name: 'writer',
      async drive(ctx) {
        // Every prompt: an answered one replays, a released one runs again.
        for (const s of ctx.state().submissions.filter((x) => x.kind === 'prompt')) {
          await ctx.effect(`w:${s.id}`, { name: 'tool.w', replay: 'safe', input: s.text, placed: [s.id] }, async () => 'ok');
        }
      },
    };
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-inv-')), recoverActiveRuns: false });
    const logs: string[] = [];
    const sessions = durableSessions({ world, harness, writeStallMs: 500, log: (m, f) => (logs.push(m), process.env.DBG && console.log(Date.now() % 100000, m, JSON.stringify(f))) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({});
    // The first outcome write is never answered and never commits.
    const create = world.events.create.bind(world.events);
    let hung = false;
    world.events.create = (async (runId: string, req: CreateEventRequest, params?: unknown) => {
      if (!hung && req.eventType === 'step_completed') {
        hung = true;
        return new Promise(() => {});
      }
      return create(runId, req, params as never);
    }) as typeof world.events.create;
    await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(logs).toContain('releasing the delivery');
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return [...s.effects.values()].some((e) => e.name === 'tool.w' && e.status === 'completed') ? s : undefined;
    });
    expect(state.effectOrder.find((e) => e.name === 'recover')?.input).toMatchObject({ continues: expect.any(String) });
  });
});
