/**
 * The sandbox lane's daemon: runs Pi and fx inside the
 * VM, with the session log on world-vercel (WebSocket event writes) and model calls straight to AI Gateway. Started by `startHost()`
 * (as root, detached) and served on port 3000 (`sb.domain(3000)`).
 *
 *   node daemon.mjs [--env /opt/harness/host.env]
 *
 * `host.env` (root, 0600) carries the OIDC token, the deployment/project/team,
 * the app origin, the environment, `HOST_SECRET` and the VM's identity. It is
 * read once and deleted (unless `HOST_KEEP_ENV=1`): model-run commands, which
 * run as an unprivileged user with a scrubbed environment, never see it.
 *
 * `HOST_WORLD_URL` points the daemon at a `createWorldHandler` endpoint
 * instead (world-remote over HTTP): how a laptop runs it against a local dev
 * server whose World is world-local.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import type { World } from '@workflow/world';
import { rawSessions } from 'harness-world';
import { rawTurn } from 'harness-world-bench/raw-turn';
import { fxHarness } from 'harness-world-fx';
import { workspaceTools } from 'harness-world-hands';
import { createGatewayModel, hybridFxHarness, hybridHarness, jwtClaims } from 'harness-world-hybrid';
import { piHarness } from 'harness-world-pi';
import { createLocalQueue, createRemoteWorld, withLocalQueue } from 'harness-world-remote';
import { createHost } from './host.ts';
import { LocalSandboxProvider, scrubbedEnv } from './local-sandbox.ts';
import { pullToken, startTokenPull } from './token.ts';

const { values: args } = parseArgs({ options: { env: { type: 'string' }, port: { type: 'string' } } });

const envFile = args.env ?? process.env.HOST_ENV_FILE ?? '/opt/harness/host.env';
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]!] = m[2]!.replace(/^'(.*)'$/, '$1');
  }
  if (process.env.HOST_KEEP_ENV !== '1') rmSync(envFile, { force: true });
}

// `HOST_WARM=1` (the VCR image build, P6): load every module the daemon
// would, so Node's compile cache (`NODE_COMPILE_CACHE`) holds it, then exit.
if (process.env.HOST_WARM === '1') {
  await import('@workflow/world-vercel');
  await import('harness-world/vercel-channel');
  await import('libfx').catch(() => {});
  const { flushCompileCache } = await import('node:module');
  flushCompileCache?.();
  process.exit(0);
}

const env = (name: string, fallback?: string) => process.env[name] ?? fallback;
const MODEL = env('HARNESS_MODEL', 'anthropic/claude-opus-5.5-fast')!;
const port = Number(args.port ?? env('HOST_PORT', '3000'));
const vm = env('HOST_VM', 'local')!;
const sandboxSession = env('HOST_SANDBOX_SESSION', `local_${randomUUID()}`)!;
const bootId = env('HOST_BOOT_ID', `boot_${randomUUID()}`)!;
const version = env('HOST_VERSION', 'dev')!;
const secret = env('HOST_SECRET');
if (!secret) throw new Error('daemon: HOST_SECRET is required');
const log = (message: string, fields?: Record<string, unknown>) =>
  console.log(`[host] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`);

/** The unprivileged user model-run commands run as (no sudo), if this machine has one. */
function runAs(): { uid: number; gid: number } | undefined {
  const user = env('HOST_RUN_AS');
  if (!user) return undefined;
  try {
    const uid = Number(execFileSync('id', ['-u', user]).toString().trim());
    const gid = Number(execFileSync('id', ['-g', user]).toString().trim());
    return { uid, gid };
  } catch {
    log('run-as user missing: commands run as the daemon user', { user });
    return undefined;
  }
}

const token = () => process.env.VERCEL_OIDC_TOKEN;

async function makeWorld(): Promise<{ world: World; openChannel?: (runId: string) => (() => void) | undefined }> {
  const local = createLocalQueue({ concurrency: 4 });
  const remoteUrl = env('HOST_WORLD_URL');
  if (remoteUrl) {
    const world = await createRemoteWorld({
      baseUrl: remoteUrl,
      queue: local,
      headers: () => ({ ...(env('HOST_WORLD_BYPASS') ? { 'x-vercel-protection-bypass': env('HOST_WORLD_BYPASS')! } : {}) }),
    });
    return { world };
  }
  // The daemon's own world-vercel opens its channels: harness-world can't
  // import it (no dependency), and in the bundle its lookup would not resolve.
  const { createWorld, openEventsChannel } = await import('@workflow/world-vercel');
  const { enableVercelWebSockets, setVercelChannelOpener, vercelChannel } = await import('harness-world/vercel-channel');
  enableVercelWebSockets();
  setVercelChannelOpener(openEventsChannel);
  // world-vercel reads VERCEL_OIDC_TOKEN per request and per WS reconnect
  // (verified in P1), so a refresh is a plain env replacement.
  return { world: withLocalQueue(createWorld(), local), openChannel: vercelChannel() };
}

const { world, openChannel } = await makeWorld();
const user = runAs();
const sandbox = new LocalSandboxProvider({
  name: vm,
  sessionId: sandboxSession,
  base: env('HOST_BASE', '')!,
  ...(user ? { runAs: user } : {}),
  env: scrubbedEnv(user ? {} : { HOME: env('HOME', '/tmp')! }),
  // Kill Sandbox VM: the app stops this VM through the Sandbox API. A laptop
  // daemon (no VM) plays it by killing its commands and exiting at once.
  async stopVm() {
    const origin = env('APP_ORIGIN');
    if (origin && env('HOST_LOCAL_STOP') !== '1') {
      const res = await fetch(`${origin}/api/hybrid/host`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The sessions it drives: the app wakes them (to the function lane) once the VM is gone.
        body: JSON.stringify({ op: 'stop', vm, bootId, secret, runIds: [...host.attached] }),
      });
      if (!res.ok) throw new Error(`POST /api/hybrid/host stop answered ${res.status}`);
      return;
    }
    log('chaos: stopping this machine (local)');
    sandbox.killAll();
    // Stop answering first, so the app's liveness probe fails, then tell it (as
    // the Sandbox API stop route would) which sessions to move off this lane.
    server.close();
    server.closeAllConnections();
    if (origin) {
      await fetch(`${origin}/api/hybrid/host`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'stop', local: true, vm, bootId, secret, runIds: [...host.attached] }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    setTimeout(() => process.exit(137), 50);
  },
});

let fx: Awaited<typeof import('libfx')> | undefined;
let fxError: string | undefined;
try {
  fx = await import('libfx');
} catch (err) {
  fxError = err instanceof Error ? err.message : String(err);
  log('libfx unavailable: fx sessions are handed to a function', { error: fxError });
}

function plainPi() {
  const models = createModels();
  models.setProvider(vercelAIGatewayProvider());
  const model = models.getModel('vercel-ai-gateway', MODEL);
  if (!model) throw new Error(`pi-ai does not know ${MODEL}`);
  return piHarness({ model, streamFn: models.streamSimple.bind(models), getApiKey: () => token(), tools: workspaceTools() });
}

const host = createHost({
  world,
  vm,
  sessionId: sandboxSession,
  bootId,
  version,
  ...(env('HOST_ENVIRONMENT') ? { environment: env('HOST_ENVIRONMENT')! } : {}),
  secret,
  sandbox,
  ...(env('APP_ORIGIN') ? { appOrigin: env('APP_ORIGIN')! } : {}),
  ...(openChannel ? { openChannel } : {}),
  chaos: env('HARNESS_CHAOS') !== '0',
  log,
  harnesses(tools, lanes) {
    // Model calls go straight to AI Gateway with the OIDC token (no proxy).
    const { model, streamFn } = createGatewayModel(undefined, MODEL);
    const list = [hybridHarness({ lane: 'sandbox', model, streamFn, getApiKey: () => token(), tools, lanes })];
    if (fx) {
      list.push(
        hybridFxHarness({ lane: 'sandbox', createFxEngine: fx.createFxEngine, apiKey: () => token() ?? '', model: MODEL, tools, lanes })
      );
    }
    return list;
  },
  setToken(next) {
    process.env.VERCEL_OIDC_TOKEN = next;
    log('token replaced', { exp: tokenExp() });
  },
  tokenExp,
  health: () => ({ fx: !!fx, ...(fxError ? { fxError } : {}), model: MODEL, runAs: !!user }),
  async benchRaw(request) {
    const body = await request.json();
    const harness = [plainPi(), ...(fx ? [fxHarness({ createFxEngine: fx.createFxEngine, apiKey: () => token() ?? '', model: MODEL, tools: workspaceTools() })] : [])];
    const raw = rawSessions({ harness });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await rawTurn(raw, body, (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)), { region: 'sandbox', vm });
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  },
});

function tokenExp(): number | undefined {
  const t = token();
  if (!t) return undefined;
  try {
    return (jwtClaims(t) as { exp?: number }).exp;
  } catch {
    return undefined;
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(req.method !== 'GET' && req.method !== 'HEAD' && chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  // The tab may call the control API directly (CORS); the secret is still required.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const server = createServer((req, res) => {
  void toRequest(req)
    .then((r) => host.handle(r))
    .then((response) => send(res, response))
    .catch((err) => {
      log('request failed', { url: req.url, error: String(err) });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
}).listen(port, () => {
  log('listening', { port, vm, bootId, version, fx: !!fx, runAs: !!user, world: env('HOST_WORLD_URL') ? 'remote' : 'vercel' });
  // The launcher's per-VM start lock (launchScript): held until this daemon
  // answers, so a concurrent start waits and then reuses it.
  const lockFd = Number(env('HOST_LOCK_FD'));
  if (Number.isInteger(lockFd) && lockFd > 2) {
    try {
      closeSync(lockFd);
    } catch {}
  }
});

// Pull fallback for the OIDC token: the app pushes a fresh one
// on wakes; if none arrived, fetch one at exp - 10 min from the app,
// authenticated with this boot's secret.
const appOrigin = env('APP_ORIGIN');
if (appOrigin && !env('HOST_WORLD_URL')) {
  startTokenPull({
    tokenExp,
    setToken(next) {
      process.env.VERCEL_OIDC_TOKEN = next;
      log('token pulled', { exp: tokenExp() });
    },
    pull: () => pullToken({ appOrigin, vm, bootId, secret }),
    log,
  });
}

process.on('unhandledRejection', (err) => log('unhandled rejection', { error: String(err) }));
