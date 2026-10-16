import { markTime, PROCESS_ID } from 'harness-world/marks';
import type { BenchClient, SendReceipt } from './recorder.ts';

/**
 * eve (`apps/demo/agent`, mounted at `/eve/v1/*` by `withEve`) as a client of
 * the bench and of `/compare`: eve's HTTP session API, with its NDJSON
 * stream translated into the events and marks every other lane emits.
 *
 * eve is its own harness on Vercel Workflow, so it writes none of
 * harness-world's marks. Every eve event carries `meta.at`, the server time it
 * was stamped just before eve wrote it to the session's stream, and the marks
 * here are made from those:
 *
 * | mark                | from                                                          |
 * | ------------------- | ------------------------------------------------------------- |
 * | `model.request`     | `step.started` (AI SDK's `onStepStart`, just before the call) |
 * | `model.first_token` | the step's first text, reasoning or tool-input delta          |
 * | `model.done`        | `actions.requested` (the calls streamed in full), else the    |
 * |                     | step's last output when `step.completed` arrives              |
 * | `tool.start/end`    | `actions.requested` / `action.result`, per call               |
 * | `idle`              | `turn.completed` / `turn.failed` / `turn.cancelled`           |
 * | `submit` (steer)    | the steer POST accepted (this process's clock)                |
 *
 * eve emits `step.started` from AI SDK's `onStepStart` callback and awaits
 * its stream write before the provider request goes out, so the model's
 * "own" time in an eve column includes that one write (stamped before it):
 * eve's overhead per model call reads low by one stream write, not high. All
 * of eve's marks share one pid (`eve`): its steps can run on different
 * instances, whose clocks are NTP-synced but not identical.
 *
 * A prewarmed session (`POST /session` with no message) is answered before
 * its workflow has started its inbox; a message sent before then gets `409
 * session_not_ready` and is retried. That wait is the session starting, which
 * the other lanes pay inside `start()` (their create returns once the run and
 * its hook exist), so `send` reports it (`SendReceipt.notReadyMs`) and the
 * bench and `/compare` start the turn's clock at the attempt eve accepted.
 * A reopened stream connection is reported as `{ type: 'reconnect' }`, as
 * the server lanes' client reports theirs, so it flags the turn the same way.
 */

export interface EveEvent {
  type: string;
  data?: any;
  meta?: { at?: string; id?: string; deliveryIds?: string[] };
  /** Transport control records (`{ $eve: 'stream.lease-ended' }`). */
  $eve?: string;
}

export const EVE_PID = 'eve';
export const EVE_PREFIX = '/eve/v1';

type Out = Record<string, unknown> & { type: string };

/**
 * One subscription's translation of an eve stream (pure: feed it eve events
 * in stream order, get the lane-neutral events back).
 */
export class EveTranslator {
  private step?: { key: string; first: boolean; done: boolean; lastOutputT?: number };
  private placed = new Set<string>();

  /** Steer delivery ids this session sent: the step that first carries one reports it as `placed`. */
  constructor(private readonly steers: ReadonlySet<string> = new Set()) {}

  feed(e: EveEvent): Out[] {
    if (!e || typeof e !== 'object' || e.$eve || typeof e.type !== 'string') return [];
    const d = e.data ?? {};
    const t = e.meta?.at ? Date.parse(e.meta.at) : markTime();
    const mark = (name: string, fields: Record<string, unknown> = {}): Out => ({ type: 'mark', name, t, pid: EVE_PID, runId: 'eve', ...fields });
    const out: Out[] = [];
    const first = (kind: string) => {
      if (this.step && !this.step.first) {
        this.step.first = true;
        out.push(mark('model.first_token', { key: this.step.key, kind }));
      }
      if (this.step) this.step.lastOutputT = t;
    };
    const done = (at = t) => {
      if (this.step && !this.step.done) {
        this.step.done = true;
        // Back-dated to the step's last output when it ends at step.completed:
        // `commitMs` says how much later it was written (as harness-world's
        // end marks do), so a reader does not take the wait for a slow stream.
        out.push({ ...mark('model.done', { key: this.step.key }), t: at, ...(t > at ? { commitMs: Math.round(t - at) } : {}) });
      }
    };
    switch (e.type) {
      case 'step.started': {
        this.step = { key: `${d.turnId ?? 'turn'}:${d.stepIndex ?? 0}`, first: false, done: false };
        const carried = (e.meta?.deliveryIds ?? []).filter((id) => this.steers.has(id) && !this.placed.has(id));
        for (const id of carried) this.placed.add(id);
        out.push(mark('model.request', { key: this.step.key, ...(carried.length ? { placed: carried } : {}) }));
        break;
      }
      case 'message.appended':
        first('text_delta');
        if (typeof d.messageDelta === 'string' && d.messageDelta) out.push({ type: 'text', delta: d.messageDelta });
        break;
      case 'reasoning.appended':
        first('thinking_delta');
        break;
      case 'action.input.appended':
        first('toolcall_delta');
        break;
      case 'message.completed':
        if (this.step) this.step.lastOutputT = t;
        break;
      case 'actions.requested':
        first('toolcall');
        done();
        for (const a of (d.actions ?? []) as { callId?: string; toolName?: string; input?: unknown }[]) {
          out.push(mark('tool.start', { key: a.callId, tool: a.toolName }));
          out.push({ type: 'tool_start', name: a.toolName ?? 'tool', args: a.input ?? {} });
        }
        break;
      case 'action.result': {
        const r = d.result ?? {};
        const isError = d.status !== 'completed' || /error/.test(String(r.kind ?? ''));
        const output = typeof r.output === 'string' ? r.output : r.output === undefined ? undefined : JSON.stringify(r.output);
        out.push(mark('tool.end', { key: r.callId, tool: r.toolName }));
        out.push({ type: 'tool_end', name: r.toolName ?? 'tool', ...(isError ? { isError: true } : {}), ...(output !== undefined ? { output: output.length > 4000 ? `${output.slice(0, 4000)}…` : output } : {}) });
        break;
      }
      case 'step.completed':
        done(this.step?.lastOutputT ?? t);
        this.step = undefined;
        break;
      case 'turn.failed':
      case 'session.failed':
        // `failed`, as the durable lanes report one: the bench fails the sample
        // at once (instead of timing out waiting for output) and /compare shows it.
        out.push({ type: 'failed', message: String(d.message ?? d.code ?? e.type) });
        // The session goes on after a failed turn: the turn has ended.
        if (e.type === 'turn.failed') out.push({ type: 'idle' }, mark('idle'));
        break;
      case 'turn.completed':
      case 'turn.cancelled':
        out.push({ type: 'idle' }, mark('idle'));
        break;
    }
    return out;
  }
}

export interface EveClientOptions {
  /** The app's origin. Empty for same-origin. */
  origin?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Where eve is mounted. Default `/eve/v1`. */
  prefix?: string;
  /** Retry `409 session_not_ready` for up to this long. Default 20 s. */
  notReadyMs?: number;
  /**
   * Reopen a stream connection that delivers nothing for this long, from the
   * last event it delivered. Default 15 s, eve's own client's read idle
   * timeout: a Workflow stream read can stall with events behind it.
   */
  idleReconnectMs?: number;
}

export interface EveClient extends BenchClient {
  /** Send one message, with eve's default `turnPolicy: 'steer'`. Resolves to its delivery id. */
  message(id: string, text: string): Promise<string | undefined>;
  send(id: string, text: string, kind: 'prompt' | 'steer'): Promise<SendReceipt>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * eve's session API as a bench client: plain fetch (the /bench and /compare
 * pages and Node alike). Every message, prompt or steer, goes with eve's
 * default `turnPolicy: 'steer'`: on an idle session it starts a turn, on a
 * busy one it lands at the running turn's next model call. Never `queue`,
 * which holds a message back until the running turn ends.
 */
export function eveClient(o: EveClientOptions = {}): EveClient {
  const base = `${(o.origin ?? '').replace(/\/+$/, '')}${o.prefix ?? EVE_PREFIX}`;
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const idleMs = o.idleReconnectMs ?? 15_000;
  const sessions = new Map<string, { steers: Set<string>; listeners: Set<(e: any) => void> }>();
  const session = (id: string) => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { steers: new Set(), listeners: new Set() }));
    return s;
  };

  /** POST, retrying `409 session_not_ready`; `notReadyMs`: first attempt → the accepted attempt's start (0 without a retry). */
  async function post(path: string, body: unknown): Promise<{ body: any; notReadyMs: number }> {
    const deadline = Date.now() + (o.notReadyMs ?? 20_000);
    const first = markTime();
    for (let wait = 100; ; wait = Math.min(wait * 2, 1000)) {
      const attempt = markTime();
      const r = await doFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...o.headers }, body: JSON.stringify(body) });
      if (r.ok) return { body: await r.json().catch(() => ({})), notReadyMs: Math.round(attempt - first) };
      const text = await r.text().catch(() => '');
      // The session's inbox is still starting: eve asks callers to retry.
      if (r.status === 409 && /session_not_ready/.test(text) && Date.now() < deadline) {
        await sleep(wait);
        continue;
      }
      throw new Error(`eve ${path} ${r.status} ${text}`);
    }
  }

  // No `turnPolicy`: eve's default, `steer`.
  const deliver = async (id: string, text: string) => {
    const { body: res, notReadyMs } = await post(`/session/${encodeURIComponent(id)}`, { message: text });
    return { deliveryId: typeof res?.deliveryId === 'string' ? (res.deliveryId as string) : undefined, notReadyMs };
  };
  const message: EveClient['message'] = async (id, text) => (await deliver(id, text)).deliveryId;
  const receipt = (notReadyMs: number): SendReceipt => (notReadyMs > 0 ? { notReadyMs } : {});

  return {
    signalsReady: true,
    message,
    /**
     * Without a prompt this is eve's prewarm, what `useEveAgent({ prewarm: true })`
     * does on mount: `POST /eve/v1/session` with no message creates the
     * durable session (its workflow and inbox) without starting a turn. `/compare`
     * and the bench always start sessions this way and attach the stream before
     * the first send; a send that finds the inbox still starting reports the
     * wait (`notReadyMs`), and the turn's clock starts after it.
     */
    async start(_harness, prompt) {
      const { body: res } = await post('/session', prompt ? { message: prompt } : {});
      if (typeof res?.sessionId !== 'string') throw new Error('eve did not return a sessionId');
      return res.sessionId;
    },
    async send(id, text, kind) {
      const s = session(id);
      // Prompt or steer, the same request (eve's default steer policy); a steer is also tracked to its placement.
      const { deliveryId, notReadyMs } = await deliver(id, text);
      if (kind !== 'steer' || !deliveryId) return receipt(notReadyMs);
      s.steers.add(deliveryId);
      // When the steer was accepted, in this process's clock (the durable lanes' `submit` mark).
      const submit = { type: 'mark', name: 'submit', kind: 'steer', id: deliveryId, t: markTime(), pid: PROCESS_ID, runId: id };
      for (const fn of s.listeners) fn(submit);
      return receipt(notReadyMs);
    },
    live(id, onEvent, onReady) {
      const s = session(id);
      const translator = new EveTranslator(s.steers);
      const abort = new AbortController();
      let index = 0;
      let ready = false;
      let opened = 0;
      s.listeners.add(onEvent);
      (async () => {
        let wait = 250;
        while (!abort.signal.aborted) {
          const before = index;
          // One connection: aborted with the subscription, or when it goes quiet.
          const connection = new AbortController();
          const cut = () => connection.abort();
          abort.signal.addEventListener('abort', cut, { once: true });
          let idle: ReturnType<typeof setTimeout> | undefined;
          const touch = () => {
            clearTimeout(idle);
            idle = setTimeout(cut, idleMs);
          };
          let body: ReadableStream<Uint8Array> | undefined;
          let leaseEnded = false;
          try {
            touch();
            const q = new URLSearchParams({ streamControlVersion: '1', ...(index ? { startIndex: String(index) } : {}) });
            const r = await doFetch(`${base}/session/${encodeURIComponent(id)}/stream?${q}`, {
              headers: { accept: 'application/x-ndjson', ...o.headers },
              cache: 'no-store',
              signal: connection.signal,
            });
            if (!r.ok || !r.body) throw new Error(`eve stream ${r.status}`);
            body = r.body;
            // A re-open (the response ended, went quiet or dropped): said, as the
            // server lanes' client says theirs, so a timing view can tell a
            // reconnect from harness latency and flag the turn alike.
            if (opened++ > 0) onEvent({ type: 'reconnect', t: Date.now(), n: opened - 1 });
            if (!ready) {
              ready = true;
              onReady?.();
            }
            const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              touch();
              buffer += value;
              for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let e: EveEvent;
                try {
                  e = JSON.parse(line);
                } catch {
                  continue;
                }
                // Control records are not events (they do not count toward startIndex).
                if (e.$eve) {
                  if (e.$eve === 'stream.lease-ended') leaseEnded = true;
                  continue;
                }
                index++;
                for (const out of translator.feed(e)) onEvent(out);
              }
            }
          } catch {
            // A dropped or silent connection: reopened below from `index`.
          } finally {
            clearTimeout(idle);
            abort.signal.removeEventListener('abort', cut);
            // Release the server's Workflow stream before opening another.
            body?.cancel().catch(() => {});
            connection.abort();
          }
          if (abort.signal.aborted) break;
          // The response ended or went quiet: reopen where it left off (at once
          // when eve said its lease ended or events were flowing).
          wait = leaseEnded ? 0 : index > before ? 250 : Math.min(wait * 2, 2000);
          await sleep(wait);
        }
      })();
      return () => {
        abort.abort();
        s.listeners.delete(onEvent);
      };
    },
  };
}
