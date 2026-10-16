/**
 * The remote World over one WebSocket ("the tab's
 * World socket").
 *
 * Rather than a second protocol, the socket carries the HTTP one: each
 * request the client would `fetch` from `createWorldHandler` becomes a
 * request frame with an id, the server runs the very same handler on it,
 * and the response (head, body chunks, end) comes back in frames with that
 * id. Every op, the wire encoding, errors and the long-lived `streams.get`
 * tails (pushed chunk by chunk, resumable by bytes) therefore behave exactly
 * as over HTTP; what changes is one held connection instead of a request
 * per op. `createWsFetch` is a `fetch` for `createRemoteWorld({ fetch })`.
 *
 * Frames are binary: `[type u8][id u32 BE][payload]`.
 * - client → server: `REQUEST` (JSON `{ method, headers, body }`), `CANCEL`.
 * - server → client: `HEAD` (JSON `{ status, headers }`), `CHUNK` (body
 *   bytes), `END`, `ERROR` (JSON `{ message }`).
 *
 * Requests in flight when the socket drops fail with a `RelayTransportError`
 * (as a dropped HTTP request would: the caller cannot know whether a write
 * landed); stream tails reconnect on their own, as they do over HTTP. A
 * request never waits for the socket: while it is not open (first use, a
 * reconnect, a rotation) requests go over the HTTP `fetch` and the socket
 * opens in the background. Text control frames carry a keepalive
 * (`ping`/`pong`) and the server's `goaway` before its invocation ends: the
 * client opens a replacement at once and the old socket drains.
 */

export const WS_FRAME = { REQUEST: 1, CANCEL: 2, HEAD: 3, CHUNK: 4, END: 5, ERROR: 6 } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: number, id: number, payload: Uint8Array | string = new Uint8Array()): Uint8Array {
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(body, 5);
  return out;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): { type: number; id: number; payload: Uint8Array } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: bytes[0]!, id: view.getUint32(1), payload: bytes.subarray(5) };
}

/** The part of a WebSocket both the browser's and `ws`'s implement. */
export interface WsLike {
  readonly readyState: number;
  binaryType?: string;
  /** Bytes queued but not yet sent (both implementations have it; optional for test doubles). */
  readonly bufferedAmount?: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void;
}

/**
 * Control messages ride text frames (the data frames are binary): `ping`
 * and `pong` keep a half-open socket from swallowing ops, and `goaway`
 * announces that the server is about to end the invocation (it drains, then
 * closes with 1000).
 */
export const WS_CONTROL = { PING: '{"t":"ping"}', PONG: '{"t":"pong"}', GOAWAY: '{"t":"goaway"}' } as const;

/**
 * A request that failed in transport: the caller cannot know whether it
 * took effect on the server (`ambiguous`). A write that failed this way
 * must be looked up (or made idempotent) before it is resent.
 */
/** The close reason of a drain that finished every request it received. */
const ROTATED = 'rotate';

export class RelayTransportError extends Error {
  readonly ambiguous = true;
  constructor(message: string) {
    super(`harness-world-remote: ${message}`);
    this.name = 'RelayTransportError';
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WsFetchOptions {
  /** `wss://…/api/session-host`. */
  url: string;
  /** Default: the global `WebSocket`. */
  createSocket?: (url: string) => WsLike;
  /** Where a request goes while the socket is not open (default: the global `fetch`). */
  fallback?: Fetch;
  /** How long an upgrade may take before it counts as failed. Default 3000. Requests never wait for it. */
  connectTimeoutMs?: number;
  /** After a failed upgrade, how long requests stay on HTTP before the next try. Default 10000. */
  retryAfterMs?: number;
  /** Keepalive ping interval. Default 15000. */
  pingIntervalMs?: number;
  /** How long after a ping with no frame at all the socket is declared dead. Default 10000. */
  pongTimeoutMs?: number;
  /** How long a request may wait for its response head. Default 15000. */
  headTimeoutMs?: number;
  /** A per-request head timeout (adapter 2): a long route (a model SSE, `GET /proc/:id/out`) can outlast `headTimeoutMs`. Falls back to `headTimeoutMs` when it returns undefined. */
  headTimeoutFor?: (url: string, init: RequestInit) => number | undefined;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface WsFetch {
  fetch: Fetch;
  /** Whether requests are going over the socket right now. */
  connected(): boolean;
  /**
   * Open the socket now (it opens lazily otherwise). Requests never wait
   * for it: until it is open they go over HTTP.
   */
  connect(): Promise<boolean>;
  close(): void;
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  headSeen: boolean;
  headTimer?: ReturnType<typeof setTimeout>;
  /** The original request, for a retry over HTTP when the server refused it unrun. */
  retry(): void;
}

/** One socket and the requests riding it. */
interface Conn {
  ws: WsLike;
  open: boolean;
  /** GOAWAY seen: finish what is in flight, send nothing new. */
  draining: boolean;
  dead: boolean;
  pending: Map<number, Pending>;
  pingTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
}

export function createWsFetch(options: WsFetchOptions): WsFetch {
  const fallback: Fetch = options.fallback ?? ((url, init) => globalThis.fetch(url, init));
  const create = options.createSocket ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const say = options.log ?? (() => {});
  const retryAfterMs = options.retryAfterMs ?? 10_000;
  const pingIntervalMs = options.pingIntervalMs ?? 15_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
  const headTimeoutMs = options.headTimeoutMs ?? 15_000;
  /** The socket new requests go over (open, not draining), if any. */
  let active: Conn | undefined;
  let opening: Promise<boolean> | undefined;
  let closed = false;
  let nextId = 1;
  /** After a failed connect, requests use HTTP for a while before retrying. */
  let retryAt = 0;

  function settle(p: Pending, error: Error) {
    clearTimeout(p.headTimer);
    if (p.headSeen) p.controller?.error(error);
    else p.reject(error);
  }

  function fail(conn: Conn, reason: string) {
    if (conn.dead) return;
    conn.dead = true;
    conn.open = false;
    clearInterval(conn.pingTimer);
    clearTimeout(conn.pongTimer);
    if (active === conn) active = undefined;
    for (const [id, p] of conn.pending) {
      conn.pending.delete(id);
      settle(p, new RelayTransportError(`WebSocket closed (${reason})`));
    }
    try {
      conn.ws.close();
    } catch {}
    // Reconnect in the background: nothing waits on it.
    if (!closed && !conn.draining) void connect();
  }

  function keepalive(conn: Conn) {
    conn.pingTimer = setInterval(() => {
      if (conn.dead || conn.pongTimer) return;
      try {
        conn.ws.send(WS_CONTROL.PING);
      } catch {
        return fail(conn, 'send failed');
      }
      conn.pongTimer = setTimeout(() => {
        say('ws: keepalive timed out');
        fail(conn, 'keepalive');
      }, pongTimeoutMs);
    }, pingIntervalMs);
  }

  function connect(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (active?.open) return Promise.resolve(true);
    if (opening) return opening;
    if (Date.now() < retryAt) return Promise.resolve(false);
    opening = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        opening = undefined;
        if (!ok) retryAt = Date.now() + retryAfterMs;
        resolve(ok);
      };
      let ws: WsLike;
      try {
        ws = create(options.url);
      } catch (error) {
        say('ws: connect failed', { error: String(error) });
        return done(false);
      }
      const conn: Conn = { ws, open: false, draining: false, dead: false, pending: new Map() };
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        if (conn.open) return;
        say('ws: connect timed out');
        conn.dead = true;
        try {
          ws.close();
        } catch {}
        done(false);
      }, options.connectTimeoutMs ?? 3000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        if (conn.dead) return;
        if (closed) {
          conn.dead = true;
          try {
            ws.close(1000, 'client closed');
          } catch {}
          return done(false);
        }
        conn.open = true;
        active = conn;
        keepalive(conn);
        done(true);
      });
      ws.addEventListener('close', (e) => {
        clearTimeout(timer);
        if (!conn.open && !conn.dead) {
          conn.dead = true;
          return done(false);
        }
        // A clean rotation: the server waited for every request it received,
        // so one still without a head was never received. Send it again.
        if (e?.code === 1000 && e?.reason === ROTATED) {
          for (const [id, p] of conn.pending) {
            if (p.headSeen) continue;
            conn.pending.delete(id);
            p.retry();
          }
        }
        fail(conn, `code ${e?.code ?? '?'}`);
      });
      ws.addEventListener('error', () => {});
      ws.addEventListener('message', (e) => onMessage(conn, e.data));
    });
    return opening;
  }

  function onMessage(conn: Conn, data: unknown) {
    // Any frame at all proves the socket is alive.
    clearTimeout(conn.pongTimer);
    conn.pongTimer = undefined;
    if (typeof data === 'string') {
      if (data === WS_CONTROL.GOAWAY && !conn.draining) {
        say('ws: goaway, rotating');
        conn.draining = true;
        if (active === conn) active = undefined;
        retryAt = 0;
        // The replacement opens now; until it does, new requests use HTTP.
        void connect();
      }
      return;
    }
    const { type, id, payload } = decodeFrame(data as ArrayBuffer);
    const p = conn.pending.get(id);
    if (!p) return;
    if (type === WS_FRAME.HEAD) {
      clearTimeout(p.headTimer);
      const head = JSON.parse(decoder.decode(payload)) as { status: number; headers: [string, string][] };
      p.headSeen = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          p.controller = controller;
        },
        cancel() {
          conn.pending.delete(id);
          if (conn.open) conn.ws.send(encodeFrame(WS_FRAME.CANCEL, id));
        },
      });
      p.resolve(new Response(body, { status: head.status, headers: head.headers }));
    } else if (type === WS_FRAME.CHUNK) {
      p.controller?.enqueue(payload.slice());
    } else if (type === WS_FRAME.END) {
      conn.pending.delete(id);
      p.controller?.close();
    } else if (type === WS_FRAME.ERROR) {
      conn.pending.delete(id);
      const { message, retry } = JSON.parse(decoder.decode(payload)) as { message: string; retry?: boolean };
      // Refused unrun (the server is draining): safe to send again.
      if (retry && !p.headSeen) return p.retry();
      settle(p, new Error(`harness-world-remote: relay error: ${message}`));
    }
  }

  async function wsFetch(url: string, init: RequestInit): Promise<Response> {
    const conn = active;
    // Never wait for a socket: without an open one the request goes over
    // HTTP now, and the socket (re)opens in the background.
    if (!conn || !conn.open || conn.draining || conn.dead) {
      if (!closed) void connect();
      return fallback(url, init);
    }
    const id = nextId++;
    const headers: [string, string][] = [];
    new Headers(init.headers).forEach((value, key) => headers.push([key, value]));
    const body = typeof init.body === 'string' ? init.body : init.body == null ? undefined : String(init.body);
    return new Promise<Response>((resolve, reject) => {
      const p: Pending = {
        resolve,
        reject,
        headSeen: false,
        retry: () => {
          clearTimeout(p.headTimer);
          fallback(url, init).then(resolve, reject);
        },
      };
      conn.pending.set(id, p);
      const headMs = options.headTimeoutFor?.(url, init) ?? headTimeoutMs;
      p.headTimer = setTimeout(() => {
        if (!conn.pending.has(id) || p.headSeen) return;
        conn.pending.delete(id);
        try {
          if (conn.open) conn.ws.send(encodeFrame(WS_FRAME.CANCEL, id));
        } catch {}
        reject(new RelayTransportError(`no response within ${headMs}ms`));
      }, headMs);
      const signal = init.signal;
      if (signal) {
        const onAbort = () => {
          const current = conn.pending.get(id);
          if (!current) return;
          conn.pending.delete(id);
          try {
            if (conn.open) conn.ws.send(encodeFrame(WS_FRAME.CANCEL, id));
          } catch {}
          settle(current, signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        conn.ws.send(encodeFrame(WS_FRAME.REQUEST, id, JSON.stringify({ method: init.method ?? 'GET', headers, body })));
      } catch {
        // Not sent at all: HTTP is safe.
        conn.pending.delete(id);
        p.retry();
        fail(conn, 'send failed');
      }
    });
  }

  return {
    fetch: wsFetch,
    connected: () => !!active?.open,
    connect,
    close() {
      closed = true;
      const conn = active;
      if (conn) {
        try {
          conn.ws.close(1000, 'client closed');
        } catch {}
        fail(conn, 'client closed');
      }
    },
  };
}

export interface ServeOverWsOptions {
  /** The URL requests are rebuilt against (the handler only reads the body and query). */
  baseUrl: string;
  /**
   * Rotate after this long: send GOAWAY, refuse new requests (retryable),
   * let the ones in flight finish, then close with 1000. Set it below the
   * invocation's `maxDuration` so the platform never cuts a request off.
   */
  drainAfterMs?: number;
  /** Longest wait for in-flight requests once draining. Default 20000. Stream tails are ended at once (they resume). */
  drainTimeoutMs?: number;
  /** After GOAWAY, how long requests already on the wire get to arrive (and be refused). Default 1000. */
  lingerMs?: number;
  /** Called when the socket ends. */
  onClose?: () => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The server half: answer every request frame on `ws` with `handler` (the
 * same `createWorldHandler` the HTTP route mounts), streaming the response
 * back. Resolves when the socket closes; in-flight requests are aborted.
 */
export function serveOverWs(ws: WsLike, handler: (request: Request) => Promise<Response>, options: ServeOverWsOptions): Promise<void> {
  const say = options.log ?? (() => {});
  const inflight = new Map<number, { abort: AbortController; tail: boolean }>();
  let draining = false;
  let idle: (() => void) | undefined;
  const send = (frame: Uint8Array | string) => {
    if (ws.readyState === 1) ws.send(frame);
  };
  const busy = () => [...inflight.values()].some((r) => !r.tail);
  ws.binaryType = 'arraybuffer';

  async function drain() {
    if (draining || ws.readyState !== 1) return;
    draining = true;
    send(WS_CONTROL.GOAWAY);
    // Tails resume on their own (by bytes), so they end now; ops finish.
    for (const [id, r] of inflight) {
      if (!r.tail) continue;
      r.abort.abort();
      inflight.delete(id);
      send(encodeFrame(WS_FRAME.END, id));
    }
    const t0 = Date.now();
    // Requests already on the wire arrive (and are refused) before the close.
    await new Promise((r) => setTimeout(r, options.lingerMs ?? 1000));
    let timedOut = false;
    if (busy()) {
      await new Promise<void>((resolve) => {
        idle = resolve;
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(0, (options.drainTimeoutMs ?? 20_000) - (Date.now() - t0)));
      });
    }
    say('ws: drained', { ms: Date.now() - t0, left: inflight.size });
    try {
      ws.close(1000, timedOut ? 'rotate-timeout' : ROTATED);
    } catch {}
  }
  const drainTimer = options.drainAfterMs !== undefined ? setTimeout(() => void drain(), options.drainAfterMs) : undefined;

  return new Promise<void>((resolve) => {
    ws.addEventListener('close', () => {
      clearTimeout(drainTimer);
      for (const r of inflight.values()) r.abort.abort();
      inflight.clear();
      idle?.();
      options.onClose?.();
      resolve();
    });
    ws.addEventListener('message', (e) => {
      const data = e.data as ArrayBuffer | Uint8Array | string;
      if (typeof data === 'string') {
        if (data === WS_CONTROL.PING) send(WS_CONTROL.PONG);
        return;
      }
      const { type, id, payload } = decodeFrame(data);
      if (type === WS_FRAME.CANCEL) {
        inflight.get(id)?.abort.abort();
        inflight.delete(id);
        if (!busy()) idle?.();
        return;
      }
      if (type !== WS_FRAME.REQUEST) return;
      if (draining) {
        // Never run: the client sends it again elsewhere.
        send(encodeFrame(WS_FRAME.ERROR, id, JSON.stringify({ message: 'draining', retry: true })));
        return;
      }
      const abort = new AbortController();
      let req: { method: string; headers: [string, string][]; body?: string };
      try {
        req = JSON.parse(decoder.decode(payload));
      } catch (error) {
        send(encodeFrame(WS_FRAME.ERROR, id, JSON.stringify({ message: String(error) })));
        return;
      }
      const tail = isTail(req.body);
      inflight.set(id, { abort, tail });
      void (async () => {
        try {
          const request = new Request(options.baseUrl, {
            method: req.method,
            headers: req.headers,
            ...(req.body !== undefined && req.method !== 'GET' ? { body: req.body } : {}),
            signal: abort.signal,
          });
          const response = await handler(request);
          const headers: [string, string][] = [];
          response.headers.forEach((value, key) => headers.push([key, value]));
          if (abort.signal.aborted) {
            response.body?.cancel().catch(() => {});
            return;
          }
          send(encodeFrame(WS_FRAME.HEAD, id, JSON.stringify({ status: response.status, headers })));
          if (response.body) {
            const reader = response.body.getReader();
            const stop = () => reader.cancel().catch(() => {});
            abort.signal.addEventListener('abort', stop, { once: true });
            for (;;) {
              const { value, done } = await reader.read();
              if (done || abort.signal.aborted) break;
              send(encodeFrame(WS_FRAME.CHUNK, id, value));
            }
          }
          if (!abort.signal.aborted) send(encodeFrame(WS_FRAME.END, id));
        } catch (error) {
          if (!abort.signal.aborted) send(encodeFrame(WS_FRAME.ERROR, id, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })));
        } finally {
          if (inflight.get(id)?.abort === abort) inflight.delete(id);
          if (!busy()) idle?.();
        }
      })();
    });
  });
}

/** A `streams.get` tail: long-lived, and resumable by bytes. */
function isTail(body: string | undefined): boolean {
  if (!body || !body.includes('streams.get')) return false;
  try {
    return (JSON.parse(body) as { op?: string }).op === 'streams.get';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Adapters for the sandbox tier's `/model` socket (docs/workspaces.md §5.4).
//
// Both sockets are dialed by the Function. On `/ctl` the Function requests and
// the relay serves. On `/model` the roles reverse: the relay sends the CLI's
// HTTP requests and the Function serves them (`gatewayHandler`). These five
// adapters reuse the frame codec and `RelayTransportError`, but not
// `createWsFetch`'s dial, HTTP fallback or rotation (the socket is already
// open, and there is no public URL to fall back to). Existing callers of
// `createWsFetch`/`serveOverWs` are untouched.
//
// 1. `throwingFetch`: a `fetch` that throws — `createWsFetch`'s fallback on a
//    socket that must never reach the public `sb-*.vercel.run` URL unbearered.
// 2. `WsFetchOptions.headTimeoutFor`: a per-request head timeout, so a long
//    route (a model SSE, `GET /proc/:id/out`) can outlast the 15 s default.
// 3. `requestOverWs`: the relay's client over a socket it accepted (did not
//    dial) — sends a request carrying its `method` and `path`, streams the
//    response.
// 4. `serveModelOverWs`: the Function's server over the socket it dialed,
//    rebuilding each request as `{ method, path, headers, body }` (not a
//    `Request` at a fixed `baseUrl`), with no tail handling.
// 5. Error mapping: a handler's failure goes back as one of the fixed codes
//    (`MODEL_ERROR_CODES`) only, anything else as `internal`; the detail stays
//    in the Function's log.
//
// Unlike the World socket's REQUEST, a `/model` REQUEST carries no body: the
// body follows as `CHUNK` frames and an `END`, as a response's does, so every
// frame stays under the relay's frame limit whatever the body's size (a Claude
// `/v1/messages` body is routinely over 1 MiB). The VM end is untrusted: the
// Function's side checks every frame's length and shape, bounds the body, and
// reports a violation (`onViolation`) instead of throwing in a listener.

/** A `fetch` that always rejects: `createWsFetch`'s `fallback` for a socket with no public HTTP fallback (adapter 1). */
export function throwingFetch(message = 'no HTTP fallback for this socket'): Fetch {
  return () => Promise.reject(new RelayTransportError(message));
}

/** One relayed request. `method` and `path` are the CLI's own text; a server only ever matches them against a fixed table, never joins them into a URL. */
export interface WsRequest {
  method: string;
  /** Pathname and query, as the CLI sent them. */
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array | string;
}

/** The server's answer: a status, allowlisted headers, and the body as it streams. */
export interface WsResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

/** A handler of relayed requests (the driver's `gatewayHandler`, adapted). A rejection's `code`, if one of `MODEL_ERROR_CODES`, is the only thing sent back. */
export type WsRequestHandler = (request: WsRequest, signal: AbortSignal) => Promise<WsResponse>;

/** The codes a `/model` failure may carry back to the VM (adapter 5); any other `code` goes back as `internal`. `budget` is a spend cap, `busy` the concurrency cap. */
export const MODEL_ERROR_CODES: ReadonlySet<string> = new Set(['bad_request', 'forbidden', 'budget', 'busy', 'upstream', 'internal']);

/** The largest body frame either side sends on `/model`: well under the relay's 1 MiB frame limit. */
const MODEL_CHUNK_BYTES = 256 * 1024;

/** Split `bytes` into frames of at most `size` bytes (one empty frame for an empty input is never sent). */
function* slices(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(bytes.length, at + size));
}

/** Decode a frame that came from an untrusted peer: undefined unless it holds at least the 5-byte header. */
function decodeUntrusted(data: unknown): { type: number; id: number; payload: Uint8Array } | undefined {
  if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return undefined;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 5) return undefined;
  return decodeFrame(bytes);
}

/**
 * An async queue of chunks, closed by `end()` or `fail()`: the body of one
 * streamed response. Bounded in bytes: a push past `maxBytes` that the reader
 * has not taken fails the queue (and calls `onOverflow`), rather than growing
 * without end when the reader is slower than the socket.
 */
function chunkQueue(maxBytes: number, onOverflow: () => void): { push(c: Uint8Array): void; end(): void; fail(e: Error): void; iterable: AsyncIterable<Uint8Array> } {
  const chunks: Uint8Array[] = [];
  let queued = 0;
  let waiting: { resolve(r: IteratorResult<Uint8Array>): void; reject(e: Error): void } | undefined;
  let done = false;
  let error: Error | undefined;
  const pump = () => {
    if (!waiting) return;
    const w = waiting;
    if (chunks.length) {
      waiting = undefined;
      const c = chunks.shift()!;
      queued -= c.length;
      w.resolve({ value: c, done: false });
    } else if (error) {
      waiting = undefined;
      w.reject(error);
    } else if (done) {
      waiting = undefined;
      w.resolve({ value: undefined, done: true });
    }
  };
  const queue = {
    push: (c: Uint8Array) => {
      if (done || error) return;
      if (queued + c.length > maxBytes) {
        queue.fail(new RelayTransportError(`response backlog over ${maxBytes} bytes`));
        onOverflow();
        return;
      }
      chunks.push(c);
      queued += c.length;
      pump();
    },
    end: () => {
      done = true;
      pump();
    },
    fail: (e: Error) => {
      error ??= e;
      chunks.length = 0;
      queued = 0;
      pump();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
              waiting = { resolve, reject };
              pump();
            }),
        };
      },
    },
  };
  return queue;
}

interface ModelPending {
  resolve(response: WsResponse): void;
  reject(error: Error): void;
  headSeen: boolean;
  headTimer?: ReturnType<typeof setTimeout>;
  queue?: ReturnType<typeof chunkQueue>;
}

/**
 * The relay's client over a socket it accepted from the Function's dial
 * (adapter 3): send a request and stream its response, using the same frames
 * as `createWsFetch` but with no dialing, fallback or rotation. One call per
 * in-flight request; `close()` fails the rest. A response the reader takes
 * more slowly than it arrives is failed once `maxQueuedBytes` are waiting.
 */
export function requestOverWs(
  ws: WsLike,
  options: { headTimeoutMs?: number; maxQueuedBytes?: number; log?: (m: string, f?: Record<string, unknown>) => void } = {}
): {
  request(req: WsRequest, signal?: AbortSignal): Promise<WsResponse>;
  close(): void;
} {
  const headTimeoutMs = options.headTimeoutMs ?? 60_000;
  const maxQueuedBytes = options.maxQueuedBytes ?? 16 * 1024 * 1024;
  const pending = new Map<number, ModelPending>();
  let nextId = 1;
  let dead: Error | undefined;
  ws.binaryType = 'arraybuffer';

  const cancel = (id: number) => {
    try {
      if (ws.readyState === 1) ws.send(encodeFrame(WS_FRAME.CANCEL, id));
    } catch {}
  };

  const failAll = (error: Error) => {
    dead ??= error;
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.headTimer);
      if (p.headSeen) p.queue?.fail(error);
      else p.reject(error);
    }
  };

  ws.addEventListener('close', () => failAll(new RelayTransportError('model socket closed')));
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', (e) => {
    const frame = decodeUntrusted((e as { data: unknown }).data);
    if (!frame) return;
    const { type, id, payload } = frame;
    const p = pending.get(id);
    if (!p) return;
    try {
      if (type === WS_FRAME.HEAD && !p.headSeen) {
        clearTimeout(p.headTimer);
        const head = JSON.parse(decoder.decode(payload)) as { status: number; headers: Record<string, string> };
        p.headSeen = true;
        const queue = chunkQueue(maxQueuedBytes, () => {
          pending.delete(id);
          cancel(id);
        });
        p.queue = queue;
        p.resolve({ status: head.status, headers: head.headers, body: queue.iterable });
      } else if (type === WS_FRAME.CHUNK) {
        p.queue?.push(payload.slice());
      } else if (type === WS_FRAME.END) {
        pending.delete(id);
        p.queue?.end();
      } else if (type === WS_FRAME.ERROR) {
        pending.delete(id);
        clearTimeout(p.headTimer);
        const { message } = JSON.parse(decoder.decode(payload)) as { message: string };
        const err = new Error(`harness-world-remote: relay error: ${String(message)}`);
        if (p.headSeen) p.queue?.fail(err);
        else p.reject(err);
      }
    } catch (error) {
      pending.delete(id);
      clearTimeout(p.headTimer);
      const err = new RelayTransportError(`bad model frame: ${String((error as Error)?.message ?? error)}`);
      if (p.headSeen) p.queue?.fail(err);
      else p.reject(err);
    }
  });

  return {
    request(req, signal) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      const body = req.body === undefined ? undefined : typeof req.body === 'string' ? encoder.encode(req.body) : req.body;
      return new Promise<WsResponse>((resolve, reject) => {
        const p: ModelPending = { resolve, reject, headSeen: false };
        pending.set(id, p);
        p.headTimer = setTimeout(() => {
          if (!pending.has(id) || p.headSeen) return;
          pending.delete(id);
          cancel(id);
          reject(new RelayTransportError(`no response within ${headTimeoutMs}ms`));
        }, headTimeoutMs);
        if (signal) {
          const onAbort = () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            clearTimeout(p.headTimer);
            cancel(id);
            const err = signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
            if (p.headSeen) p.queue?.fail(err);
            else reject(err);
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          ws.send(encodeFrame(WS_FRAME.REQUEST, id, JSON.stringify({ method: req.method, path: req.path, headers: req.headers, hasBody: body !== undefined })));
          if (body !== undefined) {
            for (const part of slices(body, MODEL_CHUNK_BYTES)) ws.send(encodeFrame(WS_FRAME.CHUNK, id, part));
            ws.send(encodeFrame(WS_FRAME.END, id));
          }
        } catch (error) {
          pending.delete(id);
          clearTimeout(p.headTimer);
          reject(new RelayTransportError(`model send failed: ${String(error)}`));
        }
      });
    },
    close() {
      failAll(new RelayTransportError('model client closed'));
      try {
        ws.close();
      } catch {}
    },
  };
}

export interface ServeModelOptions {
  onClose?: () => void;
  /** The VM sent something outside the protocol (a short or unknown frame, bad JSON, a body over the bound): the caller drops the link. Nothing more is served once it fires. */
  onViolation?: (reason: string) => void;
  /** The largest request body accepted (default 4 MiB, `LIMITS.modelBodyBytes`); a longer one is answered `bad_request`. */
  maxBodyBytes?: number;
  /** Pause a response's body while the socket holds more than this many unsent bytes (default 4 MiB). */
  highWaterMark?: number;
  /**
   * The most requests open at once, bodies still arriving and in flight
   * together (default 16: the relay itself allows 8). One more is a
   * violation: a relay that opens ids without end can't make the Function
   * buffer their bodies.
   */
  maxOpen?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A REQUEST frame's JSON, checked: anything else is a violation. */
function parseModelRequest(payload: Uint8Array): { method: string; path: string; headers: Record<string, string>; hasBody: boolean } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(payload));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { method, path, headers, hasBody } = raw as Record<string, unknown>;
  if (typeof method !== 'string' || method.length === 0 || method.length > 16) return undefined;
  if (typeof path !== 'string' || path.length > 8192) return undefined;
  if (typeof hasBody !== 'boolean') return undefined;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return undefined;
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > 128) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || k.length > 256 || v.length > 16384) return undefined;
    out[k] = v;
  }
  return { method, path, headers: out, hasBody };
}

/**
 * The Function's server for `/model` over the socket it dialed (adapters 4 and
 * 5): answer each relayed request with `handler`, streaming the response back
 * in frames of at most 256 KiB, paused while the socket's `bufferedAmount` is
 * over the high-water mark. Unlike `serveOverWs` it rebuilds the request as
 * `{ method, path, headers, body }` (the path is matched against a fixed
 * table, never a URL), has no tail or drain handling (a model call is
 * neither), aborts every in-flight handler when the socket closes, treats
 * more than `maxOpen` requests open at once as a violation, hands back unread
 * a response cancelled before its head went out, and sends a failure back as
 * a fixed code only. Resolves when the socket closes.
 */
export function serveModelOverWs(ws: WsLike, handler: WsRequestHandler, options: ServeModelOptions = {}): Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const highWaterMark = options.highWaterMark ?? 4 * 1024 * 1024;
  const maxOpen = options.maxOpen ?? 16;
  const inflight = new Map<number, AbortController>();
  /** Requests whose body is still arriving. */
  const collecting = new Map<number, { head: { method: string; path: string; headers: Record<string, string> }; parts: Uint8Array[]; bytes: number }>();
  let violated = false;
  let closed = false;
  const send = (frame: Uint8Array) => {
    if (ws.readyState === 1) ws.send(frame);
  };
  const drained = async (signal: AbortSignal) => {
    while (!signal.aborted && !closed && (ws.bufferedAmount ?? 0) > highWaterMark) await new Promise((r) => setTimeout(r, 10));
  };
  const violation = (reason: string) => {
    if (violated) return;
    violated = true;
    for (const a of inflight.values()) a.abort();
    inflight.clear();
    collecting.clear();
    options.log?.('model protocol violation', { reason });
    options.onViolation?.(reason);
  };
  const run = (id: number, request: WsRequest) => {
    const abort = new AbortController();
    inflight.set(id, abort);
    void (async () => {
      try {
        const response = await handler(request, abort.signal);
        if (abort.signal.aborted) {
          // Cancelled before the head went out: hand the body back unread, so whatever it holds (a slot, an upstream stream) is let go.
          void Promise.resolve(response.body[Symbol.asyncIterator]().return?.()).catch(() => {});
          return;
        }
        send(encodeFrame(WS_FRAME.HEAD, id, JSON.stringify({ status: response.status, headers: response.headers })));
        for await (const chunk of response.body) {
          if (abort.signal.aborted) break;
          for (const part of slices(chunk, MODEL_CHUNK_BYTES)) {
            await drained(abort.signal);
            if (abort.signal.aborted) break;
            send(encodeFrame(WS_FRAME.CHUNK, id, part));
          }
        }
        if (!abort.signal.aborted) send(encodeFrame(WS_FRAME.END, id));
      } catch (error) {
        // Adapter 5: a fixed code only, never the detail.
        const code = (error as { code?: unknown } | undefined)?.code;
        const message = typeof code === 'string' && MODEL_ERROR_CODES.has(code) ? code : 'internal';
        options.log?.('model handler error', { code: message });
        if (!abort.signal.aborted) send(encodeFrame(WS_FRAME.ERROR, id, JSON.stringify({ message })));
      } finally {
        if (inflight.get(id) === abort) inflight.delete(id);
      }
    })();
  };
  ws.binaryType = 'arraybuffer';
  return new Promise<void>((resolve) => {
    ws.addEventListener('close', () => {
      closed = true;
      for (const a of inflight.values()) a.abort();
      inflight.clear();
      collecting.clear();
      options.onClose?.();
      resolve();
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (e) => {
      if (violated) return;
      const frame = decodeUntrusted((e as { data: unknown }).data);
      if (!frame) return violation('a short or non-binary frame');
      const { type, id, payload } = frame;
      switch (type) {
        case WS_FRAME.CANCEL:
          inflight.get(id)?.abort();
          inflight.delete(id);
          collecting.delete(id);
          return;
        case WS_FRAME.REQUEST: {
          if (inflight.has(id) || collecting.has(id)) return violation('a request id already in flight');
          if (inflight.size + collecting.size >= maxOpen) return violation(`more than ${maxOpen} requests open at once`);
          const head = parseModelRequest(payload);
          if (!head) return violation('a malformed request');
          if (head.hasBody) collecting.set(id, { head, parts: [], bytes: 0 });
          else run(id, { method: head.method, path: head.path, headers: head.headers });
          return;
        }
        case WS_FRAME.CHUNK: {
          const c = collecting.get(id);
          if (!c) return violation('a body chunk for no request');
          c.bytes += payload.length;
          if (c.bytes > maxBodyBytes) {
            collecting.delete(id);
            send(encodeFrame(WS_FRAME.ERROR, id, JSON.stringify({ message: 'bad_request' })));
            return;
          }
          c.parts.push(payload.slice());
          return;
        }
        case WS_FRAME.END: {
          const c = collecting.get(id);
          if (!c) return; // a body already refused as too large
          collecting.delete(id);
          const body = new Uint8Array(c.bytes);
          let at = 0;
          for (const p of c.parts) {
            body.set(p, at);
            at += p.length;
          }
          run(id, { ...c.head, body });
          return;
        }
        default:
          return violation(`an unknown frame type ${type}`);
      }
    });
  });
}
