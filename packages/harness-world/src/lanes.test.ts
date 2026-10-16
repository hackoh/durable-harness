import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLane, type DriveContext, deliver, durableSessions, Fatal, type Harness, type Lane, Restart, Yield } from './index.ts';

/** Each prompt runs one effect that requires the lane named in the prompt. */
const needy: Harness = {
  name: 'needy',
  async drive(ctx: DriveContext) {
    for (const s of ctx.pending()) {
      const needs = (s.text ?? 'browser') as Lane;
      await ctx.effect(
        `turn:${s.id}`,
        { name: `tool.${needs}`, replay: 'safe', input: s.text, placed: [s.id], requires: needs },
        async () => `ran in ${ctx.lane}`
      );
    }
  },
};

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
});

describe('lanes', () => {
  it('escalates to the lane an effect requires, and settles back when idle', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-lanes-')), recoverActiveRuns: false });
    const woken: [Lane, string][] = [];
    const lanes = (serves: Lane[]) => ({
      serves,
      settle: 'browser' as Lane,
      async wake(runId: string, to: Lane) {
        woken.push([to, runId]);
      },
    });
    // No queue handler: the test plays each lane's delivery by hand.
    const sessions = durableSessions({ world, harness: needy });
    const { sessionId } = await sessions.start({ prompt: 'function' });

    const browser = { world, harness: needy, lanes: lanes(['browser']) };
    const fn = { world, harness: needy, lanes: lanes(['function']) };

    await deliver(browser, sessionId);
    let state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('function');
    expect(state.effectOrder.map((e) => e.name)).toEqual(['handoff']);
    expect(woken.at(-1)?.[0]).toBe('function');

    // The browser lane now declines the session; the function lane runs it.
    await deliver(browser, sessionId);
    expect((await sessions.inspect(sessionId)).effectOrder).toHaveLength(1);
    await deliver(fn, sessionId);
    state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => [e.name, e.output])).toEqual([
      ['handoff', { from: 'browser', to: 'function', reason: 'tool.function needs the function lane', forKey: expect.any(String) }],
      ['tool.function', 'ran in function'],
      ['handoff', { from: 'function', to: 'browser', reason: 'idle' }],
    ]);
    expect(currentLane(state)).toBe('browser');
    expect(woken.at(-1)?.[0]).toBe('browser');
  });

  it('applies a harness\'s own lanes to its sessions only', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-lanes-')), recoverActiveRuns: false });
    const woken: Lane[] = [];
    const hopping: Harness = {
      ...needy,
      name: 'hopping',
      lanes: { serves: ['function'], settle: 'browser', async wake(_runId, to) { woken.push(to); } },
    };
    const sessions = durableSessions({ world, harness: [needy, hopping] });
    const plain = await sessions.start({ harness: 'needy', prompt: 'sandbox' });
    const hops = await sessions.start({ harness: 'hopping', prompt: 'function' });
    const server = { world, harness: [needy, hopping] };

    // A session whose harness has no lanes ignores `requires` entirely.
    await deliver(server, plain.sessionId);
    expect((await sessions.inspect(plain.sessionId)).effectOrder.map((e) => e.name)).toEqual(['tool.sandbox']);

    // The hopping session starts in the browser lane, which this driver does not serve.
    await deliver(server, hops.sessionId);
    expect((await sessions.inspect(hops.sessionId)).effectOrder).toHaveLength(0);
    // Once something hands it to the function lane, this driver runs it and settles back.
    await deliver({ world, harness: { ...hopping, lanes: { ...hopping.lanes!, serves: ['browser'] } } }, hops.sessionId);
    await deliver(server, hops.sessionId);
    const state = await sessions.inspect(hops.sessionId);
    expect(state.effectOrder.map((e) => e.name)).toEqual(['handoff', 'tool.function', 'handoff']);
    expect(currentLane(state)).toBe('browser');
    expect(woken).toEqual(['function', 'browser']);
  });

  it('refuses any further effect in a drive that has handed off', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-lanes-')), recoverActiveRuns: false });
    const after: unknown[] = [];
    // A kernel that keeps going after a tool escalates (fx's does, for a
    // moment): it catches the Yield and tries to write another step.
    const stubborn: Harness = {
      name: 'stubborn',
      async drive(ctx) {
        try {
          await ctx.effect('needs-function', { name: 'tool.lookup', replay: 'safe', input: null, requires: 'function' }, async () => 'no');
        } catch (err) {
          after.push(err);
        }
        try {
          await ctx.effect('model:after', { name: 'model', replay: 'safe', input: null }, async () => 'late');
        } catch (err) {
          after.push(err);
          throw err;
        }
      },
    };
    const sessions = durableSessions({ world, harness: stubborn });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    await deliver({ world, harness: stubborn, lanes: { serves: ['browser'], settle: 'browser', async wake() {} } }, sessionId);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => e.name)).toEqual(['handoff']);
    expect(after).toHaveLength(2);
    expect(after.every((e) => e instanceof Yield && e.reason === 'handoff')).toBe(true);
    expect(currentLane(state)).toBe('function');
  });

  it('still stops the drive with a handoff when waking the next lane fails', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-lanes-')), recoverActiveRuns: false });
    const seen: unknown[] = [];
    const logs: string[] = [];
    const watcher: Harness = {
      name: 'watcher',
      async drive(ctx) {
        try {
          await ctx.effect('needs-function', { name: 'tool.lookup', replay: 'safe', input: null, requires: 'function' }, async () => 'no');
        } catch (err) {
          seen.push(err);
          throw err;
        }
      },
    };
    const sessions = durableSessions({ world, harness: watcher });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    const result = await deliver(
      {
        world,
        harness: watcher,
        lanes: { serves: ['browser'], settle: 'browser', async wake() { throw new Error('POST /api/hybrid/wake: 502'); } },
        log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      },
      sessionId
    );
    expect(result).toBeUndefined();
    // The harness saw the handoff, not the transport error (fx would report
    // a plain error to the model as the tool's result).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Yield);
    expect(logs.some((l) => l.startsWith('wake failed') && l.includes('502'))).toBe(true);
    // The handoff is committed, so a watcher can wake the lane again.
    expect(currentLane(await sessions.inspect(sessionId))).toBe('function');
  });
});

describe('sessions that cannot continue', () => {
  it('fails the run on Fatal instead of redelivering', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fatal-')), recoverActiveRuns: false });
    let drives = 0;
    const broken: Harness = {
      name: 'broken',
      async drive() {
        drives++;
        throw new Fatal('the log was written by another build');
      },
    };
    const sessions = durableSessions({ world, harness: broken });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    expect(await deliver({ world, harness: broken }, sessionId)).toBeUndefined();
    const state = await sessions.inspect(sessionId);
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toBe('the log was written by another build');
    await deliver({ world, harness: broken }, sessionId);
    expect(drives).toBe(1);
  });

  it('fails the run after too many restarts, naming the last reason', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fatal-')), recoverActiveRuns: false });
    const attempts: number[] = [];
    const looping: Harness = {
      name: 'looping',
      async drive(ctx) {
        attempts.push(ctx.attempt);
        throw new Restart('replayed with a different context');
      },
    };
    const sessions = durableSessions({ world, harness: looping });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    await deliver({ world, harness: looping }, sessionId);
    expect(attempts).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const state = await sessions.inspect(sessionId);
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toMatch(/restarted too many times \(restart: replayed with a different context\)/);
  });

  it('releases a safe effect whose work stops the drive, instead of recording a failure', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-yield-')), recoverActiveRuns: false });
    let calls = 0;
    const h: Harness = {
      name: 'yielding',
      async drive(ctx) {
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: null, placed: ctx.pending().map((s) => s.id) }, async () => {
          calls++;
          if (calls === 1) throw new Yield('contended', 1);
          return 'ok';
        });
      },
    };
    const sessions = durableSessions({ world, harness: h });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    // Contended: the delivery acks and a later look is a new queue message.
    expect(await deliver({ world, harness: h }, sessionId)).toBeUndefined();
    expect((await sessions.inspect(sessionId)).effects.get('model:0')?.status).toBe('pending');
    await deliver({ world, harness: h }, sessionId);
    expect((await sessions.inspect(sessionId)).effects.get('model:0')?.output).toBe('ok');
  });
});
