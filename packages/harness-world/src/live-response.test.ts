import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatRoute, type ChatSessions, decodeCursor, durableSessions, emptyState, encodeCursor, isSettled, liveResponse, liveStreamName, NO_AUTHORIZE_MESSAGE, QUEUE_PREFIX, readJsonLines } from './index.ts';
import type { EffectRecord } from './types.ts';
import type { DriveContext, Harness, SessionState } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per prompt: one `model` effect streaming `deltas` text events (multi-byte, spaced out), then `idle`. */
function chatterHarness(deltas: number, gapMs = 15): Harness {
  return {
    name: 'chatter',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.length;
      for (const submission of ctx.pending()) {
        await ctx.effect(`model:${turn++}`, { name: 'model', replay: 'safe', input: submission.text, placed: [submission.id] }, async () => {
          for (let i = 0; i < deltas; i++) {
            ctx.live({ type: 'text', delta: `${submission.text}:${i} é🙂` });
            await sleep(gapMs);
          }
          return 'ok';
        });
      }
      ctx.live({ type: 'idle' });
    },
  };
}

/**
 * A World that stores every stream write as several chunks, cut through
 * lines and through multi-byte characters: what a World may do, and why
 * chunk indices are no resume point.
 */
function splitWrites(world: LocalWorld, pieces = 3): { writes: number; chunks: number } {
  const stats = { writes: 0, chunks: 0 };
  const write = world.streams.write.bind(world.streams);
  world.streams.write = async (runId, name, chunk) => {
    stats.writes++;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    const size = Math.max(1, Math.ceil(bytes.length / pieces));
    for (let at = 0; at < bytes.length; at += size) {
      stats.chunks++;
      await write(runId, name, bytes.slice(at, at + size));
    }
  };
  return stats;
}

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
}

/**
 * Read server-sent events off `response` until `stop` says so (then cancel
 * the body: a dropped connection) or the body ends.
 */
async function readSse(response: Response, stop: (messages: SseMessage[]) => boolean = () => false): Promise<SseMessage[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
      const message: SseMessage = {};
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = line.slice(0, colon);
        const v = line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id' || field === 'event' || field === 'data') message[field] = v;
      }
      if (message.id !== undefined || message.data !== undefined) messages.push(message);
      if (stop(messages)) {
        await reader.cancel();
        return messages;
      }
    }
  }
  return messages;
}

const events = (messages: SseMessage[]) => messages.filter((m) => m.data !== undefined && m.event === undefined).map((m) => JSON.parse(m.data!));
const lastId = (messages: SseMessage[]) => messages.findLast((m) => m.id !== undefined)?.id;

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

async function setup(deltas: number) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'harness-live-')), recoverActiveRuns: false });
  const stats = splitWrites(world);
  const sessions = durableSessions({ world, harness: chatterHarness(deltas), marks: false });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  const route = chatRoute(sessions);
  const post = (body: unknown) => route.POST(new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify(body) }));
  const get = (sessionId: string, lastEventId: string) =>
    route.GET(new Request(`http://x/api/chat?sessionId=${sessionId}`, { headers: { 'last-event-id': lastEventId } }));
  return { sessions, stats, post, get };
}

const expected = (text: string, n: number) => [...Array.from({ length: n }, (_, i) => ({ type: 'text', delta: `${text}:${i} é🙂` })), { type: 'idle' }];

describe('resumable live streams', () => {
  it('a reconnect mid-turn loses and repeats nothing, with every write split into several chunks', async () => {
    const { stats, post, get } = await setup(40);
    const first = await post({ text: 'a' });
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    const sessionId = first.headers.get('x-session-id')!;
    // Drop after a few events, while the turn is still streaming.
    const before = await readSse(first, (m) => events(m).length >= 7);
    const got = events(before);
    let cursor = lastId(before)!;
    // And again, twice, from whatever this reconnect had.
    for (const n of [5, 9]) {
      const again = await readSse(await get(sessionId, cursor), (m) => events(m).length >= n);
      got.push(...events(again));
      cursor = lastId(again)!;
    }
    const rest = await readSse(await get(sessionId, cursor));
    got.push(...events(rest));
    expect(rest.at(-1)?.event).toBe('end');
    expect(got).toEqual(expected('a', 40));
    // The World really did split writes, through lines.
    expect(stats.chunks).toBeGreaterThan(stats.writes);
    // The id of the event that settled the turn says so: an EventSource reconnecting with it stops.
    expect(lastId(rest)).toMatch(/;end$/);
    expect((await get(sessionId, lastId(rest)!)).status).toBe(204);
  });

  it('a reconnect from the start cursor (before any event arrived) replays the whole turn once', async () => {
    const { post, get } = await setup(10);
    const first = await post({ text: 'b' });
    const sessionId = first.headers.get('x-session-id')!;
    const start = first.headers.get('x-live-cursor')!;
    // The first message is a bare id for the start: what an EventSource that drops now resumes from.
    const opening = await readSse(first, (m) => m.length >= 1);
    expect(opening).toEqual([{ id: start }]);
    expect(decodeCursor(start)).toEqual({ startIndex: 0, lines: 0 });
    const all = await readSse(await get(sessionId, start));
    expect(events(all)).toEqual(expected('b', 10));
  });

  it("a session's second turn streams only what its message caused, and reconnects within it", async () => {
    const { post, get } = await setup(12);
    const one = await post({ text: 'c' });
    const sessionId = one.headers.get('x-session-id')!;
    expect(events(await readSse(one))).toEqual(expected('c', 12));
    const two = await post({ sessionId, text: 'd' });
    expect(decodeCursor(two.headers.get('x-live-cursor')!)!.startIndex).toBeGreaterThan(0);
    const part = await readSse(two, (m) => events(m).length >= 4);
    const rest = await readSse(await get(sessionId, lastId(part)!));
    expect([...events(part), ...events(rest)]).toEqual(expected('d', 12));
  });

  it('cursors match plain re-reads: every cursor resumes exactly past its event', async () => {
    const { sessions, post } = await setup(15);
    const r = await post({ text: 'e' });
    const sessionId = r.headers.get('x-session-id')!;
    await readSse(r);
    const all = (await readJsonLines(world!, sessionId, liveStreamName(sessionId))) as unknown[];
    const abort = new AbortController();
    const entries: { value: unknown; cursor: string }[] = [];
    for await (const entry of sessions.liveEntries(sessionId, { startIndex: 0, signal: abort.signal })) {
      entries.push(entry);
      if (entries.length === all.length) break;
    }
    expect(entries.map((e) => e.value)).toEqual(all);
    for (const k of [0, 3, 8, all.length - 2]) {
      const next = await sessions.live(sessionId, { cursor: entries[k]!.cursor, signal: abort.signal }).next();
      expect(next.value).toEqual(all[k + 1]);
    }
    abort.abort();
  });

  it('ends on an idle the log agrees with only later (a run-ahead drive), with no event after it', async () => {
    const state = (running: boolean) => ({ submissions: [], effectOrder: [{ status: running ? 'running' : 'completed' }] }) as unknown as SessionState;
    let landed = false;
    const source = {
      liveEnd: async () => 0,
      inspect: async () => state(!landed),
      async *liveEntries(_id: string, options?: { signal?: AbortSignal }) {
        yield { value: { type: 'text', delta: 'hi' }, cursor: encodeCursor({ startIndex: 0, lines: 1 }) };
        yield { value: { type: 'idle' }, cursor: encodeCursor({ startIndex: 0, lines: 2 }) };
        // The drive's last write lands after its idle; nothing more is written to the live stream.
        setTimeout(() => (landed = true), 400);
        await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
      },
    };
    const started = Date.now();
    const messages = await readSse(await liveResponse(source, 's', { untilSettled: true }));
    expect(events(messages)).toEqual([{ type: 'text', delta: 'hi' }, { type: 'idle' }]);
    expect(messages.at(-1)).toEqual({ id: '0.2;end', event: 'end', data: '{}' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not end on an idle that came before its own message is in the log (a message acknowledged before it is durable)", async () => {
    const empty = new Set<string>();
    let landed = false;
    let answered = false;
    const state = () =>
      ({
        submissions: landed ? [{ id: 'sub_1', kind: 'prompt' }] : [],
        placed: answered ? new Set(['sub_1']) : empty,
        withdrawn: empty,
        effectOrder: answered ? [{ status: 'completed' }] : [],
      }) as unknown as SessionState;
    const source = {
      liveEnd: async () => 0,
      inspect: async () => state(),
      async *liveEntries(_id: string, options?: { signal?: AbortSignal }) {
        // An idle from a drive that found nothing to do yet: the message is still in flight.
        yield { value: { type: 'idle' }, cursor: encodeCursor({ startIndex: 0, lines: 1 }) };
        await sleep(300);
        landed = true;
        await sleep(100);
        answered = true;
        yield { value: { type: 'text', delta: 'answer' }, cursor: encodeCursor({ startIndex: 0, lines: 2 }) };
        yield { value: { type: 'idle' }, cursor: encodeCursor({ startIndex: 0, lines: 3 }) };
        await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
      },
    };
    const messages = await readSse(await liveResponse(source, 's', { untilSettled: true, submissionId: 'sub_1' }));
    expect(events(messages)).toEqual([{ type: 'idle' }, { type: 'text', delta: 'answer' }, { type: 'idle' }]);
    expect(lastId(messages)).toBe('0.3;end');
  });

  it('refuses what it cannot serve', async () => {
    const { post, get } = await setup(1);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: 'x', kind: 'nope' })).status).toBe(400);
    expect((await get('wrun_x', 'not-a-cursor')).status).toBe(400);
    const authorized = chatRoute(
      { start: async () => ({ sessionId: 's' }), send: async () => 'id', inspect: async () => { throw new Error('unused'); }, liveEnd: async () => 0, liveEntries: () => { throw new Error('unused'); } },
      {
        authorize: () => {
          throw new Response('no', { status: 403 });
        },
      }
    );
    expect((await authorized.POST(new Request('http://x', { method: 'POST', body: '{"text":"hi"}' }))).status).toBe(403);
  });
});

describe('chatRoute authorize', () => {
  /** Sessions whose every turn fails at once (a `failed` settles a response without `inspect`). */
  const quick = (): ChatSessions & { sent: string[] } => {
    const sent: string[] = [];
    return {
      sent,
      start: async () => ({ sessionId: 'wrun_s' }),
      send: async (_id, text) => {
        sent.push(text);
        return 'sub_1';
      },
      inspect: async () => emptyState('wrun_s'),
      liveEnd: async () => 0,
      async *liveEntries() {
        yield { value: { type: 'failed' }, cursor: encodeCursor({ startIndex: 0, lines: 1 }) };
      },
    };
  };
  const post = () => new Request('http://x/api/chat', { method: 'POST', body: '{"text":"hi"}' });
  const get = () => new Request('http://x/api/chat?sessionId=wrun_s&cursor=0.0');
  const warned = Symbol.for('durable-harness//chat-route-no-authorize-warned');
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete (globalThis as { [warned]?: boolean })[warned];
  });

  it('refuses every request in production without authorize: a 401 that says to pass authorize or "public", logged once', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = quick();
    const route = chatRoute(sessions);
    for (const request of [post(), get(), post(), new Request('http://x/api/chat', { method: 'POST', body: 'not json' })]) {
      const res = await (request.method === 'POST' ? route.POST(request) : route.GET(request));
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unauthorized');
      expect(body.message).toBe(NO_AUTHORIZE_MESSAGE);
    }
    expect(NO_AUTHORIZE_MESSAGE).toContain('authorize: async (request, sessionId)');
    expect(NO_AUTHORIZE_MESSAGE).toContain("authorize: 'public'");
    expect(sessions.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(NO_AUTHORIZE_MESSAGE);
  });

  it("serves anyone in production with authorize: 'public', and asks a function otherwise", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const open = chatRoute(quick(), { authorize: 'public' });
    expect((await open.POST(post())).status).toBe(200);
    expect((await open.GET(get())).status).toBe(200);
    const asked: (string | undefined)[] = [];
    const checked = chatRoute(quick(), {
      authorize: (request, sessionId) => {
        asked.push(sessionId);
        if (request.headers.get('x-key') !== 'k') throw new Response('no', { status: 403 });
      },
    });
    expect((await checked.POST(post())).status).toBe(403);
    const ok = new Request('http://x/api/chat', { method: 'POST', body: '{"text":"hi"}', headers: { 'x-key': 'k' } });
    expect((await checked.POST(ok)).status).toBe(200);
    expect(asked).toEqual([undefined, undefined]);
  });

  it('is open outside production (next dev, tests) without authorize, and logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      const route = chatRoute(quick());
      expect((await route.POST(post())).status).toBe(200);
      expect((await route.GET(get())).status).toBe(200);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws at once for an authorize that is neither a function nor "public"', () => {
    for (const authorize of ['Public', 'none', true, null, {}]) {
      expect(() => chatRoute(quick(), { authorize: authorize as never })).toThrow(/authorize must be a function or 'public'/);
    }
  });
});

describe('isSettled', () => {
  const effect = (status: EffectRecord['status'], attempt: number): EffectRecord =>
    ({ key: `k${attempt}${status}`, stepId: `step_${status}_${attempt}`, name: 'tool.bash', replay: 'safe', input: {}, status, attempt, placed: [] }) as EffectRecord;
  const state = (...effects: EffectRecord[]) => {
    const s = emptyState('wrun_test');
    s.effectOrder.push(...effects);
    return s;
  };

  it('waits for an effect that is running, or created and not started', () => {
    expect(isSettled(state(effect('running', 1)))).toBe(false);
    expect(isSettled(state(effect('pending', 0)))).toBe(false);
  });

  it('does not wait for an effect a recovery released (a process harness calls the tool again under a new id)', () => {
    // The killed attempt: running when its process died, released back to pending by the recovery.
    expect(isSettled(state(effect('pending', 1), effect('completed', 1)))).toBe(true);
  });
});
