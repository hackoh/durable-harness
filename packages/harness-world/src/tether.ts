import type { World } from '@workflow/world';
import { anchorKey, driveSettled } from './anchor.ts';
import { commitHandoff, type DeliverMeta, type DriverOptions, deliver, QUEUE_NAME } from './driver.ts';
import { isDetached, isFactStep, markHostLost } from './facts.ts';
import { publishHint } from './hints.ts';
import { currentLane, type HandoffOutput, hostOf } from './lanes.ts';
import { harnessOf } from './names.ts';
import { SessionLog } from './session-log.ts';
import { JsonLinesWriter, liveStreamName } from './streams.ts';
import type { SessionState } from './types.ts';
import { announceTether, armTabLost, takeoverLane } from './tab-lost.ts';

/**
 * Tethers: a queue delivery standing behind a drive that holds no queue
 * message of its own. The delivery keeps its message
 * locked (the queue library extends the lease while it runs) and keeps a
 * request open to whatever drives: the connection is the callback. Nothing
 * here is periodic liveness: the streams carry transport keepalives only so
 * proxies do not cut an idle connection, and nobody judges their silence.
 * What ends a tether is the connection itself (an error, a reset, the HTTP
 * client's own body timeout), checked once more with a health probe before
 * anything is taken over.
 */

/** Transport keepalive on tether streams: for proxies, never judged. */
export const TETHER_KEEPALIVE_MS = 15_000;

// ---------------------------------------------------------------- sandbox daemon

/** A sandbox-lane tether message (`input.kind`), on the session queue. */
export interface TetherMessage {
  kind: 'tether';
}

/**
 * Send the sandbox lane's tether: whoever hands a session to the sandbox
 * lane sends it (with the daemon's `/wake` as the fast path), keyed by the
 * cause, so it is never deduplicated away.
 */
export async function armTether(world: World, runId: string, idempotencyKey: string, delaySeconds?: number): Promise<void> {
  const input: TetherMessage = { kind: 'tether' };
  await world.queue(QUEUE_NAME, { runId, input }, { idempotencyKey, ...(delaySeconds ? { delaySeconds } : {}) });
}

/** How a tether reaches the session's sandbox daemon. */
export interface TetherOptions {
  /**
   * Open the daemon's drive stream for `runId` (`POST /drive`, see
   * `serveHostDrive`): the response's body stays open while the daemon drives
   * the session and ends when its drive lets go. Rejects on a connection error.
   */
  attach(runId: string, signal: AbortSignal): Promise<Response>;
  /** Whether the daemon answers its health check now (a re-probe before declaring it lost). */
  probe(runId: string): Promise<boolean>;
  /** Pause between re-probes. Default 1500 ms. */
  probeRetryMs?: number;
}

/** What a daemon's drive stream ends with. */
export interface TetherEnd {
  type: 'end';
  ok: boolean;
  error?: string;
}

/**
 * One delivery of a sandbox-lane tether (the server half): attach to the
 * daemon's drive and hold the delivery while it drives.
 *
 * - The stream ends normally (the drive went idle, parked and detached,
 *   handed the session on): ack, after making sure whatever lane the session
 *   is in now has a driver if it has work.
 * - The connection fails, and the daemon does not answer its health check
 *   (twice): the daemon or its VM is gone. Hand the session to a server lane
 *   (its intents are then older than the epoch, so they are resolved without
 *   another fence), mark the host lost, and drive it here.
 * - This delivery nears its own deadline: hand the tether to a fresh one (a
 *   new tether message) and ack; the daemon keeps driving undisturbed.
 */
export async function tetherDelivery(options: DriverOptions, runId: string, meta: DeliverMeta, tether: TetherOptions): Promise<void> {
  const { world } = options;
  const say = options.log ?? (() => {});
  const log = new SessionLog(world, runId);
  await log.refresh();
  const state = log.state;
  if (state.status !== 'running') return;
  const harness = [options.harness].flat().find((h) => h.name === harnessOf(state.workflowName));
  const lanes = harness?.lanes ?? options.lanes;
  if (!lanes || (currentLane(state, lanes.initial) !== 'sandbox' && !hostHeld(state))) {
    // Moved on before this tether landed: an ordinary delivery's job. (Not
    // while a daemon's drive still runs an effect the session left the lane
    // with, an escalation's sibling: that drive is still this tether's.)
    await deliver(options, runId, { ...meta, log });
    return;
  }
  const epoch = state.epoch;
  const reported = await world.getRuntimeDeadline?.().catch(() => undefined);
  const hard = reported ? Math.min(reported.getTime(), Date.now() + (options.maxInvocationMs ?? 10 * 60_000)) : Date.now() + (options.maxInvocationMs ?? 10 * 60_000);
  const rotateAt = hard - Math.min(15_000, (hard - Date.now()) / 4);
  for (;;) {
    const rotate = new AbortController();
    const timer = setTimeout(() => rotate.abort(), Math.max(0, rotateAt - Date.now()));
    let failure: string | undefined;
    try {
      if (hostOf(log.state)) {
        const response = await tether.attach(runId, rotate.signal);
        if (!response.ok) throw new Error(`the daemon answered ${response.status}`);
        const end = await readEnd(response);
        say('tether: the daemon let go', { runId, ...(end ?? { ended: 'without an end line' }) });
        if (!end) throw new Error('the drive stream ended without an end line');
        break;
      }
      failure = 'the session has no live sandbox host';
    } catch (err) {
      if (rotate.signal.aborted) {
        // Our own deadline: a fresh tether carries on.
        await armTether(world, runId, `${runId}:tether:${anchorKey(meta.anchor ?? { k: 'msg', m: 'direct' })}:${meta.attempt ?? 1}:rotate`, 1);
        say('tether: rotated', { runId });
        return;
      }
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (failure) {
      // Once or twice more, like a wake's probe: a proxy blip is not a dead VM.
      const healthy = (await tether.probe(runId).catch(() => false)) ||
        (await new Promise((r) => setTimeout(r, tether.probeRetryMs ?? 1500)), await tether.probe(runId).catch(() => false));
      if (healthy && hostOf(log.state)) {
        say('tether: re-attaching after a connection error', { runId, error: failure });
        await log.refresh().catch(() => {});
        if ((currentLane(log.state, lanes.initial) !== 'sandbox' || log.state.epoch !== epoch) && !hostHeld(log.state)) break;
        continue;
      }
      await takeOver(options, log, epoch, failure, meta);
      return;
    }
  }
  // The daemon let go: whatever lane the session is in now gets a driver if it has work.
  await log.refresh().catch(() => {});
  if (currentLane(log.state, lanes.initial) !== 'sandbox') await deliver(options, runId, { ...meta, log });
}

/** Daemon boots holding running effects of this session (an escalation's sibling outlives the sandbox lane). */
function hostBoots(state: SessionState): Set<string> {
  return new Set(
    state.effectOrder
      .filter((r) => r.status === 'running' && !isFactStep(r.name) && !(r.park && isDetached(r)) && r.anchor?.k === 'host')
      .map((r) => r.anchor!.m)
  );
}
const hostHeld = (state: SessionState) => hostBoots(state).size > 0;

/** Read a daemon drive stream to its end line (keepalives skipped). Undefined if it ended without one. */
async function readEnd(response: Response): Promise<TetherEnd | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let end: TetherEnd | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === 'end') end = parsed as TetherEnd;
      } catch {}
    }
  }
  return end;
}

/** The daemon is gone: hand its sandbox lane to a server lane and drive it here. */
async function takeOver(options: DriverOptions, log: SessionLog, epoch: number, why: string, meta: DeliverMeta): Promise<void> {
  const { world } = options;
  const say = options.log ?? (() => {});
  const runId = log.runId;
  await log.refresh();
  const harness = [options.harness].flat().find((h) => h.name === harnessOf(log.state.workflowName));
  const lanes = harness?.lanes ?? options.lanes;
  if (!lanes) return;
  const host = hostOf(log.state);
  if (currentLane(log.state, lanes.initial) !== 'sandbox' || log.state.epoch !== epoch) {
    // The daemon moved the session on itself (an escalation) and died with a
    // sibling effect still running: that sibling stays its drive's
    // (anchorVerdict), so the next lane finds it covered. The connection this
    // tether held is what proves the daemon gone: hand its work over.
    const boots = hostBoots(log.state);
    const boot = host?.bootId && boots.has(host.bootId) ? host.bootId : boots.size === 1 ? [...boots][0] : undefined;
    if (!boot) return;
    if (host?.bootId === boot) {
      await markHostLost(log, `tether: ${why}`, { vm: host.vm, bootId: host.bootId }).catch((err) =>
        say('tether: could not mark the host lost', { runId, error: String(err) })
      );
    }
    say('tether: handing over what a lost sandbox host left running', { runId, why });
    await deliver(options, runId, { ...meta, log, continues: anchorKey({ k: 'host', m: boot }) });
    return;
  }
  const to = takeoverLane(log.state, lanes, 'sandbox');
  const handoff: HandoffOutput = { from: 'sandbox', to, reason: `sandbox host lost (${why})` };
  const { won } = await commitHandoff(log, handoff, epoch, meta.anchor ? { anchor: meta.anchor } : {});
  if (!won) return;
  if (host) {
    await markHostLost(log, `tether: ${why}`, { vm: host.vm, bootId: host.bootId }).catch((err) =>
      say('tether: could not mark the host lost', { runId, error: String(err) })
    );
  }
  void publishHint(world, runId, { eventType: 'handoff', slot: log.state.eventCount, to, epoch: log.state.epoch });
  const live = new JsonLinesWriter(world, runId, liveStreamName(runId));
  live.write({ type: 'lane', ...handoff, takeover: true });
  await live.flush();
  say('tether: took over from a lost sandbox host', { runId, to, why });
  if (lanes.serves.includes(to)) {
    await deliver(options, runId, { ...meta, log });
    return;
  }
  await lanes.wake(runId, to, handoff, { idempotencyKey: `${runId}:${to}:${log.state.epoch}:tether` });
}

/**
 * The daemon half: answer a tether's `POST /drive` with a stream that stays
 * open while this process drives `runId` (starting the drive, or attaching
 * to the one under way) and ends with an end line when it lets go.
 */
export function serveHostDrive(world: World, runId: string, drive: () => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {}
      };
      send({ type: 'attached', runId });
      keepalive = setInterval(() => send({ type: 'keepalive' }), TETHER_KEEPALIVE_MS);
      let end: TetherEnd;
      try {
        // A drive already under way here (a `/wake`, the fast path) is
        // attached to; a delivery that lands while it drives makes it run
        // once more, and this waits for all of it.
        await drive();
        await driveSettled(world, runId);
        end = { type: 'end', ok: true };
      } catch (err) {
        end = { type: 'end', ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      clearInterval(keepalive);
      send(end);
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      clearInterval(keepalive);
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------- tab

export interface TabTetherOptions {
  /** Keeps the Function alive for the close callback after the client went away (Vercel's `waitUntil`). */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Close (and ask the tab to re-tether) after this long: under the Function's own limit. Default 700 s. */
  maxMs?: number;
  /** How long the tab-lost callback waits for a re-tether (seconds). Default `TAB_LOST_DELAY_SECONDS`. */
  lostDelaySeconds?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Serve a tab's tether (`GET ?runId=&tab=&epoch=&seq=`): a held event
 * stream. It says the tab tethered (a one-shot hint) and, if the tab goes
 * away without the server having closed it, queues the tab-lost callback
 * (tab-lost.ts). The server closes it itself only to rotate before its
 * Function's limit, after an `event: rotate` the tab answers by opening the
 * next one.
 */
export function serveTabTether(world: World, request: Request, options: TabTetherOptions = {}): Response {
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId') ?? '';
  const tab = url.searchParams.get('tab') ?? '';
  const epoch = Number(url.searchParams.get('epoch'));
  const seq = Number(url.searchParams.get('seq'));
  if (!runId.startsWith('wrun_') || !tab || !Number.isFinite(epoch) || !Number.isFinite(seq)) {
    return new Response(JSON.stringify({ error: 'expected ?runId=&tab=&epoch=&seq=' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const say = options.log ?? (() => {});
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let rotate: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let planned = false;
  const lost = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    clearTimeout(rotate);
    if (planned) return;
    say('tether: the tab went away', { runId, tab, epoch, seq });
    const work = armTabLost(world, runId, { tab, epoch, seq, ...(options.lostDelaySeconds !== undefined ? { delaySeconds: options.lostDelaySeconds } : {}) }).catch((err) => say('tether: could not queue tab-lost', { runId, error: String(err) }));
    options.waitUntil?.(work);
  };
  // A Request's signal follows its parent's only while the Request itself is
  // reachable (undici links the two through a weak reference), so the stream
  // holds the request below: otherwise a tether nothing else holds can lose
  // its listener to a collection and never see its tab go away.
  request.signal?.addEventListener('abort', lost, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          lost();
        }
      };
      send(`retry: 1000\n: tethered ${runId}\n\n`);
      void announceTether(world, runId, { tab, epoch, seq }).catch(() => {});
      keepalive = setInterval(() => send(': keepalive\n\n'), TETHER_KEEPALIVE_MS);
      rotate = setTimeout(() => {
        planned = true;
        send('event: rotate\ndata: {}\n\n');
        clearInterval(keepalive);
        closed = true;
        try {
          controller.close();
        } catch {}
      }, options.maxMs ?? 700_000);
    },
    cancel: () => {
      void request;
      lost();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  });
}
