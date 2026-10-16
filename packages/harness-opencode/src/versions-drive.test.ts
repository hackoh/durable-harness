import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { durableSessions, Unavailable, UNAVAILABLE_STEP } from 'harness-world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { opencodeHarness } from './harness.ts';

const pins = vi.hoisted(() => ({ wrong: true }));
vi.mock('./versions.ts', async (actual) => ({
  ...(await actual<typeof import('./versions.ts')>()),
  assertOpenCodeVersions: () => {
    if (pins.wrong) throw new Unavailable('harness-world-opencode: installed effect 4.0.2 (expected 4.0.0-rc.112)', { code: 'unavailable', hint: 'Install the pinned versions' });
  },
}));

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('an OpenCode install that does not match the pins', () => {
  it('fails the turn before OpenCode starts, and a fixed install drives the next message', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'oc-pins-')), recoverActiveRuns: false });
    closers.push(() => world.close?.());
    let connects = 0;
    const harness = opencodeHarness({
      root: await mkdtemp(join(tmpdir(), 'oc-pins-root-')),
      connect: async () => {
        connects++;
        // Past the check: that is all this test needs to see.
        throw new Unavailable('stopped after the check', { code: 'unavailable' });
      },
    });
    const sessions = durableSessions({ world, marks: false, harness });
    const { sessionId } = await sessions.start({});

    const first = await sessions.send(sessionId, 'hello', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    const failed = await sessions.inspect(sessionId);
    const fact = failed.effectOrder.find((e) => e.name === UNAVAILABLE_STEP)!;
    expect(fact.output).toMatchObject({
      code: 'unavailable',
      harness: 'opencode',
      message: 'harness-world-opencode: installed effect 4.0.2 (expected 4.0.0-rc.112)',
      hint: 'Install the pinned versions',
    });
    expect(failed.placed.has(first)).toBe(true);
    expect(connects).toBe(0);

    pins.wrong = false;
    await sessions.send(sessionId, 'again', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(connects).toBe(1);
  });
});
