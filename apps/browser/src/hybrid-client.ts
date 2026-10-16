/**
 * The tab's half of a hybrid session, with no DOM in it: the browser page
 * (`clients/hybrid.ts`) and the Node proof script (`scripts/hybrid-proof.ts`) run
 * exactly this code.
 *
 * - Storage and streams: the server's World over HTTP (`/api/world`), so the
 *   session is one run in world-vercel whichever lane writes to it. Each
 *   call carries the token of the run it is about (`run-tokens.ts`): the
 *   server serves this tab its own sessions and nothing else.
 * - Queue: in the tab. A session in the `browser` lane is driven right here,
 *   with no server round trip; the model call is the only thing that leaves
 *   (through the `/api/gateway` proxy, with the session's token, which keeps
 *   its budget).
 * - An effect that needs a backend secret or a real machine makes the kernel
 *   commit a handoff; `wake` then asks the server to pick the session up.
 * - The server hands the session back when it goes idle. The tab watches the
 *   log and drives again as soon as the session is in its lane with work to do.
 * - Nothing beats. While a session is in the tab's lane with work, the tab
 *   holds one request open to the server (`GET /api/hybrid/tether`): if the
 *   tab goes away, that close is the server's callback (harness-world's
 *   tab-lost), and a function takes the session over. A reloaded page of the
 *   same profile proves the old one gone with the Web Lock its drives hold.
 * - Either harness: Pi (`hybrid`) or fx (`hybrid-fx`). fx runs libfx's Wasm
 *   build here and its native addon on the server; their checkpoints and
 *   tapes are interchangeable, so an fx session escalates mid-turn exactly
 *   like a Pi one. libfx loads only when an fx session drives in this tab.
 */
import {
  type AnchorPolicy,
  currentLane,
  type DurableSessions,
  durableSessions,
  type Harness,
  JsonLinesWriter,
  type Lane,
  laneAvailable,
  liveStreamName,
  mark,
  marksEnabled,
  markTime,
  pendingSubmissions,
  type SessionState,
  SessionLog,
  tabAnchors,
  wake,
  watchHints,
} from 'harness-world';
import type { CreateFxEngine } from 'harness-world-fx';
import {
  createGatewayModel,
  HYBRID_FX_HARNESS,
  HYBRID_HARNESS,
  type HybridHands,
  hybridFxConfigHash,
  hybridFxHarness,
  hybridHarness,
  isHybridHarness,
} from 'harness-world-hybrid';

export type { HybridHands };
import { type GatewayFetch, gatewayFetch } from 'harness-world-hybrid/gateway';
import { createLocalQueue, createRemoteWorld, type LocalQueue, type RemoteWorld, RUN_TOKEN_HEADER, runOf } from 'harness-world-remote';
import { createWsFetch } from 'harness-world-remote/ws';
import { runTokens } from './run-tokens.ts';

export interface HybridClientOptions {
  /** The demo app's origin, e.g. `https://my-app.vercel.app`. */
  origin: string;
  /** Default: global fetch. */
  fetch?: typeof fetch;
  /** Model id on AI Gateway. */
  model?: string;
  /**
   * How often a watched session's log is read while it is away from the
   * tab (or has work queued for it). Default 5s with live hints (a handoff
   * back to the tab, a submission, read the moment they commit; see
   * harness-world's hints.ts), 1s with `hints: false`. A session parked in
   * the tab's lane with nothing to do is not polled at all, and in a browser
   * nothing is polled while the page is hidden.
   */
  pollMs?: number;
  /** Tail each watched session's hints stream instead of polling fast. Default true. */
  hints?: boolean;
  /**
   * How a server lane is woken after a handoff: `http` (default) asks
   * `POST /api/hybrid/drive` to drive it in that invocation now, with the
   * queue wake as a delayed companion; `queue` only sends the queue wake
   * (`/api/hybrid/wake`). An origin without the drive route (404) falls
   * back to `queue`.
   */
  drive?: 'http' | 'queue';
  /**
   * How the tab reaches the server's World: `http` (default, `/api/world`,
   * a request per op) or `ws` (one WebSocket to `/api/session-host` carrying
   * the same ops, falling back to HTTP when it cannot open).
   */
  relay?: 'http' | 'ws';
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** How an armed crash kills the tab's lane. Default: reload the page (or exit, in Node). */
  crash?: () => void;
  /**
   * libfx's `createFxEngine` for hybrid fx sessions. Default:
   * `libfx/browser`'s (Wasm + JSPI), imported the first time an fx session
   * drives here. The Node proof script passes the native addon's instead.
   */
  createFxEngine?: CreateFxEngine;
  /** Extra libfx options. Default with the default `createFxEngine`: `{ backend: 'wasm' }`. */
  fxAgentOptions?: Record<string, unknown>;
  /**
   * The server's hybrid configuration (`GET /api/hybrid/config`). An fx
   * turn recorded here must replay byte for byte on the server, so a tab
   * whose fx configuration hash differs (a tab from an older deployment)
   * hands its fx turns to the server instead of recording a tape the
   * server cannot replay. Default: fetch it from `origin`, at most every 30s.
   */
  serverConfig?: () => Promise<HybridServerConfig | undefined>;
  /**
   * How model requests reach AI Gateway. Default: `<origin>/api/gateway`,
   * with the token of the session being driven.
   */
  gateway?: GatewayFetch;
  /** Called with every fold this client reads (the page's polls and its own watch). */
  onState?: (runId: string, state: SessionState) => void;
  /**
   * This browser profile's id (Web Locks are per profile): a reloaded page of
   * the same profile proves the old page gone. Default: one stored in
   * `localStorage`, or a fresh one per client where there is none.
   */
  profile?: string;
  /** Hold the tether request while driving (default true; the Node proof script may turn it off). */
  tether?: boolean;
}

/** What `GET /api/hybrid/config` returns. */
export interface HybridServerConfig {
  model: string;
  /** `hybridFxConfigHash` of the server's hybrid fx harness. */
  fxConfig: string;
}

/** fx's Wasm build needs JSPI. */
export const hasJspi = () => typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly;

/** The server's hybrid configuration, or undefined if this server predates the endpoint. */
export async function fetchHybridConfig(origin: string, doFetch: typeof fetch = fetch): Promise<HybridServerConfig | undefined> {
  const response = await doFetch(`${origin.replace(/\/+$/, '')}/api/hybrid/config`).catch(() => undefined);
  if (!response?.ok) return undefined;
  return (await response.json().catch(() => undefined)) as HybridServerConfig | undefined;
}

/** The two hybrid session kinds, by harness name. */
export type HybridHarnessName = typeof HYBRID_HARNESS | typeof HYBRID_FX_HARNESS;

export interface HybridClient {
  world: RemoteWorld;
  queue: LocalQueue;
  sessions: DurableSessions;
  /**
   * Start a hybrid session (a run in the server's World) and watch it.
   * Default harness: Pi. `hands`: recorded on its `run_created`
   * (`config.hands`): every lane builds the session's tools and prompt for
   * them (default `machine`).
   */
  start(prompt?: string, harness?: HybridHarnessName, options?: { home?: Lane; hands?: HybridHands }): Promise<string>;
  /**
   * Wake the lane `runId` is in, if it is a server lane (a function): after
   * a submission to a session that does not live in this tab.
   */
  wake(runId: string): Promise<void>;
  /** Keep driving `runId` whenever it is in the browser lane with work to do. */
  watch(runId: string): void;
  /**
   * The latest fold of a session. Reading it also drives it here if it is
   * back in the tab's lane with work queued, and (re)arms or parks its watch.
   */
  state(runId: string): Promise<SessionState>;
  /** The latest fold, read only: no drive, no watch change (the page's own refreshes). */
  peek(runId: string): Promise<SessionState>;
  /** Call `onHint` whenever a hint for `runId` arrives (a read now finds something). */
  hints(runId: string, onHint: () => void): () => void;
  close(): void;
}

export async function createHybridClient(options: HybridClientOptions): Promise<HybridClient> {
  const origin = options.origin.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const say = options.log ?? (() => {});
  // One delivery at a time: the tab is a single driver.
  const queue = createLocalQueue({
    concurrency: 1,
    onError: (error, m) => say('delivery failed', { queue: m.queueName, attempt: m.attempt, error: String(error) }),
  });
  const relay =
    options.relay === 'ws'
      ? createWsFetch({
          url: `${origin.replace(/^http/, 'ws')}/api/session-host`,
          fallback: (url, init) => doFetch(url, init),
          log: say,
        })
      : undefined;
  // Opens in the background: requests go over HTTP until the socket is up.
  if (relay) void relay.connect().then((connected) => say('world relay', { connected }));
  // This tab's capabilities, one per session run.
  const tokens = runTokens(origin, doFetch);
  const world = await createRemoteWorld({
    baseUrl: `${origin}/api/world`,
    queue,
    fetch: relay ? relay.fetch : (url, init) => doFetch(url, init),
    headers: async (call): Promise<Record<string, string>> => {
      const runId = runOf(call.op, call.args);
      return runId ? { [RUN_TOKEN_HEADER]: await tokens.get(runId) } : {};
    },
  });

  /**
   * Ask the server to drive a session in one of its lanes. Retried a few
   * times inline; after that this tab keeps retrying in the background until
   * one lands or the session leaves that lane (nobody else would send it: a
   * tab that is alive is the wake's only sender, and one that went away is
   * covered by its tether's tab-lost callback). A wake the server has
   * already queued is deduplicated there.
   */
  let driveRoute = (options.drive ?? 'http') === 'http';
  let closed = false;
  const retrying = new Set<string>();
  async function wakeServer(runId: string, to: Lane) {
    if (to === 'browser') return;
    try {
      await wakeOnce(runId, to);
    } catch (error) {
      say('wake failed: retrying in the background', { runId, to, error: String(error) });
      void keepWaking(runId, to);
    }
  }
  async function keepWaking(runId: string, to: Lane) {
    const key = `${runId}:${to}`;
    if (retrying.has(key)) return;
    retrying.add(key);
    try {
      for (let delay = 2000; !closed; delay = Math.min(delay * 2, 30_000)) {
        await new Promise((r) => setTimeout(r, delay));
        const state = await read(runId, true).catch(() => undefined);
        if (!state || state.status !== 'running' || currentLane(state) !== to) return;
        try {
          await wakeOnce(runId, to);
          return;
        } catch (error) {
          say('wake failed again', { runId, to, error: String(error) });
        }
      }
    } finally {
      retrying.delete(key);
    }
  }
  async function wakeOnce(runId: string, to: Lane) {
    let last = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const route = driveRoute ? 'drive' : 'wake';
        const response = await doFetch(`${origin}/api/hybrid/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId, lane: to }),
        });
        if (route === 'drive' && (response.status === 404 || response.status === 405)) {
          driveRoute = false;
          attempt--;
          continue;
        }
        const result = await response.json().catch(() => null);
        if (response.ok) {
          say('woke server lane', { runId, to, status: response.status, result });
          return;
        }
        last = `${response.status} ${JSON.stringify(result)}`;
      } catch (error) {
        last = String(error);
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw new Error(`POST /api/hybrid/${driveRoute ? 'drive' : 'wake'} for the ${to} lane failed: ${last}`);
  }

  // Model calls go through the server's `/api/gateway` proxy, as the
  // session being driven (its token): the proxy adds the credential and
  // keeps the session's budget.
  const gateway =
    options.gateway ??
    gatewayFetch({
      proxyBase: `${origin}/api/gateway`,
      mode: 'proxy',
      fetch: doFetch,
      proxyHeaders: () => tokens.headers(),
    });
  const { model, streamFn } = createGatewayModel(undefined, options.model, gateway);
  // Runs this tab is driving right now. A second delivery for one of them
  // (a message sent mid-tool wakes the queue) waits for the drive under way.
  const driving = new Map<string, number>();
  const lanes = {
    serves: ['browser'] as Lane[],
    settle: 'browser' as Lane,
    // Never the retired sandbox lane (even for an older log's host fact): a function runs machine tools through the Sandbox API.
    available: (lane: Lane, state: SessionState) => lane !== 'sandbox' && laneAvailable(state, lane),
    wake: (runId: string, to: Lane) => wakeServer(runId, to),
  };
  const pi = hybridHarness({
    lane: 'browser',
    model,
    streamFn,
    // The proxy sets the real credential.
    getApiKey: () => 'gateway',
    lanes,
  });
  // Whether this tab can drive fx: libfx's Wasm build needs JSPI, and a
  // tape recorded here must replay on the server, which needs the same fx
  // configuration (prompt, tools, model, libfx) as this bundle.
  const ownFxConfig = hybridFxConfigHash({ lane: 'browser', ...(options.model ? { model: options.model } : {}) });
  const serverConfig = options.serverConfig ?? cached(() => fetchHybridConfig(origin, doFetch), 30_000);
  async function cannotDriveFx(): Promise<string | undefined> {
    if (!options.createFxEngine && !hasJspi()) return 'this browser has no WebAssembly JSPI (fx needs Chrome or Edge 137+)';
    const server = await serverConfig().catch(() => undefined);
    if (server?.fxConfig && server.fxConfig !== (await ownFxConfig)) {
      return 'this page was loaded from a different deployment than the server, so their fx tapes would not match (reload to run fx here)';
    }
    return undefined;
  }
  const fx = hybridFxHarness({
    lane: 'browser',
    cannotDrive: cannotDriveFx,
    createFxEngine:
      options.createFxEngine ??
      (async (o) => ((await import('libfx/browser')) as { createFxEngine: CreateFxEngine }).createFxEngine(o)),
    // As for Pi: the proxy sets the credential.
    apiKey: 'gateway',
    ...(options.model ? { model: options.model } : {}),
    fetch: gateway,
    agentOptions: options.fxAgentOptions ?? (options.createFxEngine ? {} : { backend: 'wasm' }),
    lanes,
  });
  const track = (base: Harness): Harness => ({
    name: base.name,
    ...(base.lanes ? { lanes: base.lanes } : {}),
    async drive(ctx) {
      driving.set(ctx.runId, (driving.get(ctx.runId) ?? 0) + 1);
      // One delivery at a time (the queue's concurrency): the model calls from here on are this session's.
      tokens.active = ctx.runId;
      tether(ctx.runId, ctx.state().epoch);
      try {
        await base.drive(ctx);
      } finally {
        const n = (driving.get(ctx.runId) ?? 1) - 1;
        if (n) driving.set(ctx.runId, n);
        else driving.delete(ctx.runId);
      }
    },
  });
  // This page's drives are anchored to it (tab id, profile), and hold the
  // session's Web Lock while they run: a reload proves the old page gone.
  const tabId = `tab_${Math.random().toString(36).slice(2, 12)}`;
  const profile = options.profile ?? profileId();
  const pageAnchors = tabAnchors({ tab: tabId, profile });
  // Runs a drive of this tab holds, from its start to its very end (past the
  // harness: an escalation's sibling effect is waited for after it returns).
  const holding = new Map<string, number>();
  const anchors: AnchorPolicy = {
    ...pageAnchors,
    async hold(runId) {
      holding.set(runId, (holding.get(runId) ?? 0) + 1);
      const release = await pageAnchors.hold?.(runId);
      return () => {
        release?.();
        const n = (holding.get(runId) ?? 1) - 1;
        if (n) holding.set(runId, n);
        else holding.delete(runId);
      };
    },
  };
  const sessions = durableSessions({
    world,
    harness: [track(pi), track(fx)],
    anchors,
    admit: async (state) =>
      driving.has(state.runId) ? { admit: false, reason: 'driven in this tab', timeoutSeconds: 1 } : { admit: true },
    // Crash = reload this tab mid-step.
    chaos: true,
    ...(options.crash ? { crash: options.crash } : {}),
    log: say,
  });
  await world.start?.();

  /**
   * The tether per session: one held `GET /api/hybrid/tether` while the
   * session is in this tab's lane with work. Its close is the server's
   * callback for a tab that went away; the server ends it itself only to
   * rotate (`event: rotate`), and the tab opens the next one at once.
   */
  const tethers = new Map<string, { abort: AbortController; epoch: number }>();
  let tetherSeq = 0;
  function tether(runId: string, epoch: number) {
    if (options.tether === false || closed) return;
    const current = tethers.get(runId);
    if (current && current.epoch === epoch) return;
    current?.abort.abort();
    const abort = new AbortController();
    tethers.set(runId, { abort, epoch });
    void (async () => {
      for (let backoff = 1000; !abort.signal.aborted && !closed; ) {
        const seq = ++tetherSeq;
        try {
          const response = await doFetch(`${origin}/api/hybrid/tether?runId=${encodeURIComponent(runId)}&tab=${tabId}&epoch=${epoch}&seq=${seq}`, {
            signal: abort.signal,
            headers: { accept: 'text/event-stream' },
          });
          if (response.status === 404) return say('tether: this server has no tether route', { runId });
          const reader = response.body?.getReader();
          while (reader) {
            const { done } = await reader.read();
            if (done) break;
          }
          backoff = 1000;
        } catch (error) {
          if (abort.signal.aborted) return;
          say('tether: reconnecting', { runId, error: String(error) });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    })();
  }
  function untether(runId: string) {
    tethers.get(runId)?.abort.abort();
    tethers.delete(runId);
  }

  const logs = new Map<string, SessionLog>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const hintWatches = new Map<string, AbortController>();
  const lastRead = new Map<string, number>();
  const hintsOn = options.hints ?? true;
  const pollMs = options.pollMs ?? (hintsOn ? 5000 : 1000);
  const hidden = () => typeof document !== 'undefined' && document.hidden;

  /** When the last hint for a run arrived (this tab's clock), for `handoff.noticed`. */
  const hintAt = new Map<string, number>();
  const marking = marksEnabled({});
  const liveWriters = new Map<string, JsonLinesWriter>();

  async function read(runId: string, peek = false): Promise<SessionState> {
    let log = logs.get(runId);
    if (!log) {
      log = new SessionLog(world, runId);
      logs.set(runId, log);
    }
    const before = log.state.eventCount > 0 ? currentLane(log.state) : undefined;
    const started = markTime();
    await log.refresh();
    // A peek (the page's own refresh) does not count as the watch's read:
    // only the watch settles, so it must not skip its tick for a peek.
    if (!peek) lastRead.set(runId, Date.now());
    // The moment this tab learned the server handed the session back, in
    // this tab's clock (the bench's serverToTab starts here or at the
    // server's line arriving, whichever came first).
    const handedBack = before !== undefined && before !== 'browser' && currentLane(log.state) === 'browser';
    if (handedBack && peek) {
      // A peek that finds the handback settles too: the watch may not read again for seconds.
      void settle(runId, log.state).catch((error) => say('watch failed', { runId, error: String(error) }));
    }
    if (marking && handedBack) {
      const hinted = hintAt.get(runId);
      let live = liveWriters.get(runId);
      if (!live) liveWriters.set(runId, (live = new JsonLinesWriter(world, runId, liveStreamName(runId))));
      live.write(
        mark(runId, 'handoff.noticed', {
          from: before,
          to: 'browser',
          via: hinted !== undefined && hinted >= started - 50 ? 'hint' : 'poll',
          readMs: Math.round(markTime() - started),
          ...(hinted !== undefined ? { hintAt: hinted } : {}),
        })
      );
    }
    try {
      options.onState?.(runId, log.state);
    } catch {}
    return log.state;
  }

  function park(runId: string) {
    clearInterval(timers.get(runId));
    timers.delete(runId);
    hintWatches.get(runId)?.abort();
    hintWatches.delete(runId);
    untether(runId);
  }

  /** React to a fresh read: drive it here, keep watching, or stop. */
  async function settle(runId: string, state: SessionState) {
    if (state.status !== 'running') return park(runId);
    const lane = currentLane(state);
    const pending = pendingSubmissions(state).length;
    const inFlight = state.effectOrder.some((e) => e.status === 'running' || e.status === 'pending');
    // In our lane with nothing queued and nothing running: nothing can move
    // it but this tab, so stop polling until we send something.
    if (lane === 'browser' && pending === 0 && !inFlight) return park(runId);
    watch(runId);
    // Waiting on a server lane (a handoff this tab made, or a takeover
    // after this tab went away): just watch, untethered. A wake of ours that
    // did not land is retried by this tab, and the server hands the session
    // back when it is idle. Not while a drive of ours still runs: after an
    // escalation its sibling effect is still this tab's (the server lane
    // finds it covered), and the tether's close is what hands it over if
    // this tab dies before it lands.
    if (lane !== 'browser') return holding.has(runId) ? undefined : untether(runId);
    // Work for this tab's lane: the server stands behind it through the tether.
    tether(runId, state.epoch);
    if (pending > 0) {
      // Back in our lane with work queued (a steer sent while the server had
      // it, or a reply to the turn the server just finished): drive it here.
      await wake(world, runId, `${runId}:tab:${state.eventCount}`);
      return;
    }
    // A step in our lane is in flight but this tab isn't driving it: the tab
    // that was driving it reloaded (an armed crash) or closed, and its queue
    // delivery lived in that page's memory. Nothing else will redeliver it,
    // so enqueue one here. The driver recovers the step at once when a chaos
    // step proves its page died, or the old page's Web Lock is free (a
    // reload of this profile); a step another device's tab holds is covered
    // by that tab's tether.
    if (inFlight && !driving.has(runId)) await wake(world, runId, `${runId}:tab:recover:${state.eventCount}`);
  }

  async function state(runId: string): Promise<SessionState> {
    const s = await read(runId);
    await settle(runId, s).catch((error) => say('watch failed', { runId, error: String(error) }));
    return s;
  }

  function watch(runId: string) {
    if (timers.has(runId)) return;
    let busy = false;
    // A hint that arrived while a read was in flight: that read may have
    // started before the write the hint announces (the handback), so read
    // again when it finishes, whichever path (poll or hint) started it.
    let again = false;
    const run = () => {
      busy = true;
      state(runId)
        .catch((error) => say('watch failed', { runId, error: String(error) }))
        .finally(() => {
          busy = false;
          if (again) {
            again = false;
            run();
          }
        });
    };
    const tick = () => {
      // Someone read it just now (the page polls the open session itself).
      if (busy || hidden() || Date.now() - (lastRead.get(runId) ?? 0) < pollMs * 0.8) return;
      run();
    };
    timers.set(runId, setInterval(tick, pollMs));
    queueMicrotask(tick);
    if (hintsOn) {
      // A hint means a read now finds something (the server handed the
      // session back, a steer landed): read at once, whatever the poll says.
      const abort = new AbortController();
      hintWatches.set(runId, abort);
      const onHint = () => {
        hintAt.set(runId, markTime());
        if (busy) {
          again = true;
          return;
        }
        run();
      };
      watchHints(world, runId, onHint, { signal: abort.signal });
    }
  }

  return {
    world,
    queue,
    sessions,
    async start(prompt, harness = HYBRID_HARNESS, startOptions = {}) {
      if (!isHybridHarness(harness)) throw new Error(`not a hybrid harness: ${harness}`);
      const config = {
        // A session that lives in another lane: it starts and settles there.
        ...(startOptions.home && startOptions.home !== 'browser' ? { home: startOptions.home } : {}),
        ...(startOptions.hands ? { hands: startOptions.hands } : {}),
      };
      const { sessionId } = await sessions.start({ harness, ...(prompt ? { prompt } : {}), ...(Object.keys(config).length ? { config } : {}) });
      watch(sessionId);
      return sessionId;
    },
    async wake(runId) {
      const log = logs.get(runId) ?? new SessionLog(world, runId);
      await log.refresh();
      const lane = currentLane(log.state);
      if (lane !== 'browser') await wakeServer(runId, lane);
    },
    watch,
    state,
    peek: (runId) => read(runId, true),
    hints(runId, onHint) {
      const abort = new AbortController();
      watchHints(world, runId, () => onHint(), { signal: abort.signal });
      return () => abort.abort();
    },
    close() {
      closed = true;
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
      for (const a of hintWatches.values()) a.abort();
      hintWatches.clear();
      for (const runId of [...tethers.keys()]) untether(runId);
      queue.stop();
    },
  };
}

/** This browser profile's id, kept in `localStorage` (Web Locks are per profile); a fresh one where there is none. */
function profileId(): string {
  const fresh = () => `profile_${Math.random().toString(36).slice(2, 12)}`;
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (!store) return fresh();
    let id = store.getItem('how:profile');
    if (!id) store.setItem('how:profile', (id = fresh()));
    return id;
  } catch {
    return fresh();
  }
}

/** `fn`'s result, reused for `ttlMs` (a failure is not cached). */
function cached<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | undefined;
  return () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      value = fn();
      value.catch(() => {
        value = undefined;
      });
    }
    return value;
  };
}
