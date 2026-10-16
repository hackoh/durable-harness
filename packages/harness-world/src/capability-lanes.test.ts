import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Capability,
  commitHost,
  currentLane,
  type DriveContext,
  deliver,
  durableSessions,
  type Harness,
  homeLane,
  type HostFact,
  hostOf,
  type Lane,
  laneAvailable,
  markHostLost,
  needsOf,
  route,
  SessionLog,
} from './index.ts';
import { emptyState } from './fold.ts';
import type { SessionState } from './types.ts';
import type { LaneOptions } from './lanes.ts';

describe('capability routing', () => {
  it('runs where the lane covers the needs natively', () => {
    expect(route([], 'browser')).toBeUndefined();
    expect(route(['workspace', 'gateway'], 'browser')).toBeUndefined();
    expect(route(['machine'], 'sandbox')).toBeUndefined();
    expect(route(['secrets'], 'function')).toBeUndefined();
  });

  it('sends secret visits from the sandbox to a function, and machine tools from the tab to the sandbox', () => {
    expect(route(['secrets'], 'sandbox')).toBe('function');
    expect(route(['secrets'], 'browser')).toBe('function');
    expect(route(['machine'], 'browser')).toBe('sandbox');
    expect(route(['machine'], 'function')).toBe('sandbox');
  });

  it('falls back to the function running machine tools remotely when no sandbox host is available', () => {
    const noSandbox = (l: Lane) => l !== 'sandbox';
    expect(route(['machine'], 'browser', noSandbox)).toBe('function');
    // Already in the function lane: run here, remotely (detached sandbox_exec).
    expect(route(['machine'], 'function', noSandbox)).toBeUndefined();
  });

  it('maps the old `requires` to capabilities for one release', () => {
    expect(needsOf({ requires: 'function' })).toEqual(['secrets']);
    expect(needsOf({ requires: 'sandbox' })).toEqual(['machine']);
    expect(needsOf({ requires: 'browser' })).toEqual([]);
    expect(needsOf({ requires: 'function', needs: ['machine'] })).toEqual(['machine']);
  });
});

/** Each prompt is a comma list of capability sets ("secrets", "machine", "" for none): one effect each. */
const needy: Harness = {
  name: 'needy',
  async drive(ctx: DriveContext) {
    for (const s of ctx.pending()) {
      const steps = (s.text ?? '').split(',');
      for (const [i, step] of steps.entries()) {
        const needs = step ? (step.split('+') as Capability[]) : [];
        await ctx.effect(
          `turn:${s.id}:${i}`,
          { name: `tool.${step || 'none'}`, replay: 'safe', input: step, placed: i === steps.length - 1 ? [s.id] : [], needs },
          async () => `ran in ${ctx.lane}`
        );
      }
    }
  },
};

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
});

const host = (vm: string, bootId = 'b1'): HostFact => ({
  lane: 'sandbox',
  url: `https://${vm}.example`,
  vm,
  bootId,
  version: 'v1',
  at: Date.now(),
});

describe('capability lanes on a session', () => {
  it('routes by the host fact, settles to the session home, and falls back to remote machine work once the host is lost', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-cap-')), recoverActiveRuns: false });
    const woken: Lane[] = [];
    const lanes = (serves: Lane[]) => ({
      serves,
      settle: 'browser' as Lane,
      available: (lane: Lane, state: Parameters<typeof laneAvailable>[0]) => laneAvailable(state, lane),
      async wake(_runId: string, to: Lane) {
        woken.push(to);
      },
    });
    const sessions = durableSessions({ world, harness: needy });
    const { sessionId } = await sessions.start({ prompt: 'machine,secrets,machine' });
    const log = new SessionLog(world, sessionId);
    await log.refresh();
    expect(hostOf(log.state)).toBeUndefined();
    expect(await commitHost(log, host('vm1'))).toEqual({ won: true });
    // Idempotent per boot: the live host is not written twice.
    const hosts = () => log.state.effectOrder.filter((e) => e.name === 'host').length;
    expect(await commitHost(log, host('vm1'))).toEqual({ won: true });
    expect(hosts()).toBe(1);
    expect(hostOf(log.state)?.vm).toBe('vm1');

    const browser = { world, harness: needy, lanes: lanes(['browser']) };
    const sandbox = { world, harness: needy, lanes: lanes(['sandbox']) };
    const fn = { world, harness: needy, lanes: lanes(['function']) };

    await deliver(browser, sessionId);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('sandbox');
    await deliver(sandbox, sessionId);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('function');
    await deliver(fn, sessionId);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('sandbox');
    await deliver(sandbox, sessionId);
    let state = await sessions.inspect(sessionId);
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => [e.name, e.output])).toEqual([
      ['tool.machine', 'ran in sandbox'],
      ['tool.secrets', 'ran in function'],
      ['tool.machine', 'ran in sandbox'],
    ]);
    expect(currentLane(state)).toBe('browser');
    expect(woken).toEqual(['sandbox', 'function', 'sandbox', 'browser']);

    // The host is lost: the next machine tool goes to the function, which runs it remotely.
    await log.refresh();
    expect(await markHostLost(log, 'test')).toBe(true);
    expect(hostOf(log.state)).toBeUndefined();
    await sessions.send(sessionId, 'machine');
    await deliver(browser, sessionId);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('function');
    await deliver(fn, sessionId);
    state = await sessions.inspect(sessionId);
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.')).at(-1)?.output).toBe('ran in function');
    expect(currentLane(state)).toBe('browser');
  });

  it('starts a `home: sandbox` session in the sandbox lane and settles it there', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-cap-')), recoverActiveRuns: false });
    const woken: Lane[] = [];
    const lanes = (serves: Lane[]) => ({
      serves,
      settle: 'browser' as Lane,
      async wake(_runId: string, to: Lane) {
        woken.push(to);
      },
    });
    const sessions = durableSessions({ world, harness: needy });
    const { sessionId } = await sessions.start({ prompt: 'secrets', config: { home: 'sandbox' } });
    let state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('sandbox');
    expect(homeLane(state, { settle: 'browser' })).toBe('sandbox');
    await deliver({ world, harness: needy, lanes: lanes(['sandbox']) }, sessionId);
    await deliver({ world, harness: needy, lanes: lanes(['function']) }, sessionId);
    state = await sessions.inspect(sessionId);
    expect(state.effectOrder.find((e) => e.name === 'tool.secrets')?.output).toBe('ran in function');
    expect(currentLane(state)).toBe('sandbox');
    expect(woken).toEqual(['function', 'sandbox']);
  });
});

describe('host facts resolve per boot', () => {
  it('re-attaches a boot that was marked lost (same bootId), and a stale lost mark never hides a newer boot', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-host-')), recoverActiveRuns: false });
    const sessions = durableSessions({ world, harness: needy });
    const { sessionId } = await sessions.start({ prompt: '' });
    const log = new SessionLog(world, sessionId);
    await log.refresh();

    expect(await commitHost(log, host('vm1', 'A'))).toEqual({ won: true });
    expect(await markHostLost(log, 'slow probe', { bootId: 'A' })).toBe(true);
    expect(hostOf(log.state)).toBeUndefined();
    // The same daemon (same bootId) attaches again: accepted, live again.
    expect(await commitHost(log, host('vm1', 'A'))).toEqual({ won: true });
    expect(hostOf(log.state)?.bootId).toBe('A');

    // Boot B attaches; a late lost mark aimed at A is a no-op and B stays live.
    expect(await commitHost(log, host('vm1', 'B'))).toEqual({ won: true });
    expect(await markHostLost(log, 'late probe for A', { bootId: 'A' })).toBe(false);
    expect(hostOf(log.state)?.bootId).toBe('B');
    // A replayed fresh view agrees.
    const fresh = new SessionLog(world, sessionId);
    await fresh.refresh();
    expect(hostOf(fresh.state)?.bootId).toBe('B');
  });

  it('a lost mark for an older boot written after a newer attach does not hide the newer boot (pure fold)', () => {
    const s = emptyState('wrun_hosts');
    const rec = (output: unknown) => ({ name: 'host', status: 'completed', output }) as never;
    s.effectOrder.push(rec(host('vm1', 'A')));
    s.effectOrder.push(rec(host('vm1', 'B')));
    s.effectOrder.push(rec({ ...host('vm1', 'A'), lost: { reason: 'late', at: 1 } }));
    expect(hostOf(s)?.bootId).toBe('B');
    s.effectOrder.push(rec({ ...host('vm1', 'B'), lost: { reason: 'gone', at: 2 } }));
    expect(hostOf(s)).toBeUndefined();
  });
});
