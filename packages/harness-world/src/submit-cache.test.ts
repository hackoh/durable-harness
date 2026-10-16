import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions } from './index.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

describe('submit', () => {
  it("reads only what was appended since this process's last submit to the session", async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-subcache-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({ world, harness: { name: 'noop', drive: async () => {} } });
    const { sessionId } = await sessions.start();
    const reads: { cursor: boolean; n: number }[] = [];
    const list = world.events.list.bind(world.events);
    world.events.list = (async (p: any) => {
      const r = await list(p);
      if (p.runId === sessionId) reads.push({ cursor: !!p.pagination?.cursor, n: r.data.length });
      return r;
    }) as typeof world.events.list;
    const waits: Promise<unknown>[] = [];
    const opts = { wake: 'backstop' as const, waitUntil: (w: Promise<unknown>) => void waits.push(w) };
    await sessions.send(sessionId, 'one', 'prompt', opts);
    const first = reads.splice(0);
    expect(first[0]?.cursor).toBe(false);
    await sessions.send(sessionId, 'two', 'prompt', opts);
    const second = reads.splice(0);
    // From the cursor: none of the events the first submit already read.
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((r) => r.cursor)).toBe(true);
    expect(second.reduce((a, r) => a + r.n, 0)).toBeLessThan(first.reduce((a, r) => a + r.n, 0) + 1);
    await Promise.allSettled(waits);
    // Both submissions are in the log, once each.
    const all = await list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' });
    expect(all.data.filter((e) => e.eventType === 'hook_received')).toHaveLength(2);
  });
});
