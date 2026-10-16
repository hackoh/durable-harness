import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import { emptyState, fold, type StepEnvelope } from './fold.ts';
import { currentLane } from './lanes.ts';
import { stepNameFor } from './names.ts';

/** Build a log by hand: one event per call, slots in order. */
function log() {
  const events: Event[] = [];
  const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 0, 0, n));
  const push = (e: Record<string, unknown>) =>
    events.push({ runId: 'wrun_x', eventId: `evnt_${events.length + 1}`, createdAt: at(events.length), ...e } as unknown as Event);
  const b = {
    events,
    created(stepId: string, name: string, env: StepEnvelope) {
      push({ eventType: 'step_created', correlationId: stepId, eventData: { stepName: stepNameFor(name), input: encode(env) } });
      return b;
    },
    started(stepId: string) {
      push({ eventType: 'step_started', correlationId: stepId, eventData: {} });
      return b;
    },
    completed(stepId: string, result: unknown) {
      push({ eventType: 'step_completed', correlationId: stepId, eventData: { result: encode(result) } });
      return b;
    },
    failed(stepId: string, error: unknown) {
      push({ eventType: 'step_failed', correlationId: stepId, eventData: { error: encode(error) } });
      return b;
    },
    retrying(stepId: string) {
      push({ eventType: 'step_retrying', correlationId: stepId, eventData: { error: encode({ message: 'x' }) } });
      return b;
    },
    /** A born-running step, as the kernel writes one. */
    run(stepId: string, name: string, env: StepEnvelope) {
      return b.created(stepId, name, env).started(stepId);
    },
  };
  return b;
}

const handoff = (from: string, to: string) => ({ from, to, reason: 'test' });

describe('fold', () => {
  it('fences a step written with a stale epoch, and a handoff moves the epoch at its intent', () => {
    const l = log()
      .run('s1', 'model', { key: 'model:0', replay: 'safe', input: 'a', epoch: 0 })
      .completed('s1', 'ok')
      // A takeover: its intent alone moves the session.
      .run('h0', 'handoff', { key: 'handoff:0', replay: 'safe', input: handoff('browser', 'function'), epoch: 0 })
      // The old lane, which had not seen it, writes an intent: fenced.
      .run('s2', 'model', { key: 'model:1', replay: 'safe', input: 'b', epoch: 0 })
      .completed('s2', 'stale')
      // The new owner writes the same key: accepted.
      .run('s3', 'model', { key: 'model:1', replay: 'safe', input: 'b', epoch: 1 });
    const seen: [string, boolean][] = [];
    const state = fold(emptyState('wrun_x'), l.events, (e, ok) => seen.push([`${e.eventType}:${(e as { correlationId?: string }).correlationId}`, ok]));
    expect(state.epoch).toBe(1);
    expect(currentLane(state)).toBe('function');
    expect(state.fenced).toEqual(new Set(['s2']));
    expect(state.effects.get('model:1')?.stepId).toBe('s3');
    expect(state.effects.get('model:1')?.status).toBe('running');
    expect(seen.filter(([, ok]) => !ok).map(([e]) => e)).toEqual([
      'step_created:s2',
      'step_started:s2',
      'step_completed:s2',
    ]);
  });

  it('keeps the first outcome of a running record; later ones are inert', () => {
    const l = log()
      .run('t1', 'tool.bash', { key: 'tool:1', replay: 'never', input: {}, epoch: 0 })
      // A recovery's interrupted result lands first...
      .failed('t1', { message: 'interrupted', interrupted: true })
      // ...then the slow driver's real result.
      .completed('t1', 'real');
    const state = fold(emptyState('wrun_x'), l.events);
    expect(state.effects.get('tool:1')).toMatchObject({ status: 'failed', error: { interrupted: true } });

    const other = log()
      .run('t1', 'tool.bash', { key: 'tool:1', replay: 'never', input: {}, epoch: 0 })
      .completed('t1', 'real')
      .failed('t1', { message: 'interrupted', interrupted: true });
    expect(fold(emptyState('wrun_x'), other.events).effects.get('tool:1')).toMatchObject({ status: 'completed', output: 'real' });
  });

  it('accepts a retry as a new step only when it names the released record, in the same epoch', () => {
    const l = log()
      .run('m1', 'model', { key: 'model:0', replay: 'safe', input: 'a', epoch: 0 })
      .retrying('m1')
      // Names a step that is not the record: ignored.
      .run('m2', 'model', { key: 'model:0', replay: 'safe', input: 'a', epoch: 0, retryOf: 'nope' })
      // The real retry replaces the record in place.
      .run('m3', 'model', { key: 'model:0', replay: 'safe', input: 'a', epoch: 0, retryOf: 'm1' })
      // A late result for the released step is inert.
      .completed('m1', 'late')
      .completed('m3', 'fresh');
    const state = fold(emptyState('wrun_x'), l.events);
    expect(state.effectOrder.map((e) => e.stepId)).toEqual(['m3']);
    expect(state.effects.get('model:0')).toMatchObject({ stepId: 'm3', status: 'completed', output: 'fresh', attempt: 2, retryOf: 'm1' });
    expect(state.superseded).toEqual(new Set(['m2', 'm1']));
  });

  it('folds a legacy log (no epochs, in-place retries, completed-only handoffs) as before', () => {
    const l = log()
      .created('m1', 'model', { key: 'model:0', replay: 'safe', input: 'a' })
      .started('m1')
      .retrying('m1')
      .started('m1')
      .completed('m1', 'ok')
      .run('h', 'handoff', { key: 'handoff:0', replay: 'safe', input: handoff('browser', 'sandbox') })
      .completed('h', handoff('browser', 'sandbox'))
      .run('t', 'tool.sandbox_exec', { key: 'tool:1', replay: 'never', input: {} });
    const state = fold(emptyState('wrun_x'), l.events);
    expect(state.effects.get('model:0')).toMatchObject({ status: 'completed', attempt: 2 });
    expect(state.epoch).toBe(1);
    expect(state.fenced.size).toBe(0);
    expect(currentLane(state)).toBe('sandbox');
    expect(state.effects.get('tool:1')?.status).toBe('running');
  });

  it('puts the session in the lane a half-written handoff names', () => {
    const l = log().run('h', 'handoff', { key: 'handoff:0', replay: 'safe', input: handoff('browser', 'function'), epoch: 0 });
    const state = fold(emptyState('wrun_x'), l.events);
    expect(currentLane(state)).toBe('function');
    expect(state.effects.get('handoff:0')?.status).toBe('running');
  });
});

describe('fold: facts about other steps', () => {
  const owner = { kind: 'sandbox', cmdId: 'cmd_1' };
  const settle = (forStepId: string, extra: Record<string, unknown> = {}) => ({
    ok: true,
    by: 'push',
    at: 0,
    value: 'done',
    files: { '/workspace/a.txt': 'a' },
    forKey: 'tool:1',
    forStepId,
    ...extra,
  });

  it('a park and a settle take effect at their intent; the settle carries the result and files', () => {
    const l = log()
      .run('t1', 'tool.sandbox_exec', { key: 'tool:1', replay: 'never', input: {}, epoch: 0, drv: 'drv_a' })
      .run('p1', 'park', { key: 'park:t1', replay: 'safe', input: { forKey: 'tool:1', forStepId: 't1', owner }, epoch: 0 })
      .run('s1', 'settle', { key: 'settle:t1', replay: 'safe', input: settle('t1'), epoch: 0 });
    const state = fold(emptyState('wrun_x'), l.events);
    const tool = state.effects.get('tool:1')!;
    expect(tool).toMatchObject({ status: 'running', driver: 'drv_a', park: owner, settlement: { ok: true, by: 'push', value: 'done' } });
    expect(state.effectOrder.map((e) => e.name)).toEqual(['tool.sandbox_exec', 'park', 'settle']);
  });

  it('a settle for an unparked, settled or finished step is inert, and so is a second park', () => {
    const l = log()
      .run('t1', 'tool.sandbox_exec', { key: 'tool:1', replay: 'never', input: {}, epoch: 0 })
      // Not parked yet: inert.
      .run('s0', 'settle', { key: 'settle:t1', replay: 'safe', input: settle('t1'), epoch: 0 })
      .run('p1', 'park', { key: 'park:t1', replay: 'safe', input: { forKey: 'tool:1', forStepId: 't1', owner }, epoch: 0 })
      .run('p2', 'park', { key: 'park:t1b', replay: 'safe', input: { forKey: 'tool:1', forStepId: 't1', owner: { kind: 'other' } }, epoch: 0 })
      .run('s1', 'settle', { key: 'settle:t1', replay: 'safe', input: settle('t1', { by: 'check' }), epoch: 0 })
      // Already settled: a second settle (another key) is inert.
      .run('s2', 'settle', { key: 'settle:t1:again', replay: 'safe', input: settle('t1', { by: 'backstop', value: 'other' }), epoch: 0 })
      .completed('t1', 'done')
      .run('s3', 'settle', { key: 'settle:t1:late', replay: 'safe', input: settle('t1'), epoch: 0 });
    const state = fold(emptyState('wrun_x'), l.events);
    const tool = state.effects.get('tool:1')!;
    expect(tool.park).toEqual(owner);
    expect(tool.settlement).toMatchObject({ by: 'check', value: 'done' });
    expect([...state.superseded].sort()).toEqual(['p2', 's0', 's2', 's3']);
  });

  it('a v2 chaos step is effective only while its target is running and unsettled; an inert one leaves the crash armed', () => {
    const l = log();
    l.events.push({
      runId: 'wrun_x',
      eventId: 'evnt_0',
      createdAt: new Date(0),
      eventType: 'hook_created',
      correlationId: 'hook_1',
      eventData: { token: 'harness:wrun_x:inbox' },
    } as unknown as Event);
    l.events.push({
      runId: 'wrun_x',
      eventId: 'evnt_00',
      createdAt: new Date(0),
      eventType: 'hook_received',
      correlationId: 'hook_1',
      eventData: { payload: encode({ kind: 'chaos', chaos: { at: 'any' } }) },
    } as unknown as Event);
    const chaos = (stepId: string) => ({ v: 2, kind: 'process', crashedDuring: 'model:0', stepId, effect: 'model', afterMs: 1500, driver: 'drv_a' });
    l.run('m1', 'model', { key: 'model:0', replay: 'safe', input: 'a', epoch: 0, drv: 'drv_a' })
      .completed('m1', 'ok')
      // Decided after the model finished in log order (the production race): inert.
      .run('c1', 'chaos', { key: 'chaos:evnt_00', replay: 'safe', placed: ['evnt_00'], input: chaos('m1'), epoch: 0 })
      .run('k1', 'checkpoint', { key: 'checkpoint:0', replay: 'safe', input: {}, epoch: 0, drv: 'drv_a' })
      .run('c2', 'chaos', { key: 'chaos:evnt_00', replay: 'safe', placed: ['evnt_00'], input: { ...chaos('k1'), crashedDuring: 'checkpoint:0' }, epoch: 0 });
    const state = fold(emptyState('wrun_x'), l.events.slice(0, 7));
    expect(state.superseded.has('c1')).toBe(true);
    expect(state.placed.has('evnt_00')).toBe(false);
    fold(state, l.events.slice(7));
    expect(state.effects.get('chaos:evnt_00')?.stepId).toBe('c2');
    expect(state.placed.has('evnt_00')).toBe(true);
  });
});

