import type { World } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  type Anchor,
  anchorVerdict,
  browserAnchors,
  claimDrive,
  deliveryAnchors,
  exclusiveAnchors,
  localAnchors,
  type ProcessIdentity,
  processGone,
  processIdentity,
  releaseDrive,
  tabAnchors,
  vercelAnchors,
} from './anchor.ts';
import { emptyState } from './fold.ts';
import type { EffectRecord, SessionState } from './types.ts';

const world = {} as World;

function record(over: Partial<EffectRecord> = {}): EffectRecord {
  return { key: 'k', stepId: 'step_1', name: 'tool.x', replay: 'safe', input: null, status: 'running', attempt: 1, placed: [], startedEpoch: 0, driver: 'drv_1', ...over };
}

function state(over: Partial<SessionState> = {}): SessionState {
  return { ...emptyState('wrun_v'), status: 'running', ...over };
}

const own: Anchor = { k: 'msg', m: 'msg_own' };

describe('anchorVerdict: the rules every World shares', () => {
  it('its own message redelivered, or a continuation that hands it over: mine, fenced', async () => {
    const c = { world, policy: deliveryAnchors(), own, state: state() };
    expect(await anchorVerdict(c, record({ anchor: own }))).toMatchObject({ v: 'mine', fence: true });
    expect(await anchorVerdict({ ...c, continues: 'msg:msg_x' }, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'mine' });
  });

  it("any other message's anchor: covered (its holder takes it, or its message comes back)", async () => {
    expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: state() }, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'covered' });
  });

  it('a drive that closed: gone, with no fence (it writes nothing more)', async () => {
    const s = state({ closed: new Set(['drv_1']) });
    expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: s }, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'gone', fence: false });
  });

  it('the epoch moved past it by another writer: gone; by its own drive (an escalation): not by that alone', async () => {
    const mover = (driver: string): EffectRecord => record({ key: 'handoff:0', stepId: 'step_h', name: 'handoff', status: 'completed', startedEpoch: 0, driver });
    const other = state({ epoch: 1, effectOrder: [mover('drv_other')] });
    expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: other }, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'gone', fence: false });
    const self = state({ epoch: 1, effectOrder: [mover('drv_1')] });
    expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: self }, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'covered' });
  });

  it("past a direct drive's deadline: gone, fenced (a write of it may still land)", async () => {
    const c = { world, policy: vercelAnchors(), own, state: state(), now: 10_000 };
    expect(await anchorVerdict(c, record({ anchor: { k: 'deadline', m: 'direct_1', at: 9_000 } }))).toMatchObject({ v: 'gone', fence: true });
    expect(await anchorVerdict(c, record({ anchor: { k: 'deadline', m: 'direct_1', at: 11_000 } }))).toMatchObject({ v: 'covered' });
  });

  it('a drive running in this process: covered, whatever its anchor', async () => {
    const claim = claimDrive(world, 'wrun_v', { drv: 'drv_1', anchor: own })!;
    try {
      expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: state() }, record({ anchor: own }))).toMatchObject({ v: 'covered' });
    } finally {
      releaseDrive(world, 'wrun_v', claim);
    }
  });

  it('written before anchors: gone where only the process could hold it, covered on Vercel (its pinned message comes back to the build that wrote it)', async () => {
    expect(await anchorVerdict({ world, policy: localAnchors(), own, state: state() }, record())).toMatchObject({ v: 'gone' });
    expect(await anchorVerdict({ world, policy: vercelAnchors(), own, state: state() }, record())).toMatchObject({ v: 'covered' });
  });
});

describe('localAnchors (world-local, world-postgres on one host)', () => {
  const me: ProcessIdentity = { pid: 100, boot: 'boot_me', host: 'h1', start: 1 };
  const policy = (gone: (p: ProcessIdentity) => boolean) => localAnchors({ self: () => me, gone });
  const anchor = (p: Partial<ProcessIdentity>): Anchor => ({ k: 'msg', m: 'msg_x', proc: { ...me, ...p } });

  it('a dead or reused pid on this host is gone; a live one is covered', async () => {
    const c = (gone: boolean) => ({ world, policy: policy(() => gone), own, state: state() });
    expect(await anchorVerdict(c(true), record({ anchor: anchor({ pid: 7, boot: 'boot_dead' }) }))).toMatchObject({ v: 'gone', fence: true });
    expect(await anchorVerdict(c(false), record({ anchor: anchor({ pid: 7, boot: 'boot_live' }) }))).toMatchObject({ v: 'covered' });
  });

  it('this very process, its drive not running: gone (the delivery ended without closing it)', async () => {
    expect(await anchorVerdict({ world, policy: policy(() => false), own, state: state() }, record({ anchor: anchor({}) }))).toMatchObject({ v: 'gone' });
  });

  it('another host is never judged', async () => {
    expect(await anchorVerdict({ world, policy: policy(() => true), own, state: state() }, record({ anchor: anchor({ host: 'h2', boot: 'b2' }) }))).toMatchObject({ v: 'covered' });
  });

  it('the OS check: this process is alive; a pid nobody holds is gone', () => {
    const self = processIdentity()!;
    expect(processGone(self)).toBe(false);
    expect(processGone({ ...self, pid: 999_999_9 })).toBe(true);
    // The same pid, started at another time: a reused pid.
    expect(processGone({ ...self, start: self.start - 60_000 })).toBe(true);
  });
});

describe('exclusiveAnchors (Cloudflare: one flow delivery per run)', () => {
  it("any other message's anchor is gone; a direct drive's is not judged that way", async () => {
    const c = { world, policy: exclusiveAnchors(), own, state: state(), now: 0 };
    expect(await anchorVerdict(c, record({ anchor: { k: 'msg', m: 'msg_x' } }))).toMatchObject({ v: 'gone' });
    expect(await anchorVerdict(c, record({ anchor: { k: 'deadline', m: 'direct', at: 10 } }))).toMatchObject({ v: 'covered' });
  });
});

describe('browserAnchors (world-browser: one leader tab)', () => {
  it("a message this leader is not running is gone, with Web Locks; without them every tab leads, so nothing is proven", async () => {
    const nav = globalThis as { navigator?: unknown };
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const withNavigator = async (value: unknown) => {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
      try {
        return await anchorVerdict({ world, policy: browserAnchors(), own, state: state() }, record({ anchor: { k: 'msg', m: 'msg_x' } }));
      } finally {
        if (before) Object.defineProperty(globalThis, 'navigator', before);
        else delete nav.navigator;
      }
    };
    expect(await withNavigator({ locks: { request: async () => {} } })).toMatchObject({ v: 'gone' });
    expect(await withNavigator({})).toMatchObject({ v: 'covered' });
  });
});

describe('tabAnchors (a hybrid tab)', () => {
  /** A fake `navigator.locks`: names held by some tab of this profile. */
  function locks(held: Set<string>) {
    return {
      async request(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown) {
        if (options.ifAvailable) return cb(held.has(name) ? null : { name });
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    };
  }

  it('a page of this profile whose Web Lock is free is gone (a reload); held, it is covered; another profile is never judged', async () => {
    const held = new Set<string>();
    const policy = tabAnchors({ tab: 'tab_new', profile: 'p1', locks: locks(held) });
    const c = { world, policy, own: policy.own({}), state: state() };
    const old: Anchor = { k: 'tab', m: 'tab_old', profile: 'p1' };
    expect(await anchorVerdict(c, record({ anchor: old }))).toMatchObject({ v: 'gone', fence: true });
    held.add('harness:wrun_v');
    expect(await anchorVerdict(c, record({ anchor: old }))).toMatchObject({ v: 'covered' });
    held.clear();
    expect(await anchorVerdict(c, record({ anchor: { ...old, profile: 'p2' } }))).toMatchObject({ v: 'covered' });
  });

  it('holds the lock for a drive', async () => {
    const held = new Set<string>();
    const policy = tabAnchors({ tab: 't', profile: 'p', locks: locks(held) });
    const release = await policy.hold!('wrun_v');
    expect(held.has('harness:wrun_v')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(held.has('harness:wrun_v')).toBe(false);
  });
});
