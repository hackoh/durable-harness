import type { World } from '@workflow/world';
import {
  createDriveRoute,
  currentLane,
  type DurableSessions,
  durableSessions,
  type Harness,
  hostAnchors,
  hostOf,
  type Lane,
  type LaneOptions,
  laneAvailable,
  serveHostDrive,
  SessionLog,
} from 'harness-world';
import { hybridTools, sandboxOwnerPolicy } from 'harness-world-hybrid';
import type { LocalSandboxProvider } from './local-sandbox.ts';
import { tokenExpired } from './token.ts';

/** What one daemon is. */
export interface HostIdentity {
  /** The VM's sandbox name. */
  vm: string;
  /** The VM session (`Sandbox` sessionId): a stop and resume is a new one. */
  sessionId: string;
  /** One per daemon start. */
  bootId: string;
  /** The bundle's content hash (`HOST_VERSION`). */
  version: string;
  /** `production` / `preview` / … : the daemon refuses sessions of another environment. */
  environment?: string;
}

export interface HostOptions extends HostIdentity {
  /** The session log (and streams): world-vercel straight from the VM, with a local queue. */
  world: World;
  /** Builds the hybrid harnesses for this lane (`hybridTools({ lane: 'sandbox', sandbox })`). */
  harnesses(tools: ReturnType<typeof hybridTools>, lanes: LaneOptions): Harness[];
  sandbox: LocalSandboxProvider;
  /** `Authorization: Bearer <secret>` on every control call. */
  secret: string;
  /**
   * Wake the function lane: POST `${appOrigin}/api/hybrid/drive`.
   * Unset: no app (tests).
   */
  appOrigin?: string;
  /** Headers for calls to the app (the scoped bypass is injected by the VM's egress proxy, so normally none). */
  appHeaders?: Record<string, string>;
  /** Replace the OIDC token every World and Gateway call reads (`POST /token`). */
  setToken?(token: string): void;
  /** When the current token expires (unix seconds), for `/health`. */
  tokenExp?(): number | undefined;
  /** `POST /bench/raw`: a raw (no World) busy period in the VM, the `/api/bench/raw` protocol (NDJSON). */
  benchRaw?(request: Request): Promise<Response>;
  /** Extra `/health` fields (fx readiness, …). */
  health?(): Record<string, unknown>;
  /**
   * Honor armed crashes (default on, like the app): Kill Function kills this
   * daemon, Kill Sandbox VM stops its VM (through the app), Kill Command
   * kills the command.
   */
  chaos?: boolean;
  openChannel?: (runId: string) => (() => void) | undefined;
  fetch?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface Host {
  readonly sessions: Promise<DurableSessions>;
  /** The control API (Web `Request` → `Response`), mounted by `daemon.ts` on port 3000. */
  handle(request: Request): Promise<Response>;
  /** Sessions attached to this daemon. */
  readonly attached: ReadonlySet<string>;
  /** Wait for the drives in flight (tests). */
  idle(): Promise<void>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * The in-VM host: a normal durable driver serving the
 * `sandbox` lane, with the session's machine tools on this VM, model calls
 * straight to AI Gateway and the log straight to world-vercel. Nothing in
 * the kernel is VM-specific: the same driver, epochs and fencing.
 *
 * Its drives hold no queue message: they run under this boot's anchor
 * (`hostAnchors`), and the app's tether stands behind them, a flow-route
 * delivery that holds its own message while it holds `POST /drive` open
 * here (harness-world's tether.ts). The daemon writes nothing about its own
 * liveness: a VM that dies resets that connection, and the tether takes the
 * session to a function.
 */
export function createHost(options: HostOptions): Host {
  const say = options.log ?? (() => {});
  const doFetch = options.fetch ?? fetch;
  const attached = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const startedAt = Date.now();
  let lastDrive: number | undefined;

  const lanes: LaneOptions = {
    serves: ['sandbox'],
    settle: 'browser',
    available: (lane, state) => laneAvailable(state, lane),
    async wake(runId, to, handoff) {
      if (to === 'sandbox') {
        drive(runId, 'self');
        return;
      }
      // The tab watches its session's log and hints: nothing to send.
      if (to === 'browser') return;
      if (!options.appOrigin) throw new Error('no app to wake the function lane on');
      // The HTTP drive route drives the function lane in that invocation; it
      // sends the delayed queue companion itself.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await doFetch(`${options.appOrigin}/api/hybrid/drive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(options.appHeaders ?? {}) },
            body: JSON.stringify({ runId, lane: to, from: 'sandbox', reason: handoff.reason }),
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) return;
          lastError = new Error(`POST /api/hybrid/drive answered ${response.status}`);
        } catch (err) {
          lastError = err;
        }
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
      throw lastError;
    },
  };

  // run_on_machine waits for its command inside the call (on this machine).
  const tools = hybridTools({ lane: 'sandbox', sandbox: options.sandbox });

  const sessions = (async () =>
    durableSessions({
      world: options.world,
      harness: options.harnesses(tools, lanes),
      lanes,
      owners: [sandboxOwnerPolicy({ provider: options.sandbox })],
      // A drive here is anchored to this daemon's boot; its tether is its backstop.
      anchors: hostAnchors({ boot: options.bootId }),
      chaos: options.chaos ?? true,
      ...(options.openChannel ? { openChannel: options.openChannel } : {}),
      log: (message, fields) => say(message, fields),
    }))();

  const route = createDriveRoute({
    after: (work) => {
      const p = work().catch((err) => say('drive failed', { error: String(err) }));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    drive: async (runId, meta) => {
      lastDrive = Date.now();
      return (await sessions).drive(runId, meta);
    },
    log: say,
  });

  function drive(runId: string, why: string) {
    route.drive(runId, { why });
  }

  async function attach(runId: string): Promise<Response> {
    const log = new SessionLog(options.world, runId);
    await log.refresh();
    const env = (log.state.config as { environment?: string } | undefined)?.environment;
    if (env && options.environment && env !== options.environment) {
      return json({ error: `session is in ${env}, this host serves ${options.environment}` }, 409);
    }
    attached.add(runId);
    options.openChannel?.(runId);
    const host = hostOf(log.state);
    return json({ attached: true, lane: currentLane(log.state), host: host?.bootId === options.bootId });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (path === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        vm: options.vm,
        bootId: options.bootId,
        sessionId: options.sessionId,
        version: options.version,
        environment: options.environment,
        attached: [...attached],
        driving: [...attached].filter((r) => route.driving(r)),
        tokenExp: options.tokenExp?.(),
        lastDrive,
        uptimeMs: Date.now() - startedAt,
        ...(options.health?.() ?? {}),
      });
    }
    const auth = request.headers.get('authorization') ?? `Bearer ${url.searchParams.get('secret') ?? ''}`;
    if (auth !== `Bearer ${options.secret}`) return json({ error: 'unauthorized' }, 401);
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const runId = typeof body.runId === 'string' ? body.runId : url.searchParams.get('runId') ?? undefined;
    switch (path) {
      case '/attach':
        if (!runId?.startsWith('wrun_')) return json({ error: 'expected { runId }' }, 400);
        return attach(runId);
      case '/wake': {
        if (!runId?.startsWith('wrun_')) return json({ error: 'expected { runId }' }, 400);
        // Only sessions attached to this boot (`/attach`, after which the app
        // commits the host fact): a wake for anything else is refused, so the
        // caller hands the session to a function instead of trusting this daemon.
        if (!attached.has(runId)) return json({ error: 'session not attached to this host', bootId: options.bootId }, 409);
        // An expired token: every World write and Gateway call would fail, so
        // say so (the caller pushes a fresh token, or hands off at once).
        const tokenExp = options.tokenExp?.();
        if (tokenExpired(tokenExp)) return json({ error: 'token expired', tokenExp, bootId: options.bootId }, 503);
        // Answer at once: the caller's liveness probe needs a 202 in 500 ms.
        drive(runId, typeof body.why === 'string' ? body.why : 'wake');
        return json({ accepted: true, bootId: options.bootId, ...(tokenExp !== undefined ? { tokenExp } : {}) }, 202);
      }
      case '/drive': {
        // A tether (the app's flow route): a stream that stays open while this
        // daemon drives the session, and ends with an end line when it lets go.
        if (!runId?.startsWith('wrun_')) return json({ error: 'expected { runId }' }, 400);
        if (!attached.has(runId)) return json({ error: 'session not attached to this host', bootId: options.bootId }, 409);
        const tokenExp = options.tokenExp?.();
        if (tokenExpired(tokenExp)) return json({ error: 'token expired', tokenExp, bootId: options.bootId }, 503);
        lastDrive = Date.now();
        return serveHostDrive(options.world, runId, async () => (await sessions).drive(runId));
      }
      case '/token': {
        if (typeof body.token !== 'string' || !options.setToken) return json({ error: 'expected { token }' }, 400);
        options.setToken(body.token);
        return json({ ok: true, tokenExp: options.tokenExp?.() });
      }
      case '/bench/raw':
        if (!options.benchRaw) return json({ error: 'no raw baseline here' }, 404);
        return options.benchRaw(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }));
      default:
        return json({ error: 'not found' }, 404);
    }
  }

  return {
    sessions,
    handle,
    attached,
    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}

export type { Lane };
