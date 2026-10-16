import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowNameFor } from 'harness-world/names';
import { ulid } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { FLOW_ROUTE, QUEUE_PREFIX } from '../src/index.ts';

/**
 * A process that starts a World on the app's database (or data directory)
 * but makes no agents: `forwardQueue(world)` before `world.start()`. Its
 * start-up recovery re-enqueues every open session on durable-harness's
 * prefix; without a route of its own registered for that prefix, its worker
 * sends them to the Workflow SDK's flow route (a 404 on a server that mounts
 * only durable-harness's), and the turn stays open.
 *
 * Each drill is real OS processes (forward-queue-child.ts), Pi with a
 * scripted model: the app starts a session whose tool hangs and is
 * SIGKILLed mid-tool; the worker starts while the app is down (its recovery
 * jobs wait for it); the app starts again; the worker delivers the session
 * over HTTP to the app's flow route, and the turn finishes there.
 *
 * world-postgres needs `WORKFLOW_POSTGRES_URL` (a database with the World's
 * migrations applied); each drill works its own job queue
 * (`WORKFLOW_POSTGRES_JOB_PREFIX`).
 */

const CHILD = new URL('./forward-queue-child.ts', import.meta.url).pathname;
const url = process.env.WORKFLOW_POSTGRES_URL;
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

type Line = Record<string, any>;
interface Req {
  path: string;
  queue: string | null;
  runId?: string;
  status: number;
}

function child(args: string[], env: Record<string, string>) {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.add(proc);
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (err = (err + d).slice(-4000)));
  proc.once('exit', () => children.delete(proc));
  const lines = (): Line[] =>
    out
      .split('\n')
      .filter((l) => l.startsWith('{"'))
      .map((l) => JSON.parse(l) as Line);
  const next = async (pred: (l: Line) => boolean, timeoutMs = 60_000): Promise<Line> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = lines().find(pred);
      if (hit) return hit;
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`child ${args.join(' ')} exited (${proc.exitCode ?? proc.signalCode}): ${err}`);
      if (Date.now() > deadline) throw new Error(`timed out (${args.join(' ')}): ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const requests = (): Req[] => lines().flatMap((l) => (l.req ? [l.req as Req] : []));
  const kill = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGKILL');
    await exited;
  };
  return { proc, next, requests, kill };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise((r) => server.close(r));
  return port;
}

/** The jobs on a world-postgres job queue, as Graphile Worker holds them (their payload without the body). */
async function jobs(jobPrefix: string): Promise<{ attempts: number; payload: { id: string; prefix?: string; route?: string } }[]> {
  // pg, as world-postgres resolves it (durable-harness does not depend on it).
  type Pool = { query(sql: string, params: unknown[]): Promise<{ rows: any[] }>; end(): Promise<void> };
  const pg = createRequire(createRequire(import.meta.url).resolve('@workflow/world-postgres'))('pg') as { Pool: new (o: object) => Pool };
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query(
      `select j.attempts, j.payload::jsonb - 'data' as payload from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id where t.identifier = $1 order by j.id`,
      [`${jobPrefix}flows`]
    );
    return rows;
  } finally {
    await pool.end();
  }
}

/** The Workflow SDK's flow route, where a Next.js app without the Workflow SDK serves durable-harness's. */
const WORKFLOW_FLOW_ROUTE = '/.well-known/workflow/v1/flow';

interface Drill {
  world: 'postgres' | 'local';
  /** explicit: the app passes its World (world-postgres, no `world.start()`) and mounts `agent.handler`; env: `getWorld()` and `flowHandler()`. */
  web: 'explicit' | 'env';
  /** bare: the worker without `forwardQueue` (the control). */
  worker?: 'forward' | 'bare';
  /** Where the app mounts its consumer (default `FLOW_ROUTE`). */
  mount?: string;
  /** The worker's `forwardQueue(world, { route })`. */
  route?: string;
  /** Whether the turn is expected to finish (default: unless the worker is bare). */
  settles?: boolean;
}

async function drill({ world, web, worker: mode = 'forward', mount, route, settles = mode !== 'bare' }: Drill) {
  const name = `pi-fq-${ulid().toLowerCase().slice(-10)}`;
  const port = await freePort();
  const storage: Record<string, string> =
    world === 'postgres'
      ? { WORKFLOW_POSTGRES_URL: url!, WORKFLOW_POSTGRES_JOB_PREFIX: `fq_${ulid().toLowerCase()}_` }
      : { WORKFLOW_LOCAL_DATA_DIR: await mkdtemp(join(tmpdir(), 'durable-harness-fq-')) };
  const appEnv = {
    ...storage,
    FQ_NAME: name,
    PORT: String(port),
    ...(mount ? { FQ_MOUNT: mount } : {}),
    ...(web === 'env' ? { WORKFLOW_TARGET_WORLD: world === 'postgres' ? '@workflow/world-postgres' : 'local' } : {}),
  };

  // The app drives a turn into a tool that hangs, and dies there.
  const app = child(['web', String(port), web, 'hang'], appEnv);
  const { sessionId } = await app.next((l) => typeof l.sessionId === 'string');
  await app.next((l) => l.worked === true);
  await app.kill();

  // The worker starts while the app is down: its start-up recovery re-enqueues the session.
  const worker = child(['worker', world, mode], { ...storage, WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`, ...(route ? { FQ_ROUTE: route } : {}) });
  await worker.next((l) => l.started === true);
  const queued = world === 'postgres' ? (await jobs(storage.WORKFLOW_POSTGRES_JOB_PREFIX!)).filter((j) => j.payload.id === workflowNameFor(name)) : [];

  // The app again: the worker delivers the session to its flow route, and the turn finishes.
  const again = child(['web', String(port), web, 'resume', sessionId], appEnv);
  const report = await again.next((l) => l.settled === true, settles ? 90_000 : 20_000).catch((error: unknown) => {
    if (!settles) return undefined;
    throw error;
  });
  const requests = again.requests();
  await again.kill();
  await worker.kill();
  return { name, sessionId, queued, requests, effects: report?.effects as { name: string; status: string; retryOf?: string; output?: any }[] | undefined };
}

function expectResumedThroughTheRoute(r: Awaited<ReturnType<typeof drill>>, mount = FLOW_ROUTE) {
  console.log(`[forwardQueue] ${r.requests.length} deliveries to the app:`, JSON.stringify(r.requests.filter((q) => q.runId === r.sessionId)));
  // Every delivery the app got came to its flow route; none to another path.
  expect(r.requests.length).toBeGreaterThan(0);
  for (const q of r.requests) expect(q.path).toBe(mount);
  // The session's recovery (on durable-harness's prefix, under its run's name) among them, taken.
  const recovery = r.requests.filter((q) => q.runId === r.sessionId && q.queue === `${QUEUE_PREFIX}${workflowNameFor(r.name)}`);
  expect(recovery.length).toBeGreaterThan(0);
  expect(recovery.every((q) => q.status === 200)).toBe(true);
  // The turn finished: the tool (replay: 'safe') rerun once, then the model's answer (besides the kernel's `recover` step).
  const calls = (r.effects ?? []).filter((e) => e.name !== 'recover');
  expect(calls.map((e) => [e.name, e.status])).toEqual([
    ['model', 'completed'],
    ['tool.wait', 'completed'],
    ['model', 'completed'],
  ]);
  expect(calls[1]!.retryOf).toBeDefined();
  expect(JSON.stringify(calls[2]!.output)).toContain('done');
}

describe.skipIf(!url)('forwardQueue on world-postgres: a worker process that makes no agents', () => {
  it("the app passes its World and never starts it: the worker's start-up recovery jobs carry the app's route, reach its consumer, and the turn a SIGKILL left mid-tool finishes", async () => {
    const r = await drill({ world: 'postgres', web: 'explicit' });
    // Enqueued by the worker's start (the app was down), each with durable-harness's prefix and route.
    expect(r.queued.length).toBeGreaterThan(0);
    for (const j of r.queued) expect(j.payload).toMatchObject({ prefix: QUEUE_PREFIX, route: FLOW_ROUTE });
    expectResumedThroughTheRoute(r);
  }, 180_000);

  it("the app on durable-harness's World (WORKFLOW_TARGET_WORLD), made on its first request: the worker's recovery reaches flowHandler(), and the turn finishes", async () => {
    const r = await drill({ world: 'postgres', web: 'env' });
    expect(r.queued.length).toBeGreaterThan(0);
    for (const j of r.queued) expect(j.payload).toMatchObject({ prefix: QUEUE_PREFIX, route: FLOW_ROUTE });
    expectResumedThroughTheRoute(r);
  }, 180_000);

  it("a Next.js app without the Workflow SDK, whose flow route is the Workflow SDK's path: the worker names it ({ route }), and the turn finishes there", async () => {
    const r = await drill({ world: 'postgres', web: 'env', mount: WORKFLOW_FLOW_ROUTE, route: WORKFLOW_FLOW_ROUTE });
    expect(r.queued.length).toBeGreaterThan(0);
    for (const j of r.queued) expect(j.payload).toMatchObject({ prefix: QUEUE_PREFIX, route: WORKFLOW_FLOW_ROUTE });
    expectResumedThroughTheRoute(r, WORKFLOW_FLOW_ROUTE);
  }, 180_000);
});

/**
 * A worker that also serves the Workflow SDK (or another consumer of its own
 * prefix): `forwardQueue` changes where durable-harness's prefix goes and
 * nothing else, so the Workflow SDK's runs still go to its flow route.
 */
describe.each([
  { world: 'postgres' as const, skip: !url },
  { world: 'local' as const, skip: false },
])("forwardQueue next to the Workflow SDK's queue ($world)", ({ world, skip }) => {
  it.skipIf(skip)("durable-harness's prefix goes to FLOW_ROUTE; the Workflow SDK's and another consumer's to the Workflow SDK's flow route", async () => {
    const port = await freePort();
    const storage: Record<string, string> =
      world === 'postgres'
        ? { WORKFLOW_POSTGRES_URL: url!, WORKFLOW_POSTGRES_JOB_PREFIX: `fq_${ulid().toLowerCase()}_` }
        : { WORKFLOW_LOCAL_DATA_DIR: await mkdtemp(join(tmpdir(), 'durable-harness-fq-')) };
    const probe = child(['probe', world, String(port)], { ...storage, WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}` });
    const delivered = async (queue: string) => (await probe.next((l) => l.req?.queue === queue)).req.path as string;
    expect(await delivered('__wkf_workflow_fq-probe')).toBe(WORKFLOW_FLOW_ROUTE);
    expect(await delivered('__libfx_wkf_workflow_fq-probe')).toBe(WORKFLOW_FLOW_ROUTE);
    expect(await delivered(`${QUEUE_PREFIX}fq-probe`)).toBe(FLOW_ROUTE);
    await probe.kill();
  }, 60_000);
});

describe('forwardQueue on world-local: a second process on the data directory', () => {
  it("its start-up recovery reaches the app's flowHandler(), and the turn a SIGKILL left mid-tool finishes", async () => {
    expectResumedThroughTheRoute(await drill({ world: 'local', web: 'env' }));
  }, 180_000);
});

/**
 * The controls (`FORWARD_QUEUE_CONTROL=1`). Without `forwardQueue`: the
 * worker's recovery jobs carry no route and go to the Workflow SDK's flow
 * route, which the app does not have. With an app that never starts its
 * World, nothing else re-enqueues the session and the turn stays open. With
 * `forwardQueue` on a route the app does not serve: the worker's route wins
 * over the one on the app's own jobs too, so every delivery it makes misses.
 * Off by default: they show the World's behavior, not durable-harness's.
 */
describe.skipIf(!process.env.FORWARD_QUEUE_CONTROL)('the controls: a bare worker (no forwardQueue), a worker on the wrong route', () => {
  const misrouted = (r: Awaited<ReturnType<typeof drill>>) => {
    const ours = r.requests.filter((q) => q.runId === r.sessionId);
    console.log('[control] deliveries for the session:', JSON.stringify(ours));
    expect(ours.some((q) => q.path === '/.well-known/workflow/v1/flow' && q.status === 404)).toBe(true);
  };
  it.skipIf(!url)('world-postgres, the app passing its World: no route on the jobs, 404s, the turn stays open', async () => {
    const r = await drill({ world: 'postgres', web: 'explicit', worker: 'bare' });
    expect(r.queued.length).toBeGreaterThan(0);
    for (const j of r.queued) expect(j.payload.route).toBeUndefined();
    misrouted(r);
    expect(r.requests.filter((q) => q.runId === r.sessionId).every((q) => q.path === '/.well-known/workflow/v1/flow')).toBe(true);
    expect(r.effects).toBeUndefined();
  }, 120_000);
  it.skipIf(!url)("world-postgres, durable-harness's World: the worker's recovery jobs 404", async () => {
    // (A recovery job the app's own World enqueued at its start carries the route, and can still reach flowHandler().)
    misrouted(await drill({ world: 'postgres', web: 'env', worker: 'bare' }));
  }, 120_000);
  it.skipIf(!url)("world-postgres, a worker on the default route next to an app whose flow route is elsewhere (a Next.js app without the Workflow SDK): every delivery it makes 404s", async () => {
    // The worker's route wins over the one on a job the app enqueued, so it must be the app's.
    const r = await drill({ world: 'postgres', web: 'env', mount: WORKFLOW_FLOW_ROUTE, settles: false });
    const ours = r.requests.filter((q) => q.runId === r.sessionId);
    console.log('[control] deliveries for the session:', JSON.stringify(ours));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((q) => q.path === FLOW_ROUTE && q.status === 404)).toBe(true);
  }, 120_000);
  it('world-local: 404s, flowHandler() never reached, the turn stays open', async () => {
    const r = await drill({ world: 'local', web: 'env', worker: 'bare' });
    misrouted(r);
    expect(r.requests.every((q) => q.path === '/.well-known/workflow/v1/flow')).toBe(true);
    expect(r.effects).toBeUndefined();
  }, 120_000);
});
