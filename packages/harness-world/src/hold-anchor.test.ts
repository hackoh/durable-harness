import type { World } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { type Anchor, holdAnchor, isActiveAnchor, judgeAnchor, localAnchors, type ProcessIdentity, vercelAnchors } from './anchor.ts';

/**
 * A writer of this process that holds a deadline anchor with no drive of its
 * own (pi-world's storage, open in a request): a delivery here finds its
 * writes covered until the hold is released or the deadline passes.
 */
describe('holdAnchor', () => {
  const world = {} as World;
  const me: ProcessIdentity = { pid: 1, boot: 'boot_me', host: 'here', start: 0 };
  const local = localAnchors({ self: () => me, gone: () => true });
  const deadline = (at: number): Anchor => ({ k: 'deadline', m: `direct_${Math.random().toString(36).slice(2)}`, at, proc: me });
  const judge = (a: Anchor, policy = local, now?: number) =>
    judgeAnchor({ world, policy, own: { k: 'msg', m: 'msg_wake' }, state: { runId: 'wrun_x' }, ...(now !== undefined ? { now } : {}) }, a);

  it('covers a held direct anchor in its own process, where the same-boot rule would take it', async () => {
    const a = deadline(Date.now() + 60_000);
    expect((await judge(a)).v).toBe('gone'); // Not held: this very process, no drive running it.
    const release = holdAnchor(world, a);
    expect(isActiveAnchor(world, `deadline:${a.m}`)).toBe(true);
    expect(await judge(a)).toMatchObject({ v: 'covered', why: 'it drives in this process' });
    release();
    expect(isActiveAnchor(world, `deadline:${a.m}`)).toBe(false);
    expect((await judge(a)).v).toBe('gone');
  });

  it('stops counting at its deadline, the moment another process stops counting it too', async () => {
    const at = Date.now() + 60_000;
    const a = deadline(at);
    const release = holdAnchor(world, a);
    expect(isActiveAnchor(world, `deadline:${a.m}`, at - 1)).toBe(true);
    expect(isActiveAnchor(world, `deadline:${a.m}`, at)).toBe(false);
    expect(await judge(a, vercelAnchors(), at + 1)).toMatchObject({ v: 'gone', why: "past its drive's deadline" });
    release();
  });

  it('is per World object, and a release only lets go of its own hold', () => {
    const a = deadline(Date.now() + 60_000);
    const other = {} as World;
    const first = holdAnchor(world, a);
    const second = holdAnchor(world, a);
    expect(isActiveAnchor(other, `deadline:${a.m}`)).toBe(false);
    first();
    first();
    expect(isActiveAnchor(world, `deadline:${a.m}`)).toBe(true);
    second();
    expect(isActiveAnchor(world, `deadline:${a.m}`)).toBe(false);
  });
});
