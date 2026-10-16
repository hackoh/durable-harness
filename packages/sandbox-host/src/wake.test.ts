import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { commitHandoff, commitHost, currentLane, durableSessions, type Harness, hostOf, SessionLog } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { wakeHostLane } from './wake.ts';

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
});

const idle: Harness = { name: 'idle', async drive() {} };

async function inSandbox() {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-wake-')), recoverActiveRuns: false });
  const sessions = durableSessions({ world, harness: idle });
  const { sessionId } = await sessions.start();
  const log = new SessionLog(world, sessionId);
  await log.refresh();
  await commitHost(log, { lane: 'sandbox', url: 'https://vm.test', vm: 'vm1', bootId: 'b1', version: 'v', at: Date.now() });
  await commitHandoff(log, { from: 'browser', to: 'sandbox', reason: 'test' }, log.state.epoch);
  return log;
}

describe('waking the sandbox lane', () => {
  it('a live daemon answers 202: woken, nothing else written', async () => {
    const log = await inSandbox();
    const seen: string[] = [];
    const result = await wakeHostLane(log, {
      secretFor: () => 's3cret',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ woke: true });
    expect(seen).toEqual(['https://vm.test/wake Bearer s3cret']);
    expect(currentLane(log.state)).toBe('sandbox');
  });

  it('an unreachable daemon: host marked lost and the session handed to the function lane within the probe window', async () => {
    const log = await inSandbox();
    const t0 = Date.now();
    const result = await wakeHostLane(log, {
      secretFor: () => 's3cret',
      timeoutMs: 300,
      retryTimeoutMs: 300,
      // A dead VM: the request hangs until the probe gives up.
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch,
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(hostOf(log.state)).toBeUndefined();
    expect(result).toEqual({ woke: false, reason: 'host unreachable', handedTo: 'function' });
    await log.refresh();
    expect(currentLane(log.state)).toBe('function');
    expect(hostOf(log.state)).toBeUndefined();
    expect(log.state.effectOrder.findLast((e) => e.name === 'handoff')?.input).toMatchObject({ from: 'sandbox', to: 'function', reason: 'sandbox host unreachable' });
  });

  it('a probe that is only slow is retried once: the host stays and nothing is handed off', async () => {
    const log = await inSandbox();
    let calls = 0;
    const result = await wakeHostLane(log, {
      secretFor: () => 's3cret',
      timeoutMs: 50,
      retryTimeoutMs: 1000,
      fetch: ((_url: string, init: RequestInit) => {
        calls++;
        // First answer arrives after the 50 ms probe gave up; the retry is answered in time.
        const delay = calls === 1 ? 200 : 10;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(null, { status: 202 })), delay);
          init.signal?.addEventListener('abort', () => (clearTimeout(t), reject(init.signal!.reason)));
        });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ woke: true });
    expect(calls).toBe(2);
    await log.refresh();
    expect(currentLane(log.state)).toBe('sandbox');
    expect(hostOf(log.state)?.bootId).toBe('b1');
  });

  it('a connection error is unreachable at once (no retry), and the lost mark names the probed boot', async () => {
    const log = await inSandbox();
    let calls = 0;
    const result = await wakeHostLane(log, {
      secretFor: () => 's3cret',
      fetch: (async () => {
        calls++;
        throw new TypeError('fetch failed: ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ woke: false, handedTo: 'function' });
    await log.refresh();
    const mark = log.state.effectOrder.findLast((e) => e.name === 'host')?.input as { bootId: string; lost?: unknown };
    expect(mark).toMatchObject({ bootId: 'b1', lost: expect.anything() });
  });

  it('an expired daemon token is replaced with a pushed one and the wake retried; a near-expiry token is pushed after a 202', async () => {
    const log = await inSandbox();
    const seen: string[] = [];
    let expired = true;
    const soon = Math.floor(Date.now() / 1000) + 60;
    const result = await wakeHostLane(log, {
      secretFor: () => 's3cret',
      freshToken: async () => 'fresh',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(`${new URL(url).pathname} ${init.body}`);
        if (url.endsWith('/token')) {
          expired = false;
          return Response.json({ ok: true, tokenExp: soon });
        }
        return expired ? Response.json({ error: 'token expired' }, { status: 503 }) : Response.json({ accepted: true, tokenExp: soon }, { status: 202 });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ woke: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((l) => l.split(' ')[0])).toEqual(['/wake', '/token', '/wake', '/token']);
    expect(seen[1]).toContain('"token":"fresh"');
    expect(hostOf(log.state)?.bootId).toBe('b1');
  });
});
