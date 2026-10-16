import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLane, type DriveContext, type DriverOptions, deliver, durableSessions, type Harness, type Lane, QUEUE_PREFIX, vercelAnchors } from './index.ts';
import { leasedWorld } from './testing/index.ts';

/**
 * One drive per session per process (anchor.ts's registry): a delivery that
 * lands while the session drives here has that drive run once more. That
 * holds only for a delivery the running drive can stand in for: one for
 * another driver of the same process (other lanes) waits for it to let go
 * and then looks itself, or the work it was sent for would be dropped.
 */

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

/** Every prompt: one effect in the lane it requires (`needs`), recorded per lane. */
function laneHarness(ran: string[], lane: Lane, needs: Lane): Harness {
  return {
    name: 'lanes',
    async drive(ctx: DriveContext) {
      for (const s of ctx.pending()) {
        await ctx.effect(`work:${s.id}`, { name: 'tool.work', replay: 'safe', input: s.text, placed: [s.id], requires: needs }, async () => (ran.push(lane), lane));
      }
    },
  };
}

describe('the drive registry across drivers of one process', () => {
  it("a handoff's wake to another driver of this process, sent before the first lets go, is driven by that driver", async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-registry-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({}));
    const ran: string[] = [];
    const logs: string[] = [];
    let woken: Promise<unknown> | undefined;
    // The function lane's driver, in the same process as the tab's (a test; a demo dev server).
    const fn: DriverOptions = {
      world,
      harness: laneHarness(ran, 'function', 'function'),
      lanes: { serves: ['function'], settle: 'function', async wake() {} },
      log: (m) => logs.push(`fn ${m}`),
    };
    const tab: DriverOptions = {
      world,
      harness: laneHarness(ran, 'browser', 'function'),
      lanes: {
        serves: ['browser'],
        settle: 'function',
        // The mover wakes the next lane before it lets go (I3): here, a drive in this very process.
        async wake(runId, to) {
          if (to === 'function') woken = deliver(fn, runId);
        },
      },
      log: (m) => logs.push(`tab ${m}`),
    };
    const sessions = durableSessions({ world, harness: tab.harness });
    const { sessionId } = await sessions.start({});
    await sessions.send(sessionId, 'go');
    await deliver(tab, sessionId);
    await woken;
    expect(ran).toEqual(['function']);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('function');
    expect(logs).toContain('fn wait: this session drives here under another driver; looking after it');
  });

  it('a delivery for the same driver landing while it drives makes it run once more, and starts nothing', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-registry-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({}));
    const logs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const harness: Harness = {
      name: 'gated',
      async drive(ctx) {
        for (const s of ctx.pending()) await ctx.effect(`work:${s.id}`, { name: 'tool.work', replay: 'safe', input: s.text, placed: [s.id] }, async () => (runs++, await gate, 'ok'));
      },
    };
    const options: DriverOptions = { world, harness, log: (m) => logs.push(m) };
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({});
    await sessions.send(sessionId, 'one');
    const first = deliver(options, sessionId);
    while (runs === 0) await new Promise((r) => setTimeout(r, 10));
    await sessions.send(sessionId, 'two');
    expect(await deliver({ ...options }, sessionId)).toBeUndefined();
    expect(logs).toContain('skip: this session is driving in this process; it drives once more');
    release();
    await first;
    expect(runs).toBe(2);
    expect(logs).toContain('rerun: a delivery landed while this drove');
  });

  it('past the rerun cap, a requested look is not dropped: it goes out as a message of its own', async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-registry-')), recoverActiveRuns: false });
    world = base;
    const leased = leasedWorld(base);
    const logs: string[] = [];
    let passes = 0;
    let gate: (() => void) | undefined;
    // Every pass blocks until released, so each look can be asked for while one runs.
    const harness: Harness = {
      name: 'busy',
      async drive() {
        passes++;
        await new Promise<void>((r) => (gate = r));
      },
    };
    const options: DriverOptions = { world: leased, harness, anchors: vercelAnchors(), log: (m) => logs.push(m) };
    const sessions = durableSessions({ world: leased, harness });
    const { sessionId } = await sessions.start({ harness: 'busy' });
    const first = deliver(options, sessionId, { anchor: { k: 'msg', m: 'msg_first' } });
    for (let n = 0; n < 12; n++) {
      while (passes <= n) await new Promise((r) => setTimeout(r, 5));
      // Another delivery lands while this pass runs: it acks, asking for one more look.
      await deliver(options, sessionId, { anchor: { k: 'msg', m: `msg_${n}` } });
      const release = gate!;
      gate = undefined;
      release();
      if (passes > 8) break;
    }
    await first;
    expect(passes).toBe(9);
    // The ninth look it was asked for is a queued wake, not a promise nobody keeps.
    expect(leased.broker.sent().filter((m) => m.idempotencyKey?.includes(':rerun:'))).toHaveLength(1);
  });
});
