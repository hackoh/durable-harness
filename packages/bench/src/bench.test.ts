import { type DriveContext, EffectFailure, type Harness, rawSessions } from 'harness-world';
import { describe, expect, it, vi } from 'vitest';
import { type BenchClient, baselineOf, compare, formatReport, handbackSpan, parseCells, quantile, rawFunctionClient, rawTurn, runBench, SCENARIOS, summarize, summarizeSamples } from './index.ts';
import { mark, PROCESS_ID } from 'harness-world';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A scripted "model" with fixed latencies: every submission is one model
 * effect (first token after `ttftMs`), a tool call when the prompt asks for
 * one, then a second model effect. Steers land at the next model request.
 */
function scripted(ttftMs: number, extraMs = 0): Harness {
  return {
    name: 'pi',
    async drive(ctx: DriveContext) {
      let n = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      for (let next = ctx.pending(); next.length; next = ctx.pending()) {
        const s = next[0]!;
        const wantsTool = /tool|Run|Write/.test(s.text ?? '');
        const model = async (key: string, placed: string[]) =>
          ctx.effect(key, { name: 'model', replay: 'safe', input: s.text, placed }, async () => {
            await sleep(ttftMs + extraMs);
            ctx.mark?.('model.first_token', { key });
            ctx.live({ type: 'text', delta: 'ok' });
            await sleep(5);
            return 'ok';
          });
        await model(`model:${n++}`, [s.id]);
        if (wantsTool) {
          ctx.live({ type: 'tool_start', name: 'bash' });
          try {
            await ctx.effect(`tool:${n}`, { name: 'tool.bash', replay: 'never', input: {} }, async () => {
              await sleep(60);
              return 'done';
            });
          } catch (err) {
            if (!(err instanceof EffectFailure)) throw err;
          }
          ctx.live({ type: 'tool_end', name: 'bash' });
          // Steers that arrived during the tool ride the next request.
          const steers = ctx.pending().filter((p) => p.kind === 'steer').map((p) => p.id);
          await model(`model:${n++}`, steers);
        }
      }
      ctx.live({ type: 'idle' });
    },
  };
}

function rawClient(harness: Harness): BenchClient {
  const raw = rawSessions({ harness });
  return {
    signalsReady: true,
    start: async (_h, prompt) => (await raw.start(prompt ? { prompt } : {})).sessionId,
    send: async (id, text, kind) => {
      await raw.send(id, text, kind);
    },
    live(id, onEvent, onReady) {
      const off = raw.subscribe(id, onEvent);
      onReady?.();
      return off;
    },
  };
}

describe('stats', () => {
  it('computes quantiles like numpy', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(summarize([5, 1, 3])).toEqual({ n: 3, p50: 3, p90: 5, min: 1, max: 5, mean: 3 });
    expect(summarize([Number.NaN])).toBeUndefined();
  });
});

describe('runBench', () => {
  it('measures every scenario against the same-place raw baseline and checks budgets', async () => {
    // "Durable" is the raw harness with 250ms of extra latency per model call.
    const clients: Record<string, BenchClient> = {
      'server/off': rawClient(scripted(40)),
      'server/on': rawClient(scripted(40, 250)),
    };
    const progress: string[] = [];
    const report = await runBench({
      cells: [
        { mode: 'server', durability: 'off', harness: 'pi' },
        { mode: 'server', durability: 'on', harness: 'pi' },
      ],
      scenarios: ['chat', 'tool-bash', 'steer'],
      n: 3,
      warmup: 1,
      idleMs: 20,
      client: async (cell) => clients[`${cell.mode}/${cell.durability}`]!,
      onProgress: (p) => progress.push(`${p.scenario}:${p.cell.durability}:${p.round}${p.sample?.error ? `:${p.sample.error}` : ''}`),
    });
    expect(progress.filter((p) => p.includes(':-1'))).toHaveLength(6); // one warm-up per cell and scenario
    for (const r of report.results) {
      expect(r.samples).toHaveLength(3);
      expect(r.samples.every((s) => !s.error)).toBe(true);
    }
    const chatOn = report.results.find((r) => r.scenario === 'chat' && r.cell.durability === 'on')!;
    const chatOff = report.results.find((r) => r.scenario === 'chat' && r.cell.durability === 'off')!;
    expect(chatOff.stats.ttft!.p50).toBeGreaterThanOrEqual(40);
    expect(chatOn.stats.ttft!.p50 - chatOff.stats.ttft!.p50).toBeGreaterThan(200);
    // The model's own latency as its driver saw it includes the injected delay here.
    expect(chatOn.stats.modelTtft!.p50).toBeGreaterThanOrEqual(290);
    expect(chatOn.stats.followupTtft).toBeDefined();
    const tool = report.results.find((r) => r.scenario === 'tool-bash' && r.cell.durability === 'on')!;
    expect(tool.stats.toolGap!.p50).toBeGreaterThanOrEqual(60);
    expect(tool.stats.toolMs!.p50).toBeGreaterThanOrEqual(55);
    const steer = report.results.find((r) => r.scenario === 'steer' && r.cell.durability === 'off')!;
    expect(steer.stats.steerToEffect).toBeDefined();

    const ttft = report.comparisons.find((c) => c.scenario === 'chat' && c.metric === 'ttft')!;
    expect(ttft.budget).toBe('TTFT ≤ raw + 150 ms');
    expect(ttft.pass).toBe(false);
    expect(ttft.delta).toBeGreaterThan(200);
    // The interval of the per-round difference is past the budget: over, not inconclusive.
    expect(ttft.interval!.lo).toBeGreaterThan(150);
    expect(ttft.verdict).toBe('over');
    expect(ttft.against).toBe('server/off/pi');
    expect(formatReport(report)).toContain('## chat');
    expect(formatReport(report)).toContain('OVER');
    // Overheads per sample, as /compare computes them: the model's own time taken out.
    expect(chatOn.stats.ttftOverhead).toBeDefined();
    expect(chatOn.stats.ttftOverhead!.p50).toBeLessThan(chatOn.stats.ttft!.p50);
  });

  it('refuses cells a harness has no lane for, with the reason', () => {
    expect(parseCells(['server/on'], ['pi', 'claude-code']).map((c) => c.harness)).toEqual(['pi', 'claude-code']);
    expect(() => parseCells(['server/off'], ['codex'])).toThrow(/Wrapped \(no World\) runs Pi and fx only; codex has no raw lane/);
    expect(() => parseCells(['server/native'], ['opencode'])).toThrow(/no native baseline for opencode yet/);
    expect(() => parseCells(['tab/on'], ['claude-code'])).toThrow(/claude-code runs on the server only/);
    const skipped: string[] = [];
    expect(parseCells(['server/off', 'server/on'], ['pi', 'codex'], (why) => skipped.push(why)).map((c) => `${c.durability}/${c.harness}`)).toEqual(['off/pi', 'on/pi', 'on/codex']);
    expect(skipped).toEqual(['server/off: Wrapped (no World) runs Pi and fx only; codex has no raw lane.']);
  });

  it('a budget whose interval spans it is inconclusive', () => {
    const sample = (v: number) => ({ metrics: { ttft: v }, at: '' });
    const off = { cell: { mode: 'server' as const, durability: 'off' as const, harness: 'pi' }, scenario: 'chat' as const, samples: [100, 100, 100, 100, 100, 100].map(sample), stats: { ttft: summarize([100])! } };
    const on = { cell: { mode: 'server' as const, durability: 'on' as const, harness: 'pi' }, scenario: 'chat' as const, samples: [130, 400, 90, 300, 110, 260].map(sample), stats: { ttft: summarize([130, 400, 90, 300, 110, 260])! } };
    const c = compare([off, on]).find((x) => x.metric === 'ttft')!;
    expect(c.verdict).toBe('inconclusive');
  });

  it('records a failing sample instead of aborting the run', async () => {
    const broken: BenchClient = {
      signalsReady: true,
      start: async () => {
        throw new Error('no server');
      },
      send: async () => {},
      live: () => () => {},
    };
    const report = await runBench({ cells: [{ mode: 'tab', durability: 'on', harness: 'fx' }], scenarios: ['chat'], n: 2, warmup: 0, client: async () => broken });
    expect(report.results[0]!.samples.map((s) => s.error)).toEqual(['no server', 'no server']);
    expect(report.results[0]!.stats).toEqual({});
  });

  it('takes a throttled sample again after waiting', async () => {
    const inner = rawClient(scripted(5));
    let calls = 0;
    const flaky: BenchClient = {
      ...inner,
      start: async (h, p) => {
        if (calls++ === 0) throw new Error('/api/sessions 500 ThrottleError: Too many requests — please retry later');
        return inner.start(h, p);
      },
    };
    const logs: string[] = [];
    const report = await runBench({
      cells: [{ mode: 'server', durability: 'on', harness: 'pi' }],
      scenarios: ['tool-bash'],
      n: 1,
      warmup: 0,
      throttleWaitMs: 10,
      client: async () => flaky,
      log: (m) => logs.push(m),
    });
    expect(report.results[0]!.samples[0]!.error).toBeUndefined();
    expect(logs).toEqual(['throttled; retrying in 0.01s']);
  });

  it('skips scenarios that do not apply to a cell, and pairs hybrid with the tab baseline', async () => {
    expect(baselineOf({ mode: 'hybrid', durability: 'on', harness: 'fx' })).toEqual({ mode: 'tab', durability: 'off', harness: 'fx' });
    expect(baselineOf({ mode: 'sandbox', durability: 'on', harness: 'pi' })).toEqual({ mode: 'server', durability: 'off', harness: 'pi' });
    const report = await runBench({
      cells: [{ mode: 'tab', durability: 'off', harness: 'pi' }],
      scenarios: ['handoff-function', 'crash'],
      n: 1,
      client: async () => {
        throw new Error('not called');
      },
    });
    expect(report.results).toEqual([]);
    expect(compare([])).toEqual([]);
  });
});

describe('raw Function client', () => {
  /** A fetch that serves `/api/bench/raw` the way the route does, from a fresh process per request. */
  const fakeFunction = (harness: () => Harness) => {
    const bodies: any[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const encoder = new TextEncoder();
      const raw = rawSessions({ harness: harness() });
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          await rawTurn(raw, body, (line) => c.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    return { fetchImpl, bodies };
  };

  it('carries the session between stateless turns, and runs a steer sent mid-turn as the next one', async () => {
    const fn = fakeFunction(() => scripted(20));
    const client = rawFunctionClient({ fetch: fn.fetchImpl });
    const id = await client.start('pi');
    const events: any[] = [];
    client.live(id, (e) => events.push(e));
    await client.send(id, 'hello', 'prompt');
    // Mid-turn: a Function in flight cannot be reached, so this waits.
    await client.send(id, 'faster', 'steer');
    await until(() => events.filter((e) => e.type === 'mark' && e.name === 'idle').length === 2);
    await until(() => (client.snapshot(id)?.submissions.length === 2 ? true : undefined));
    expect(fn.bodies.map((b) => [b.text, b.kind, !!b.snapshot])).toEqual([
      ['hello', 'prompt', false],
      ['faster', 'steer', true],
    ]);
    const snap = client.snapshot(id)!;
    expect(snap.effects.map((e) => e.name)).toEqual(['model', 'model']);
    expect(events.some((e) => e.type === 'state')).toBe(true);
  });

  it('targets the VM raw baseline (lane=vm, the session it runs beside) when given vmRunId', async () => {
    const urls: string[] = [];
    const fn = fakeFunction(() => scripted(5));
    const fetchImpl: typeof fetch = async (url, init) => {
      urls.push(String(url));
      return fn.fetchImpl(url, init);
    };
    const client = rawFunctionClient({ fetch: fetchImpl }, { vmRunId: 'wrun_vm' });
    const id = await client.start('pi');
    const events: any[] = [];
    client.live(id, (e) => events.push(e));
    await client.send(id, 'hello', 'prompt');
    await until(() => events.some((e) => e.type === 'mark' && e.name === 'idle'));
    expect(urls[0]).toMatch(/\/api\/bench\/raw\?lane=vm$/);
    expect(fn.bodies[0].runId).toBe('wrun_vm');
  });

  it('runs a scripted steer inside the invocation', async () => {
    const fn = fakeFunction(() => scripted(20));
    const client = rawFunctionClient({ fetch: fn.fetchImpl });
    const id = await client.start('pi');
    const events: any[] = [];
    client.live(id, (e) => events.push(e));
    await client.runScripted(id, 'Run a tool', [{ on: 'tool_start', text: 'steer!', kind: 'steer' }]);
    expect(fn.bodies).toHaveLength(1);
    const steer = events.find((e) => e.type === 'mark' && e.name === 'submit' && e.kind === 'steer');
    const carrier = events.find((e) => e.type === 'mark' && e.name === 'model.request' && e.placed?.includes(steer.id));
    expect(carrier).toBeDefined();
  });
});

async function until<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(10);
  }
}

describe('handback measurement', () => {
  const seen = (event: unknown, at: number) => ({ event, at, index: 0 });
  const own = (name: string, t: number) => ({ type: 'mark', name, t, pid: PROCESS_ID, runId: 'r', to: 'browser' });
  it('starts at whichever evidence reached this tab first, in its own clock', () => {
    // The server's line lags behind its hint: the tab noticed and drove first.
    const back = seen({ type: 'lane', to: 'browser' }, 1_000);
    const noticed = seen(own('handoff.noticed', 600), 900);
    const driven = seen(own('handoff.picked', 640), 950);
    expect(handbackSpan(back, noticed, driven)).toBe(40);
    // The line arrived first.
    expect(handbackSpan(seen({ type: 'lane', to: 'browser' }, 500), noticed, driven)).toBe(140);
    expect(handbackSpan(back, undefined, undefined)).toBeUndefined();
  });

  /**
   * A Hybrid session as the scenario sees it: on send, the tab hands the
   * machine tool to `firstTo`; a sandbox lane then runs it and hands back.
   * `hostAfterMs`: when its host attaches (undefined: never).
   */
  function hybridClient(firstTo: 'sandbox' | 'function', hostAfterMs: number | undefined, hostAnswers = true): BenchClient & { sends: number } {
    const subs = new Set<(e: unknown) => void>();
    const emit = (e: unknown) => subs.forEach((fn) => fn(e));
    const startedAt = Date.now();
    const client = {
      sends: 0,
      signalsReady: true,
      start: async () => 'wrun_x',
      async send() {
        client.sends++;
        setTimeout(() => {
          emit(mark('wrun_x', 'handoff.sent', { from: 'browser', to: firstTo, reason: `tool.sandbox_exec needs the ${firstTo} lane` }));
          if (firstTo !== 'sandbox') return;
          // The host's wake probe failed: the session went to a function, which drives it.
          if (!hostAnswers) return emit({ ...mark('wrun_x', 'drive.start'), pid: 'p_fn', lane: 'function' });
          const lane = (name: Parameters<typeof mark>[1], f = {}) => emit({ ...mark('wrun_x', name, f), pid: 'p_vm', lane: 'sandbox' });
          lane('drive.start');
          lane('tool.start');
          lane('tool.end');
          lane('handoff.sent', { from: 'sandbox', to: 'browser' });
          emit(mark('wrun_x', 'handoff.picked', { from: 'sandbox', to: 'browser' }));
        }, 5);
      },
      live(_id: string, onEvent: (e: unknown) => void, onReady?: () => void) {
        subs.add(onEvent);
        onReady?.();
        return () => subs.delete(onEvent);
      },
      async hostReady(_id: string, timeoutMs: number) {
        if (hostAfterMs === undefined) {
          await sleep(timeoutMs);
          return false;
        }
        await sleep(Math.max(0, hostAfterMs - (Date.now() - startedAt)));
        return true;
      },
    };
    return client;
  }

  it('handoff-sandbox waits for the host, reports when it attached, and times the tab → sandbox hop', async () => {
    const client = hybridClient('sandbox', 80);
    const r = await SCENARIOS['handoff-sandbox']({ client, harness: 'hybrid' });
    expect(r.metrics.hostReady).toBeGreaterThanOrEqual(70);
    expect(r.metrics.tabToServer).toBeGreaterThanOrEqual(0);
    expect(r.metrics.serverToTab).toBeDefined();
  });

  it('handoff-sandbox fails at once when the tool goes to a function, instead of waiting for a sandbox handoff', async () => {
    const client = hybridClient('function', 0);
    const t0 = Date.now();
    await expect(SCENARIOS['handoff-sandbox']({ client, harness: 'hybrid' })).rejects.toThrow(/handed to the function lane/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('handoff-sandbox fails at once when a function takes the session from a host that did not answer', async () => {
    const client = hybridClient('sandbox', 0, false);
    const t0 = Date.now();
    await expect(SCENARIOS['handoff-sandbox']({ client, harness: 'hybrid' })).rejects.toThrow(/did not take the handoff/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('handoff-sandbox does not send when no host attaches', async () => {
    const client = hybridClient('sandbox', undefined);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const p = SCENARIOS['handoff-sandbox']({ client, harness: 'hybrid' });
      const failed = expect(p).rejects.toThrow(/did not attach/);
      await vi.advanceTimersByTimeAsync(61_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
    expect(client.sends).toBe(0);
  });

  it('counts samples that could not measure a metric instead of hiding them', () => {
    const stats = summarizeSamples([{ metrics: { a: 1, b: 5 } }, { metrics: { a: undefined, b: 7 } }, { metrics: { a: 3 } }]);
    expect(stats.a).toMatchObject({ n: 2, missing: 1 });
    expect(stats.b!.missing).toBeUndefined();
  });
});

describe('live over HTTP', () => {
  it('reopens a live subscription whose connection dies and delivers each event once', async () => {
    const { liveOverHttp } = await import('./http.ts');
    const all = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
    let connections = 0;
    // First connection: two events, then the Function serving it dies.
    // Every reconnect replays from the start with whatever exists by then.
    const fakeFetch = (async () => {
      const upTo = ++connections === 1 ? 2 : 4;
      const text = ': ready\n\n' + all.slice(0, upTo).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            if (connections === 1) c.error(new Error('socket hang up'));
            else c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }) as typeof fetch;
    const seen: number[] = [];
    let ready = 0;
    const stop = liveOverHttp({ origin: 'http://x', fetch: fakeFetch }, 's', (e) => seen.push(e.n), () => ready++, 0, 5);
    const start = Date.now();
    while (seen.length < 4 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(ready).toBe(1);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it('reopens a connection that goes silent and picks up what it missed', async () => {
    const { liveOverHttp } = await import('./http.ts');
    let connections = 0;
    // The first connection stalls after one event; the stream has two.
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const first = ++connections === 1;
      const events = first ? [{ n: 1 }] : [{ n: 1 }, { n: 2 }];
      const text = ': ready\n\n' + events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            if (!first) c.close();
            init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
          },
        })
      );
    }) as typeof fetch;
    const seen: number[] = [];
    const stop = liveOverHttp({ origin: 'http://x', fetch: fakeFetch }, 's', (e) => seen.push(e.n), undefined, 0, 5, 50);
    const start = Date.now();
    while (seen.length < 2 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(seen).toEqual([1, 2]);
  });

  it('delivers an event a replay moved behind one that never became durable', async () => {
    const { liveOverHttp } = await import('./http.ts');
    let connections = 0;
    // The first connection (served by the process that died) carried an
    // `ack` that never became durable; the replay has the crash instead.
    const streams = [
      [{ n: 'submit' }, { n: 'ack-lost' }],
      [{ n: 'submit' }, { n: 'chaos' }, { n: 'recover' }],
    ];
    const fakeFetch = (async () => {
      const i = Math.min(connections++, 1);
      const text = ': ready\n\n' + streams[i]!.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        })
      );
    }) as typeof fetch;
    const seen: string[] = [];
    const stop = liveOverHttp({ origin: 'http://x', fetch: fakeFetch }, 's', (e) => seen.push(e.n), undefined, 0, 5);
    const start = Date.now();
    while (seen.length < 4 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(seen).toEqual(['submit', 'ack-lost', 'chaos', 'recover']);
  });
});

describe('crash spans', () => {
  it('are timed from server-written times, not arrival, when both events carry them', async () => {
    const { serverSpan } = await import('./scenarios.ts');
    const died = { event: { type: 'chaos', t: 1000, pid: 'p_a' }, at: 50_000, index: 0 };
    const next = { event: { type: 'mark', name: 'drive.start', t: 2400, pid: 'p_b' }, at: 50_003, index: 1 };
    expect(serverSpan(died, next)).toBe(1400);
    expect(serverSpan({ ...died, event: { type: 'chaos' } }, next)).toBeUndefined();
  });
});
