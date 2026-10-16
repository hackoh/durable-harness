import { IDBFactory } from 'fake-indexeddb';
import { durableSessions, EffectFailure } from 'harness-world';
import type { DriveContext, Harness } from 'harness-world';
import { eventIdToSlot } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import { type BrowserWorld, createWorld } from './index.ts';

// fake-indexeddb needs IDBKeyRange globally, as a browser has it.
import 'fake-indexeddb/auto';

function echoHarness(onTool: () => Promise<void> = async () => {}): Harness {
  return {
    name: 'echo',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      const last = ctx.state().effectOrder.findLast((e) => e.name === 'model');
      if (last && !ctx.isMemoized(`tool:${last.key}`)) await runTurn(ctx, last.key, [], String(last.input));
      for (const s of ctx.pending()) await runTurn(ctx, `model:${turn++}`, [s.id], s.text ?? '');
    },
  };
  async function runTurn(ctx: DriveContext, key: string, placed: string[], text: string) {
    const decision = await ctx.effect(key, { name: 'model', replay: 'safe', input: text, placed }, async () => text.toUpperCase());
    try {
      await ctx.effect(`tool:${key}`, { name: 'tool.echo', replay: 'never', input: decision }, async (io) => {
        io.progress({ started: decision });
        await onTool();
        return decision;
      });
    } catch (err) {
      if (!(err instanceof EffectFailure)) throw err;
    }
    ctx.live({ type: 'turn_end', key });
  }
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const worlds: BrowserWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function open(factory: IDBFactory) {
  const world = await createWorld({ indexedDB: factory, name: 'test' });
  worlds.push(world);
  return world;
}

describe('world-browser', () => {
  it('allocates dense slots and reports what a stale writer missed', async () => {
    const world = await open(new IDBFactory());
    const runId = 'wrun_01TEST';
    await world.events.create(runId, { eventType: 'run_created', eventData: { deploymentId: 'browser', workflowName: 'w', input: new Uint8Array() } } as never);
    await world.events.create(runId, { eventType: 'run_started' } as never, { eventCount: 1 });
    const writes: any[] = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        world.events.create(runId, { eventType: 'step_started', correlationId: `step_${i}`, eventData: { stepName: 's', input: new Uint8Array([i]) } } as never, { eventCount: 2 })
      )
    );
    const slots = writes.map((w) => eventIdToSlot(w.event!.eventId)).sort((a: any, b: any) => a - b);
    expect(slots).toEqual([4, 6, 8, 10]); // each lazy start also commits a step_created
    const reported = writes.map((w: any) => w.events?.length ?? 0).sort();
    expect(reported).toEqual([0, 2, 4, 6]);
    const list = await world.events.list({ runId, pagination: { sortOrder: 'asc' } } as never);
    expect(list.data.map((e) => eventIdToSlot(e.eventId))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('runs a session end to end', async () => {
    const world = await open(new IDBFactory());
    const sessions = durableSessions({ world, harness: echoHarness(), contendedDelaySeconds: 1 });
    await world.start?.();
    const { sessionId } = await sessions.start({ prompt: 'hello' });
    await sessions.send(sessionId, 'world');
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.filter((e) => e.status === 'completed').length === 4 ? s : undefined;
    });
    expect(state.effectOrder.map((e) => e.output)).toEqual(['HELLO', 'HELLO', 'WORLD', 'WORLD']);
    const live = [];
    for await (const e of sessions.live(sessionId)) {
      // Timing marks (harness-world marks.ts) share the stream.
      if ((e as { type?: string }).type === 'mark') continue;
      live.push(e);
      if (live.length === 2) break;
    }
    expect(live).toEqual([{ type: 'turn_end', key: 'model:0' }, { type: 'turn_end', key: 'model:1' }]);
  });

  it('redelivers a message left behind by a closed tab', async () => {
    const factory = new IDBFactory();
    const tabA = await open(factory);
    const a = durableSessions({ world: tabA, harness: echoHarness(() => new Promise(() => {})) });
    await tabA.start?.();
    const { sessionId } = await a.start({ prompt: 'hello' });
    await until(async () => ((await a.inspect(sessionId)).effects.get('tool:model:0')?.status === 'running' ? true : undefined));
    await tabA.close(); // the tab goes away mid-tool

    const tabB = await open(factory);
    const b = durableSessions({ world: tabB, harness: echoHarness() });
    await tabB.start?.();
    const tool = await until(async () => {
      const t = (await b.inspect(sessionId)).effects.get('tool:model:0');
      return t?.status === 'failed' ? t : undefined;
    });
    expect(tool.error).toMatchObject({ interrupted: true, partial: [{ started: 'HELLO' }] });
  });
});
