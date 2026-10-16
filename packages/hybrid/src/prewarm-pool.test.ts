import { describe, expect, it } from 'vitest';
import { createPoolSlot, type PoolWarmResult } from './prewarm-pool.ts';

function harness(results: PoolWarmResult[] = ['ok']) {
  let t = 0;
  let n = 0;
  const warmed: string[] = [];
  const kept: string[] = [];
  const timers: (() => void)[] = [];
  let keepStatus: string | undefined = 'running';
  const pending: ((r: PoolWarmResult) => void)[] = [];
  const slot = createPoolSlot({
    enabled: true,
    warm: (key) => {
      warmed.push(key);
      const r = results.shift() ?? 'ok';
      return r === 'error' ? Promise.reject(new Error('boom')) : new Promise<PoolWarmResult>((res) => pending.push(() => res(r)));
    },
    keepalive: async (key) => {
      kept.push(key);
      return keepStatus;
    },
    now: () => t,
    newKey: () => `pool-key${String(++n).padStart(5, '0')}`,
    schedule: (fn) => void timers.push(fn),
  });
  const settle = async () => {
    while (pending.length) pending.shift()!('ok' as never);
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    slot,
    warmed,
    kept,
    timers,
    settle,
    advance: (ms: number) => void (t += ms),
    setKeepStatus: (s: string | undefined) => void (keepStatus = s),
  };
}

describe('a tab’s pool VM', () => {
  it('warms one VM, hands it to one session, then tops up later', async () => {
    const h = harness();
    h.slot.prime();
    h.slot.prime();
    expect(h.warmed).toEqual(['pool-key00001']);
    await h.settle();
    const take = h.slot.take()!;
    expect(take).toMatchObject({ key: 'pool-key00001', ready: true });
    expect(await take.warm).toBe(true);
    // One VM goes to one session: nothing left until the top-up runs.
    expect(h.slot.take()).toBeUndefined();
    expect(h.warmed).toHaveLength(1);
    h.timers.shift()!();
    expect(h.warmed).toEqual(['pool-key00001', 'pool-key00002']);
  });

  it('hands out a VM still booting (the attach joins its boot)', async () => {
    const h = harness();
    h.slot.prime();
    const take = h.slot.take()!;
    expect(take.ready).toBe(false);
    await h.settle();
    expect(await take.warm).toBe(true);
  });

  it('over the team cap there is no pool VM, and it asks again only after a while', async () => {
    const h = harness(['cap']);
    h.slot.prime();
    await h.settle();
    expect(h.slot.take()).toBeUndefined();
    h.slot.prime();
    expect(h.warmed).toHaveLength(1);
    h.advance(61_000);
    h.slot.prime();
    expect(h.warmed).toHaveLength(2);
  });

  it('turns itself off on a deployment without hosts', async () => {
    const h = harness(['off']);
    h.slot.prime();
    await h.settle();
    expect(h.slot.enabled()).toBe(false);
    h.slot.prime();
    h.slot.touch();
    expect(h.warmed).toHaveLength(1);
  });

  it('a failed warm leaves the slot empty, and the next focus tries again', async () => {
    const h = harness(['error']);
    h.slot.prime();
    await h.settle();
    expect(h.slot.take()).toBeUndefined();
    h.slot.touch();
    expect(h.warmed).toHaveLength(2);
  });

  it('composer focus keeps the VM alive at most every few minutes, and replaces one that stopped', async () => {
    const h = harness();
    h.slot.prime();
    await h.settle();
    h.slot.touch();
    expect(h.kept).toHaveLength(0); // just warmed
    h.advance(4 * 60_000);
    h.slot.touch();
    h.slot.touch();
    expect(h.kept).toEqual(['pool-key00001']);
    h.advance(4 * 60_000);
    h.setKeepStatus('stopped');
    h.slot.touch();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.warmed).toEqual(['pool-key00001', 'pool-key00002']);
    expect(h.slot.unused()).toEqual(['pool-key00001', 'pool-key00002']);
  });

  it('lists only the keys no session took, for the pagehide release', async () => {
    const h = harness();
    h.slot.prime();
    await h.settle();
    h.slot.take();
    h.timers.shift()!();
    expect(h.slot.unused()).toEqual(['pool-key00002']);
  });
});
