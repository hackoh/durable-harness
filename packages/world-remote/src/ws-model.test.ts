import { describe, expect, it } from 'vitest';
import {
  createWsFetch,
  encodeFrame,
  MODEL_ERROR_CODES,
  RelayTransportError,
  requestOverWs,
  serveModelOverWs,
  throwingFetch,
  WS_FRAME,
  type WsLike,
  type WsRequest,
} from './ws.ts';

/**
 * The sandbox tier's `/model` adapters (docs/workspaces.md §5.4): the relay's
 * client (`requestOverWs`) and the Function's server (`serveModelOverWs`) over
 * one in-memory socket pair, plus the `createWsFetch` options they add.
 */

type L = (e: any) => void;

/** Two connected in-memory sockets, open at once, delivering asynchronously. `raw` sends a frame from the client end as a hostile VM would. */
function pair() {
  const make = () => {
    const listeners: Record<string, L[]> = {};
    const end = {
      readyState: 1,
      binaryType: 'blob' as string,
      bufferedAmount: 0,
      peer: undefined as any,
      sent: [] as Uint8Array[],
      send(data: Uint8Array | string) {
        if (end.readyState !== 1) throw new Error('not open');
        if (typeof data !== 'string') end.sent.push(data.slice());
        const copy = typeof data === 'string' ? data : data.slice().buffer;
        setTimeout(() => end.peer.emit('message', { data: copy }), 0);
      },
      close() {
        drop();
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
  const relay = make();
  const fn = make();
  relay.peer = fn;
  fn.peer = relay;
  const drop = () => {
    if (relay.readyState === 3) return;
    relay.readyState = fn.readyState = 3;
    setTimeout(() => {
      relay.emit('close', { code: 1006 });
      fn.emit('close', { code: 1006 });
    }, 0);
  };
  return { relay: relay as typeof relay & WsLike, fn: fn as typeof fn & WsLike, drop };
}

const text = async (body: AsyncIterable<Uint8Array>) => {
  let out = '';
  for await (const c of body) out += new TextDecoder().decode(c);
  return out;
};
const once = (s: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(s);
  },
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('the /model adapters', () => {
  it('relays method, path, headers and a body bigger than one frame', async () => {
    const p = pair();
    const seen: WsRequest[] = [];
    void serveModelOverWs(p.fn, async (req) => {
      seen.push(req);
      return { status: 201, headers: { 'content-type': 'text/plain' }, body: once(`got ${(req.body as Uint8Array).length}`) };
    });
    const client = requestOverWs(p.relay);
    const body = new Uint8Array(3 * 1024 * 1024).fill(7);
    const res = await client.request({ method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(201);
    expect(await text(res.body)).toBe(`got ${body.length}`);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json' } });
    // Every frame the relay sent fits well under the 1 MiB frame limit.
    expect(Math.max(...p.relay.sent.map((f) => f.length))).toBeLessThanOrEqual(256 * 1024 + 5);
  });

  it('sends back only a fixed error code: a handler’s own code or message never reaches the VM', async () => {
    const p = pair();
    const codes: string[] = [];
    void serveModelOverWs(p.fn, async (req) => {
      if (req.path === '/forbidden') throw Object.assign(new Error('secret detail https://internal.example'), { code: 'forbidden' });
      throw Object.assign(new Error('getaddrinfo ENOTFOUND ai-gateway.internal'), { code: 'ENOTFOUND: host' });
    });
    const client = requestOverWs(p.relay);
    for (const path of ['/forbidden', '/other']) {
      await client.request({ method: 'GET', path, headers: {} }).catch((e: Error) => codes.push(e.message));
    }
    expect(codes).toEqual(['harness-world-remote: relay error: forbidden', 'harness-world-remote: relay error: internal']);
    expect([...MODEL_ERROR_CODES].sort()).toEqual(['bad_request', 'budget', 'busy', 'forbidden', 'internal', 'upstream']);
  });

  it('an abort sends CANCEL, and the server aborts its handler', async () => {
    const p = pair();
    let aborted = false;
    void serveModelOverWs(p.fn, (_req, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted'))))));
    const client = requestOverWs(p.relay);
    const ac = new AbortController();
    const pending = client.request({ method: 'GET', path: '/slow', headers: {} }, ac.signal);
    await tick();
    ac.abort();
    await expect(pending).rejects.toThrow();
    await tick();
    expect(p.relay.sent.some((f) => f[0] === WS_FRAME.CANCEL)).toBe(true);
    expect(aborted).toBe(true);
  });

  it('a request cancelled after the handler answered but before the head went out hands the body back unread', async () => {
    const p = pair();
    let returned = 0;
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    void serveModelOverWs(p.fn, async () => {
      await answered;
      return {
        status: 200,
        headers: {},
        body: {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true as const, value: undefined }),
            return: async () => (returned++, { done: true as const, value: undefined }),
          }),
        },
      };
    });
    const client = requestOverWs(p.relay);
    const ac = new AbortController();
    const pending = client.request({ method: 'GET', path: '/x', headers: {} }, ac.signal);
    await tick();
    ac.abort();
    await expect(pending).rejects.toThrow();
    await tick();
    release();
    await tick();
    expect(returned).toBe(1);
    expect(p.fn.sent.some((f) => f[0] === WS_FRAME.HEAD)).toBe(false);
  });

  it('more requests open at once than the bound is a violation: a relay can\'t make the Function buffer bodies without end', async () => {
    const p = pair();
    const violations: string[] = [];
    void serveModelOverWs(p.fn, () => new Promise(() => {}), { maxOpen: 4, onViolation: (r) => violations.push(r) });
    for (let id = 1; id <= 3; id++) p.relay.send(encodeFrame(WS_FRAME.REQUEST, id, JSON.stringify({ method: 'POST', path: '/', headers: {}, hasBody: true })));
    p.relay.send(encodeFrame(WS_FRAME.REQUEST, 4, JSON.stringify({ method: 'GET', path: '/', headers: {}, hasBody: false })));
    await tick();
    expect(violations).toEqual([]);
    p.relay.send(encodeFrame(WS_FRAME.REQUEST, 5, JSON.stringify({ method: 'POST', path: '/', headers: {}, hasBody: true })));
    await tick();
    expect(violations).toEqual(['more than 4 requests open at once']);
  });

  it('a socket close fails every in-flight request and aborts the handlers', async () => {
    const p = pair();
    let aborted = 0;
    void serveModelOverWs(p.fn, (_req, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => (aborted++, reject(new Error('x'))))));
    const client = requestOverWs(p.relay);
    const a = client.request({ method: 'GET', path: '/a', headers: {} });
    const b = client.request({ method: 'GET', path: '/b', headers: {} });
    await tick();
    p.drop();
    await expect(a).rejects.toBeInstanceOf(RelayTransportError);
    await expect(b).rejects.toBeInstanceOf(RelayTransportError);
    await tick();
    expect(aborted).toBe(2);
  });

  it('a body over the bound is answered bad_request, never handed to the handler', async () => {
    const p = pair();
    let calls = 0;
    void serveModelOverWs(
      p.fn,
      async () => {
        calls++;
        return { status: 200, headers: {}, body: once('') };
      },
      { maxBodyBytes: 1024 }
    );
    const client = requestOverWs(p.relay);
    await expect(client.request({ method: 'POST', path: '/v1/messages', headers: {}, body: new Uint8Array(4096) })).rejects.toThrow(/bad_request/);
    expect(calls).toBe(0);
  });

  it('a hostile VM: short, unknown and malformed frames are a violation, never a throw, and nothing more is served', async () => {
    for (const bad of [new Uint8Array([10, 0]), encodeFrame(99, 1), encodeFrame(WS_FRAME.REQUEST, 1, '{"method":1}'), encodeFrame(WS_FRAME.REQUEST, 1, 'not json'), encodeFrame(WS_FRAME.CHUNK, 7, 'x')]) {
      const p = pair();
      const violations: string[] = [];
      let calls = 0;
      void serveModelOverWs(
        p.fn,
        async () => {
          calls++;
          return { status: 200, headers: {}, body: once('') };
        },
        { onViolation: (r) => violations.push(r) }
      );
      p.relay.send(bad);
      p.relay.send(encodeFrame(WS_FRAME.REQUEST, 2, JSON.stringify({ method: 'GET', path: '/', headers: {}, hasBody: false })));
      await tick();
      expect(violations).toHaveLength(1);
      expect(calls).toBe(0);
    }
  });

  it('a reader slower than the socket fails the response once its backlog passes the bound', async () => {
    const p = pair();
    void serveModelOverWs(p.fn, async () => ({
      status: 200,
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 10; i++) yield new Uint8Array(100_000);
        },
      },
    }));
    const client = requestOverWs(p.relay, { maxQueuedBytes: 250_000 });
    const res = await client.request({ method: 'GET', path: '/big', headers: {} });
    await tick(100);
    await expect(text(res.body)).rejects.toThrow(/backlog/);
  });
});

describe('createWsFetch options for the sandbox tier', () => {
  it('throwingFetch rejects with a RelayTransportError', async () => {
    await expect(throwingFetch()('https://sb.example/x', {})).rejects.toBeInstanceOf(RelayTransportError);
  });

  it('headTimeoutFor overrides the default head timeout per request', async () => {
    const p = pair();
    // The server never answers; the per-request timeout decides how long a request waits.
    const createSocket = () => {
      // Opens on the next tick, as a real socket does.
      p.relay.readyState = 0;
      setTimeout(() => ((p.relay.readyState = 1), p.relay.emit('open', {})), 0);
      return p.relay;
    };
    const ws = createWsFetch({ url: 'wss://sb.example/ctl', createSocket, fallback: throwingFetch(), headTimeoutMs: 5_000, headTimeoutFor: (url) => (url.endsWith('/fast') ? 50 : undefined) });
    expect(await ws.connect()).toBe(true);
    const t = Date.now();
    await expect(ws.fetch('https://sb.example/fast', { method: 'GET' })).rejects.toThrow(/no response within 50ms/);
    expect(Date.now() - t).toBeLessThan(2_000);
    ws.close();
  });
});
