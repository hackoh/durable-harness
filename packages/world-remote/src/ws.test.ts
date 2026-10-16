import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalQueue, createRemoteWorld } from './index.ts';
import { createWorldHandler } from './server.ts';
import { createWsFetch, serveOverWs, type WsLike } from './ws.ts';

const BASE = 'http://remote.test/api/world';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Two connected in-memory WebSockets (async delivery, like a network). */
function socketPair(): { client: WsLike; server: WsLike; drop(code?: number, reason?: string): void; stall(): void; sent: () => number } {
  let stalled = false;
  type L = (e: any) => void;
  let sent = 0;
  const make = () => {
    const listeners: Record<string, L[]> = {};
    const end = {
      readyState: 0,
      binaryType: 'blob' as string,
      peer: undefined as any,
      send(data: Uint8Array | string) {
        if (end.readyState !== 1) throw new Error('not open');
        sent++;
        // Half-open: sends "succeed", nothing arrives, no close fires.
        if (stalled) return;
        const copy = typeof data === 'string' ? data : data.slice().buffer;
        setTimeout(() => end.peer.emit('message', { data: copy }), 0);
      },
      close(code?: number, reason?: string) {
        pair.drop(code, reason);
      },
      addEventListener(type: string, fn: L) {
        (listeners[type] ??= []).push(fn);
      },
      emit(type: string, e: any) {
        for (const fn of listeners[type] ?? []) fn(e);
      },
    };
    return end;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  const pair = {
    client: a as WsLike,
    server: b as WsLike,
    drop(code = 1006, reason = '') {
      if (a.readyState === 3) return;
      a.readyState = b.readyState = 3;
      setTimeout(() => {
        a.emit('close', { code, reason });
        b.emit('close', { code, reason });
      }, 0);
    },
    stall() {
      stalled = true;
    },
    sent: () => sent,
  };
  setTimeout(() => {
    a.readyState = b.readyState = 1;
    a.emit('open', {});
  }, 0);
  return pair;
}

async function setup(opts: { refuse?: boolean; hang?: boolean; ws?: Partial<Parameters<typeof createWsFetch>[0]>; serve?: Partial<Parameters<typeof serveOverWs>[2]> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-remote-ws-'));
  const backing: LocalWorld = createWorld({ dataDir, recoverActiveRuns: false });
  cleanups.push(() => backing.close?.());
  const handle = createWorldHandler(backing);
  let httpRequests = 0;
  const http = (url: string, init: RequestInit) => {
    httpRequests++;
    return handle(new Request(url, init));
  };
  const pairs: ReturnType<typeof socketPair>[] = [];
  const ws = createWsFetch({
    url: 'wss://remote.test/api/session-host',
    fallback: http,
    connectTimeoutMs: 200,
    ...opts.ws,
    createSocket: () => {
      if (opts.refuse) throw new Error('refused');
      if (opts.hang) return { readyState: 0, send() {}, close() {}, addEventListener() {} } as WsLike;
      const pair = socketPair();
      pairs.push(pair);
      // Rotation options apply to the first socket only.
      void serveOverWs(pair.server, handle, { baseUrl: BASE, ...(pairs.length === 1 ? opts.serve : {}) });
      return pair.client;
    },
  });
  cleanups.push(() => ws.close());
  if (!opts.refuse && !opts.hang) await ws.connect();
  const queue = createLocalQueue();
  cleanups.push(() => queue.stop());
  const world = await createRemoteWorld({ baseUrl: BASE, fetch: ws.fetch, queue });
  return { world, backing, ws, pairs, httpRequests: () => httpRequests };
}

/** A run id the World accepts: `wrun_` + a ULID minted now. */
function runId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i++) tail += alphabet[Math.floor(Math.random() * 32)];
  return `wrun_${head}${tail}`;
}

describe('the remote World over one WebSocket', () => {
  it('carries ops and pushes stream tails over the socket, with no HTTP requests', async () => {
    const { world, backing, ws, httpRequests } = await setup();
    expect(ws.connected()).toBe(true);
    const id = runId();
    await world.events.create(id, {
      eventType: 'run_created',
      specVersion: world.specVersion,
      eventData: { deploymentId: 'dpl_test', workflowName: 'w', input: new Uint8Array([1]) },
    });
    const run = await backing.runs.get(id);
    expect(run.runId).toBe(id);
    const listed = await world.events.list({ runId: id, pagination: { sortOrder: 'asc' }, resolveData: 'all' });
    expect(listed.data.map((e) => e.eventType)).toEqual(['run_created']);

    // A tail opened before the writes sees them pushed as they land.
    const stream = await world.streams.get(id, `${id}_s`, 0);
    const reader = stream.getReader();
    await backing.streams.write(id, `${id}_s`, new TextEncoder().encode('a\n'));
    await backing.streams.write(id, `${id}_s`, new TextEncoder().encode('b\n'));
    const got: string[] = [];
    while (got.join('').split('\n').length < 3) {
      const { value } = await reader.read();
      got.push(new TextDecoder().decode(value));
    }
    expect(got.join('')).toBe('a\nb\n');
    await reader.cancel();
    expect(httpRequests()).toBe(0);
  });

  it('falls back to HTTP when the socket cannot open', async () => {
    const { world, ws, httpRequests } = await setup({ refuse: true });
    expect(ws.connected()).toBe(false);
    await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(httpRequests()).toBeGreaterThan(0);
  });

  it('fails requests in flight when the socket drops, then reconnects for the next', async () => {
    const { world, pairs, ws } = await setup();
    const id = runId();
    const stream = await world.streams.get(id, `${id}_t`, 0);
    const reader = stream.getReader();
    pairs[0]!.drop();
    await new Promise((r) => setTimeout(r, 20));
    // The socket reopened in the background.
    expect(ws.connected()).toBe(true);
    expect(pairs.length).toBe(2);
    // The tail reconnects by itself (over a new socket, or HTTP meanwhile).
    await world.streams.write(id, `${id}_t`, new TextEncoder().encode('x\n'));
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('x\n');
    await reader.cancel();
  });

  it('never makes a request wait for the socket: a hung upgrade sends over HTTP at once', async () => {
    const { world, httpRequests } = await setup({ hang: true, ws: { connectTimeoutMs: 3000 } });
    const t0 = Date.now();
    await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(httpRequests()).toBeGreaterThan(0);
  });

  it('after a drop, the next request goes over HTTP immediately while the socket reopens', async () => {
    const { world, pairs, ws, httpRequests } = await setup();
    pairs[0]!.drop();
    await new Promise((r) => setTimeout(r, 5));
    const before = httpRequests();
    const t0 = Date.now();
    await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(Date.now() - t0).toBeLessThan(500);
    // Either it went over HTTP, or the replacement was already open.
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.connected()).toBe(true);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const after = httpRequests();
    await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(httpRequests()).toBe(after);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('rotates on GOAWAY: in-flight ops finish, new ones never fail, the socket is replaced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { world, pairs, ws, backing } = await setup({ serve: { drainAfterMs: 60, drainTimeoutMs: 2000, lingerMs: 10 } });
    const id = runId();
    await world.events.create(id, {
      eventType: 'run_created',
      specVersion: world.specVersion,
      eventData: { deploymentId: 'dpl_test', workflowName: 'w', input: new Uint8Array([1]) },
    });
    // A tail spanning the rotation keeps delivering.
    const stream = await world.streams.get(id, `${id}_r`, 0);
    const reader = stream.getReader();
    // Hold one op in flight across the GOAWAY.
    const slowGet = backing.runs.get.bind(backing.runs);
    (backing.runs as any).get = async (...args: any[]) => {
      await gate;
      return slowGet(...(args as [string]));
    };
    const inflight = world.runs.get(id);
    await new Promise((r) => setTimeout(r, 120));
    // Draining: the old socket is not closed yet (an op is in flight), a new one is open.
    expect(pairs.length).toBe(2);
    expect(ws.connected()).toBe(true);
    const listed = await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(listed.data.length).toBe(1);
    release();
    (backing.runs as any).get = slowGet;
    expect((await inflight).runId).toBe(id);
    await backing.streams.write(id, `${id}_r`, new TextEncoder().encode('after\n'));
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('after\n');
    await reader.cancel();
  });

  it('refused requests on a draining server are resent, never surfaced', async () => {
    const { world, pairs } = await setup({ serve: { drainAfterMs: 0, lingerMs: 30 } });
    // Race the GOAWAY: a request sent before the client has seen it.
    const result = await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' });
    expect(result.data).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(1);
  });

  it('declares a half-open socket dead by keepalive and fails its requests as ambiguous', async () => {
    const { world, pairs, ws } = await setup({ ws: { pingIntervalMs: 30, pongTimeoutMs: 40, headTimeoutMs: 60_000 } });
    pairs[0]!.stall();
    const t0 = Date.now();
    const error = await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((error as { ambiguous?: boolean }).ambiguous).toBe(true);
    expect(String(error)).toMatch(/keepalive/);
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.connected()).toBe(true);
    expect(pairs.length).toBe(2);
  });

  it('times out a request whose head never arrives', async () => {
    const { world, pairs } = await setup({ ws: { pingIntervalMs: 60_000, headTimeoutMs: 50 } });
    pairs[0]!.stall();
    const error = await world.runs.list({ pagination: { limit: 1 }, resolveData: 'none' }).catch((e) => e);
    expect((error as { ambiguous?: boolean }).ambiguous).toBe(true);
    expect(String(error)).toMatch(/no response within 50ms/);
  });
});
