import { markTime, type RawSnapshot } from 'harness-world';
import type { BenchClient } from './recorder.ts';
import { summarize } from './stats.ts';
import { ReplayDedupe } from './replay.ts';

/**
 * The demo app's HTTP API as bench clients: plain `fetch`, so they run in the
 * /bench page and in Node (scripts/bench.mjs) alike, with extra headers for a
 * protected deployment (`x-vercel-protection-bypass`).
 */

export interface HttpOptions {
  /** The app's origin, e.g. `https://my-app.vercel.app`. Empty for same-origin. */
  origin?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * How the server drives a durable session's turn: `http` (the drive
   * route: in the invocation that took the submission), `queue` (a queue
   * hop to the flow route), or unset (the deployment's default).
   */
  drive?: 'http' | 'queue';
  /** `run-ahead`: sessions this client starts run ahead of durability (recorded on the run). */
  durability?: 'run-ahead';
}

const base = (o: HttpOptions) => (o.origin ?? '').replace(/\/+$/, '');
const doFetch = (o: HttpOptions): typeof fetch => o.fetch ?? ((input, init) => globalThis.fetch(input, init));

async function postJson<T>(o: HttpOptions, path: string, body: unknown): Promise<T> {
  const r = await doFetch(o)(base(o) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...o.headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text().catch(() => '')}`);
  return (await r.json()) as T;
}

/** Read a streamed body line by line (NDJSON) or block by block (SSE). */
async function readStream(body: ReadableStream<Uint8Array>, separator: string, onChunk: (text: string) => void, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i = buffer.indexOf(separator);
      while (i !== -1) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + separator.length);
        if (chunk) onChunk(chunk);
        i = buffer.indexOf(separator);
      }
    }
    if (buffer) onChunk(buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Subscribe to `/api/sessions/:id/live` (server-sent events) with fetch, so headers can be set.
 *
 * The subscription survives its connection: a response that ends or fails
 * (the Function serving it was killed by a crash drill, a platform timeout)
 * is reopened and replayed from the same start, and the events already
 * delivered are skipped by value (`ReplayDedupe`: a replay is not always the
 * prefix that was delivered), so the recorder sees each event once.
 */
export function liveOverHttp(
  o: HttpOptions,
  id: string,
  onEvent: (event: any) => void,
  onReady?: () => void,
  from = 0,
  reconnectMs = 250,
  idleReconnectMs = 10_000
): () => void {
  const abort = new AbortController();
  const dedupe = new ReplayDedupe();
  let delivered = 0;
  let ready = false;
  const once = async () => {
    // A connection that goes silent is reopened too: a tail that stalled on
    // the server (the events are in the World stream, the response never
    // carries them) must not hold a measurement for its whole timeout.
    const connection = new AbortController();
    const cut = () => connection.abort();
    abort.signal.addEventListener('abort', cut, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(cut, idleReconnectMs);
    };
    touch();
    try {
      await readConnection(connection.signal, touch);
    } finally {
      clearTimeout(idle);
      abort.signal.removeEventListener('abort', cut);
    }
  };
  const readConnection = async (signal: AbortSignal, touch: () => void) => {
    const r = await doFetch(o)(`${base(o)}/api/sessions/${id}/live?from=${from}`, { headers: { accept: 'text/event-stream', ...o.headers }, signal });
    if (!r.ok || !r.body) throw new Error(`live ${r.status}`);
    dedupe.reconnect();
    await readStream(
      r.body,
      '\n\n',
      (block) => {
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) {
            if (!ready) {
              ready = true;
              onReady?.();
            }
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            let event: unknown;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }
            touch();
            if (!dedupe.accept(raw)) continue;
            delivered++;
            onEvent(event);
          }
        }
      },
      signal
    );
  };
  (async () => {
    let wait = reconnectMs;
    while (!abort.signal.aborted) {
      const before = delivered;
      await once().catch(() => {});
      if (abort.signal.aborted) break;
      // A stream that keeps closing with nothing new: back off to 2s.
      wait = delivered > before ? reconnectMs : Math.min(wait * 2, 2000);
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return () => abort.abort();
}

/** Durability on, in a Function: the app's durable server sessions. */
export function serverClient(o: HttpOptions = {}): BenchClient {
  return {
    signalsReady: true,
    start: async (harness, prompt) =>
      (
        await postJson<{ sessionId: string }>(o, '/api/sessions', {
          harness,
          ...(prompt ? { prompt } : {}),
          ...(o.drive ? { drive: o.drive } : {}),
          ...(o.durability ? { durability: o.durability } : {}),
        })
      ).sessionId,
    send: async (id, text, kind) => {
      await postJson(o, `/api/sessions/${id}/messages`, { text, kind, ...(o.drive ? { drive: o.drive } : {}) });
    },
    live: (id, onEvent, onReady) => liveOverHttp(o, id, onEvent, onReady),
    chaos: async (id, spec) => {
      await postJson(o, `/api/sessions/${id}/chaos`, spec);
    },
  };
}

export interface ScriptStep {
  on: 'first_token' | 'text' | 'tool_start' | 'idle';
  afterMs?: number;
  text: string;
  kind?: 'prompt' | 'steer' | 'followUp';
}

interface RawHandle {
  harness: string;
  snapshot?: RawSnapshot;
  listeners: Set<(event: any) => void>;
  /** The turn in flight, if any. */
  busy?: Promise<void>;
  /** Submissions that arrived while a turn was in flight: they run next (a Function cannot be reached mid-turn). */
  queued: { text: string; kind: 'prompt' | 'steer' | 'followUp' }[];
  history: any[];
}

export interface RawFunctionClient extends BenchClient {
  /** Run one turn with more submissions made from inside the same invocation (a steer at the first tool call). */
  runScripted(id: string, text: string, script: ScriptStep[]): Promise<void>;
  /** The session's in-memory state as the last response left it. */
  snapshot(id: string): RawSnapshot | undefined;
  /** Rows for a session list. */
  sessions(): { id: string; harness: string; status: string }[];
}

let rawCounter = 0;

/**
 * Durability off, in a Function (`/api/bench/raw`): the same harness with no
 * World. A Function keeps nothing between requests, so this client carries
 * the session: each turn posts the last snapshot and gets the next one back.
 */
export function rawFunctionClient(o: HttpOptions = {}, lane: { vmRunId?: string } = {}): RawFunctionClient {
  const handles = new Map<string, RawHandle>();
  const get = (id: string) => {
    const h = handles.get(id);
    if (!h) throw new Error(`no raw session ${id}`);
    return h;
  };
  const emit = (h: RawHandle, event: any) => {
    h.history.push(event);
    for (const fn of h.listeners) fn(event);
  };
  async function turn(id: string, text: string, kind: 'prompt' | 'steer' | 'followUp', script?: ScriptStep[]) {
    const h = get(id);
    // `vmRunId`: the VM raw baseline, the same turn in that session's sandbox daemon.
    const r = await doFetch(o)(`${base(o)}/api/bench/raw${lane.vmRunId ? '?lane=vm' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...o.headers },
      body: JSON.stringify({ harness: h.harness, ...(h.snapshot ? { snapshot: h.snapshot } : {}), text, kind, ...(script ? { script } : {}), ...(lane.vmRunId ? { runId: lane.vmRunId } : {}) }),
    });
    if (!r.ok || !r.body) throw new Error(`/api/bench/raw ${r.status} ${await r.text().catch(() => '')}`);
    await readStream(r.body, '\n', (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === 'snapshot') {
        h.snapshot = event.snapshot;
        // Readers of the state (a UI) learn it changed.
        for (const fn of h.listeners) fn({ type: 'state' });
      } else if (event?.type !== 'hello' && event?.type !== 'end') emit(h, event);
    });
  }
  function run(id: string, text: string, kind: 'prompt' | 'steer' | 'followUp', script?: ScriptStep[]) {
    const h = get(id);
    h.busy = (async () => {
      try {
        await turn(id, text, kind, script);
        for (let next = h.queued.shift(); next; next = h.queued.shift()) await turn(id, next.text, next.kind);
      } catch (err) {
        emit(h, { type: 'failed', message: err instanceof Error ? err.message : String(err) });
      } finally {
        h.busy = undefined;
      }
    })();
    return h.busy;
  }
  return {
    signalsReady: true,
    async start(harness, prompt) {
      const id = `rawfn_${Date.now().toString(36)}_${rawCounter++}`;
      handles.set(id, { harness, listeners: new Set(), queued: [], history: [] });
      if (prompt) void run(id, prompt, 'prompt');
      return id;
    },
    async send(id, text, kind) {
      const h = get(id);
      if (h.busy) {
        h.queued.push({ text, kind });
        return;
      }
      void run(id, text, kind);
    },
    runScripted: (id, text, script) => run(id, text, 'prompt', script),
    live(id, onEvent, onReady) {
      const h = get(id);
      for (const e of h.history) onEvent(e);
      h.listeners.add(onEvent);
      onReady?.();
      return () => h.listeners.delete(onEvent);
    },
    snapshot: (id) => handles.get(id)?.snapshot,
    sessions: () => [...handles.entries()].map(([id, h]) => ({ id, harness: h.harness, status: h.snapshot?.status ?? 'running' })),
  };
}

let nativeCounter = 0;

/**
 * Durability Native, in a Function (`/api/native`): plain Pi or fx, no
 * durable-harness at all, the same model, instructions and tools as the
 * durable lanes. A Function keeps nothing between requests, so this client
 * carries the conversation: each turn posts the `state` line the last one
 * ended with. Pi and fx only.
 */
export function nativeFunctionClient(o: HttpOptions = {}): BenchClient {
  const handles = new Map<string, { harness: string; state?: unknown; listeners: Set<(event: any) => void>; history: any[]; busy?: Promise<void>; queued: string[] }>();
  const get = (id: string) => {
    const h = handles.get(id);
    if (!h) throw new Error(`no native session ${id}`);
    return h;
  };
  const emit = (h: { listeners: Set<(event: any) => void>; history: any[] }, event: any) => {
    h.history.push(event);
    for (const fn of h.listeners) fn(event);
  };
  async function turn(id: string, text: string) {
    const h = get(id);
    const r = await doFetch(o)(`${base(o)}/api/native`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...o.headers },
      body: JSON.stringify({ harness: h.harness, text, ...(h.state ? { state: h.state } : {}) }),
    });
    if (!r.ok || !r.body) throw new Error(`/api/native ${r.status} ${await r.text().catch(() => '')}`);
    await readStream(r.body, '\n', (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === 'state') h.state = event.state;
      else emit(h, event);
    });
  }
  function run(id: string, text: string) {
    const h = get(id);
    h.busy = (async () => {
      try {
        await turn(id, text);
        for (let next = h.queued.shift(); next; next = h.queued.shift()) await turn(id, next);
      } catch (err) {
        emit(h, { type: 'failed', message: err instanceof Error ? err.message : String(err) });
      } finally {
        h.busy = undefined;
      }
    })();
    return h.busy;
  }
  return {
    signalsReady: true,
    async start(harness, prompt) {
      if (harness !== 'pi' && harness !== 'fx') throw new Error(`no native baseline for ${harness} yet (Native runs Pi and fx)`);
      const id = `native_${Date.now().toString(36)}_${nativeCounter++}`;
      handles.set(id, { harness, listeners: new Set(), history: [], queued: [] });
      if (prompt) void run(id, prompt);
      return id;
    },
    async send(id, text) {
      const h = get(id);
      if (h.busy) h.queued.push(text);
      else void run(id, text);
    },
    live(id, onEvent, onReady) {
      const h = get(id);
      for (const e of h.history) onEvent(e);
      h.listeners.add(onEvent);
      onReady?.();
      return () => h.listeners.delete(onEvent);
    },
  };
}

export interface AppInfo {
  t: number;
  pid: string;
  world: string;
  model: string;
  deploymentId: string | null;
  url: string | null;
  sha: string | null;
  region: string | null;
  env: string;
  chaos: boolean;
  marks: boolean;
}

export async function appInfo(o: HttpOptions = {}): Promise<AppInfo> {
  const r = await doFetch(o)(`${base(o)}/api/bench/info`, { headers: { ...o.headers }, cache: 'no-store' });
  if (!r.ok) throw new Error(`/api/bench/info ${r.status}`);
  return (await r.json()) as AppInfo;
}

/** Round trips to a warm Function (`/api/bench/info`), after `warm` unmeasured ones. */
export async function measureRtt(o: HttpOptions = {}, n = 10, warm = 2): Promise<{ p50: number; p90: number }> {
  const xs: number[] = [];
  for (let i = 0; i < n + warm; i++) {
    const t0 = markTime();
    await appInfo(o);
    if (i >= warm) xs.push(markTime() - t0);
  }
  const s = summarize(xs)!;
  return { p50: s.p50, p90: s.p90 };
}
