import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidQueueName } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, QUEUE_PREFIX, ROUTE_PASS } from './index.ts';
import type { Harness } from './types.ts';

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

async function until(fn: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('durableSessions route', () => {
  it('hands messages the route takes to it, and drives the rest', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'harness-route-')), recoverActiveRuns: false });
    const drives: string[] = [];
    const harness: Harness = {
      name: 'echo',
      async drive(ctx) {
        drives.push(ctx.runId);
        for (const s of ctx.pending()) await ctx.effect(`m:${s.id}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => 'ok');
      },
    };
    const routed: { runId: string; attempt: number }[] = [];
    const sessions = durableSessions({
      world,
      harness,
      route: (message, meta) => {
        const m = message as { runId: string; input?: { kind?: string } };
        if (m.input === undefined) return Promise.resolve(ROUTE_PASS);
        if (m.input?.kind !== 'pi-wake') return undefined;
        return (async () => {
          routed.push({ runId: m.runId, attempt: meta.attempt });
        })();
      },
    });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();

    await world.queue(`${QUEUE_PREFIX}pi` as ValidQueueName, { runId: 'wrun_other', input: { kind: 'pi-wake' } } as never, { idempotencyKey: 'k1' });
    await until(() => routed.length === 1);
    expect(routed[0]).toMatchObject({ runId: 'wrun_other', attempt: 1 });

    const { sessionId } = await sessions.start({ prompt: 'hello' });
    await until(() => drives.includes(sessionId));
    expect(routed).toHaveLength(1);
    // A route that needs a read to decide can hand a message back.
    const before = drives.length;
    await world.queue(`${QUEUE_PREFIX}x` as ValidQueueName, { runId: sessionId } as never, { idempotencyKey: 'k2' });
    await until(() => drives.length > before);
    expect(routed).toHaveLength(1);
  });
});
