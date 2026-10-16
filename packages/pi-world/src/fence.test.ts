import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CreateEventParams, Event, World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageFenced, worldStorage } from './index.ts';
import { JournalReader } from './reader.ts';
import { SessionSandbox } from './sandbox-record.ts';
import { journalToken } from './storage.ts';

/**
 * Pi variant A's journal on the World's in-band writer fence: a commit is the
 * owner's progress, so it is in-band at the count the World gave with the
 * replay; a commit decided from a stale replay is refused by the World and
 * never lands. The close entry is out-of-band. A World without the fence is
 * never sent it, and the `after` chain decides there, as before.
 */

const ctx = BACKGROUND_CONTEXT;

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function newWorld(): Promise<LocalWorld> {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'pi-world-fence-')), recoverActiveRuns: false });
  worlds.push(world);
  return world;
}

/**
 * `base`, recording every event write's params; `fence: false` hides the
 * capability and the snapshot (a World without the fence), `'no-snapshot'`
 * only the snapshot (a World that fences but lists no counters: world-vercel).
 */
function recorded(base: World, fence: boolean | 'no-snapshot' = true) {
  const creates: Array<{ eventType: string; params?: CreateEventParams }> = [];
  const events = new Proxy(base.events, {
    get(t, key) {
      const v = (t as unknown as Record<string | symbol, unknown>)[key];
      if (key === 'create') {
        return (runId: string, data: { eventType: string }, params?: CreateEventParams) => {
          creates.push({ eventType: data.eventType, ...(params ? { params } : {}) });
          return (v as (...a: unknown[]) => unknown).call(t, runId, data, params);
        };
      }
      if (key === 'list' && fence !== true) {
        return async (...args: unknown[]) => {
          const { snapshot: _s, ...page } = (await (v as (...a: unknown[]) => Promise<Record<string, unknown>>).apply(t, args)) as Record<string, unknown>;
          return page;
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const world = new Proxy(base, {
    get(t, key) {
      if (key === 'events') return events;
      if (key === 'capabilities' && fence === false) {
        const { inBandFence: _f, ...rest } = (t.capabilities ?? {}) as Record<string, unknown>;
        return rest;
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as World;
  return { world, creates };
}

async function journal(world: World, sessionId: string): Promise<Event[]> {
  const page = await world.events.list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' });
  return page.data.filter((e) => e.eventType === 'hook_received' && (e.eventData as { token?: string }).token === journalToken(sessionId));
}

describe('pi-world on the in-band writer fence', () => {
  it('a commit from a stale replay is refused by the World (StorageFenced) and never lands; the owner keeps committing', async () => {
    const { world, creates } = recorded(await newWorld());
    const sessionId = await worldStorage.create(world);
    const owner = await worldStorage(world, sessionId);
    const stale = await worldStorage(world, sessionId);
    await owner.commit([], ctx);
    await expect(stale.commit([], ctx)).rejects.toBeInstanceOf(StorageFenced);
    // Every later commit of the stale storage is refused too, unsent.
    const sent = creates.length;
    await expect(stale.commit([], ctx)).rejects.toBeInstanceOf(StorageFenced);
    expect(creates.length).toBe(sent);
    await owner.commit([], ctx);
    expect(await journal(world, sessionId)).toHaveLength(2);
    // Commits are in-band; run creation is not.
    const journalWrites = creates.filter((c) => c.eventType === 'hook_received');
    expect(journalWrites.every((c) => c.params?.inBand === true)).toBe(true);
    expect(creates.filter((c) => c.eventType !== 'hook_received').every((c) => c.params?.inBand === undefined)).toBe(true);
    // A reopened storage replays both commits, and its count is the World's.
    const reopened = await worldStorage(world, sessionId);
    await reopened.commit([], ctx);
    expect(await journal(world, sessionId)).toHaveLength(3);
    await reopened.close(ctx);
    await owner.close(ctx).catch(() => {});
  });

  it('on a World that fences but lists no snapshot (world-vercel), a storage reads its count from a probe the fence refuses: a stale commit is refused and never lands, and the probe writes nothing', async () => {
    const base = await newWorld();
    const { world, creates } = recorded(base, 'no-snapshot');
    const sessionId = await worldStorage.create(world);
    const owner = await worldStorage(world, sessionId);
    const stale = await worldStorage(world, sessionId);
    await owner.commit([], ctx);
    await expect(stale.commit([], ctx)).rejects.toBeInstanceOf(StorageFenced);
    await owner.commit([], ctx);
    expect(await journal(base, sessionId)).toHaveLength(2);
    const probes = creates.filter((c) => c.eventType === 'attr_set');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((c) => c.params?.inBand === true && c.params.expectedSeqInBand === Number.MAX_SAFE_INTEGER)).toBe(true);
    const all = await base.events.list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 } });
    expect(all.data.some((e) => e.eventType === 'attr_set')).toBe(false);
    expect(creates.filter((c) => c.eventType === 'hook_received').every((c) => c.params?.inBand === true)).toBe(true);
    await owner.close(ctx);
  });

  it('without the fence (a World that does not declare it) the stale commit lands, and the `after` chain makes it count for nobody', async () => {
    const { world, creates } = recorded(await newWorld(), false);
    const sessionId = await worldStorage.create(world);
    const owner = await worldStorage(world, sessionId);
    const stale = await worldStorage(world, sessionId);
    await owner.commit([], ctx);
    await expect(stale.commit([], ctx)).rejects.toBeInstanceOf(StorageFenced);
    expect(await journal(world, sessionId)).toHaveLength(2);
    expect(creates.every((c) => c.params?.inBand === undefined && c.params?.expectedSeqInBand === undefined)).toBe(true);
    await owner.commit([], ctx);
    await owner.close(ctx);
  });
});

describe("a storage's fencing token and the session's sandbox record (the sandbox tier, docs/workspaces.md §4.1, P0.12)", () => {
  it("the token is the count the storage's first accepted in-band write was checked against: the same for the rest of it, higher for the next owner; refused, it is no longer fenced and the storage's signal aborts", async () => {
    const { world } = recorded(await newWorld());
    const sessionId = await worldStorage.create(world);
    const a = await worldStorage(world, sessionId);
    // Not an owner before its first accepted write.
    expect(a.writerFence).toBeUndefined();
    await a.claim();
    const fa = a.writerFence!;
    expect(fa).toEqual({ count: expect.any(Number), fenced: true });
    await a.commit([], ctx);
    await a.writeSandbox({ driveId: 'drv_1' });
    await a.claim();
    expect(a.writerFence).toEqual(fa);
    // The next owner: its first accepted write comes after every write of A, at a higher count.
    const b = await worldStorage(world, sessionId);
    expect(b.sandbox.record).toEqual({ driveId: 'drv_1' });
    await b.commit([], ctx);
    expect(b.writerFence!.count).toBeGreaterThan(fa.count);
    expect(b.writerFence!.fenced).toBe(true);
    // A doesn't know until it writes: then the World refuses it.
    expect(a.writerFence!.fenced).toBe(true);
    expect(a.signal.aborted).toBe(false);
    await expect(a.writeSandbox({ driveId: 'drv_stale' })).rejects.toBeInstanceOf(StorageFenced);
    expect(a.writerFence).toEqual({ count: fa.count, fenced: false });
    expect(a.signal.aborted).toBe(true);
    await expect(a.commit([], ctx)).rejects.toBeInstanceOf(StorageFenced);
    // B's token stays fenced until B lets go.
    await b.close(ctx);
    expect(b.writerFence!.fenced).toBe(false);
    expect(b.signal.aborted).toBe(true);
    await a.close(ctx).catch(() => {});
  });

  it('a sandbox record is an in-band entry of the journal, replayed by the next storage and never a commit: the commits around it count, the reader lists it as the record', async () => {
    const { world, creates } = recorded(await newWorld());
    const sessionId = await worldStorage.create(world);
    const a = await worldStorage(world, sessionId);
    await a.commit([], ctx);
    await a.writeSandbox({ driveId: 'drv_1', vmSeconds: 60 });
    await a.commit([], ctx);
    await a.writeSandbox({ driveId: 'drv_1', vmSeconds: 120 });
    await a.close(ctx);
    const records = creates.filter((c) => c.eventType === 'hook_received');
    expect(records.every((c) => c.params?.inBand === true)).toBe(true);
    const reopened = await worldStorage(world, sessionId);
    expect(reopened.sandbox.record).toEqual({ driveId: 'drv_1', vmSeconds: 120 });
    // Both commits counted (the records between them don't break the chain), and the reopened storage commits on top.
    await reopened.commit([], ctx);
    const reader = new JournalReader(world, sessionId);
    await reader.refresh();
    const log = (await reader.snapshot()).log;
    expect(log.map((c) => (c.valid ? 'commit' : c.summary[0]))).toEqual(['commit', 'sandbox record', 'commit', 'sandbox record', 'commit']);
    await reopened.close(ctx);
  });

  it('without the fence the storage has no token, and a sandbox record is kept in memory only (never written out of band)', async () => {
    const { world, creates } = recorded(await newWorld(), false);
    const sessionId = await worldStorage.create(world);
    const a = await worldStorage(world, sessionId);
    await a.commit([], ctx);
    await a.claim();
    expect(a.writerFence).toBeUndefined();
    const before = creates.length;
    await a.writeSandbox({ driveId: 'drv_1' });
    expect(creates.length).toBe(before);
    expect(a.sandbox.record).toEqual({ driveId: 'drv_1' });
    await a.close(ctx);
  });

  it("a committed tool result that names the Drive the model was told about acknowledges the record's files-lost note, and only that Drive's", () => {
    const sandbox = new SessionSandbox();
    sandbox.set({ driveId: 'drv_2', filesLost: 'drv_2' });
    const result = (told: string) => [{ type: 'entry', value: { kind: 'pi.tool-result', model: [{ details: { 'hw.sandbox': { told } } }] } }] as never;
    sandbox.fold(result('drv_1'));
    expect(sandbox.record).toEqual({ driveId: 'drv_2', filesLost: 'drv_2' });
    sandbox.fold(result('drv_2'));
    expect(sandbox.record).toEqual({ driveId: 'drv_2' });
  });
});
