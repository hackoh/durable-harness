/**
 * The processes of the forwardQueue drill (forward-queue.test.ts), each a
 * separate OS process, with Pi and a scripted model (pi-ai's faux provider).
 *
 *   web <port> <explicit|env> <hang|resume> [sessionId]
 *   worker <postgres|local> <forward|bare>
 *   probe <postgres|local> <port>
 *
 * web: the app, an HTTP server on 127.0.0.1:<port> that mounts the queue's
 * consumer at `FQ_MOUNT` (default `FLOW_ROUTE`; another path is named to
 * `flowHandler({ route })` or `registerQueue(world, { route })`) and nothing
 * else (a request to any other path, the Workflow SDK's flow route
 * included, gets the 404 a server without it answers). Every request it
 * gets is printed as `{"req":{path, queue, runId, status}}`.
 * - explicit: the World passed in (`createWorld()` from world-postgres,
 *   `registerQueue(world)`, no `world.start()`), the agent's own `handler`
 *   at the route.
 * - env: durable-harness's World (`WORKFLOW_TARGET_WORLD`), `flowHandler()`
 *   at the route. With `resume`, nothing touches the World until the first
 *   delivery reaches the route: the World is made then, as an app makes it
 *   on its first request.
 * - hang: starts a session whose model calls `wait`, which prints
 *   `{"worked":true}` and hangs, so the parent's SIGKILL leaves the turn open
 *   in the middle of the tool.
 * - resume: the model answers `done`; once the session settles (two model
 *   calls completed, nothing pending) it closes the session and prints its
 *   effects.
 *
 * worker: `createWorld()` (world-postgres from `WORKFLOW_POSTGRES_URL` and
 * `WORKFLOW_POSTGRES_JOB_PREFIX`, or world-local on
 * `WORKFLOW_LOCAL_DATA_DIR`), `forwardQueue(world)` unless bare (with
 * `{ route: FQ_ROUTE }` when set), then `world.start()`. It makes no agents.
 * It delivers over HTTP to `WORKFLOW_LOCAL_BASE_URL`.
 *
 * probe: a worker that also runs the Workflow SDK's queue (and a third
 * consumer's): an HTTP server on 127.0.0.1:<port> that answers every POST
 * and prints its path, a World as the worker makes it with
 * `forwardQueue(world)`, then one message on each of the Workflow SDK's
 * prefix, libfx's and durable-harness's.
 */
import { createServer } from 'node:http';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { World } from '@workflow/world';
import { durableAgent, FLOW_ROUTE, flowHandler, forwardQueue, type HostTool, isSettled, QUEUE_PREFIX, registerQueue } from '../src/index.ts';
import { piHarness } from '../src/pi.ts';

const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const [role, ...args] = process.argv.slice(2);
const workerWorld = async (kind: string | undefined): Promise<World> =>
  kind === 'postgres'
    ? (await import('@workflow/world-postgres')).createWorld()
    : (await import('@workflow/world-local')).createWorld({ dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR! });

if (role === 'worker') {
  const [kind, mode] = args;
  const world = await workerWorld(kind);
  if (mode === 'forward') forwardQueue(world, process.env.FQ_ROUTE ? { route: process.env.FQ_ROUTE } : {});
  await world.start?.();
  say({ started: true, pid: process.pid });
  setInterval(() => {}, 1 << 30);
} else if (role === 'probe') {
  const [kind, port] = args;
  await new Promise<void>((listening) =>
    createServer(async (req, res) => {
      for await (const _ of req);
      say({ req: { path: String(req.url).split('?')[0], queue: req.headers['x-vqs-queue-name'] } });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }).listen(Number(port), '127.0.0.1', listening)
  );
  const world = await workerWorld(kind);
  forwardQueue(world);
  await world.start?.();
  const queue = world.queue as (name: string, message: unknown) => Promise<unknown>;
  for (const prefix of ['__wkf_workflow_', '__libfx_wkf_workflow_', QUEUE_PREFIX]) await queue(`${prefix}fq-probe`, { runId: 'wrun_fq_probe' });
  say({ queued: true, pid: process.pid });
  setInterval(() => {}, 1 << 30);
} else if (role === 'web') {
  const [port, kind, mode, resumeId] = args;
  const hang = mode === 'hang';
  const wait: HostTool<{ seconds: number }> = {
    name: 'wait',
    description: 'Waits, then says so',
    replay: 'safe',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
    async execute() {
      if (hang) {
        say({ worked: true });
        await new Promise((r) => setTimeout(r, 120_000));
      }
      return 'waited';
    },
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(hang ? [fauxAssistantMessage(fauxToolCall('wait', { seconds: 1 }), { stopReason: 'toolUse' })] : [fauxAssistantMessage(fauxText('done'))]);
  // A name of its own (FQ_NAME), so a session another drill left open on a shared database is not this agent's.
  const harness = { ...piHarness({ model: faux.getModel(), streamFn: models.streamSimple.bind(models), tools: [wait] }), name: process.env.FQ_NAME ?? 'pi' };

  const mount = process.env.FQ_MOUNT || FLOW_ROUTE;
  const route = mount === FLOW_ROUTE ? {} : { route: mount };
  let world: World | undefined;
  if (kind === 'explicit') {
    world = (await import('@workflow/world-postgres')).createWorld();
    registerQueue(world, route);
  }
  const agent = durableAgent({ harness, ...(world ? { world } : {}) });
  const consume = world ? agent.handler : flowHandler(route);

  let delivered!: () => void;
  const firstDelivery = new Promise<void>((r) => (delivered = r));
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let runId: string | undefined;
    try {
      runId = (JSON.parse(body.toString('utf8')) as { runId?: string }).runId;
    } catch {}
    const path = String(req.url).split('?')[0]!;
    let response: Response;
    if (req.method === 'POST' && path === mount) {
      delivered();
      response = await consume(new Request(`http://127.0.0.1:${port}${req.url}`, { method: 'POST', headers, body }));
    } else {
      response = new Response('Not found', { status: 404 });
    }
    say({ req: { path, queue: headers.get('x-vqs-queue-name'), runId, status: response.status } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(Number(port), '127.0.0.1', () => say({ listening: Number(port), pid: process.pid }));

  if (hang) {
    const { sessionId } = await agent.sessions.start({ prompt: 'wait a second' });
    say({ sessionId, pid: process.pid });
    setInterval(() => {}, 1 << 30);
  } else {
    // Lazy (env): the first delivery to the route makes the World; reading the session before would make it here.
    if (!world) await firstDelivery;
    const started = Date.now();
    for (;;) {
      const s = await agent.sessions.inspect(resumeId!);
      const answered = s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length >= 2;
      if (answered && isSettled(s)) {
        const effects = s.effectOrder.map(({ name, status, retryOf, output }) => ({ name, status, retryOf, output }));
        // Closed, so no later World start on a shared database re-enqueues it.
        await agent.sessions.close(resumeId!);
        say({ settled: true, pid: process.pid, effects });
        break;
      }
      if (Date.now() - started > 90_000) throw new Error('timed out waiting for the recovered turn');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
} else {
  throw new Error('usage: forward-queue-child.ts web <port> <explicit|env> <hang|resume> [sessionId] | worker <postgres|local> <forward|bare> | probe <postgres|local> <port>');
}
