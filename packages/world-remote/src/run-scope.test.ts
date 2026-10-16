import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness, SessionLog } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalQueue, createRemoteWorld, runOf } from './index.ts';
import { createWorldHandler, mintRunToken, RUN_TOKEN_HEADER, runScope, verifyRunToken, type WorldCall } from './server.ts';

/**
 * A tab's World access, scoped to its own session: every call it sends
 * carries the run token of the run the call is about, and the endpoint
 * serves only calls about that run (docs/workspaces.md §8, "Tab
 * capability").
 */

const BASE = 'http://remote.test/api/world';
const SECRET = 'run-scope-test-secret';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const quiet: Harness = { name: 'echo', async drive(_ctx: DriveContext) {} };

async function setup(admit?: (call: WorldCall, runId: string) => boolean) {
  const backing: LocalWorld = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'world-remote-scope-')), recoverActiveRuns: false });
  cleanups.push(() => backing.close?.());
  const handle = createWorldHandler(backing, { authorize: runScope({ secret: SECRET, ...(admit ? { admit } : {}) }) });
  // Two sessions, made by the server.
  const sessions = durableSessions({ world: backing, harness: quiet });
  const own = (await sessions.start({ prompt: 'mine' })).sessionId;
  const other = (await sessions.start({ prompt: 'not mine' })).sessionId;
  const { token } = await mintRunToken(SECRET, own);
  const calls: WorldCall[] = [];
  const queue = createLocalQueue();
  cleanups.push(() => queue.stop());
  /** A tab holding the token for `own` only: it sends it on the calls about that run. */
  const tab = await createRemoteWorld({
    baseUrl: BASE,
    queue,
    fetch: (url, init) => handle(new Request(url, init)),
    headers: (call): Record<string, string> => {
      calls.push(call);
      return runOf(call.op, call.args) === own ? { [RUN_TOKEN_HEADER]: token } : {};
    },
  });
  /** A raw call with whatever token. */
  const raw = (op: string, args: unknown[], withToken = token) =>
    handle(new Request(BASE, { method: 'POST', headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: withToken }, body: JSON.stringify({ op, args }) }));
  return { backing, handle, own, other, token, tab, raw, calls };
}

describe('run tokens', () => {
  it('verify what was minted for that run, and nothing else', async () => {
    const { token, runId, expiresAt } = await mintRunToken(SECRET, 'wrun_A', { ttlSeconds: 60 });
    expect(runId).toBe('wrun_A');
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await verifyRunToken(SECRET, token)).toEqual({ runId: 'wrun_A', expiresAt });
    expect(await verifyRunToken('another-secret', token)).toBeUndefined();
    const [p, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ r: 'wrun_B', x: expiresAt / 1000 })).toString('base64url');
    expect(await verifyRunToken(SECRET, `${p}.${forged}.${sig}`)).toBeUndefined();
    expect(await verifyRunToken(SECRET, (await mintRunToken(SECRET, 'wrun_A', { ttlSeconds: -1 })).token)).toBeUndefined();
    expect(await verifyRunToken(SECRET, 'garbage')).toBeUndefined();
  });

  it('name the run each op is about, and no run for ops that span runs', () => {
    expect(runOf('events.list', [{ runId: 'wrun_A' }])).toBe('wrun_A');
    expect(runOf('events.create', ['wrun_A', {}])).toBe('wrun_A');
    expect(runOf('streams.get', ['wrun_A', 'x'])).toBe('wrun_A');
    expect(runOf('hooks.getByToken', ['harness:wrun_A:inbox'])).toBe('wrun_A');
    expect(runOf('info', [])).toBeNull();
    expect(runOf('getDeploymentId', [])).toBeNull();
    for (const [op, args] of [
      ['runs.list', [{}]],
      ['hooks.get', ['hook_1']],
      ['events.listByCorrelationId', [{ correlationId: 'x' }]],
      ['hooks.getByToken', ['some-webhook-token']],
      ['events.create', [null, {}]],
      ['events.list', [{}]],
    ] as const) {
      expect(runOf(op, args)).toBeUndefined();
    }
  });
});

describe('a run-scoped World endpoint', () => {
  it("the tab's token reads only its own run", async () => {
    const { tab, own, other, raw, calls } = await setup();
    // Its own session: the log, the inbox hook, the streams.
    const log = new SessionLog(tab, own);
    await log.refresh();
    expect(log.state.status).toBe('running');
    expect(log.state.submissions.map((s) => s.text)).toEqual(['mine']);
    expect(await tab.hooks.getByToken(`harness:${own}:inbox`)).toMatchObject({ runId: own });
    await tab.streams.write(own, `${own}_scratch`, 'hello');
    expect(await tab.streams.list(own)).toContain(`${own}_scratch`);
    expect(calls.every((c) => [own, null].includes(runOf(c.op, c.args) as string | null))).toBe(true);
    // Any other run: refused, however it is asked for.
    const otherLog = new SessionLog(tab, other);
    await expect(otherLog.refresh()).rejects.toThrow(/unauthorized/);
    await expect(tab.runs.get(other)).rejects.toThrow(/unauthorized/);
    await expect(tab.streams.list(other)).rejects.toThrow(/unauthorized/);
    await expect(tab.hooks.getByToken(`harness:${other}:inbox`)).rejects.toThrow(/unauthorized/);
    for (const [op, args] of [
      ['events.list', [{ runId: other }]],
      ['events.create', [other, { eventType: 'run_cancelled' }]],
      ['streams.write', [other, `${other}_x`, 'x']],
      ['streams.getChunks', [other, `${other}_live`]],
      ['streams.get', [other, `${other}_live`]],
      // Calls that span runs, or name none it holds a token for.
      ['runs.list', [{}]],
      ['events.listByCorrelationId', [{ correlationId: 'hook_x' }]],
      ['hooks.list', [{}]],
    ] as const) {
      expect((await raw(op, [...args])).status, op).toBe(401);
    }
    // No token, a forged one, another run's: refused on its own run too.
    expect((await raw('events.list', [{ runId: own }], '')).status).toBe(401);
    expect((await raw('events.list', [{ runId: own }], 'hwr1.x.y')).status).toBe(401);
    expect((await raw('events.list', [{ runId: own }], (await mintRunToken(SECRET, other)).token)).status).toBe(401);
    expect((await raw('events.list', [{ runId: own }])).status).toBe(200);
    // Reading the World's own description needs no token.
    expect(tab.remote.specVersion).toBeGreaterThan(0);
  });

  it("refuses what admit refuses on the token's own run", async () => {
    const { tab, own } = await setup((call) => !(call.op === 'streams.write' && String(call.args[1]).endsWith('_ledger')));
    await tab.streams.write(own, `${own}_scratch`, 'ok');
    await expect(tab.streams.write(own, `${own}_ledger`, '{"usd":-100}')).rejects.toThrow(/unauthorized/);
  });
});
