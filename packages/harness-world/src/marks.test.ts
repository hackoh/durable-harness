import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, EffectFailure, isMark, type Mark, PROCESS_ID, QUEUE_PREFIX, rawSessions, readJsonLines, liveStreamName, workflowNameFor } from './index.ts';
import type { DriveContext, Harness } from './types.ts';

/** One `model` effect (with a first-token mark), then one `tool.echo`, per prompt. */
function echoHarness(): Harness {
  return {
    name: 'echo',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      for (const submission of ctx.pending()) {
        const key = `model:${turn++}`;
        const decision = await ctx.effect(key, { name: 'model', replay: 'safe', input: submission.text, placed: [submission.id] }, async () => {
          ctx.mark?.('model.first_token', { key });
          ctx.live({ type: 'text', delta: 'ok' });
          return { args: (submission.text ?? '').toUpperCase() };
        });
        try {
          await ctx.effect(`tool:${key}`, { name: 'tool.echo', replay: 'never', input: decision.args }, async () => decision.args);
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
      }
      ctx.live({ type: 'idle' });
    },
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

const names = (events: unknown[]) => events.filter(isMark).filter((m) => m.name !== 'ack').map((m) => m.name);

describe('timing marks', () => {
  it('a durable drive marks submit, intents, model and tool phases, acks and idle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-marks-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness: echoHarness() });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const { sessionId } = await sessions.start({ prompt: 'hi' });
    const lines = await until(async () => {
      const l = await readJsonLines(world!, sessionId, liveStreamName(sessionId));
      return l.some((e) => isMark(e) && e.name === 'idle') ? l : undefined;
    });
    expect(names(lines)).toEqual([
      'submit',
      'drive.start',
      'intent',
      'model.request',
      'model.first_token',
      'model.done',
      'intent',
      'tool.start',
      'tool.end',
      'idle',
    ]);
    const marks = lines.filter(isMark) as Mark[];
    for (const m of marks) {
      expect(m.runId).toBe(sessionId);
      expect(m.pid).toBe(PROCESS_ID);
      expect(typeof m.t).toBe('number');
    }
    // Times never go backwards within one process, except the end marks:
    // written after their commit, they carry when the work itself ended.
    const ends = new Set(['model.done', 'tool.end']);
    const ts = marks.filter((m) => !ends.has(m.name)).map((m) => m.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    for (const [start, end] of [
      ['model.request', 'model.done'],
      ['tool.start', 'tool.end'],
    ] as const) {
      const s = marks.find((m) => m.name === start)!;
      const e = marks.find((m) => m.name === end)!;
      // The commit's ack lands between the work ending and the end mark.
      const commit = marks.find((m) => m.name === 'ack' && m.eventType === 'step_completed' && marks.indexOf(m) > marks.indexOf(s) && marks.indexOf(m) < marks.indexOf(e))!;
      expect(e.t).toBeGreaterThanOrEqual(s.t);
      expect(e.t).toBeLessThanOrEqual(commit.t);
      expect(e.commitMs).toBeGreaterThanOrEqual(0);
      expect(e.key).toBe(s.key);
    }
    // Every durable write is acked with its type, slot and latency.
    const acks = marks.filter((m) => m.name === 'ack');
    expect(acks.map((a) => a.eventType)).toEqual(['step_started', 'step_completed', 'step_started', 'step_completed']);
    expect(acks.every((a) => typeof a.slot === 'number' && typeof a.lagMs === 'number')).toBe(true);
    // The model intent names what it placed: a steer is found where it lands.
    const intent = marks.find((m) => m.name === 'model.request')!;
    const submit = marks.find((m) => m.name === 'submit')!;
    expect(intent.placed).toEqual([submit.id]);
  });

  it('marks can be turned off', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-marks-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness: echoHarness(), marks: false });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const { sessionId } = await sessions.start({ prompt: 'hi' });
    const lines = await until(async () => {
      const l = await readJsonLines(world!, sessionId, liveStreamName(sessionId));
      return l.some((e) => (e as { type?: string }).type === 'idle') ? l : undefined;
    });
    // The harness's own mark call is a no-op too.
    expect(lines.filter(isMark)).toEqual([]);
  });
});

describe('durability off: raw sessions', () => {
  it('drives the same harness with no World and folds the same shape of state', async () => {
    const raw = rawSessions({ harness: echoHarness() });
    const { sessionId } = await raw.start();
    const seen: unknown[] = [];
    raw.subscribe(sessionId, (e) => seen.push(e));
    await raw.send(sessionId, 'hello');
    await raw.idle(sessionId);
    await raw.send(sessionId, 'world');
    await raw.idle(sessionId);
    const state = await raw.inspect(sessionId);
    expect(state.workflowName).toBe(workflowNameFor('echo'));
    expect(state.effectOrder.map((e) => [e.key, e.name, e.status, e.output])).toEqual([
      ['model:0', 'model', 'completed', { args: 'HELLO' }],
      ['tool:model:0', 'tool.echo', 'completed', 'HELLO'],
      ['model:1', 'model', 'completed', { args: 'WORLD' }],
      ['tool:model:1', 'tool.echo', 'completed', 'WORLD'],
    ]);
    expect(state.submissions.map((s) => s.text)).toEqual(['hello', 'world']);
    expect([...state.placed]).toEqual(state.submissions.map((s) => s.id));
    // No acks: nothing is durable. The rest of the marks match a durable drive's.
    expect(seen.filter(isMark).some((m) => m.name === 'ack')).toBe(false);
    const turn = ['submit', 'drive.start', 'intent', 'model.request', 'model.first_token', 'model.done', 'intent', 'tool.start', 'tool.end', 'idle'];
    expect(names(seen)).toEqual([...turn, ...turn]);
    // The synthetic log names what a durable session would have written.
    expect(raw.events(sessionId).map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
      'hook_received',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'hook_received',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
    ]);
    expect(state.eventCount).toBe(13);
  });

  it('a snapshot carries the session into another process, which continues it', async () => {
    const a = rawSessions({ harness: echoHarness() });
    const { sessionId } = await a.start({ prompt: 'one' });
    await a.idle(sessionId);
    const snap = JSON.parse(JSON.stringify(a.snapshot(sessionId)));
    const b = rawSessions({ harness: echoHarness() });
    const id = b.restore(snap);
    expect(id).toBe(sessionId);
    await b.send(id, 'two');
    await b.idle(id);
    const state = await b.inspect(id);
    expect(state.effectOrder.map((e) => e.output)).toEqual([{ args: 'ONE' }, 'ONE', { args: 'TWO' }, 'TWO']);
    expect(state.effectOrder[0]!.startedAt).toBeInstanceOf(Date);
  });

  it('live() replays history, then follows', async () => {
    const raw = rawSessions({ harness: echoHarness() });
    const { sessionId } = await raw.start({ prompt: 'x' });
    await raw.idle(sessionId);
    const abort = new AbortController();
    const got: unknown[] = [];
    const done = (async () => {
      for await (const e of raw.live(sessionId, { signal: abort.signal })) {
        got.push(e);
        if (got.filter((g) => isMark(g) && g.name === 'idle').length === 2) abort.abort();
      }
    })();
    await raw.send(sessionId, 'y');
    await done;
    expect(got.filter((g) => (g as { type?: string }).type === 'text')).toHaveLength(2);
  });

  it('a harness failure fails the raw session', async () => {
    const raw = rawSessions({
      harness: {
        name: 'boom',
        async drive() {
          throw new Error('boom');
        },
      },
    });
    const { sessionId } = await raw.start({ prompt: 'x' });
    await raw.idle(sessionId);
    const state = await raw.inspect(sessionId);
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toBe('boom');
  });
});
