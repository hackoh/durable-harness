import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode } from './codec.ts';
import { commitEpochStep } from './driver.ts';
import type { StepEnvelope } from './fold.ts';
import { durableSessions, EffectFailure, QUEUE_PREFIX } from './index.ts';
import { stepNameFor } from './names.ts';
import { SessionLog } from './session-log.ts';
import type { DriveContext, Harness, SessionState } from './types.ts';

/**
 * Run-ahead durability, end to end on world-local: drives run
 * replay-safe effects ahead of their acks, and block only at barriers. Each
 * barrier is attacked here: a crash on either side of its ack, a rejected
 * pipelined write, a foreign writer, an epoch fence. Invariants checked
 * every time: a `replay: 'never'` tool never runs twice, and the log never
 * forks (one effective record per key, every submission placed at most once).
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Counter {
  sends: number;
  errors: string[];
  /** Was model:0's outcome durable when the never tool started? */
  durableAtBarrier?: boolean;
  modelMs?: number;
}

/** model:0 (safe) → tool.send (never) → model:1 (safe), once per prompt. */
function agent(counter: Counter, probe?: (ctx: DriveContext) => Promise<boolean>): Harness {
  return {
    name: 'agent',
    async drive(ctx: DriveContext) {
      // Like a real harness, a restart picks the turn up where the log has it
      // (model:0 done, tool not yet), not only from unplaced submissions.
      const st = ctx.state();
      const s = st.submissions.find((x) => x.kind !== 'withdraw' && x.kind !== 'chaos' && !st.withdrawn.has(x.id));
      if (!s || ctx.isMemoized('model:1')) {
        if (ctx.pending().length) await ctx.effect(`ack:${ctx.pending()[0]!.id}`, { name: 'model', replay: 'safe', input: 0, placed: ctx.pending().map((p) => p.id) }, async () => 'ok');
        return;
      }
      {
        const t0 = Date.now();
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => 'call send');
        counter.modelMs = Date.now() - t0;
        try {
          await ctx.effect('tool:0', { name: 'tool.send', replay: 'never', input: s.text }, async () => {
            if (probe) counter.durableAtBarrier = await probe(ctx);
            counter.sends++;
            return 'sent';
          });
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
          counter.errors.push(err.message);
          return;
        }
        const rest = ctx.pending().map((p) => p.id);
        await ctx.effect('model:1', { name: 'model', replay: 'safe', input: 'sent', placed: rest }, async () => 'done');
      }
    },
  };
}

type Fault = (req: CreateEventRequest, go: () => Promise<unknown>) => Promise<unknown> | undefined;

async function setup(opts: { fault?: Fault; dataDir?: string; delayMs?: number; runAhead?: boolean } = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'hw-ahead-')));
  const world = createWorld({ dataDir, recoverActiveRuns: !!opts.dataDir });
  worlds.push(world);
  const create = world.events.create.bind(world.events);
  let writes = 0;
  world.events.create = (async (runId: string, req: any, params?: any) => {
    writes++;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const go = () => create(runId, req, params);
    return (opts.fault?.(req, go) ?? go()) as ReturnType<typeof create>;
  }) as typeof world.events.create;
  const counter: Counter = { sends: 0, errors: [] };
  const sessions = durableSessions({
    world,
    harness: agent(counter, async (ctx) => {
      const durable = new SessionLog(world, ctx.runId);
      await durable.refresh();
      return durable.state.effects.get('model:0')?.status === 'completed';
    }),
    runAhead: opts.runAhead ?? true,
    contendedDelaySeconds: 1,
    log: (m, f) => process.env.DBG && console.log('LOG', m, JSON.stringify(f)),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  if (opts.dataDir) await world.start?.();
  return { world, sessions, counter, dataDir, writes: () => writes };
}

const isStep = (req: CreateEventRequest, type: string, effect: string, key?: string) => {
  if (req.eventType !== type) return false;
  const data = (req as { eventData?: { stepName?: string; input?: unknown } }).eventData;
  if (data?.stepName !== stepNameFor(effect)) return false;
  if (key === undefined || data.input === undefined) return true;
  return (decode(data.input) as StepEnvelope).key === key;
};
const never = () => new Promise<never>(() => {});

/** No forks: one effective record per key, a submission placed at most once. */
function expectNoFork(state: SessionState) {
  const keys = state.effectOrder.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
  const placed = state.effectOrder.flatMap((r) => r.placed);
  expect(new Set(placed).size).toBe(placed.length);
}

describe('run-ahead durability', () => {
  it('runs a replay-safe effect without waiting for its writes, and waits at the never tool barrier', async () => {
    const { sessions, counter } = await setup({ delayMs: 60 });
    const { sessionId } = await sessions.start({ prompt: 'email bob' });
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effects.get('model:1')?.status === 'completed' ? s : undefined;
    });
    // Two writes (intent, outcome) at 60ms each would cost 120ms awaited.
    expect(counter.modelMs!).toBeLessThan(60);
    expect(counter.durableAtBarrier).toBe(true);
    expect(counter.sends).toBe(1);
    expect(state.effectOrder.map((r) => [r.key, r.status])).toEqual([
      ['model:0', 'completed'],
      ['tool:0', 'completed'],
      ['model:1', 'completed'],
    ]);
    // Every intent of the run-ahead chain carries a seq.
    expectNoFork(state);
  });

  it('a submit followed by a drive in the same process (the drive route) places the prompt before it is durable', async () => {
    const { sessions, counter } = await setup({ delayMs: 60 });
    const { sessionId } = await sessions.start();
    const t0 = Date.now();
    const id = await sessions.send(sessionId, 'email bob', 'prompt', { wake: 'backstop' });
    const submitMs = Date.now() - t0;
    expect(id).toMatch(/^sub_/);
    await sessions.drive(sessionId);
    const state = await sessions.inspect(sessionId);
    // The submit did not wait for its write (60ms) before returning.
    expect(submitMs).toBeLessThan(60);
    expect(state.submissions.map((s) => s.id)).toEqual([id]);
    expect(state.placed.has(id)).toBe(true);
    expect(state.effects.get('model:1')?.status).toBe('completed');
    expect(counter.sends).toBe(1);
    expectNoFork(state);
  });

  it('with durability on (no run-ahead) the same model effect waits for its writes', async () => {
    const { sessions, counter } = await setup({ delayMs: 60, runAhead: false });
    const { sessionId } = await sessions.start({ prompt: 'email bob' });
    await until(async () => ((await sessions.inspect(sessionId)).effects.get('model:1')?.status === 'completed' ? true : undefined));
    expect(counter.modelMs!).toBeGreaterThanOrEqual(110);
  });

  it('a crash before the barrier intent lands: the never tool runs once, in the recovery', async () => {
    let dead = false;
    const a = await setup({
      fault: (req) => {
        if (dead) return never();
        if (isStep(req, 'step_started', 'tool.send')) {
          dead = true; // the process dies with the barrier write unsent
          return never();
        }
        return undefined;
      },
    });
    const { sessionId } = await a.sessions.start({ prompt: 'email bob' });
    await until(async () => (dead ? true : undefined));
    expect(a.counter.sends).toBe(0);
    await a.world.close?.();
    const b = await setup({ dataDir: a.dataDir });
    await b.sessions.send(sessionId, 'nudge', 'followUp').catch(() => {});
    const state = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      return s.effects.get('model:1')?.status === 'completed' ? s : undefined;
    });
    expect(a.counter.sends + b.counter.sends).toBe(1);
    expect(state.effects.get('model:0')?.status).toBe('completed');
    expectNoFork(state);
  });

  it('a crash after the barrier ack, before the outcome lands: interrupted, never rerun', async () => {
    let dead = false;
    const a = await setup({
      fault: (req) => {
        if (dead) return never();
        if (isStep(req, 'step_completed', 'tool.send')) {
          dead = true; // the tool ran; its result dies with the process
          return never();
        }
        return undefined;
      },
    });
    const { sessionId } = await a.sessions.start({ prompt: 'email bob' });
    await until(async () => (dead ? true : undefined));
    expect(a.counter.sends).toBe(1);
    await a.world.close?.();
    const b = await setup({ dataDir: a.dataDir });
    await b.sessions.send(sessionId, 'nudge', 'followUp').catch(() => {});
    const state = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      return s.effects.get('tool:0')?.status === 'failed' ? s : undefined;
    });
    expect(state.effects.get('tool:0')?.error).toMatchObject({ interrupted: true });
    expect(a.counter.sends + b.counter.sends).toBe(1);
    expectNoFork(state);
  });

  it('a rejected pipelined write (its submission was withdrawn first) rewinds, and the barrier keeps the never tool from running', async () => {
    let world!: LocalWorld;
    let injected = false;
    const t = await setup({
      fault: (req, go) => {
        if (injected || !isStep(req, 'step_started', 'model', 'model:0')) return undefined;
        injected = true;
        // A withdraw of the prompt lands just ahead of the intent that places it.
        return (async () => {
          const other = new SessionLog(world, (req as any).runId ?? currentRun);
          await other.refresh();
          const sub = other.state.submissions[0]!;
          await other.write({
            eventType: 'hook_received',
            correlationId: other.state.inbox!.hookId,
            eventData: { token: other.state.inbox!.token, payload: encode({ kind: 'withdraw', target: sub.id, nonce: 'w1' }) },
          } as CreateEventRequest);
          return go();
        })();
      },
    });
    world = t.world;
    let currentRun = '';
    const started = t.sessions.start();
    const { sessionId } = await started;
    currentRun = sessionId;
    await t.sessions.send(sessionId, 'email bob');
    const state = await until(async () => {
      const s = await t.sessions.inspect(sessionId);
      return injected && s.withdrawn.size === 1 && s.effectOrder.some((r) => r.key === 'model:0') === false && s.superseded.size > 0 ? s : undefined;
    });
    // Let the drive settle (restart, idle).
    await new Promise((r) => setTimeout(r, 500));
    const after = await t.sessions.inspect(sessionId);
    expect(t.counter.sends).toBe(0);
    expect(after.effects.has('tool:0')).toBe(false);
    expect(after.effects.has('model:0')).toBe(false);
    expect(state.placed.size).toBe(0);
    expectNoFork(after);
  });

  it('a foreign writer lands next to a pipelined intent: the drive yields, releases, and the session still runs the tool once', async () => {
    let world!: LocalWorld;
    let injected = false;
    const t = await setup({
      fault: (req, go) => {
        if (injected || !isStep(req, 'step_started', 'model', 'model:0')) return undefined;
        injected = true;
        return (async () => {
          const other = new SessionLog(world, runIdOf);
          await other.refresh();
          // Another live driver's progress on this session (an unrelated key).
          await other.write({
            eventType: 'step_started',
            correlationId: 'step_foreign',
            eventData: { stepName: stepNameFor('model'), input: encode({ key: 'x', replay: 'safe', input: 0, epoch: other.state.epoch, drv: 'drv_other' } satisfies StepEnvelope) },
          } as CreateEventRequest);
          return go();
        })();
      },
    });
    world = t.world;
    let runIdOf = '';
    const { sessionId } = await t.sessions.start();
    runIdOf = sessionId;
    await t.sessions.send(sessionId, 'email bob');
    const state = await until(async () => {
      const s = await t.sessions.inspect(sessionId);
      return s.effects.get('model:1')?.status === 'completed' ? s : undefined;
    }, 20_000);
    expect(injected).toBe(true);
    expect(t.counter.sends).toBe(1);
    expectNoFork(state);
  });

  it('an epoch fence (a recovery elsewhere) lands before a pipelined intent: the drive stops and writes nothing that counts', async () => {
    let world!: LocalWorld;
    let injected = false;
    const t = await setup({
      fault: (req, go) => {
        if (injected || !isStep(req, 'step_started', 'model', 'model:0')) return undefined;
        injected = true;
        return (async () => {
          const other = new SessionLog(world, runIdOf);
          await other.refresh();
          await commitEpochStep(other, 'recover', { reason: 'test: another process took over', keys: [] }, other.state.epoch);
          return go();
        })();
      },
    });
    world = t.world;
    let runIdOf = '';
    const { sessionId } = await t.sessions.start();
    runIdOf = sessionId;
    await t.sessions.send(sessionId, 'email bob');
    const state = await until(async () => {
      const s = await t.sessions.inspect(sessionId);
      return injected && s.fenced.size > 0 ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 500));
    const after = await t.sessions.inspect(sessionId);
    expect(t.counter.sends).toBe(0);
    expect(after.effects.has('model:0')).toBe(false);
    expect(after.effects.has('tool:0')).toBe(false);
    expect(state.epoch).toBe(1);
    expectNoFork(after);
  });
});
