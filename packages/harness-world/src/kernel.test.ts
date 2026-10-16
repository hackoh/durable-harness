import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, EffectFailure, QUEUE_PREFIX, workflowNameFor } from './index.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * A harness with no model: each prompt becomes one `model` effect that
 * "decides" to call a tool, then one `tool.echo` effect. Enough to exercise
 * the log mechanics without a provider.
 */
function echoHarness(opts: { onTool?: (text: string) => Promise<void> } = {}): Harness {
  return {
    name: 'echo',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      // Resume an unfinished turn first: its model step is memoized.
      const last = ctx.state().effectOrder.findLast((e) => e.name === 'model');
      const unfinished =
        last && !ctx.isMemoized(`tool:${last.key}`) ? [last] : [];
      for (const record of unfinished) await runTurn(ctx, record.key, [], String(record.input));
      for (const submission of ctx.pending()) {
        const key = `model:${turn++}`;
        await runTurn(ctx, key, [submission.id], submission.text ?? '');
      }
    },
  };

  async function runTurn(ctx: DriveContext, key: string, placed: string[], text: string) {
    const decision = await ctx.effect(
      key,
      { name: 'model', replay: 'safe', input: text, placed },
      async () => ({ tool: 'echo', args: text.toUpperCase() })
    );
    try {
      await ctx.effect(
        `tool:${key}`,
        { name: 'tool.echo', replay: 'never', input: decision.args },
        async (io) => {
          io.progress({ started: decision.args });
          await opts.onTool?.(decision.args);
          return decision.args;
        }
      );
    } catch (err) {
      if (!(err instanceof EffectFailure)) throw err;
    }
    ctx.live({ type: 'turn_end', key });
  }
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

async function setup(harness: Harness) {
  const dataDir = await mkdtemp(join(tmpdir(), 'harness-world-'));
  world = createWorld({ dataDir, recoverActiveRuns: false });
  const sessions = durableSessions({ world, harness, contendedDelaySeconds: 1, log: process.env.DBG ? (m, f) => console.log(m, JSON.stringify(f)) : undefined });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { sessions, world };
}

describe('kernel on world-local', () => {
  it('turns a session into a run whose steps are the transcript', async () => {
    const { sessions } = await setup(echoHarness());
    const { sessionId } = await sessions.start({ prompt: 'hello' });
    await sessions.send(sessionId, 'world');

    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.filter((e) => e.status === 'completed').length === 4 ? s : undefined;
    });
    expect(state.workflowName).toBe(workflowNameFor('echo'));
    expect(state.effectOrder.map((e) => [e.key, e.name, e.output])).toEqual([
      ['model:0', 'model', { tool: 'echo', args: 'HELLO' }],
      ['tool:model:0', 'tool.echo', 'HELLO'],
      ['model:1', 'model', { tool: 'echo', args: 'WORLD' }],
      ['tool:model:1', 'tool.echo', 'WORLD'],
    ]);
    expect(state.submissions.every((s) => state.placed.has(s.id))).toBe(true);
  });

  it('recovers a crashed invocation with the effect replay policy', async () => {
    // "Process A" hangs inside a replay:'never' tool and then dies.
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-world-'));
    const worldA = createWorld({ dataDir, recoverActiveRuns: false });
    const a = durableSessions({
      world: worldA,
      harness: echoHarness({ onTool: () => new Promise(() => {}) }),
    });
    worldA.registerHandler(QUEUE_PREFIX, a.handler);
    const { sessionId } = await a.start({ prompt: 'hello' });
    await until(async () => {
      const s = await a.inspect(sessionId);
      return s.effects.get('tool:model:0')?.status === 'running' ? true : undefined;
    });
    await worldA.close?.();

    // "Process B" starts on the same storage. Its World recovers active runs.
    world = createWorld({ dataDir });
    const b = durableSessions({ world, harness: echoHarness() });
    world.registerHandler(QUEUE_PREFIX, b.handler);
    // No lease to wait out: B's recovery delivery finds A's intent anchored
    // to a process whose drive is not running (anchor.ts, localAnchors).
    await world.start?.();

    const tool = await until(async () => {
      const s = await b.inspect(sessionId);
      const t = s.effects.get('tool:model:0');
      return t?.status === 'failed' ? t : undefined;
    });
    expect(tool.error).toMatchObject({
      interrupted: true,
      partial: [{ started: 'HELLO' }],
    });
    // The model step was not rerun: its outcome was already committed.
    const state = await b.inspect(sessionId);
    expect(state.effects.get('model:0')?.attempt).toBe(1);

    // The session keeps going.
    await b.send(sessionId, 'again');
    await until(async () => {
      const s = await b.inspect(sessionId);
      return s.effects.get('tool:model:1')?.status === 'completed' ? true : undefined;
    });
  });

  it('withdraws a submission that has not been placed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sessions } = await setup(echoHarness({ onTool: () => gate }));
    const { sessionId } = await sessions.start({ prompt: 'first' });
    await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.name === 'tool.echo') ? true : undefined;
    });
    const queued = await sessions.send(sessionId, 'second');
    expect(await sessions.withdraw(sessionId, queued)).toBe('withdrawn');
    release();
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.find((e) => e.key === 'tool:model:0')?.status === 'completed' ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await sessions.inspect(sessionId);
    expect(after.effectOrder.map((e) => e.key)).toEqual(['model:0', 'tool:model:0']);
    expect(state.withdrawn.has(queued)).toBe(true);
  });
});

describe('SessionLog.fence', () => {
  it('refuses every write without the token, including one queued before the fence; reads and token writes pass', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fence-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const { SessionLog, LogFenced } = await import('./index.ts');
    const { encode } = await import('./codec.ts');
    const { stepNameFor } = await import('./names.ts');
    const s = durableSessions({ world, harness: echoHarness() });
    const { sessionId } = await s.start();
    const log = new SessionLog(world, sessionId);
    await log.refresh();
    const step = (id: string) => ({
      eventType: 'step_started' as const,
      correlationId: id,
      eventData: { stepName: stepNameFor('model'), input: encode({ key: `k:${id}`, replay: 'safe', input: null, epoch: 0 }) },
    });
    // One write on the wire, one queued behind the lock; the fence goes up.
    const a = log.write(step('step_a'));
    await new Promise((r) => setImmediate(r));
    const b = log.write(step('step_b'));
    const token = log.fence('chaos');
    await expect(a).resolves.toBeDefined(); // already on the wire: cannot be recalled
    await expect(b).rejects.toBeInstanceOf(LogFenced);
    await expect(log.write(step('step_c'))).rejects.toBeInstanceOf(LogFenced);
    await expect(log.write(step('step_d'), { fenceToken: token })).resolves.toBeDefined();
    await log.refresh();
    expect([...log.state.effects.keys()]).toEqual(['k:step_a', 'k:step_d']);
    log.unfence(token);
    await expect(log.write(step('step_e'))).resolves.toBeDefined();
  });
});

describe('SessionLog stale writes', () => {
  async function setup(name: string) {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), `hw-${name}-`)), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const { SessionLog } = await import('./index.ts');
    const { encode } = await import('./codec.ts');
    const { stepNameFor } = await import('./names.ts');
    const s = durableSessions({ world, harness: echoHarness() });
    const { sessionId } = await s.start();
    const step = (id: string) => ({
      eventType: 'step_started' as const,
      correlationId: id,
      eventData: { stepName: stepNameFor('model'), input: encode({ key: `k:${id}`, replay: 'safe', input: null, epoch: 0 }) },
    });
    const mine = new SessionLog(world, sessionId);
    const other = new SessionLog(world, sessionId);
    await mine.refresh();
    await other.refresh();
    return { world, sessionId, mine, other, step, SessionLog };
  }

  it('folds a complete bump report without re-listing, and ends up where a fresh read does', async () => {
    const t = await setup('bump');
    await t.other.write(t.step('step_theirs'));
    // Simulate a World that reports the skipped slots, as world-vercel does.
    const create = t.world.events.create.bind(t.world.events);
    const list = t.world.events.list.bind(t.world.events);
    let lists = 0;
    t.world.events.create = (async (runId: string, req: never, params?: never) => {
      const result = await create(runId, req, params);
      const all = await list({ runId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' } as never);
      return { ...(result as object), events: all.data.slice(t.mine.state.eventCount) };
    }) as never;
    t.world.events.list = (async (...a: Parameters<typeof list>) => {
      lists++;
      return list(...a);
    }) as never;
    const written = await t.mine.write(t.step('step_mine'));
    expect(lists).toBe(0);
    // Their step (a born-running step_started lands as step_created + step_started).
    expect(new Set(written.foreign.map((e) => (e as { correlationId?: string }).correlationId))).toEqual(new Set(['step_theirs']));
    t.world.events.create = create;
    t.world.events.list = list;
    const fresh = new t.SessionLog(t.world, t.sessionId);
    await fresh.refresh();
    expect(t.mine.state.eventCount).toBe(fresh.state.eventCount);
    expect([...t.mine.state.effects.keys()]).toEqual([...fresh.state.effects.keys()]);
  });

  it('re-lists when the report is missing or has a gap', async () => {
    const t = await setup('gap');
    await t.other.write(t.step('step_theirs'));
    await t.other.write(t.step('step_theirs2'));
    const create = t.world.events.create.bind(t.world.events);
    const list = t.world.events.list.bind(t.world.events);
    t.world.events.create = (async (runId: string, req: never, params?: never) => {
      const result = await create(runId, req, params);
      const all = await list({ runId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' } as never);
      // Drop the first skipped slot: an incomplete report must not be trusted.
      return { ...(result as object), events: all.data.slice(t.mine.state.eventCount + 1) };
    }) as never;
    await t.mine.write(t.step('step_mine'));
    t.world.events.create = create;
    const fresh = new t.SessionLog(t.world, t.sessionId);
    await fresh.refresh();
    expect(t.mine.state.eventCount).toBe(fresh.state.eventCount);
    expect([...t.mine.state.effects.keys()]).toEqual(['k:step_theirs', 'k:step_theirs2', 'k:step_mine']);
  });
});
