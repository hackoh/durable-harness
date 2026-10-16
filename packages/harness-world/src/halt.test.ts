import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, QUEUE_PREFIX, Restart, Yield } from './index.ts';
import { rawSessions } from './raw.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * `ctx.halt`: a harness callback whose in-band write failed outside any
 * effect the drive awaits (a session store's append, a background journal
 * flush) stops the drive. The drive's signal aborts with the reason, later
 * effects throw it without writing, and the driver handles the reason as the
 * drive's outcome even when the harness throws something else on its way out.
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function setup(harness: Harness) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-halt-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness });
  const { sessionId } = await sessions.start();
  await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
  return { world, sessions, sessionId };
}

/** A harness that commits one effect, halts from a "callback", then tries another. */
function halting(reason: () => unknown, seen: { signal?: unknown; second?: unknown; attempts: number[] }): Harness {
  return {
    name: 'halting',
    async drive(ctx: DriveContext) {
      seen.attempts.push(ctx.attempt);
      // Every prompt, placed or not: a restarted drive replays the first effect.
      for (const s of ctx.state().submissions.filter((x) => x.kind === 'prompt')) {
        await ctx.effect(`first:${s.id}`, { name: 'tool.first', replay: 'safe', input: null, placed: [s.id] }, async () => 'ok');
        if (ctx.attempt === 0) {
          // The callback: the adapter's own runtime would swallow this error.
          setTimeout(() => ctx.halt?.(reason()), 0);
          await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
          seen.signal = ctx.signal.reason;
          try {
            await ctx.effect(`second:${s.id}`, { name: 'tool.second', replay: 'safe', input: null }, async () => 'ran');
          } catch (err) {
            seen.second = err;
          }
          // What a process harness throws once its child is killed.
          throw new Error('child exited with SIGKILL');
        }
        await ctx.effect(`second:${s.id}`, { name: 'tool.second', replay: 'safe', input: null }, async () => 'ran');
      }
    },
  };
}

describe('ctx.halt', () => {
  it('a raw error ends the delivery with that error, and nothing more is written', async () => {
    const seen: { signal?: unknown; second?: unknown; attempts: number[] } = { attempts: [] };
    const refused = new Error('append refused');
    const { sessions, sessionId } = await setup(halting(() => refused, seen));
    await expect(sessions.drive(sessionId)).rejects.toBe(refused);
    expect(seen.signal).toBe(refused);
    expect(seen.second).toBe(refused);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([['tool.first', 'completed']]);
  });

  it('a Restart rebuilds the drive from the log', async () => {
    const seen: { signal?: unknown; second?: unknown; attempts: number[] } = { attempts: [] };
    const { sessions, sessionId } = await setup(halting(() => new Restart('the journal fell behind'), seen));
    await sessions.drive(sessionId);
    expect(seen.attempts).toEqual([0, 1]);
    expect(seen.second).toBeInstanceOf(Restart);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([
      ['tool.first', 'completed'],
      ['tool.second', 'completed'],
    ]);
  });

  it('a preemption stops the drive quietly', async () => {
    const seen: { signal?: unknown; second?: unknown; attempts: number[] } = { attempts: [] };
    const { sessions, sessionId } = await setup(halting(() => new Yield('preempted'), seen));
    await expect(sessions.drive(sessionId)).resolves.toBeUndefined();
    expect(seen.signal).toBeInstanceOf(Yield);
    expect((seen.signal as Yield).reason).toBe('preempted');
    expect(seen.attempts).toEqual([0]);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => e.name)).toEqual(['tool.first']);
  });

  it('works in raw sessions too', async () => {
    const seen: { signal?: unknown; second?: unknown; attempts: number[] } = { attempts: [] };
    const raw = rawSessions({ harness: halting(() => new Restart('again'), seen) });
    const { sessionId } = await raw.start({});
    await raw.send(sessionId, 'go');
    await raw.idle(sessionId);
    expect(seen.attempts).toEqual([0, 1]);
    expect((await raw.inspect(sessionId)).effectOrder.map((e) => [e.name, e.status])).toEqual([
      ['tool.first', 'completed'],
      ['tool.second', 'completed'],
    ]);
  });
});
