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

/** A World whose replies to step writes can be held: the write commits, the answer does not come back. */
async function setup() {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-slow-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness: { name: 'noop', drive: async () => {} } });
  const { sessionId } = await sessions.start();
  const log = new SessionLog(world, sessionId);
  log.slowWriteProbeMs = 40;
  await log.refresh();
  const ctl = { hold: false, holdBefore: false, release: [] as (() => void)[] };
  const create = world.events.create.bind(world.events);
  world.events.create = (async (runId: string, req: any, params?: any) => {
    if (ctl.holdBefore) await new Promise<void>((r) => ctl.release.push(r));
    const r = await create(runId, req, params);
    if (ctl.hold) await new Promise<void>((res) => ctl.release.push(res));
    return r;
  }) as typeof world.events.create;
  return { world, sessionId, log, ctl };
}

let n = 0;
const intent = (key: string) => {
  const stepId = `step_s${n++}_${key.replace(/\W/g, '')}`;
  const envelope: StepEnvelope = { key, replay: 'safe', input: key, epoch: 0, drv: 'drv_test' };
  return {
    stepId,
    req: { eventType: 'step_started', correlationId: stepId, eventData: { stepName: stepNameFor('model'), input: encode(envelope) } } as CreateEventRequest,
  };
};
const outcome = (stepId: string, value: unknown) =>
  ({ eventType: 'step_completed', correlationId: stepId, eventData: { stepName: stepNameFor('model'), result: encode(value) } }) as CreateEventRequest;

describe('slow step writes', () => {
  it('a write that committed but whose reply hangs resolves from the log', async () => {
    const { world, sessionId, log, ctl } = await setup();
    const a = intent('model:a');
    await log.write(a.req);
    ctl.hold = true;
    const t0 = Date.now();
    const w = await log.write(outcome(a.stepId, 'done'));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(w.event?.eventType).toBe('step_completed');
    expect(w.foreign).toEqual([]);
    expect(log.state.effects.get('model:a')?.status).toBe('completed');
    // The view is the log's.
    const all = await world.events.list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' });
    const ref = emptyState(sessionId);
    fold(ref, all.data);
    expect(ref.eventCount).toBe(log.state.eventCount);
    // The next write is on our slot (no hole, no stale count).
    ctl.hold = false;
    const b = intent('model:b');
    await log.write(b.req);
    expect(log.state.effects.get('model:b')?.status).toBe('running');
    for (const r of ctl.release.splice(0)) r();
  });

  it('a born-running intent whose reply hangs resolves with its step_created', async () => {
    const { log, ctl } = await setup();
    ctl.hold = true;
    const a = intent('model:x');
    const before = log.state.eventCount;
    await log.write(a.req);
    expect(log.state.eventCount).toBe(before + 2);
    expect(log.state.effects.get('model:x')?.status).toBe('running');
    for (const r of ctl.release.splice(0)) r();
  });

  it('a write that has not committed keeps waiting for its reply', async () => {
    const { log, ctl } = await setup();
    const a = intent('model:y');
    await log.write(a.req);
    ctl.holdBefore = true;
    let done = false;
    const p = log.write(outcome(a.stepId, 'y')).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    ctl.holdBefore = false;
    for (const r of ctl.release.splice(0)) r();
    await p;
    expect(log.state.effects.get('model:y')?.status).toBe('completed');
  });
});
