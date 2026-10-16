import { describe, expect, it } from 'vitest';
import { sandboxNameFor } from 'harness-world-hybrid';
import { createPrewarmPolicy, isPoolKey, newPoolKey, poolVmName } from './prewarm.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('pre-warming policy', () => {
  it('admits pool VMs up to the team cap, counting its own admissions on top of a cached count', async () => {
    const c = clock();
    let calls = 0;
    const policy = createPrewarmPolicy({ cap: 3, countWarm: async () => (calls++, 1), now: c.now });
    expect((await policy.admit()).ok).toBe(true); // 1 warm + this one
    expect((await policy.admit()).ok).toBe(true); // 3
    const third = await policy.admit();
    expect(third).toMatchObject({ ok: false, warm: 3, cap: 3 });
    expect(calls).toBe(1);
    // A fresh count replaces this instance's tally (the VMs it admitted are in it now, or gone).
    c.advance(16_000);
    expect((await policy.admit()).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('degrades to admitting when the count fails (the cap bounds cost; it must not take the lane down)', async () => {
    const policy = createPrewarmPolicy({ cap: 1, countWarm: async () => Promise.reject(new Error('list failed')) });
    expect(await policy.admit()).toMatchObject({ ok: true, uncounted: true });
    expect(await policy.admit()).toMatchObject({ ok: true, uncounted: true });
  });

  it('shares one in-flight count between concurrent admissions', async () => {
    let calls = 0;
    let release!: (n: number) => void;
    const policy = createPrewarmPolicy({
      cap: 2,
      countWarm: () => {
        calls++;
        return new Promise<number>((r) => (release = r));
      },
    });
    const all = Promise.all([policy.admit(), policy.admit(), policy.admit()]);
    release(0);
    const results = await all;
    expect(calls).toBe(1);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });

  it('keeps a VM alive at most once per interval, and retries after a failure', () => {
    const c = clock();
    const policy = createPrewarmPolicy({ countWarm: async () => 0, keepaliveEveryMs: 300_000, now: c.now });
    expect(policy.keepaliveDue('vm-a')).toBe(true);
    expect(policy.keepaliveDue('vm-a')).toBe(false);
    expect(policy.keepaliveDue('vm-b')).toBe(true);
    c.advance(299_000);
    expect(policy.keepaliveDue('vm-a')).toBe(false);
    c.advance(1_000);
    expect(policy.keepaliveDue('vm-a')).toBe(true);
    policy.keepaliveFailed('vm-a');
    expect(policy.keepaliveDue('vm-a')).toBe(true);
  });

  it('hands a pool key to one session only', () => {
    const policy = createPrewarmPolicy({ countWarm: async () => 0 });
    expect(policy.claim('pool-abc12345', 'wrun_A')).toBe(true);
    expect(policy.claim('pool-abc12345', 'wrun_A')).toBe(true);
    expect(policy.claim('pool-abc12345', 'wrun_B')).toBe(false);
    expect(policy.claimedBy('pool-abc12345')).toBe('wrun_A');
  });

  it('recognises only tab-minted pool keys (the release route deletes nothing else)', () => {
    const key = newPoolKey();
    expect(isPoolKey(key)).toBe(true);
    expect(key.length).toBeLessThanOrEqual(5 + 24);
    // The VM a pool key boots is the one the Sandbox provider opens for it.
    expect(poolVmName(key)).toBe(sandboxNameFor(key));
    for (const bad of ['wrun_01ABC', 'pool-', 'pool-SHORT', 'hybrid-wrun-01abc', 'pool-abc/../x', 42, undefined]) {
      expect(isPoolKey(bad)).toBe(false);
    }
  });
});
