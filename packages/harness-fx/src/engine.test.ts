import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { deliver, durableSessions, QUEUE_PREFIX } from 'harness-world';
import { createFxAgent, createFxEngine } from 'libfx';
import { afterEach, describe, expect, it } from 'vitest';
import { type CreateFxEngine, createEngine, engineFactory, fxHarness } from './index.ts';

// Since vercel-labs/fx#1180, libfx's `createFxAgent` is its durable agent
// factory and `createFxEngine` the engine this adapter drives. Passing the
// first where the second belongs used to run every turn, silently, in a
// session libfx keeps in a World of its own.

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

describe('the engine factory', () => {
  it('is createFxEngine, or createFxAgent under its deprecated name', () => {
    const factory = (async () => ({})) as never as CreateFxEngine;
    expect(engineFactory({ createFxEngine: factory })).toBe(factory);
    expect(engineFactory({ createFxAgent: factory })).toBe(factory);
    expect(() => fxHarness({ apiKey: 'test' } as never)).toThrow(TypeError);
    // The deprecated name still builds a harness.
    expect(fxHarness({ createFxAgent: factory, apiKey: 'test' }).name).toBe('fx');
  });

  it("refuses libfx's durable createFxAgent with a TypeError that says what to pass", async () => {
    const made = createEngine(createFxAgent as never, { apiKey: 'test', model: 'test/model' });
    await expect(made).rejects.toThrow(TypeError);
    await expect(made).rejects.toThrow(/durable agent.*pass libfx's createFxEngine as createFxEngine/);
  });

  it('refuses a factory that does not return a promise, or whose engine looks like a durable agent', async () => {
    await expect(createEngine((() => ({ prompt() {} })) as never, { apiKey: 'k' })).rejects.toThrow(/must return a promise/);
    await expect(createEngine((() => undefined) as never, { apiKey: 'k' })).rejects.toThrow(TypeError);
    await expect(createEngine((async () => ({ prompt() {}, wakeHandler() {} })) as never, { apiKey: 'k' })).rejects.toThrow(/durable agent/);
    await expect(createEngine((async () => ({ prompt() {}, session() {} })) as never, { apiKey: 'k' })).rejects.toThrow(/durable agent/);
  });

  it("takes libfx's createFxEngine", async () => {
    const engine = await createEngine(createFxEngine as never, { apiKey: 'test', model: 'test/model' });
    expect(typeof engine.prompt).toBe('function');
    await engine.close();
  });

  it("fails the delivery with the reason instead of running the turn in libfx's own session", async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fx-engine-')), recoverActiveRuns: false });
    worlds.push(world);
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    let requests = 0;
    const gateway = async () => {
      requests += 1;
      throw new Error('no model request may be made');
    };
    const harness = fxHarness({ createFxEngine: createFxAgent as never, apiKey: 'test', model: 'test/model', fetch: gateway as never });
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({ prompt: 'hi' });
    // The queue would redeliver it; each delivery fails the same way, and no turn runs anywhere.
    await expect(deliver({ world, harness }, sessionId)).rejects.toThrow(/durable agent.*pass libfx's createFxEngine/);
    expect(requests).toBe(0);
    const state = await sessions.inspect(sessionId);
    expect(state.status).toBe('running');
    expect(state.effectOrder.filter((e) => e.name === 'model')).toEqual([]);
  });
});
