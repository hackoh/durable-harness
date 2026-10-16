import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { describe, expect, it } from 'vitest';
import { durableSessions, type Harness } from './index.ts';

const run = promisify(execFile);
const CHILD = new URL('./testing/fence-process.ts', import.meta.url).pathname;

/**
 * world-local keeps a run's in-band count on disk (`.locks/runs/<runId>.in-band`,
 * from 5.1.1), so the writer fence holds between processes on one data
 * directory, not only between World instances in one process
 * (in-band-fence.test.ts): two servers that each drive the same turn, from the
 * same log, write one turn between them.
 */
describe('in-band fence on world-local, across processes', () => {
  it('two processes race one turn on one data directory: one is refused, the tool runs once, one driver in the log', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-fence-processes-'));
    const barrier = await mkdtemp(join(tmpdir(), 'hw-fence-barrier-'));
    const world = createWorld({ dataDir, recoverActiveRuns: false });
    const idle: Harness = { name: 'turns', async drive() {} };
    // The prompt's own wake is dropped: only the two processes drive it.
    const unqueued = new Proxy(world, { get: (t, k) => (k === 'queue' ? async () => ({ messageId: 'msg_dropped' }) : (t as never)[k]) }) as unknown as World;
    const sessions = durableSessions({ world: unqueued, harness: idle });
    const { sessionId } = await sessions.start({ harness: 'turns' });
    await sessions.send(sessionId, 'go');

    const drive = (name: string) => run(process.execPath, ['--import', 'tsx', CHILD, dataDir, sessionId, name, barrier], { cwd: new URL('..', import.meta.url).pathname });
    const results = (await Promise.all([drive('a'), drive('b')])).map((r) => JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { calls: { model: number; tool: number }; reached: boolean; refused: number });
    expect(results.every((r) => r.reached)).toBe(true);
    expect(results.reduce((n, r) => n + r.refused, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.calls.tool, 0)).toBe(1);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([
      ['model', 'completed'],
      ['tool.slow', 'completed'],
    ]);
    expect(new Set(state.effectOrder.map((e) => e.driver)).size).toBe(1);
    expect(state.superseded.size).toBe(0);
    await world.close?.();
  }, 60_000);
});
