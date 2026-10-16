import { readFileSync } from 'node:fs';
import { PROCESS_ID } from 'harness-world/marks';
import { describe, expect, it } from 'vitest';
import { EVE_PID, type EveEvent, EveTranslator, eveClient } from './eve.ts';
import { applies, cellKey, EVE_CELL_KEY, parseCells, runBench } from './runner.ts';

/** Streams recorded from the eve agent (apps/demo/agent) on eve 0.69.0, world-local. */
const fixture = (name: string): EveEvent[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const at = (events: EveEvent[], type: string, n = 0) => Date.parse(events.filter((e) => e.type === type)[n]!.meta!.at!);
const label = (e: any) => (e.type === 'mark' ? `mark:${e.name}` : e.type);

describe('EveTranslator', () => {
  it('turns a write_file turn into the events and marks every lane emits', () => {
    const events = fixture('eve-tool-turn.ndjson');
    const tr = new EveTranslator();
    const out = events.flatMap((e) => tr.feed(e));
    expect(out.map(label)).toEqual([
      'mark:model.request',
      'mark:model.first_token',
      'mark:model.done',
      'mark:tool.start',
      'tool_start',
      'mark:tool.end',
      'tool_end',
      'mark:model.request',
      'mark:model.first_token',
      'text',
      'mark:model.done',
      'idle',
      'mark:idle',
    ]);
    const marks = out.filter((e) => e.type === 'mark') as any[];
    expect(new Set(marks.map((m) => m.pid))).toEqual(new Set([EVE_PID]));
    // Server times from meta.at: the request at step.started, the tool call's end of streaming as model.done.
    expect(marks[0]).toMatchObject({ name: 'model.request', key: 'turn_0:0', t: at(events, 'step.started') });
    expect(marks[1]).toMatchObject({ name: 'model.first_token', key: 'turn_0:0', t: at(events, 'action.input.appended') });
    expect(marks[2]).toMatchObject({ name: 'model.done', key: 'turn_0:0', t: at(events, 'actions.requested') });
    expect(marks.find((m) => m.name === 'tool.end')).toMatchObject({ t: at(events, 'action.result'), tool: 'write_file' });
    // A text step is done at its last output, not at step.completed.
    expect(marks.filter((m) => m.name === 'model.done')[1]).toMatchObject({ key: 'turn_0:1', t: at(events, 'message.completed') });
    expect(out.find((e) => e.type === 'tool_start')).toEqual({ type: 'tool_start', name: 'write_file', args: { path: 'notes.txt', content: 'hi' } });
    expect(out.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', name: 'write_file', output: 'wrote 2 bytes to /workspace/notes.txt' });
    expect(out.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'done' });
  });

  it('reports a steer as placed by the model request that carries it', () => {
    const events = fixture('eve-steer.ndjson');
    const steer = '47831cfb-8adc-462f-bbf6-c9f0ce02b1ac';
    const out = events.flatMap(((tr) => (e: EveEvent) => tr.feed(e))(new EveTranslator(new Set([steer]))));
    const requests = out.filter((e: any) => e.type === 'mark' && e.name === 'model.request') as any[];
    expect(requests).toHaveLength(2);
    expect(requests[0].placed).toBeUndefined();
    expect(requests[1].placed).toEqual([steer]);
    expect(requests[1].t).toBe(at(events, 'step.started', 1));
    expect(out.map(label).slice(-2)).toEqual(['idle', 'mark:idle']);
  });

  it('reports a failed turn as `failed` (as the durable lanes do) then idle, and skips transport control records', () => {
    const tr = new EveTranslator();
    expect(tr.feed({ $eve: 'stream.lease-ended' } as EveEvent)).toEqual([]);
    const out = tr.feed({ type: 'turn.failed', data: { code: 'MODEL_CALL_FAILED', message: 'boom' }, meta: { at: '2026-10-01T00:00:00.000Z' } });
    expect(out.map(label)).toEqual(['failed', 'idle', 'mark:idle']);
    expect(out[0]).toEqual({ type: 'failed', message: 'boom' });
    // A failed session is terminal: no turn ends with it.
    expect(tr.feed({ type: 'session.failed', data: { code: 'X' } }).map(label)).toEqual(['failed']);
  });

  it('fails a bench sample at once on a failed turn instead of timing out', async () => {
    const lines = [
      { type: 'turn.started', data: { turnId: 'turn_0' }, meta: { at: '2026-10-01T00:00:00.000Z' } },
      { type: 'step.started', data: { turnId: 'turn_0', stepIndex: 0 }, meta: { at: '2026-10-01T00:00:00.010Z' } },
      { type: 'turn.failed', data: { message: 'Gateway 503' }, meta: { at: '2026-10-01T00:00:00.500Z' } },
    ].map((e) => JSON.stringify(e));
    let posted = false;
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/eve/v1/session')) return Response.json({ sessionId: 'wrun_f' }, { status: 202 });
      if (url.includes('/stream')) {
        const start = Number(new URL(url, 'http://x').searchParams.get('startIndex') ?? 0);
        return new Response(
          new ReadableStream({
            async start(c) {
              while (!posted) await new Promise((r) => setTimeout(r, 5));
              for (const l of lines.slice(start)) c.enqueue(new TextEncoder().encode(`${l}\n`));
            },
          })
        );
      }
      posted = true;
      return Response.json({ deliveryId: 'd' }, { status: 202 });
    }) as typeof globalThis.fetch;
    const t0 = Date.now();
    const report = await runBench({ cells: parseCells([EVE_CELL_KEY], []), scenarios: ['chat'], n: 1, warmup: 0, client: async () => eveClient({ fetch }) });
    expect(report.results[0]!.samples[0]!.error).toMatch(/session failed: Gateway 503/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('marks a failed tool call as an error', () => {
    const tr = new EveTranslator();
    const [, end] = tr.feed({ type: 'action.result', data: { status: 'failed', result: { callId: 'c', kind: 'tool-error', output: 'oldText not found', toolName: 'edit_file' } } });
    expect(end).toEqual({ type: 'tool_end', name: 'edit_file', isError: true, output: 'oldText not found' });
  });
});

describe('eveClient', () => {
  /** A fake eve: sessions, messages (409 until the inbox is up), and a stream that ends after each chunk of lines. */
  function fakeEve(lines: string[]) {
    const calls: { url: string; body?: any }[] = [];
    let notReady = 1;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/eve/v1/session')) return Response.json({ ok: true, sessionId: 'wrun_1', status: 'accepted' }, { status: 202 });
      if (url.includes('/stream')) {
        const start = Number(new URL(url, 'http://x').searchParams.get('startIndex') ?? 0);
        // Half the lines per response, so the client has to reopen from where it stopped.
        const chunk = lines.slice(start, start + Math.ceil(lines.length / 2));
        if (!chunk.length) return new Response(new ReadableStream({ start() {} }));
        return new Response(`${chunk.join('\n')}\n`);
      }
      if (notReady-- > 0) return new Response('{"code":"session_not_ready"}', { status: 409 });
      return Response.json({ ok: true, sessionId: 'wrun_1', status: 'accepted', deliveryId: 'd_steer' }, { status: 202 });
    }) as typeof globalThis.fetch;
    return { fetch: fakeFetch, calls };
  }

  it('creates a session, retries a send while the inbox starts, and reports a steer', async () => {
    const eve = fakeEve([]);
    const client = eveClient({ fetch: eve.fetch, notReadyMs: 5000 });
    const id = await client.start('pi');
    expect(id).toBe('wrun_1');
    const seen: any[] = [];
    const stop = client.live(id, (e) => seen.push(e));
    const first = await client.send(id, 'steer now', 'steer');
    const second = await client.send(id, 'next', 'prompt');
    stop();
    // The refused attempt and the wait before the accepted one: the session starting, reported apart from the turn.
    expect(first.notReadyMs).toBeGreaterThanOrEqual(90);
    expect(second).toEqual({});
    const posts = eve.calls.filter((c) => c.body && c.url.includes('/session/'));
    expect(posts.map((c) => c.body)).toEqual([{ message: 'steer now' }, { message: 'steer now' }, { message: 'next' }]);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'mark', name: 'submit', kind: 'steer', id: 'd_steer', pid: PROCESS_ID }));
  });

  it('streams a recorded turn across reconnects without repeating events', async () => {
    const lines = readFileSync(new URL('./fixtures/eve-tool-turn.ndjson', import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
    const eve = fakeEve(lines);
    const client = eveClient({ fetch: eve.fetch });
    const seen: any[] = [];
    let ready = false;
    const stop = client.live('wrun_1', (e) => seen.push(e), () => (ready = true));
    for (let i = 0; i < 100 && !seen.some((e) => e.type === 'idle'); i++) await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(ready).toBe(true);
    expect(seen.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'mark' && e.name === 'model.request')).toHaveLength(2);
    const starts = eve.calls.filter((c) => c.url.includes('/stream')).map((c) => new URL(c.url, 'http://x').searchParams.get('startIndex'));
    expect(starts.slice(0, 2)).toEqual([null, String(Math.ceil(lines.length / 2))]);
    expect(eve.calls.filter((c) => c.url.includes('/stream')).every((c) => c.url.includes('streamControlVersion=1'))).toBe(true);
  });

  /** A stream whose first connection delivers `firstN` lines and then ends (`lease`) or goes silent without ending. */
  function stallingEve(lines: string[], firstN: number, mode: 'stall' | 'lease') {
    const opens: (string | null)[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = Number(new URL(String(input), 'http://x').searchParams.get('startIndex') ?? 0);
      opens.push(new URL(String(input), 'http://x').searchParams.get('startIndex'));
      const enc = new TextEncoder();
      const chunk = opens.length === 1 ? lines.slice(0, firstN) : lines.slice(start);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const l of chunk) c.enqueue(enc.encode(`${l}\n`));
            if (opens.length === 1 && mode === 'lease') {
              c.enqueue(enc.encode('{"$eve":"stream.lease-ended","version":1}\n'));
              c.close();
            } else if (opens.length > 1) c.close();
            // 'stall': the first connection stays open with nothing more, until aborted.
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        })
      );
    }) as typeof globalThis.fetch;
    return { fetch, opens };
  }

  const recorded = () => readFileSync(new URL('./fixtures/eve-tool-turn.ndjson', import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
  const until = async (pred: () => boolean, ms = 3000) => {
    for (const t0 = Date.now(); !pred() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 10));
  };

  it('reopens a connection that goes silent, from the last event it delivered, and the turn still ends', async () => {
    const lines = recorded();
    const textAt = lines.findIndex((l) => l.includes('"message.appended"'));
    const eve = stallingEve(lines, textAt + 1, 'stall');
    const seen: any[] = [];
    const stop = eveClient({ fetch: eve.fetch, idleReconnectMs: 100 }).live('wrun_1', (e) => seen.push(e));
    await until(() => seen.some((e) => e.type === 'mark' && e.name === 'idle'));
    stop();
    // The text arrived on the first connection, the turn's end only after the idle reopen.
    expect(seen.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(seen.some((e) => e.type === 'mark' && e.name === 'idle')).toBe(true);
    expect(eve.opens.slice(0, 2)).toEqual([null, String(textAt + 1)]);
  });

  it('reopens at once when eve says the lease ended, without counting the control record', async () => {
    const lines = recorded();
    const eve = stallingEve(lines, 5, 'lease');
    const seen: any[] = [];
    const t0 = Date.now();
    const stop = eveClient({ fetch: eve.fetch, idleReconnectMs: 60_000 }).live('wrun_1', (e) => seen.push(e));
    await until(() => seen.some((e) => e.type === 'mark' && e.name === 'idle'));
    stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(eve.opens.slice(0, 2)).toEqual([null, '5']);
    expect(seen.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    // The reopen is reported, as the server lanes' client reports theirs (it flags the turn alike).
    expect(seen.filter((e) => e.type === 'reconnect')).toEqual([expect.objectContaining({ type: 'reconnect', n: 1 })]);
  });
});

describe('eve in the bench', () => {
  it('is one cell, whatever harnesses the rest use, and only runs what means something for it', () => {
    const cells = parseCells(['server/on', EVE_CELL_KEY], ['pi', 'fx']);
    expect(cells.map(cellKey)).toEqual(['server/on/pi', 'server/on/fx', 'server/on/eve']);
    const eve = cells[2]!;
    expect(['chat', 'tool-write', 'tool-bash', 'steer'].every((s) => applies(s as never, eve))).toBe(true);
    expect(['crash', 'crash-silent', 'handoff-function', 'handoff-sandbox'].some((s) => applies(s as never, eve))).toBe(false);
  });

  /** A fake eve whose stream plays a recorded session once a message arrives (the steer's delivery id is the recorded one). */
  function replayingEve(file: string, steerId?: string, notReady = 0) {
    const lines = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
    let messages = 0;
    let wake = () => {};
    const posted = new Promise<void>((r) => (wake = r));
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/eve/v1/session')) return Response.json({ ok: true, sessionId: 'wrun_r' }, { status: 202 });
      if (url.includes('/stream')) {
        const start = Number(new URL(url, 'http://x').searchParams.get('startIndex') ?? 0);
        if (start >= lines.length) return new Response(new ReadableStream({ start() {} }));
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(c) {
              await posted;
              for (const line of lines.slice(start)) {
                // The steer scenario sends its steer once it sees the tool start.
                if (steerId && line.includes('"action.result"')) while (messages < 2) await new Promise((r) => setTimeout(r, 5));
                c.enqueue(enc.encode(`${line}\n`));
                await new Promise((r) => setTimeout(r, 1));
              }
              c.close();
            },
          })
        );
      }
      // A prewarmed session whose inbox is not up yet.
      if (notReady-- > 0) return new Response('{"code":"session_not_ready"}', { status: 409 });
      messages++;
      wake();
      return Response.json({ ok: true, deliveryId: messages === 2 && steerId ? steerId : `d_${messages}` }, { status: 202 });
    }) as typeof fetch;
  }

  it('measures a tool turn from eve\'s own marks', async () => {
    const report = await runBench({
      cells: parseCells([EVE_CELL_KEY], []),
      scenarios: ['tool-write'],
      n: 1,
      warmup: 0,
      client: async () => eveClient({ fetch: replayingEve('eve-tool-turn.ndjson') }),
    });
    const sample = report.results[0]!.samples[0]!;
    expect(sample.error).toBeUndefined();
    const events = fixture('eve-tool-turn.ndjson');
    // Server clock: tool call streamed (model.done) → next step started; the tool's own run inside it.
    expect(sample.metrics.toolGap).toBe(at(events, 'step.started', 1) - at(events, 'actions.requested'));
    expect(sample.metrics.toolMs).toBe(at(events, 'action.result') - at(events, 'actions.requested'));
    expect(sample.metrics.modelTtft).toBe(at(events, 'action.input.appended') - at(events, 'step.started'));
    // One tool: model → tool → model.
    expect(sample.metrics.modelCalls).toBe(2);
    expect(sample.metrics.turn).toBeGreaterThan(0);
  });

  it('starts the turn at the attempt eve accepted, not while its prewarmed session was starting', async () => {
    const run = (notReady: number) =>
      runBench({
        cells: parseCells([EVE_CELL_KEY], []),
        scenarios: ['tool-write'],
        n: 1,
        warmup: 0,
        client: async () => eveClient({ fetch: replayingEve('eve-tool-turn.ndjson', undefined, notReady) }),
      }).then((r) => r.results[0]!.samples[0]!);
    const ready = await run(0);
    const starting = await run(2);
    expect(ready.error).toBeUndefined();
    expect(starting.error).toBeUndefined();
    expect(ready.metrics.notReadyMs).toBe(0);
    // Two refusals: a 100 ms then a 200 ms wait before the accepted attempt.
    expect(starting.metrics.notReadyMs).toBeGreaterThanOrEqual(290);
    // None of it in the turn: the replay starts once a message is accepted, so the two turns match.
    expect(Math.abs(starting.metrics.turn! - ready.metrics.turn!)).toBeLessThan(150);
    expect(Math.abs(starting.metrics.ttft! - ready.metrics.ttft!)).toBeLessThan(150);
  });

  it('measures steer to effect: the steer accepted → the model request that carries it', async () => {
    const report = await runBench({
      cells: parseCells([EVE_CELL_KEY], []),
      scenarios: ['steer'],
      n: 1,
      warmup: 0,
      client: async () => eveClient({ fetch: replayingEve('eve-steer.ndjson', '47831cfb-8adc-462f-bbf6-c9f0ce02b1ac') }),
    });
    const sample = report.results[0]!.samples[0]!;
    expect(sample.error).toBeUndefined();
    expect(sample.metrics.steerToEffect).toBeGreaterThanOrEqual(0);
    expect(sample.metrics.steerCommit).toBeGreaterThanOrEqual(0);
  });
});
