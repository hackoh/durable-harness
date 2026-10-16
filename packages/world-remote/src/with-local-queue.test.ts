import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { describe, expect, it } from 'vitest';
import { createLocalQueue, withLocalQueue } from './index.ts';

describe('withLocalQueue', () => {
  it('keeps storage and streams on the base World and sends queue messages to the local queue', async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'wlq-')), recoverActiveRuns: false });
    const local = createLocalQueue();
    const world = withLocalQueue(base, local);
    const got: unknown[] = [];
    local.createQueueHandler('__wkf_workflow_', async (payload) => {
      got.push(payload);
    });
    await world.queue('__wkf_workflow_x', { runId: 'wrun_1' } as never);
    await local.idle();
    expect(got).toEqual([{ runId: 'wrun_1' }]);
    // Storage is the base's.
    expect(world.events).toBe(base.events);
    expect(await world.getDeploymentId()).toBe(await base.getDeploymentId());
    await world.close?.();
  });
});
