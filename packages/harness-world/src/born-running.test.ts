import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import { emptyState, fold, type StepEnvelope } from './fold.ts';
import { durableSessions } from './index.ts';
import { stepNameFor } from './names.ts';
import { SessionLog } from './session-log.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function setup() {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-born-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness: { name: 'noop', drive: async () => {} } });
  const { sessionId } = await sessions.start();
  const log = new SessionLog(world, sessionId);
  await log.refresh();
  // world-vercel never reports skipped slots on step_started; world-local
  // does. Drop the
  // report so this is the production shape.
  const create = world.events.create.bind(world.events);
  world.events.create = (async (runId: string, req: any, params?: any) => {
    const r = (await create(runId, req, params)) as Record<string, unknown>;
    if (req.eventType !== 'step_started') return r;
    const { events: _e, cursor: _c, hasMore: _h, ...rest } = r;
    return rest;
  }) as typeof world.events.create;
  const lists = { n: 0 };
  const list = world.events.list.bind(world.events);
  world.events.list = ((p: any) => {
    lists.n++;
    return list(p);
  }) as typeof world.events.list;
  return { world, sessionId, log, lists };
}

let n = 0;
const intent = (key: string) => {
  const stepId = `step_b${n++}_${key.replace(/\W/g, '')}`;
  const envelope: StepEnvelope = { key, replay: 'safe', input: key, epoch: 0, drv: 'drv_test' };
  const req = {
    eventType: 'step_started',
    correlationId: stepId,
    eventData: { stepName: stepNameFor('model'), input: encode(envelope) },
  } as CreateEventRequest;
  return { stepId, req };
};

describe('born-running intents', () => {
  it('fold the synthetic step_created without re-reading the log', async () => {
    const { world, sessionId, log, lists } = await setup();
    const before = log.state.eventCount;
    const a = intent('model:a');
    const w = await log.write(a.req);
    expect(w.foreign).toEqual([]);
    expect(lists.n).toBe(0);
    expect(log.state.eventCount).toBe(before + 2);
    expect(log.state.effects.get('model:a')?.status).toBe('running');
    // The fold is exactly what a reader of the whole log folds.
    const all = await world.events.list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' });
    const ref = emptyState(sessionId);
    fold(ref, all.data);
    expect(ref.eventCount).toBe(log.state.eventCount);
    expect(ref.effects.get('model:a')?.stepId).toBe(a.stepId);
    expect(ref.effects.get('model:a')?.status).toBe('running');
    // A following write lands on the slot we expect (no hole in our view).
    const b = intent('model:b');
    const lb = lists.n;
    await log.write(b.req);
    expect(lists.n).toBe(lb);
    expect(log.state.eventCount).toBe(before + 4);
  });

  it('still re-reads when a foreign write landed in between', async () => {
    const { world, sessionId, log, lists } = await setup();
    // Another writer appends behind our back.
    const other = new SessionLog(world, sessionId);
    await other.refresh();
    const x = intent('model:x');
    await other.write(x.req);
    const y = intent('model:y');
    const w = await log.write(y.req);
    expect(lists.n).toBeGreaterThan(0);
    expect(w.foreign.map((e) => e.correlationId)).toContain(x.stepId);
    expect(log.state.effects.get('model:x')?.stepId).toBe(x.stepId);
    expect(log.state.effects.get('model:y')?.stepId).toBe(y.stepId);
    expect(log.state.eventCount).toBe(other.state.eventCount + 2);
  });
});
