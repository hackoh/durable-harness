import { type ChatAuthorize, chatGate } from './authorize.ts';
import { type Doc, docEventFor, docLiveEvent, isDocLiveEvent } from './docs.ts';
import { markTime } from './marks.ts';
import { pendingSubmissions } from './fold.ts';
import { decodeCursor, encodeCursor, type TailEntry, type TailOptions } from './streams.ts';
import type { SessionState, Submission } from './types.ts';

/** What `liveResponse` reads: `durableSessions()`, or a wrapper over it (`durablePi()`). */
export interface LiveSource {
  liveEnd(sessionId: string): Promise<number>;
  liveEntries(sessionId: string, options?: TailOptions): AsyncGenerator<TailEntry>;
  /** Needed for `untilSettled`. */
  inspect?(sessionId: string): Promise<SessionState>;
}

export interface LiveResponseOptions {
  /**
   * The request being answered: its `Last-Event-ID` header (an EventSource
   * reconnecting) picks the start, ahead of `cursor` and `startIndex`, and
   * its signal ends the response.
   */
  request?: Request;
  signal?: AbortSignal;
  /** Start just past this cursor (an earlier event's `id`). */
  cursor?: string;
  /** Start at this chunk. Default: the live stream's end now (what follows). */
  startIndex?: number;
  /**
   * End the response when the session settles: an `idle` with no message
   * waiting and no effect running, or a `failed`. The event that settles
   * it carries an end id (its cursor with `;end`), and a reconnect with
   * that id gets a 204, which tells an EventSource to stop. An `idle` the
   * log does not agree with yet is looked at again (250 ms, doubling to 2 s)
   * until it does, and then a bare `event: end` carries its end id. Needs
   * `inspect`.
   */
  untilSettled?: boolean;
  /**
   * With `untilSettled`: the message this response streams the turn of. The
   * turn is not settled until that message is in the log: a message
   * acknowledged before it is durable (Durable On, through the drive route)
   * must not let an idle that came before it end the response.
   */
  submissionId?: string;
  /** Passed to the tail (a read quiet this long is checked for a missed wakeup). Default 1500 ms. */
  quietMs?: number;
  /** A comment line this often keeps proxies from closing an idle response (transport only; nobody judges its silence). Default 15 s. */
  keepaliveMs?: number;
  headers?: HeadersInit;
  /**
   * What to send for each live event: the event (possibly changed), or
   * `undefined` to drop it. A dropped event is as if it never happened (it
   * neither ends a turn nor shows that one went on). Default: every event as is.
   */
  filter?: (event: unknown) => unknown | undefined;
  /**
   * Events to send first, before any live event, each without an `id:` line,
   * so they never move a client's `Last-Event-ID` (the current value of
   * state the client shows, such as documents). A function is called once
   * the response starts (not for a reconnect that is told to stop).
   */
  prelude?: unknown[] | (() => Promise<unknown[]>);
}

/** Marks the cursor of the event that settled a turn. */
const END = ';end';

/**
 * The session's live events as server-sent events: `id: <cursor>` and
 * `data: <event JSON>` per event. A client that reconnects with the last id
 * it saw (an EventSource does, as `Last-Event-ID`) continues with the next
 * event, nothing lost and nothing twice, even if the World split a write
 * into several chunks. The first message is a bare `id:` for the start, so
 * a client that drops before any event still resumes from there; the
 * `x-live-cursor` header carries the same cursor.
 */
export async function liveResponse(source: LiveSource, sessionId: string, options: LiveResponseOptions = {}): Promise<Response> {
  const requested = options.request?.headers.get('last-event-id') || options.cursor;
  let start: string;
  if (requested) {
    let cursor = requested.trim();
    if (cursor.endsWith(END)) {
      if (options.untilSettled) return new Response(null, { status: 204 });
      cursor = cursor.slice(0, -END.length);
    }
    if (!decodeCursor(cursor)) return new Response('not a live cursor', { status: 400 });
    start = cursor;
  } else {
    start = encodeCursor({ startIndex: options.startIndex ?? (await source.liveEnd(sessionId)), lines: 0 });
  }
  const inspect = source.inspect?.bind(source);
  if (options.untilSettled && !inspect) throw new TypeError('harness-world: liveResponse({ untilSettled }) needs a source with inspect()');

  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, ...[options.signal, options.request?.signal].filter((s): s is AbortSignal => !!s)]);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {}
      };
      const keepalive = setInterval(() => send(': keepalive\n\n'), options.keepaliveMs ?? 15_000);
      // An idle the log did not agree with yet (a run-ahead drive can say idle
      // before its last writes land): look again until it does, or until the
      // next event shows the turn went on. Then the end needs no new event.
      let recheck: ReturnType<typeof setTimeout> | undefined;
      /** Bumped by every event, so a look that started before it counts for nothing. */
      let seen = 0;
      const settleLater = (cursor: string, delayMs = 250) => {
        const at = seen;
        recheck = setTimeout(async () => {
          let settled = false;
          try {
            settled = isSettled(await inspect!(sessionId), options.submissionId);
          } catch {}
          if (at !== seen || signal.aborted) return; // the next event came first
          if (!settled) return settleLater(cursor, Math.min(2000, delayMs * 2));
          send(`id: ${cursor}${END}\nevent: end\ndata: {}\n\n`);
          stop.abort();
        }, delayMs);
      };
      try {
        send(`retry: 1000\nid: ${start}\n\n`);
        const prelude = typeof options.prelude === 'function' ? await options.prelude().catch(() => []) : (options.prelude ?? []);
        for (const event of prelude) send(`data: ${JSON.stringify(event)}\n\n`);
        for await (const entry of source.liveEntries(sessionId, { cursor: start, signal, quietMs: options.quietMs ?? 1500 })) {
          const { cursor } = entry;
          const value = options.filter ? options.filter(entry.value) : entry.value;
          if (value === undefined) continue;
          // A document changing is not the turn going on: an app's edit after
          // the turn's idle must not cancel the look that ends the response.
          if (!isDocLiveEvent(value)) {
            clearTimeout(recheck);
            seen++;
          }
          const ends = options.untilSettled && (await settles(value, () => inspect!(sessionId), options.submissionId));
          send(`id: ${ends ? cursor + END : cursor}\ndata: ${JSON.stringify(value)}\n\n`);
          if (ends) {
            send('event: end\ndata: {}\n\n');
            break;
          }
          if (options.untilSettled && typeOf(value) === 'idle') settleLater(cursor);
        }
      } catch (error) {
        if (!signal.aborted) send(`event: error\ndata: ${JSON.stringify(String(error))}\n\n`);
      } finally {
        clearTimeout(recheck);
        seen++;
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel: () => stop.abort(),
  });
  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');
  headers.set('x-live-cursor', start);
  return new Response(body, { headers });
}

const typeOf = (event: unknown) => (event as { type?: unknown } | null)?.type;

/** Whether `event` ends the turn: a `failed`, or an `idle` the log agrees with. */
async function settles(event: unknown, inspect: () => Promise<SessionState>, submissionId?: string): Promise<boolean> {
  const type = typeOf(event);
  if (type === 'failed') return true;
  if (type !== 'idle') return false;
  return isSettled(await inspect(), submissionId);
}

/**
 * No message waiting to be placed, and no effect still running (and, given
 * one, `submissionId` is in the log). An effect a recovery released (it was
 * running when its process died: `step_retrying`, back to pending after an
 * attempt) is not running: Pi reruns it in place, but a process harness
 * (Claude Code, Codex) calls the tool again under a new call id, and the
 * released one stays pending for good.
 */
export function isSettled(state: SessionState, submissionId?: string): boolean {
  if (submissionId !== undefined && !state.submissions.some((s) => s.id === submissionId)) return false;
  return pendingSubmissions(state).length === 0 && !state.effectOrder.some((e) => e.status === 'running' || (e.status === 'pending' && e.attempt === 0));
}

type MessageKind = Extract<Submission['kind'], 'prompt' | 'steer' | 'followUp'>;
const KINDS: readonly MessageKind[] = ['prompt', 'steer', 'followUp'];

/** What `chatRoute` drives: `durableSessions()`, or a wrapper over it. */
export interface ChatSessions extends LiveSource {
  start(): Promise<{ sessionId: string }>;
  send(sessionId: string, text: string, kind?: MessageKind): Promise<string>;
  inspect(sessionId: string): Promise<SessionState>;
}

export interface ChatRouteOptions {
  /**
   * Who may use the route: a function that checks the caller may use the
   * session (`undefined`: POST is about to start a new one) and throws a
   * `Response` (a 401, a 404) to refuse, or `'public'` for anyone. Without
   * one the route is open only outside production: with `NODE_ENV`
   * `production` it refuses every request with a 401 saying so (authorize.ts).
   */
  authorize?: ChatAuthorize;
  /** Send instead of `sessions.send` (a drive route's `send`, which serves the turn in this invocation). */
  send?: (sessionId: string, text: string, kind: MessageKind) => Promise<string>;
  quietMs?: number;
  keepaliveMs?: number;
  /**
   * Documents (docs.ts) the browser may see. Each response starts with the
   * current value of each listed document that has been written (sent
   * without an `id:` line), and forwards every live `doc` event of a listed
   * kind, its value migrated by the definition given here. Every other
   * `doc` event is dropped. Default none: documents are app state, and the
   * browser sees only what the app names. Writes are the app's own route
   * (`updateDoc` behind its own authorization).
   */
  docs?: Doc<any>[];
}

export interface ChatRoute {
  /**
   * `{ sessionId?, text, kind? }`: send a message (starting a session if
   * there is none) and stream what it causes as server-sent events until
   * the turn settles. Headers `x-session-id`, `x-submission-id`, and
   * `x-live-cursor` (the turn's start).
   */
  POST(request: Request): Promise<Response>;
  /**
   * `?sessionId=…&cursor=…` (or a `Last-Event-ID` header): reconnect to a
   * turn and continue just past the cursor. An EventSource on this URL
   * reconnects by itself and stops when the turn settles.
   */
  GET(request: Request): Promise<Response>;
}

/**
 * A chat route over durable sessions: POST sends and streams the turn,
 * GET reconnects to it. The turn runs on the queue (or the drive route),
 * not in the response, so a response that ends early loses nothing.
 *
 * ```ts
 * // app/api/chat/route.ts
 * export const { POST, GET } = chatRoute(sessions, { authorize })
 * ```
 */
export function chatRoute(sessions: ChatSessions, options: ChatRouteOptions = {}): ChatRoute {
  const docs = new Map<string, Doc<any>>();
  for (const doc of options.docs ?? []) docs.set(doc.definition.kind, doc);
  const filter = (event: unknown): unknown | undefined => {
    if (!isDocLiveEvent(event)) return event;
    const doc = docs.get(event.kind);
    return doc ? docEventFor(doc, event) : undefined;
  };
  /** The current value of each listed document that has been written. */
  const prelude = async (sessionId: string): Promise<unknown[]> => {
    if (docs.size === 0) return [];
    const state = await sessions.inspect(sessionId);
    const out: unknown[] = [];
    for (const doc of docs.values()) {
      const stored = state.docs?.get(doc.definition.kind);
      if (stored) out.push(docEventFor(doc, docLiveEvent(stored, markTime())));
    }
    return out;
  };
  const stream = {
    untilSettled: true,
    filter,
    ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
    ...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
  };
  const gate = chatGate(options.authorize);
  return {
    async POST(request) {
      const closed = gate.unconfigured();
      if (closed) return closed;
      let body: { sessionId?: unknown; text?: unknown; kind?: unknown };
      try {
        body = await request.json();
      } catch {
        return new Response('expected a JSON body', { status: 400 });
      }
      const { text, kind = 'prompt' } = body ?? {};
      if (typeof text !== 'string' || !text) return new Response('text is required', { status: 400 });
      if (!KINDS.includes(kind as MessageKind)) return new Response(`kind must be one of ${KINDS.join(', ')}`, { status: 400 });
      if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return new Response('sessionId must be a string', { status: 400 });
      const refused = await gate.check(request, body.sessionId);
      if (refused) return refused;
      const sessionId = body.sessionId ?? (await sessions.start()).sessionId;
      // Stream what this message causes, not the session's history.
      const startIndex = await sessions.liveEnd(sessionId);
      const submissionId = await (options.send ?? ((id, t, k) => sessions.send(id, t, k)))(sessionId, text, kind as MessageKind);
      return liveResponse(sessions, sessionId, {
        ...stream,
        prelude: () => prelude(sessionId),
        startIndex,
        submissionId,
        signal: request.signal,
        headers: { 'x-session-id': sessionId, 'x-submission-id': submissionId },
      });
    },
    async GET(request) {
      const closed = gate.unconfigured();
      if (closed) return closed;
      const params = new URL(request.url).searchParams;
      const sessionId = params.get('sessionId');
      if (!sessionId) return new Response('sessionId is required', { status: 400 });
      const cursor = params.get('cursor') ?? undefined;
      if (!cursor && !request.headers.get('last-event-id')) return new Response('cursor is required', { status: 400 });
      const refused = await gate.check(request, sessionId);
      if (refused) return refused;
      return liveResponse(sessions, sessionId, { ...stream, prelude: () => prelude(sessionId), request, ...(cursor ? { cursor } : {}), headers: { 'x-session-id': sessionId } });
    },
  };
}
