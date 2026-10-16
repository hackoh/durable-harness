import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRunStreams, durableSessions, EffectFailure, effectStreamName, Fatal, JsonLinesWriter, kernelStreamNames, liveStreamName, QUEUE_PREFIX, readJsonLines } from './index.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * Streams end when there is nothing more to write to them: an effect's
 * progress stream when its step settles, every stream of a session when the
 * session closes or fails. A reader that tails one (`workflow inspect
 * stream`, a UI's live tail) then stops instead of waiting forever.
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function local() {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-close-')), recoverActiveRuns: false });
  worlds.push(world);
  return world;
}

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** One tool step per prompt, reporting progress; `fail` makes it throw. */
function progressHarness(fail = false): Harness {
  return {
    name: 'progress',
    async drive(ctx: DriveContext) {
      for (const [i, s] of ctx.state().submissions.entries()) {
        try {
          await ctx.effect(`tool:${i}`, { name: 'tool.work', replay: 'safe', input: s.text, placed: [s.id] }, async (io) => {
            io.progress({ working: s.text });
            if (fail) throw new Error('no');
            return 'done';
          });
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
        ctx.live({ type: 'turn_end', i });
      }
    },
  };
}

const done = async (world: LocalWorld, runId: string, name: string) => (await world.streams.getInfo(runId, name)).done;

describe('closing streams', () => {
  it("ends an effect's progress stream when its step completes, and when it fails", async () => {
    for (const fail of [false, true]) {
      const world = await local();
      const sessions = durableSessions({ world, harness: progressHarness(fail) });
      world.registerHandler(QUEUE_PREFIX, sessions.handler);
      const { sessionId } = await sessions.start({ prompt: 'go' });
      const step = await until(async () => (await sessions.inspect(sessionId)).effectOrder.find((e) => e.status === (fail ? 'failed' : 'completed')));
      const name = effectStreamName(sessionId, step.stepId);
      await until(() => done(world, sessionId, name));
      // The session itself goes on: its live stream is still open.
      expect(await done(world, sessionId, liveStreamName(sessionId))).toBe(false);
    }
  });

  it('ends every stream of a session when it closes', async () => {
    const world = await local();
    const sessions = durableSessions({ world, harness: progressHarness() });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'go' });
    // Idle: the drive's last live line has landed.
    await until(async () => (await readJsonLines(world, sessionId, liveStreamName(sessionId))).some((e) => (e as { type?: string })?.type === 'turn_end'));
    await sessions.close(sessionId);
    // Every listed stream, and the live stream whether or not the World listed it (world-local can drop a name).
    const names = new Set([...(await world.streams.list(sessionId)), liveStreamName(sessionId)]);
    for (const name of names) expect(await done(world, sessionId, name)).toBe(true);
  });

  it("closes the kernel's streams by name even when the World's listing lost one", async () => {
    const world = await local();
    const runId = 'wrun_close_unlisted';
    const live = new JsonLinesWriter(world, runId, liveStreamName(runId));
    live.write({ type: 'x' });
    await live.flush();
    // As if world-local's read-modify-write of the run's stream list had lost the name.
    const list = world.streams.list.bind(world.streams);
    world.streams.list = (async (id: string) => (await list(id)).filter((n) => n !== liveStreamName(runId))) as typeof world.streams.list;
    await closeRunStreams(world, runId, kernelStreamNames(runId));
    expect(await done(world, runId, liveStreamName(runId))).toBe(true);
    // A known stream that holds nothing is not created by closing it.
    expect((await world.streams.getInfo(runId, `${runId}_hints`)).tailIndex).toBe(-1);
  });

  it('ends every stream of a session that fails', async () => {
    const world = await local();
    const harness: Harness = {
      name: 'fatal',
      async drive(ctx) {
        ctx.live({ type: 'about to fail' });
        throw new Fatal('cannot continue');
      },
    };
    const sessions = durableSessions({ world, harness });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'go' });
    await until(async () => (await sessions.inspect(sessionId)).status === 'failed');
    await until(async () => {
      const names = await world.streams.list(sessionId);
      return names.length > 0 && (await Promise.all(names.map((n) => done(world, sessionId, n)))).every(Boolean);
    });
  });

  it('a writer that wrote nothing closes nothing, and writes nothing once closed', async () => {
    const world = await local();
    const runId = 'wrun_close_writer';
    await new JsonLinesWriter(world, runId, `${runId}_empty`).close();
    expect(await world.streams.list(runId)).toEqual([]);
    const w = new JsonLinesWriter(world, runId, `${runId}_one`);
    w.write({ n: 1 });
    await w.close();
    w.write({ n: 2 });
    await w.flush();
    expect(await world.streams.list(runId)).toEqual([`${runId}_one`]);
    expect(await world.streams.getInfo(runId, `${runId}_one`)).toMatchObject({ tailIndex: 0, done: true });
  });
});
