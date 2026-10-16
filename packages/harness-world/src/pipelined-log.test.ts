import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest, Event } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import { emptyState, fold, type StepEnvelope } from './fold.ts';
import { durableSessions } from './index.ts';
import { stepNameFor } from './names.ts';
import { PipelinedLog, Rejection, stepKnown } from './pipelined-log.ts';
import { SessionLog } from './session-log.ts';
import type { SessionState } from './types.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function setup() {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-pipe-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness: { name: 'noop', drive: async () => {} } });
  const { sessionId } = await sessions.start();
  const log = new SessionLog(world, sessionId);
  await log.refresh();
  const creates: string[] = [];
  const create = world.events.create.bind(world.events);
  let fault: ((req: CreateEventRequest, go: () => Promise<unknown>) => Promise<unknown>) | undefined;
  world.events.create = (async (runId: string, req: any, params?: any) => {
    creates.push(req.eventType);
    const f = fault;
    if (f) {
      fault = undefined;
      return f(req, () => create(runId, req, params));
    }
    return create(runId, req, params);
  }) as typeof world.events.create;
  return { world, sessionId, log, creates, setFault: (f: typeof fault) => (fault = f) };
}

let n = 0;
const intent = (key: string, extra: Partial<StepEnvelope> = {}) => {
  const stepId = `step_t${n++}_${key.replace(/\W/g, '')}`;
  const envelope: StepEnvelope = { key, replay: 'safe', input: key, epoch: 0, drv: 'drv_test', ...extra };
  const req: CreateEventRequest = {
    eventType: 'step_started',
    correlationId: stepId,
    eventData: { stepName: stepNameFor('model'), input: encode(envelope) },
  } as CreateEventRequest;
  return { stepId, req };
};
const outcome = (stepId: string, value: unknown): CreateEventRequest =>
  ({ eventType: 'step_completed', correlationId: stepId, eventData: { stepName: stepNameFor('model'), result: encode(value) } }) as CreateEventRequest;
const won = (key: string, stepId: string) => (s: SessionState) => (s.effects.get(key)?.stepId === stepId ? undefined : ('first-writer' as const));

describe('PipelinedLog', () => {
  it('runs ahead: the speculative fold has every write at once; durability trails in order', async () => {
    const { log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    pipe.enqueue(a.req, { check: won('model:0', a.stepId) });
    pipe.enqueue(outcome(a.stepId, 'hello'));
    const b = intent('model:1');
    pipe.enqueue(b.req, { check: won('model:1', b.stepId) });
    // Nothing acked yet, everything visible.
    expect(pipe.speculative.effects.get('model:0')?.status).toBe('completed');
    expect(pipe.speculative.effects.get('model:1')?.status).toBe('running');
    expect(log.state.effects.get('model:1')).toBeUndefined();
    expect(pipe.lag.pending).toBe(3);
    await pipe.drain();
    expect(log.state.effects.get('model:0')?.output).toBe('hello');
    expect(log.state.effects.get('model:1')?.status).toBe('running');
    expect(pipe.lag.pending).toBe(0);
    expect(pipe.lag.durableSlot).toBe(pipe.lag.specSlot);
  });

  it('a head write jumps queued writes but never its own intent', async () => {
    const { log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    const b = intent('model:1');
    pipe.enqueue(a.req, { check: won('model:0', a.stepId) });
    pipe.enqueue(b.req, { check: won('model:1', b.stepId) });
    const c = intent('tool:0');
    pipe.enqueue(c.req, { check: won('tool:0', c.stepId) });
    // The outcome of `b` goes ahead of `c`, behind `b` itself.
    pipe.enqueue(outcome(b.stepId, 'x'), { head: true });
    expect(pipe.speculative.effects.get('model:1')?.status).toBe('completed');
    await pipe.drain();
    expect(log.state.effects.get('model:1')?.status).toBe('completed');
    const order = log.state.effectOrder.map((r) => r.key);
    expect(order).toEqual(['model:0', 'model:1', 'tool:0']);
  });

  it('rejects an intent that lost first-writer-wins and drops what was issued after it unsent', async () => {
    const { world, sessionId, log, creates } = await setup();
    const other = new SessionLog(world, sessionId);
    await other.refresh();
    const theirs = intent('model:0', { drv: 'drv_other' });
    await other.write(theirs.req);
    const pipe = new PipelinedLog(log);
    const rejected: Rejection[] = [];
    pipe.onRejected((r) => rejected.push(r));
    const a = intent('model:0');
    const pa = pipe.enqueue(a.req, { check: won('model:0', a.stepId) });
    const b = intent('model:1');
    const pb = pipe.enqueue(b.req, { check: won('model:1', b.stepId) });
    const before = creates.length;
    await expect(pa).rejects.toMatchObject({ reason: 'first-writer' });
    await expect(pb).rejects.toBeInstanceOf(Rejection);
    await expect(pipe.drain()).rejects.toBeInstanceOf(Rejection);
    expect(rejected.map((r) => r.reason)).toEqual(['first-writer']);
    // Only `a` went out; `b` never did.
    expect(creates.length - before).toBe(1);
    await log.refresh();
    expect(log.state.effects.get('model:1')).toBeUndefined();
    // The speculative state is the durable fold again.
    expect(pipe.speculative.effects.get('model:0')?.stepId).toBe(theirs.stepId);
    // A failed pipeline refuses new views until reset.
    await expect(pipe.enqueue(intent('model:2').req)).rejects.toBeInstanceOf(Rejection);
    pipe.reset();
    await pipe.enqueue(intent('model:2').req);
  });

  it('still writes survivors after a rejection', async () => {
    const { world, sessionId, log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('tool:a');
    await pipe.enqueue(a.req, { check: won('tool:a', a.stepId) });
    const other = new SessionLog(world, sessionId);
    await other.refresh();
    await other.write(intent('model:9', { drv: 'drv_other' }).req);
    const b = intent('model:9');
    const pb = pipe.enqueue(b.req, { check: won('model:9', b.stepId) });
    const pa = pipe.enqueue(outcome(a.stepId, 'done'), { survives: (s) => s.effects.get('tool:a')?.status === 'running' });
    await expect(pb).rejects.toMatchObject({ reason: 'first-writer' });
    await pa;
    expect(log.state.effects.get('tool:a')?.status).toBe('completed');
  });

  it('a write that committed before its response was lost is not resent', async () => {
    const { log, creates, setFault } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    setFault(async (_req, go) => {
      await go();
      throw new Error('socket dropped after send');
    });
    const before = creates.length;
    await pipe.enqueue(a.req, { check: won('model:0', a.stepId), landed: (s) => stepKnown(s, a.stepId) });
    expect(creates.length - before).toBe(1);
    expect(log.state.effects.get('model:0')?.stepId).toBe(a.stepId);
  });

  it('a write that did not land is resent once it is known absent', async () => {
    const { log, creates, setFault } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    setFault(async () => {
      throw new Error('connection reset');
    });
    const before = creates.length;
    await pipe.enqueue(a.req, { check: won('model:0', a.stepId), landed: (s) => stepKnown(s, a.stepId) });
    expect(creates.length - before).toBe(2);
    expect(log.state.effects.get('model:0')?.stepId).toBe(a.stepId);
    expect(log.state.effectOrder.filter((r) => r.key === 'model:0')).toHaveLength(1);
  });

  it('never blind-resends a write it cannot look up', async () => {
    const { log, creates, setFault } = await setup();
    const pipe = new PipelinedLog(log);
    setFault(async () => {
      throw new Error('timeout');
    });
    const before = creates.length;
    await expect(pipe.enqueue(intent('model:0').req)).rejects.toMatchObject({ reason: 'transport' });
    expect(creates.length - before).toBe(1);
  });

  it('a fenced log (a crash under way) rejects as chaos', async () => {
    const { log } = await setup();
    const pipe = new PipelinedLog(log);
    log.fence('chaos');
    await expect(pipe.enqueue(intent('model:0').req)).rejects.toMatchObject({ reason: 'chaos' });
  });

  it('a submission with a cid is placed by its cid and its resend is inert', async () => {
    const { log } = await setup();
    const pipe = new PipelinedLog(log);
    const inbox = log.state.inbox!;
    const sub = (cid: string): CreateEventRequest =>
      ({ eventType: 'hook_received', correlationId: inbox.hookId, eventData: { token: inbox.token, payload: encode({ kind: 'prompt', text: 'hi', cid, nonce: cid }) } }) as CreateEventRequest;
    pipe.enqueue(sub('sub_1'));
    expect(pipe.speculative.submissions.map((s) => s.id)).toEqual(['sub_1']);
    const a = intent('model:0', { placed: ['sub_1'] });
    pipe.enqueue(a.req, { check: won('model:0', a.stepId) });
    pipe.enqueue(sub('sub_1'));
    await pipe.drain();
    expect(log.state.submissions.map((s) => s.id)).toEqual(['sub_1']);
    expect(log.state.placed.has('sub_1')).toBe(true);
  });
});

describe('PipelinedLog persistence (writes the harness already acted on)', () => {
  /** Fail every create until `ms` from the first one. */
  const blip = (world: LocalWorld, ms: number) => {
    const create = world.events.create.bind(world.events);
    let until = 0;
    world.events.create = (async (runId: string, req: any, params?: any) => {
      if (until === 0) until = Date.now() + ms;
      if (Date.now() < until) throw new Error('fetch failed (blip)');
      return create(runId, req, params);
    }) as typeof world.events.create;
  };

  it('persistMs keeps resending past maxResends, by lookup, until the write lands', async () => {
    const { world, log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    blip(world, 700);
    await pipe.enqueue(a.req, { check: won('model:0', a.stepId), landed: (s) => stepKnown(s, a.stepId), persistMs: 3000 });
    expect(log.state.effects.get('model:0')?.stepId).toBe(a.stepId);
    expect(log.state.effectOrder.filter((r) => r.key === 'model:0')).toHaveLength(1);
  });

  it('without persistMs the same blip rejects the write as transport', async () => {
    const { world, log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    blip(world, 700);
    const err = await pipe.enqueue(a.req, { landed: (s) => stepKnown(s, a.stepId) }).catch((e) => e);
    expect(err).toBeInstanceOf(Rejection);
    expect((err as Rejection).reason).toBe('transport');
    expect(pipe.takeOrphans()).toHaveLength(0);
  });

  it('a reissue write still lost after its window is kept for the restart to re-issue', async () => {
    const { world, log } = await setup();
    const pipe = new PipelinedLog(log);
    const a = intent('model:0');
    blip(world, 1000);
    const err = await pipe.enqueue(a.req, { landed: (s) => stepKnown(s, a.stepId), persistMs: 100, reissue: true }).catch((e) => e);
    expect((err as Rejection).reason).toBe('transport');
    const orphans = pipe.takeOrphans();
    expect(orphans.map((o) => o.req.correlationId)).toEqual([a.stepId]);
    expect(pipe.takeOrphans()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1000));
    pipe.reset();
    await pipe.enqueue(orphans[0]!.req, { ...orphans[0]!.opts, reissue: false });
    expect(log.state.effects.get('model:0')?.stepId).toBe(a.stepId);
  });

  it('enterFn: a never effect in fn holds liveness; a safe one does not', async () => {
    const { log } = await setup();
    const pipe = new PipelinedLog(log);
    const safe = pipe.enterFn('step_safe', false);
    expect(pipe.liveHeld).toBe(0);
    expect(pipe.inFn('step_safe')).toBe(true);
    const never = pipe.enterFn('step_never', true);
    expect(pipe.liveHeld).toBe(1);
    never();
    never();
    safe();
    expect(pipe.liveHeld).toBe(0);
    expect(pipe.inFn('step_never')).toBe(false);
  });
});

describe('chain fence (fold)', () => {
  const ev = (eventType: string, correlationId: string, eventData: unknown, i: number) =>
    ({ eventType, correlationId, eventData, eventId: `evnt_${i}`, runId: 'r', createdAt: new Date() }) as unknown as Event;
  const created = (stepId: string, env: StepEnvelope, i: number) => ev('step_created', stepId, { stepName: stepNameFor('model'), input: encode(env) }, i);

  it('once an intent of a chain is ineffective, every later intent of that chain is inert', () => {
    const s = emptyState('r');
    fold(s, [
      created('s_theirs', { key: 'model:1', replay: 'safe', input: 0, epoch: 0 }, 1),
      // Chain C: seq 1 lands, seq 2 loses first-writer, seq 3 would claim the next key.
      created('s_c1', { key: 'tool:a', replay: 'safe', input: 0, epoch: 0, chain: 'C', seq: 1 }, 2),
      created('s_c2', { key: 'model:1', replay: 'safe', input: 0, epoch: 0, chain: 'C', seq: 2 }, 3),
      created('s_c3', { key: 'model:2', replay: 'safe', input: 0, epoch: 0, chain: 'C', seq: 3 }, 4),
      // A fresh chain (the restart) is not fenced.
      created('s_d1', { key: 'model:2', replay: 'safe', input: 0, epoch: 0, chain: 'D', seq: 1 }, 5),
      // An exempt write (no seq) from chain C still applies.
      created('s_c4', { key: 'tool:b', replay: 'safe', input: 0, epoch: 0, chain: 'C' }, 6),
    ]);
    expect(s.effects.get('tool:a')?.stepId).toBe('s_c1');
    expect(s.effects.get('model:1')?.stepId).toBe('s_theirs');
    expect(s.effects.get('model:2')?.stepId).toBe('s_d1');
    expect(s.superseded.has('s_c3')).toBe(true);
    expect(s.effects.get('tool:b')?.stepId).toBe('s_c4');
    expect(s.fencedChains.has('C')).toBe(true);
  });

  it('old logs without chains fold unchanged', () => {
    const s = emptyState('r');
    fold(s, [
      created('a', { key: 'k', replay: 'safe', input: 0, epoch: 0 }, 1),
      created('b', { key: 'k', replay: 'safe', input: 0, epoch: 0 }, 2),
      created('c', { key: 'k2', replay: 'safe', input: 0, epoch: 0 }, 3),
    ]);
    expect(s.effects.get('k2')?.stepId).toBe('c');
    expect(s.fencedChains.size).toBe(0);
  });
});
