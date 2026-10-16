import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import type { StepEnvelope } from './fold.ts';
import { type DriveContext, type DriveFence, type DriverOptions, deliver, durableSessions, EffectFailure, type Harness, LogSuperseded, SessionLog, vercelAnchors } from './index.ts';
import { stepNameFor } from './names.ts';
import { hostProcess, leasedWorld } from './testing/index.ts';

/**
 * `DriveContext.fence`: the token a drive arms a machine outside the World
 * with (a sandbox relay, docs/workspaces.md §5.4). It must only rise across
 * owners of a session, stay the same within one drive (a re-attach shows the
 * relay the same token), and two drives must never hold the same one: the
 * count a drive armed with is not enough (two deliveries can decide from one
 * view and arm at one count), the count of its first accepted in-band write
 * is.
 */

const ulid = monotonicFactory();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
}

const opened: Array<{ close?(): Promise<void> }> = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close?.().catch(() => {});
});

/** world-local with its queue kept in memory (no queue process in these tests: deliveries are the tests' own). */
async function world(): Promise<World> {
  const w = createLocalWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-drive-fence-')), recoverActiveRuns: false });
  opened.push(w as { close?(): Promise<void> });
  expect(w.capabilities?.inBandFence).toBe(true);
  return new Proxy(w, {
    get(target, key) {
      if (key === 'queue') return async () => ({ messageId: `msg_${ulid()}` });
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as World;
}

const intent = (drv: string) => ({
  eventType: 'step_started' as const,
  correlationId: `step_${ulid()}`,
  eventData: { stepName: stepNameFor('tool.x'), input: encode({ key: `k:${drv}:${ulid()}`, replay: 'safe', input: null, epoch: 0, drv } satisfies StepEnvelope) },
});

/** Where in a turn a drive read its fence. */
type At = 'start' | 'model' | 'after model' | 'tool' | 'after tool';
/** What each drive saw of its own fence: one list per drive, in order. */
type Seen = Map<string, Array<{ at: At; fence: DriveFence | undefined }>>;

/**
 * One turn per prompt (a `safe` model call, then a `never` tool), recording
 * `ctx.fence()` at the drive's start, inside each body, and after each
 * effect.
 */
function turnHarness(seen: Seen, s: { model: (ctx: DriveContext) => Promise<unknown>; calls: { model: number; tool: number } }): Harness {
  return {
    name: 'turns',
    async drive(ctx) {
      const mine: Array<{ at: At; fence: DriveFence | undefined }> = [];
      seen.set(`drive${seen.size}`, mine);
      const read = (at: At) => mine.push({ at, fence: ctx.fence?.() });
      read('start');
      const pending = new Set(ctx.pending().map((p) => p.id));
      for (const sub of ctx.state().submissions) {
        if (sub.kind !== 'prompt') continue;
        if (!pending.has(sub.id) && !ctx.state().placed.has(sub.id)) continue;
        await ctx.effect(`model:${sub.id}`, { name: 'model', replay: 'safe', input: sub.text, placed: [sub.id] }, async () => {
          read('model');
          s.calls.model++;
          return s.model(ctx);
        });
        read('after model');
        try {
          await ctx.effect(`tool:${sub.id}`, { name: 'tool.slow', replay: 'never', input: sub.text }, async () => {
            // A `never` intent is a barrier: durable before this body runs, in either mode.
            read('tool');
            s.calls.tool++;
            return 'ran';
          });
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
        read('after tool');
      }
    },
  };
}

type Reads = Array<{ at: At; fence: DriveFence | undefined }> | undefined;
const tokens = (list: Reads) => (list ?? []).flatMap((r) => (r.fence ? [r.fence] : []));
const counts = (list: Reads) => tokens(list).map((f) => f.count);
/** The drive's last read at `where` (a later turn's drive replays the earlier turns' effects from the log first). */
const at = (list: Reads, where: At) => list?.findLast((r) => r.at === where)?.fence;

describe('SessionLog.fenceOf', () => {
  it('two drives armed at one count: the one the World accepts gets the token (the same for every write), the refused one none; a later owner gets a higher one', async () => {
    const w = await world();
    const sessions = durableSessions({ world: w, harness: { name: 'x', drive: async () => {} } });
    const { sessionId } = await sessions.start();
    const a = new SessionLog(w, sessionId);
    const b = new SessionLog(w, sessionId);
    await a.refresh();
    await b.refresh();
    // The same view, so the same count: the armed count does not tell them apart.
    expect(a.arm('drv_a')).toBe(true);
    expect(b.arm('drv_b')).toBe(true);
    expect(a.inBandCount).toBe(b.inBandCount);
    expect(a.fenceOf('drv_a')).toBeUndefined();

    await a.write(intent('drv_a'));
    const first = a.fenceOf('drv_a')!;
    expect(first).toEqual({ count: b.inBandCount, fenced: true });
    await expect(b.write(intent('drv_b'))).rejects.toBeInstanceOf(LogSuperseded);
    expect(b.fenceOf('drv_b')).toBeUndefined();

    // A's next write leaves its token where it was: one token per drive.
    await a.write(intent('drv_a'));
    expect(a.fenceOf('drv_a')).toEqual(first);
    expect(a.inBandCount).toBeGreaterThan(first.count + 1);
    expect(a.fenceOf('drv_b')).toBeUndefined();

    // B decides again from a fresh read and takes over: higher than every write A made.
    const b2 = new SessionLog(w, sessionId);
    await b2.refresh();
    const before = b2.inBandCount!;
    expect(b2.arm('drv_b2')).toBe(true);
    await b2.write(intent('drv_b2'));
    expect(b2.fenceOf('drv_b2')).toEqual({ count: before, fenced: true });
    expect(before).toBeGreaterThan(first.count);
    // A is refused from then on, and keeps its lower token, no longer fenced.
    await expect(a.write(intent('drv_a'))).rejects.toBeInstanceOf(LogSuperseded);
    expect(a.fenceOf('drv_a')).toEqual({ count: first.count, fenced: false });
    a.disarm('drv_a');
    expect(a.fenceOf('drv_a')).toEqual({ count: first.count, fenced: false });
    // B2 lets go: same token, no longer fenced.
    b2.disarm('drv_b2');
    expect(b2.fenceOf('drv_b2')).toEqual({ count: before, fenced: false });
  });

  it("a write whose outcome is unknown: the drive keeps its token, but it is no longer fenced (its later writes go out of band)", async () => {
    const base = await world();
    let fail = false;
    const flaky = new Proxy(base, {
      get(target, key) {
        if (key === 'events') {
          return new Proxy(target.events, {
            get(events, k) {
              if (k === 'create' && fail) {
                return async () => {
                  fail = false;
                  // Not a refusal: the World may or may not have counted it.
                  throw new Error('socket hang up');
                };
              }
              const value = (events as unknown as Record<string | symbol, unknown>)[k];
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(events) : value;
            },
          });
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as World;
    const sessions = durableSessions({ world: flaky, harness: { name: 'x', drive: async () => {} } });
    const { sessionId } = await sessions.start();
    const log = new SessionLog(flaky, sessionId);
    await log.refresh();
    expect(log.arm('drv_a')).toBe(true);
    await log.write(intent('drv_a'));
    const token = log.fenceOf('drv_a')!;
    expect(token.fenced).toBe(true);
    fail = true;
    await expect(log.write(intent('drv_a'))).rejects.toThrow('socket hang up');
    expect(log.inBandCount).toBeUndefined();
    expect(log.fenceOf('drv_a')).toEqual({ count: token.count, fenced: false });
    // The rest of the drive writes unfenced, and the token says so.
    await log.write(intent('drv_a'));
    expect(log.fenceOf('drv_a')).toEqual({ count: token.count, fenced: false });
  });

  it('a World without the fence gives no token', async () => {
    const base = await world();
    const unfenced = new Proxy(base, {
      get(target, key) {
        if (key === 'capabilities') return { ...target.capabilities, inBandFence: false };
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as World;
    const sessions = durableSessions({ world: unfenced, harness: { name: 'x', drive: async () => {} } });
    const { sessionId } = await sessions.start();
    const log = new SessionLog(unfenced, sessionId);
    await log.refresh();
    expect(log.arm('drv_a')).toBe(false);
    await log.write(intent('drv_a'));
    expect(log.fenceOf('drv_a')).toBeUndefined();
  });
});

describe('DriveContext.fence', () => {
  it('two drives decide from one log: the drive that writes first holds one token for the whole drive, the refused one never gets one, and the next owner is higher', async () => {
    const w = await world();
    const seen: Seen = new Map();
    const calls = { model: 0, tool: 0 };
    const harness = turnHarness(seen, { model: async () => 'plan', calls });
    const sessions = durableSessions({ world: w, harness, runAhead: false });
    const { sessionId } = await sessions.start({ harness: 'turns' });
    await sessions.send(sessionId, 'go');
    const a = hostProcess(w);
    const b = hostProcess(w);
    const base: DriverOptions = { world: w, harness, anchors: vercelAnchors(), contendedDelaySeconds: 1, runAhead: false };
    // B loads, then (inside its admission) A drives the whole turn; B goes on from the log it loaded, at A's starting count.
    await deliver(
      { ...base, world: b.world, admit: async () => (await deliver({ ...base, world: a.world }, sessionId, { anchor: { k: 'msg', m: 'msg_a' } }), { admit: true }) },
      sessionId,
      { anchor: { k: 'msg', m: 'msg_b' } }
    );
    expect(calls).toEqual({ model: 1, tool: 1 });
    const [driveA, driveB] = [...seen.values()];
    // A: nothing accepted yet at its start; from its intent on, one token, fenced, the same at every read.
    expect(at(driveA, 'start')).toBeUndefined();
    const ofA = tokens(driveA);
    expect(ofA.length).toBe(4);
    for (const t of ofA) expect(t).toEqual({ count: ofA[0]!.count, fenced: true });
    // B was refused at its first write: it never held a token (so it could arm nothing).
    expect(driveB).toBeDefined();
    expect(counts(driveB)).toEqual([]);

    // The next turn's drive is a later owner: its token is above A's.
    await sessions.send(sessionId, 'again');
    await deliver(base, sessionId, { anchor: { k: 'msg', m: 'msg_c' } });
    const driveC = [...seen.values()].at(-1)!;
    expect(new Set(counts(driveC)).size).toBe(1);
    expect(counts(driveC)[0]).toBeGreaterThan(ofA[0]!.count);
  });

  it('run ahead: inside a `never` body the token is there (its intent was a barrier), the same as later reads, and above the previous owner', async () => {
    const w = await world();
    const seen: Seen = new Map();
    const calls = { model: 0, tool: 0 };
    const harness = turnHarness(seen, { model: async () => 'plan', calls });
    const sessions = durableSessions({ world: w, harness, runAhead: true });
    const { sessionId } = await sessions.start({ harness: 'turns' });
    const base: DriverOptions = { world: w, harness, anchors: vercelAnchors(), runAhead: true };
    await sessions.send(sessionId, 'go');
    await deliver(base, sessionId, { anchor: { k: 'msg', m: 'msg_1' } });
    await sessions.send(sessionId, 'again');
    await deliver(base, sessionId, { anchor: { k: 'msg', m: 'msg_2' } });
    expect(calls).toEqual({ model: 2, tool: 2 });
    const [first, second] = [...seen.values()];
    for (const drive of [first, second]) {
      // A `safe` body may start before its intent is durable, so no claim there; a `never` body's intent is durable.
      const inTool = at(drive, 'tool');
      expect(inTool).toMatchObject({ fenced: true });
      expect(at(drive, 'after tool')).toEqual(inTool);
      for (const t of tokens(drive)) expect(t.count).toBe(inTool!.count);
    }
    expect(at(second, 'tool')!.count).toBeGreaterThan(at(first, 'tool')!.count);
  });

  it("a frozen holder's takeover: the takeover's token is above the holder's, and the holder, refused when it thaws, keeps its own, no longer fenced", async () => {
    const base = await world();
    const leased = leasedWorld(base, { visibilityMs: 200 });
    let releaseFirst!: (v: string) => void;
    const firstModel = new Promise<string>((r) => (releaseFirst = r));
    const seen: Seen = new Map();
    const calls = { model: 0, tool: 0 };
    const harness = turnHarness(seen, { model: async () => (calls.model === 1 ? firstModel : 'from the takeover'), calls });
    const logs: string[] = [];
    // No hints: the frozen holder learns of the takeover only from its own write.
    const sessions = durableSessions({ world: leased, harness, anchors: vercelAnchors(), hints: false, runAhead: false, log: (m) => logs.push(m) });
    const { sessionId } = await sessions.start({ harness: 'turns' });
    await sessions.send(sessionId, 'go');
    const first = leased.broker.deliver()!;
    await until(async () => ((await sessions.inspect(sessionId)).effectOrder.find((e) => e.name === 'model')?.status === 'running' ? true : undefined));
    await until(() => (counts([...seen.values()][0]).length > 0 ? true : undefined));
    const holder = [...seen.values()][0]!;
    const held = at(holder, 'model')!;
    expect(held.fenced).toBe(true);
    // The holder freezes, its model call returns meanwhile, and its lease lapses: a redelivery recovers the turn.
    first.freeze();
    releaseFirst('from the frozen holder');
    const again = await until(() => leased.broker.deliver());
    await again.done;
    const takeover = [...seen.values()][1]!;
    // The recovery wrote in-band before the harness ran: the takeover holds its token from its start.
    expect(at(takeover, 'start')).toBeDefined();
    expect(new Set(counts(takeover))).toEqual(new Set([at(takeover, 'start')!.count]));
    expect(at(takeover, 'start')!.count).toBeGreaterThan(held.count);

    first.thaw();
    await until(() => (logs.includes('in-band fence: a write was refused') ? true : undefined));
    await first.done;
    // The holder never read another token, and stopped before its tool.
    expect(new Set(counts(holder))).toEqual(new Set([held.count]));
    expect(calls.tool).toBe(1);
  });
});
