/**
 * P0.1 and P0.2, from a Function in iad1: the deployed half of the probes.
 *
 * POST /api/hold?hold=780 boots one VM in iad1 running `echo-server.js`,
 * dials it through the port ingress the way a driver dials the relay, and
 * streams NDJSON while it:
 *
 * - P0.2: times 200 serial WebSocket echoes, 50 HTTP `/health` round trips
 *   and 10 `writeStdin` echoes (the fallback transport) from this Function;
 * - P0.1: holds two WebSockets for `hold` seconds: one pinged every 5 s (as
 *   the driver's heartbeat does), one silent until the end, then echoes once
 *   on each still open and reports how long each stayed open and how it
 *   closed.
 *
 * POST, not GET, so a link prefetcher or crawler can't boot a VM; and
 * `deploy.sh` refuses a project without deployment protection, so only a
 * team member (through `vercel curl`) reaches it.
 * The VM is deleted at the end; if the Function is killed first, its own
 * 20 minute timeout ends it and the laptop sweep (`auth-check.ts`) finds it.
 * Deployed by `deploy.sh` into a scratch project (`maxDuration: 800`, Fluid,
 * iad1); never part of an app.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from '@vercel/sandbox';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function percentiles(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? NaN;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? NaN };
}

/** One WebSocket to the VM, with its open time and how it ended. */
function dial(url: string) {
  const t0 = Date.now();
  const ws = new WebSocket(url);
  const state = { openMs: -1, closedAtMs: -1, closeCode: 0, closeReason: '', error: '' };
  const waiters: ((data: string) => void)[] = [];
  ws.onmessage = (m) => waiters.shift()?.(String(m.data));
  ws.onclose = (e) => {
    state.closedAtMs = Date.now() - t0;
    state.closeCode = e.code;
    state.closeReason = e.reason;
  };
  ws.onerror = (e) => {
    state.error = String((e as { message?: string }).message ?? e.type);
  };
  const opened = new Promise<void>((ok, fail) => {
    ws.onopen = () => {
      state.openMs = Date.now() - t0;
      ok();
    };
    setTimeout(() => fail(new Error('open timeout')), 15_000);
  });
  /** Send and wait for the echo; resolves with the round trip in ms. */
  const echo = (data: string, timeoutMs = 10_000) =>
    new Promise<number>((ok, fail) => {
      const t = Date.now();
      const timer = setTimeout(() => fail(new Error('echo timeout')), timeoutMs);
      waiters.push((got) => {
        clearTimeout(timer);
        got === data ? ok(Date.now() - t) : fail(new Error('wrong echo'));
      });
      ws.send(data);
    });
  return { ws, state, opened, echo, t0 };
}

/** `maxDuration`, and what the end of a hold needs before it: one heartbeat (5 s), the final echo's timeout (10 s), and a margin for the report and the VM's delete. */
const MAX_DURATION_S = 800;
const MAX_HOLD_S = MAX_DURATION_S - 5 - 10 - 5;

export async function POST(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const holdMs = Math.min(Number(params.get('hold') ?? MAX_HOLD_S), MAX_HOLD_S) * 1000;
  const started = Date.now();
  const enc = new TextEncoder();
  const name = `dh-probe-fn-${randomBytes(3).toString('hex')}`;

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const emit = (key: string, value: unknown) => c.enqueue(enc.encode(JSON.stringify({ t: Date.now() - started, key, value }) + '\n'));
      let sb: Sandbox | undefined;
      try {
        emit('function', { region: process.env.VERCEL_REGION, node: process.version, name });
        const t = Date.now();
        sb = await Sandbox.create({ name, region: 'iad1', ports: [3000], timeout: 20 * 60_000, persistent: false, tags: { purpose: 'dh-sandbox-probe' } });
        emit('sandbox.create.ms', Date.now() - t);
        emit('sandbox.region', sb.currentSession().region);
        await sb.writeFiles([{ path: '/tmp/echo-server.js', content: readFileSync(join(process.cwd(), 'echo-server.js')) }]);
        await sb.runCommand({ cmd: 'bun', args: ['/tmp/echo-server.js'], detached: true });
        const base = sb.domain(3000).replace(/\/+$/, '');
        for (let i = 0; i < 80; i++) {
          try {
            if ((await fetch(`${base}/health`, { cache: 'no-store' })).ok) break;
          } catch {}
          await sleep(250);
        }
        const wsUrl = `${base.replace(/^https/, 'wss')}/ws`;

        // P0.2: Function -> VM round trips.
        const a = dial(wsUrl);
        await a.opened;
        emit('ws.openMs', a.state.openMs);
        const wsRtt: number[] = [];
        for (let i = 0; i < 200; i++) wsRtt.push(await a.echo(`rtt-${i}`));
        emit('p0.2.wsEchoMs', { ...percentiles(wsRtt), first10: wsRtt.slice(0, 10) });
        const httpRtt: number[] = [];
        for (let i = 0; i < 50; i++) {
          const s = Date.now();
          await (await fetch(`${base}/health`, { cache: 'no-store' })).text();
          httpRtt.push(Date.now() - s);
        }
        emit('p0.2.httpHealthMs', percentiles(httpRtt));
        const cat = await sb.runCommand({ cmd: 'cat', stdin: true, detached: true });
        const it = cat.logs()[Symbol.asyncIterator]();
        let buf = '';
        const stdin: number[] = [];
        for (let i = 0; i < 10; i++) {
          const s = Date.now();
          await cat.writeStdin(`line-${i}\n`);
          while (!buf.includes(`line-${i}\n`)) {
            const { value } = await it.next();
            if (value?.stream === 'stdout') buf += value.data;
          }
          stdin.push(Date.now() - s);
        }
        emit('p0.2.stdinEchoMs', percentiles(stdin));
        await cat.closeStdin().catch(() => {});

        // P0.1: hold until `hold` seconds after the request started.
        const b = dial(wsUrl);
        await b.opened;
        emit('ws.silent.openMs', b.state.openMs);
        const heartbeats: number[] = [];
        let failures = 0;
        let lastReport = Date.now();
        while (Date.now() - started < holdMs && a.state.closedAtMs < 0) {
          await sleep(5000);
          try {
            heartbeats.push(await a.echo(`hb-${heartbeats.length}`));
          } catch {
            failures++;
          }
          if (Date.now() - lastReport > 60_000) {
            lastReport = Date.now();
            emit('p0.1.progress', { heldS: Math.round((Date.now() - a.t0) / 1000), heartbeats: heartbeats.length, failures, pinged: a.state.closedAtMs < 0 ? 'open' : a.state, silent: b.state.closedAtMs < 0 ? 'open' : b.state });
          }
        }
        // Each socket's hold ends at its last verified echo. A closed socket
        // isn't echoed: send() on it doesn't throw, so the echo would only
        // time out, and that wait is not time the socket was held.
        const endPinged = await a.echo('end-pinged').then((ms) => ({ ok: true, ms }), (e) => ({ ok: false, why: String(e.message) }));
        const pingedHeldS = Math.round((Date.now() - a.t0) / 1000);
        const endSilent =
          b.state.closedAtMs >= 0 ? { ok: false, why: 'closed' } : await b.echo('end-silent').then((ms) => ({ ok: true, ms }), (e) => ({ ok: false, why: String(e.message) }));
        emit('p0.1.result', {
          functionElapsedS: Math.round((Date.now() - started) / 1000),
          pinged: { heldS: pingedHeldS, heartbeats: heartbeats.length, failures, heartbeatMs: percentiles(heartbeats), endEcho: endPinged, closed: a.state.closedAtMs < 0 ? null : a.state },
          silent: { heldS: b.state.closedAtMs >= 0 ? Math.round(b.state.closedAtMs / 1000) : Math.round((Date.now() - b.t0) / 1000), endEcho: endSilent, closed: b.state.closedAtMs < 0 ? null : b.state },
        });
        a.ws.close();
        b.ws.close();
      } catch (err) {
        emit('fatal', String((err as Error)?.stack ?? err).slice(0, 600));
      } finally {
        if (sb) await sb.delete().then(() => emit('cleanup.sandbox', 'deleted'), (err) => emit('cleanup.sandbox', String(err?.message ?? err).slice(0, 200)));
        c.close();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
