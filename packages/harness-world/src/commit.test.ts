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

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * One `replay: 'never'` tool behind a model that, like an LLM, calls the
 * tool again when the first call comes back as an error.
 */
function sendHarness(counter: { runs: number; errors: string[] }): Harness {
  return {
    name: 'send',
    async drive(ctx: DriveContext) {
      for (const s of ctx.pending()) {
        for (let i = 0; i < 2; i++) {
          await ctx.effect(`model:${i}`, { name: 'model', replay: 'safe', input: i, placed: i === 0 ? [s.id] : [] }, async () => 'call send');
          try {
            await ctx.effect(`tool:${i}`, { name: 'tool.send', replay: 'never', input: s.text }, async () => {
              counter.runs++;
              return 'sent';
            });
            return;
          } catch (err) {
            if ((err as Error)?.name === 'Yield' || (err as Error)?.name === 'Restart') throw err;
            counter.errors.push((err as Error).message);
          }
        }
      }
    },
  };
}

async function setup(fault: (create: () => Promise<unknown>) => Promise<unknown>) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-commit-')), recoverActiveRuns: false });
  worlds.push(world);
  let armed = true;
  const create = world.events.create.bind(world.events);
  world.events.create = (async (runId: string, req: any, params?: any) => {
    if (armed && req.eventType === 'step_completed' && JSON.stringify(req).includes('tool.send')) {
      armed = false;
      return fault(() => create(runId, req, params));
    }
    return create(runId, req, params);
  }) as typeof world.events.create;
  const counter = { runs: 0, errors: [] as string[] };
  const sessions = durableSessions({ world, harness: sendHarness(counter), log: (m, f) => process.env.DBG && console.log('LOG', m, JSON.stringify(f)) });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  return { sessions, counter };
}

describe('outcome writes that throw', () => {
  it('treats an outcome that committed before the response was lost as committed', async () => {
    const { sessions, counter } = await setup(async (create) => {
      await create();
      throw new Error('socket dropped after send');
    });
    const { sessionId } = await sessions.start({ prompt: 'email bob' });
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effects.get('tool:0')?.status === 'completed' ? s : undefined;
    });
    expect(counter.runs).toBe(1);
    expect(counter.errors).toEqual([]);
    expect(state.effects.has('tool:1')).toBe(false);
  });

  it('retries an outcome that did not land instead of losing it', async () => {
    const { sessions, counter } = await setup(async () => {
      throw new Error('connection reset');
    });
    const { sessionId } = await sessions.start({ prompt: 'email bob' });
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effects.get('tool:0')?.status === 'completed' ? s : undefined;
    });
    expect(state.effects.get('tool:0')?.output).toBe('sent');
    expect(counter.runs).toBe(1);
    expect(counter.errors).toEqual([]);
  });
});
