import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, EffectFailure, QUEUE_NAME, QUEUE_PREFIX } from './index.ts';
import { stepNameFor } from './names.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * A drive that runs out of invocation time mid tool chain yields and wakes
 * the session, and the next drive picks the chain up at once, under Strict
 * and under run-ahead alike. Run ahead, the yielding drive's last outcomes
 * may still be in its pipeline when it yields; the same goes, in Strict too,
 * for a harness that stops on `ctx.signal` while a tool it started is still
 * running (harness-codex, harness-claude-code): that tool's outcome is not
 * written yet. The drive finishes both before it wakes, but only until
 * shortly before the hard limit: a tool or a write stuck at the boundary
 * must not keep the session from moving on. Then it writes nothing more and
 * hands the session to a continuation, whose delivery recovers (and fences)
 * what it left open at once.
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEPS = 6;
const stalled = (logs: string[]) => new Error(`stalled: ${logs.filter((l) => l.startsWith('defer')).join('; ')}`);

/** model:i (safe) → tool:i, STEPS times, then a closing model call. */
function chain(replay: 'safe' | 'never', ran: string[]): Harness {
  return {
    name: 'chain',
    async drive(ctx: DriveContext) {
      const s = ctx.state().submissions.find((x) => x.kind === 'prompt');
      if (!s) return;
      for (let i = 0; i < STEPS; i++) {
        await ctx.effect(`model:${i}`, { name: 'model', replay: 'safe', input: i, ...(i === 0 ? { placed: [s.id] } : {}) }, async () => {
          await sleep(50);
          return `call ${i}`;
        });
        await ctx.effect(`tool:${i}`, { name: 'tool.step', replay, input: i }, async () => {
          ran.push(`tool:${i}`);
          await sleep(400);
          return `ok ${i}`;
        });
      }
      await ctx.effect('model:end', { name: 'model', replay: 'safe', input: 'end' }, async () => 'done');
    },
  };
}

describe('a budget boundary mid tool chain', () => {
  for (const runAhead of [false, true]) {
    for (const replay of ['never', 'safe'] as const) {
      it(`${runAhead ? 'run-ahead' : 'Strict'}, ${replay} tools: hands off without waiting out a lease`, async () => {
        const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-budget-')) });
        worlds.push(world);
        const ran: string[] = [];
        const logs: string[] = [];
        const sessions = durableSessions({
          world,
          harness: chain(replay, ran),
          runAhead,
          // About three steps per drive, so the chain crosses two boundaries.
          maxInvocationMs: 1300,
          deadlineMarginMs: 0,
          log: (m) => logs.push(m),
        });
        world.registerHandler(QUEUE_PREFIX, sessions.handler);
        const t0 = Date.now();
        const { sessionId } = await sessions.start({ prompt: 'go' });
        for (;;) {
          const s = await sessions.inspect(sessionId);
          if (s.effects.get('model:end')?.status === 'completed') break;
          // About 3 s of work; a wait for the default 30 s lease is far past this.
          if (Date.now() - t0 > 15_000) throw stalled(logs);
          await sleep(50);
        }
        expect(logs.filter((l) => l === 'yield: budget').length).toBeGreaterThanOrEqual(1);
        expect(logs.filter((l) => l.startsWith('defer'))).toEqual([]);
        expect(ran).toEqual(Array.from({ length: STEPS }, (_, i) => `tool:${i}`));
      }, 30_000);
    }
  }
});

describe('a run-ahead write stuck at the budget boundary', () => {
  it('hands the session to a continuation, which recovers it at once (no lease)', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-budget-')), recoverActiveRuns: false });
    worlds.push(world);
    // The tool's outcome write is never answered (a lost reply, a stuck socket).
    let hung = false;
    const create = world.events.create.bind(world.events);
    world.events.create = (async (runId: string, req: CreateEventRequest, params?: unknown) => {
      const name = (req as { eventData?: { stepName?: string } }).eventData?.stepName;
      if (!hung && req.eventType === 'step_completed' && name === stepNameFor('tool.step')) {
        hung = true;
        return new Promise(() => {});
      }
      return create(runId, req, params as never);
    }) as typeof world.events.create;
    const logs: string[] = [];
    const harness: Harness = {
      name: 'stuck',
      async drive(ctx: DriveContext) {
        const s = ctx.state().submissions.find((x) => x.kind === 'prompt');
        if (!s) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: 0, placed: [s.id] }, async () => 'call');
        try {
          // The budget runs out while this runs.
          await ctx.effect('tool:0', { name: 'tool.step', replay: 'never', input: 0 }, async () => {
            await sleep(600);
            return 'ok';
          });
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
        await ctx.effect('model:end', { name: 'model', replay: 'safe', input: 'end' }, async () => 'done');
      },
    };
    const sessions = durableSessions({ world, harness, runAhead: true, maxInvocationMs: 400, deadlineMarginMs: 0, log: (m) => logs.push(m) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const t0 = Date.now();
    const { sessionId } = await sessions.start({ prompt: 'go' });
    for (;;) {
      const s = await sessions.inspect(sessionId);
      if (s.effects.get('model:end')?.status === 'completed') break;
      if (Date.now() - t0 > 25_000) throw new Error(`never continued: ${logs.join('; ')}`);
      await sleep(100);
    }
    expect(logs).toContain('budget: work still in flight');
    expect(logs).toContain('continuation');
    expect(logs).toContain('recovered abandoned intent');
  }, 40_000);
});

/** The chain, with every wait guarded by `ctx.signal`: the drive stops the moment the budget aborts it. */
function racing(replay: 'safe' | 'never', ran: string[]): Harness {
  return {
    name: 'racing',
    async drive(ctx: DriveContext) {
      const s = ctx.state().submissions.find((x) => x.kind === 'prompt');
      if (!s) return;
      const stopped = new Promise<never>((_, reject) => {
        const fail = () => reject(ctx.signal.reason);
        if (ctx.signal.aborted) fail();
        else ctx.signal.addEventListener('abort', fail, { once: true });
      });
      stopped.catch(() => {});
      const guard = <T>(p: Promise<T>) => Promise.race([p, stopped]);
      for (let i = 0; i < STEPS; i++) {
        await guard(
          ctx.effect(`model:${i}`, { name: 'model', replay: 'safe', input: i, ...(i === 0 ? { placed: [s.id] } : {}) }, async () => {
            await sleep(50);
            return `call ${i}`;
          })
        );
        await guard(
          ctx.effect(`tool:${i}`, { name: 'tool.step', replay, input: i }, async () => {
            ran.push(`tool:${i}`);
            await sleep(500);
            return `ok ${i}`;
          })
        );
      }
      await ctx.effect('model:end', { name: 'model', replay: 'safe', input: 'end' }, async () => 'done');
    },
  };
}

describe('a budget boundary while a tool the harness gave up on is still running', () => {
  for (const runAhead of [false, true]) {
    for (const replay of ['never', 'safe'] as const) {
      it(`${runAhead ? 'run-ahead' : 'Strict'}, ${replay} tools: the tool finishes inside the margin, and the next drive goes on at once`, async () => {
        const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-budget-')) });
        worlds.push(world);
        const ran: string[] = [];
        const logs: string[] = [];
        const sessions = durableSessions({
          world,
          harness: racing(replay, ran),
          runAhead,
          // The deadline (1.3 s) lands inside tool:2 (model 50 ms + tool 500 ms
          // per step), which ends inside the margin, before the hard limit
          // (3.3 s). The margin is wide so a loaded machine still finishes the
          // tool in it (a tool that does not is interrupted, a different case).
          maxInvocationMs: 3300,
          deadlineMarginMs: 2000,
          log: (m) => logs.push(m),
        });
        world.registerHandler(QUEUE_PREFIX, sessions.handler);
        const t0 = Date.now();
        const { sessionId } = await sessions.start({ prompt: 'go' });
        let state;
        for (;;) {
          state = await sessions.inspect(sessionId);
          if (state.effects.get('model:end')?.status === 'completed') break;
          if (Date.now() - t0 > 15_000) throw stalled(logs);
          await sleep(50);
        }
        expect(logs).toContain('yield: budget');
        expect(logs.filter((l) => l.startsWith('defer'))).toEqual([]);
        expect(ran).toEqual(Array.from({ length: STEPS }, (_, i) => `tool:${i}`));
        // Finished, not recovered: no tool came back interrupted.
        expect([...state.effects.values()].filter((e) => e.status === 'failed')).toEqual([]);
      }, 30_000);
    }
  }
});

describe('a run-ahead write slow at the budget boundary', () => {
  it('does not hold the wake past the hard limit', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-budget-')) });
    worlds.push(world);
    const logs: { m: string; at: number }[] = [];
    const wakes: number[] = [];
    const queue = world.queue.bind(world);
    world.queue = (async (name: string, ...rest: unknown[]) => {
      if (name === QUEUE_NAME) wakes.push(Date.now());
      return (queue as (...a: unknown[]) => Promise<unknown>)(name, ...rest);
    }) as typeof world.queue;
    // tool:2's outcome, the last write before the boundary, commits 4 s late.
    const create = world.events.create.bind(world.events);
    let hangFrom = Infinity;
    let hung = false;
    world.events.create = (async (...args: Parameters<typeof create>) => {
      const req = args[1] as { eventType: string };
      if (!hung && req.eventType === 'step_completed' && Date.now() >= hangFrom) {
        hung = true;
        await sleep(4000);
      }
      return create(...args);
    }) as typeof create;
    const sessions = durableSessions({
      world,
      harness: chain('safe', []),
      runAhead: true,
      maxInvocationMs: 2300, // the hard limit
      deadlineMarginMs: 1000, // the budget, at 1.3 s
      log: (m) => logs.push({ m, at: Date.now() }),
    });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    hangFrom = Date.now() + 1150;
    const { sessionId } = await sessions.start({ prompt: 'go' });
    let done = false;
    for (const t0 = Date.now(); !done && Date.now() - t0 < 20_000; await sleep(50)) {
      done = (await sessions.inspect(sessionId)).effects.get('model:end')?.status === 'completed';
    }
    const yieldAt = logs.find((l) => l.m === 'yield: budget')!.at;
    const wakeAt = wakes.find((w) => w >= yieldAt)!;
    expect(hung).toBe(true);
    // Inside the margin, before the hard limit.
    expect(wakeAt - yieldAt).toBeLessThan(1000);
    expect(done).toBe(true);
  }, 30_000);
});
