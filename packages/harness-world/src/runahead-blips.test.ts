import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, EffectFailure, QUEUE_PREFIX } from './index.ts';
import { stepNameFor } from './names.ts';
import type { DriveContext, Harness, SessionState } from './types.ts';

/**
 * Run-ahead under write blips and stalls (review of P3): a lost or slow ack
 * must not turn a real `replay: 'never'` result into "may or may not have
 * taken effect", must not drop a prompt the harness already answered, and a
 * drive that gives its delivery up because its durability stalled is always
 * fenced out by the delivery that carries on.
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

type Create = (runId: string, req: CreateEventRequest, params?: unknown) => Promise<unknown>;

async function setup(intercept: (req: CreateEventRequest, create: () => Promise<unknown>) => Promise<unknown>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hw-runahead-blips-'));
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  const create = world.events.create.bind(world.events) as Create;
  world.events.create = (async (runId: string, req: CreateEventRequest, params?: unknown) =>
    intercept(req, () => create(runId, req, params))) as typeof world.events.create;
  return world;
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

const stepName = (req: CreateEventRequest) => (req.eventData as { stepName?: string } | undefined)?.stepName;

describe('run-ahead blips', () => {
  it('a sibling never tool that finished is recorded, not interrupted, when another write rejects the pipeline', async () => {
    // tool.send's outcome fails for 7s: past the resend window, so the
    // pipeline rejects and the drive stops, while tool.charge is still in fn.
    let blipUntil = 0;
    const world = await setup(async (req, create) => {
      if (req.eventType === 'step_completed' && stepName(req) === stepNameFor('tool.send') && blipUntil === 0) blipUntil = Date.now() + 7000;
      if (Date.now() < blipUntil) throw new Error('fetch failed (blip)');
      return create();
    });
    const runs = { charge: 0, send: 0 };
    const harness: Harness = {
      name: 'agent',
      async drive(ctx: DriveContext) {
        const st = ctx.state();
        const s = st.submissions.find((x) => x.kind === 'prompt');
        if (!s || ctx.isMemoized('model:1')) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: 1, placed: [s.id] }, async () => 'call');
        let r: unknown;
        try {
          const B = ctx.effect('tool:1', { name: 'tool.charge', replay: 'never', input: 2 }, async () => {
            runs.charge++;
            await new Promise((x) => setTimeout(x, 6000));
            return 'charged';
          });
          B.catch(() => {});
          r = await ctx.effect('tool:0', { name: 'tool.send', replay: 'never', input: 1 }, async () => {
            runs.send++;
            return 'sent';
          });
          await B;
        } catch (e) {
          if (!(e instanceof EffectFailure)) throw e;
          r = 'ERR';
        }
        await ctx.effect('model:1', { name: 'model', replay: 'safe', input: r }, async () => 'done');
      },
    };
    const sessions = durableSessions({ world, harness, runAhead: true, contendedDelaySeconds: 1 });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'charge and email' });
    const state = await until(async () => {
      const st = await sessions.inspect(sessionId);
      // Settled: neither just written (pending) nor under way (running).
      const status = st.effects.get('tool:1')?.status;
      return status && status !== 'running' && status !== 'pending' ? st : undefined;
    }, 40_000);
    expect(runs.charge).toBe(1);
    const charge = state.effects.get('tool:1')!;
    expect(charge.status).toBe('completed');
    expect(runs.send).toBe(1);
  }, 60_000);

  it('a ~400ms blip on a never tool outcome is resent: the result the harness acted on is kept', async () => {
    let blipUntil = 0;
    const world = await setup(async (req, create) => {
      if (req.eventType === 'step_completed' && stepName(req) === stepNameFor('tool.send') && blipUntil === 0) blipUntil = Date.now() + 400;
      if (Date.now() < blipUntil) throw new Error('fetch failed (blip)');
      return create();
    });
    const seen: unknown[] = [];
    let sends = 0;
    const harness: Harness = {
      name: 'agent',
      async drive(ctx: DriveContext) {
        const st = ctx.state();
        const s = st.submissions.find((x) => x.kind === 'prompt');
        if (!s || ctx.isMemoized('model:1')) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: 1, placed: [s.id] }, async () => 'call');
        let r: unknown;
        try {
          r = await ctx.effect('tool:0', { name: 'tool.send', replay: 'never', input: 1 }, async () => {
            sends++;
            return 'sent';
          });
        } catch (e) {
          if (!(e instanceof EffectFailure)) throw e;
          r = 'ERR';
        }
        await ctx.effect('model:1', { name: 'model', replay: 'safe', input: r }, async () => {
          seen.push(r);
          return 'done';
        });
      },
    };
    const sessions = durableSessions({ world, harness, runAhead: true, contendedDelaySeconds: 1 });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'email bob' });
    const state = await until(async () => {
      const st = await sessions.inspect(sessionId);
      return st.effects.get('model:1')?.status === 'completed' ? st : undefined;
    });
    expect(sends).toBe(1);
    expect(state.effects.get('tool:0')?.status).toBe('completed');
    expect(seen).not.toContain('ERR');
    expect(state.epoch).toBe(0);
  }, 30_000);

  it('a 1.2s blip on a run-ahead submit is resent: the answered prompt is durable', async () => {
    let failUntil = 0;
    const world = await setup(async (req, create) => {
      if (req.eventType === 'hook_received' && failUntil === 0) failUntil = Date.now() + 1200;
      if (req.eventType === 'hook_received' && Date.now() < failUntil) {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error('fetch failed');
      }
      return create();
    });
    const answered: string[] = [];
    const harness: Harness = {
      name: 'agent',
      async drive(ctx: DriveContext) {
        const p = ctx.pending();
        if (!p.length) return;
        await ctx.effect(`model:${p[0]!.id}`, { name: 'model', replay: 'safe', input: 0, placed: p.map((x) => x.id) }, async () => {
          answered.push(p[0]!.id);
          return 'answer';
        });
      },
    };
    const sessions = durableSessions({ world, harness, runAhead: true });
    const { sessionId } = await sessions.start();
    const id = await sessions.send(sessionId, 'hi', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    const st: SessionState = await sessions.inspect(sessionId);
    expect(st.submissions.map((s) => s.id)).toEqual([id]);
    expect(st.effects.get(`model:${id}`)?.status).toBe('completed');
    expect(answered).toContain(id);
  }, 30_000);

  it('a drive does not give its delivery up while a never effect is in fn, even with a stalled write (no self-demotion)', async () => {
    // A parallel safe effect's intent stalls 8s (past the 5s demotion
    // window) while a never tool runs for 12s: the drive must not let go of
    // the session under the running tool. The stall ends well inside the
    // tool's run: one that outlived the tool would be a stall with nothing
    // in fn, which the watchdog rightly demotes (a race on a slow runner).
    let stalled = false;
    const world = await setup(async (req, create) => {
      if (!stalled && req.eventType === 'step_started' && stepName(req) === stepNameFor('lookup')) {
        stalled = true;
        await new Promise((r) => setTimeout(r, 8_000));
      }
      return create();
    });
    const harness: Harness = {
      name: 'agent',
      async drive(ctx: DriveContext) {
        const p = ctx.pending();
        if (!p.length) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: 0, placed: p.map((x) => x.id) }, async () => 'go');
        let inFn!: () => void;
        const started = new Promise<void>((r) => (inFn = r));
        const tool = ctx.effect('tool:0', { name: 'tool.send', replay: 'never', input: 0 }, async () => {
          inFn();
          await new Promise((r) => setTimeout(r, 12_000));
          return 'sent';
        });
        await started;
        const side = ctx.effect('lookup:0', { name: 'lookup', replay: 'safe', input: 0 }, async () => 'found');
        await Promise.all([tool, side]);
      },
    };
    const logs: string[] = [];
    const sessions = durableSessions({ world, harness, runAhead: true, log: (m) => logs.push(m) });
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'hi', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(logs).not.toContain('releasing the delivery');
    expect(logs).not.toContain('continuation');
    const st = await sessions.inspect(sessionId);
    expect(st.effects.get('tool:0')?.status).toBe('completed');
    expect(st.epoch).toBe(0);
  }, 45_000);

  it('a run-ahead drive whose durability stalls gives its delivery up; the continuation fences it out, even with no durable intent', async () => {
    // The drive's born-running intent stalls 13s: the drive demotes itself
    // before anything of it is durable to fence by.
    let stall = false;
    const world = await setup(async (req, create) => {
      if (stall && req.eventType === 'step_started') {
        stall = false;
        await new Promise((r) => setTimeout(r, 13_000));
      }
      return create();
    });
    const runs: number[] = [];
    const harness: Harness = {
      name: 'agent',
      async drive(ctx: DriveContext) {
        const p = ctx.pending();
        if (!p.length) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: 0, placed: p.map((x) => x.id) }, async (io) => {
          runs.push(ctx.state().epoch);
          await new Promise((r) => setTimeout(r, runs.length === 1 ? 16_000 : 50));
          void io;
          return 'ok';
        });
      },
    };
    const logs: string[] = [];
    const sessions = durableSessions({ world, harness, runAhead: true, log: (m) => logs.push(m) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start();
    stall = true;
    await sessions.send(sessionId, 'hi', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(logs).toContain('releasing the delivery');
    expect(logs).toContain('continuation');
    // The continuation's delivery recovers the session on a new epoch.
    const st = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.key === 'model:0' && e.status === 'completed') ? s : undefined;
    }, 30_000);
    // The two drives never shared an epoch, and the log has exactly one effective model:0.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[1]).toBeGreaterThan(runs[0]!);
    expect(st.epoch).toBeGreaterThanOrEqual(1);
    expect(st.effectOrder.find((e) => e.name === 'recover')?.input).toMatchObject({ continues: expect.stringMatching(/^deadline:/) });
    // The stalled intent lands later, fenced: still one effective model:0.
    await new Promise((r) => setTimeout(r, 14_000));
    const after = await sessions.inspect(sessionId);
    expect(after.effectOrder.filter((e) => e.key === 'model:0')).toHaveLength(1);
  }, 90_000);
});
