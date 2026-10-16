import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, QUEUE_PREFIX } from './index.ts';
import type { DriveContext, Harness } from './types.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

/** Harnesses refresh first thing in a drive (Pi does): time that refresh, then answer. */
function timing(out: { refreshMs: number[]; ran: string[] }): Harness {
  return {
    name: 'h',
    async drive(ctx: DriveContext) {
      const t0 = Date.now();
      await ctx.refresh();
      out.refreshMs.push(Date.now() - t0);
      for (const s of ctx.pending()) {
        await ctx.effect(`model:${s.id}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => {
          out.ran.push(s.text ?? '');
          return 'ok';
        });
      }
    },
  };
}

async function setup(runAhead: boolean, writeDelayMs: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hw-ra-refresh-'));
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  const create = world.events.create.bind(world.events);
  world.events.create = (async (runId: string, req: any, params?: any) => {
    if (req.eventType === 'hook_received') await new Promise((r) => setTimeout(r, writeDelayMs));
    return create(runId, req, params);
  }) as typeof world.events.create;
  const out = { refreshMs: [] as number[], ran: [] as string[] };
  const sessions = durableSessions({ world, harness: timing(out), runAhead });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  return { sessions, out };
}

describe('run-ahead: the drive does not wait on its own submit', () => {
  it("skips the first refresh behind the submit's in-flight write on the log the submit handed over", async () => {
    const { sessions, out } = await setup(true, 300);
    const { sessionId } = await sessions.start({});
    await sessions.send(sessionId, 'hi', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(out.ran).toEqual(['hi']);
    expect(out.refreshMs[0]).toBeLessThan(150);
  });

  it('without run-ahead the refresh reads the durable log as before', async () => {
    const { sessions, out } = await setup(false, 0);
    const { sessionId } = await sessions.start({});
    await sessions.send(sessionId, 'hi', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(out.ran).toEqual(['hi']);
  });
});
