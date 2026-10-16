import type { World } from '@workflow/world';
import { sameHarness } from 'harness-world/names';
import { FLOW_ROUTE, QUEUE_PREFIX } from './routing.ts';

/** What a queue delivery carries besides the message. */
export interface QueueMeta {
  attempt: number;
  queueName: string;
  messageId: string;
}

/**
 * An agent as the flow route sees it. Every agent registers itself when it
 * is made (`claudeCode()`, `pi()`, ...), so the flow route only has to load
 * the modules that make them.
 */
export interface Registered {
  /** The harness's kernel name, or pi-durable's name: the last part of its sessions' run name. */
  name: string;
  /**
   * The `workflowName` its new sessions' runs carry
   * (`workflow//durable-harness@<version>//<name>`). A run is this agent's
   * when its name names the same harness in any version or form (`sameHarness`).
   */
  workflowName: string;
  /** The World it was given, or undefined for the environment's (`getWorld()`). */
  world?: World;
  /** Messages it knows as its own without reading the run (pi-durable's wakes). */
  claims?(message: unknown, meta: QueueMeta): boolean;
  /** Run one queue delivery (the kernel's `consume`). */
  consume(message: unknown, meta: QueueMeta): Promise<unknown>;
}

const AGENTS = Symbol.for('durable-harness//agents');
const THIS_TICK = Symbol.for('durable-harness//registered-this-tick');

function agents(): Map<string, Registered> {
  const g = globalThis as { [AGENTS]?: Map<string, Registered> };
  return (g[AGENTS] ??= new Map());
}

/**
 * Register an agent. The latest one with a workflow name wins: a module
 * evaluated again (a hot reload) replaces its agent. Two agents made with one
 * name at once (`export const a = pi(...), b = pi(...)`) are refused: their
 * sessions' runs could not tell them apart, so one would drive the other's.
 */
export function register(agent: Registered): void {
  const g = globalThis as { [THIS_TICK]?: Set<string> };
  let tick = g[THIS_TICK];
  if (!tick) {
    tick = g[THIS_TICK] = new Set();
    queueMicrotask(() => {
      g[THIS_TICK] = undefined;
    });
  }
  if (tick.has(agent.workflowName)) {
    throw new Error(
      `durable-harness: two agents are named '${agent.name}'. A session's run records its agent's name, so two agents of one harness need a name each: pass \`name\` (for example { name: '${agent.name}-2' }), and keep it stable, since sessions already started carry it.`
    );
  }
  tick.add(agent.workflowName);
  agents().set(agent.workflowName, agent);
}

/** The registered agents. */
export function registered(): Registered[] {
  return [...agents().values()];
}

const RECOVERY = `${QUEUE_PREFIX}workflow//`;
const owners = new Map<string, string>();

async function workflowNameOf(world: World, runId: string): Promise<string | undefined> {
  const known = owners.get(runId);
  if (known) return known;
  const run = await world.runs.get(runId).catch(() => undefined);
  const name = (run as { workflowName?: string } | undefined)?.workflowName;
  if (name) {
    owners.set(runId, name);
    while (owners.size > 4096) owners.delete(owners.keys().next().value as string);
  }
  return name;
}

/**
 * One queue message, to the agent whose session it is. With one agent on
 * this World, that one (a World's recovery delivery for another agent's run,
 * whose module has not loaded yet, comes back later); with several, the one
 * that claims it, else the one whose harness the run's `workflowName` names
 * (in any version of durable-harness, or the older `harness-world` form).
 */
export async function dispatch(world: World, message: unknown, meta: QueueMeta): Promise<unknown> {
  const here = registered().filter((a) => a.world === undefined || a.world === world);
  if (here.length === 0) {
    console.warn('[durable-harness] a queue message arrived before any agent was made in this process; it is redelivered in 5 s', { queueName: meta.queueName });
    return { timeoutSeconds: 5 };
  }
  const recoveryOf = meta.queueName.startsWith(RECOVERY) ? meta.queueName.slice(QUEUE_PREFIX.length) : undefined;
  if (here.length === 1) {
    const [only] = here as [Registered];
    if (recoveryOf !== undefined && !sameHarness(recoveryOf, only.workflowName) && !only.claims?.(message, meta)) return { timeoutSeconds: 5 };
    return only.consume(message, meta);
  }
  // A claim settles it when one agent makes it (several pi-durable agents all claim Pi's wakes: the run decides).
  const claimants = here.filter((a) => a.claims?.(message, meta));
  if (claimants.length === 1) return claimants[0]!.consume(message, meta);
  const runId = (message as { runId?: unknown } | undefined)?.runId;
  const name = recoveryOf ?? (typeof runId === 'string' ? await workflowNameOf(world, runId) : undefined);
  const owner = (claimants.length > 1 ? claimants : here).find((a) => sameHarness(name, a.workflowName));
  if (!owner) {
    console.warn('[durable-harness] no agent in this process owns a queue message; it is redelivered in 5 s', { queueName: meta.queueName, runId, workflowName: name });
    return { timeoutSeconds: 5 };
  }
  return owner.consume(message, meta);
}

/** The queue consumer for `world`: every registered agent's deliveries. */
export function queueHandler(world: World): (request: Request) => Promise<Response> {
  return world.createQueueHandler(QUEUE_PREFIX, (message, meta) => dispatch(world, message, meta) as Promise<void>);
}

/** A World's optional per-prefix delivery (`@workflow/world` 5.0.4+: `Queue.registerHandler`, `Queue.registerRoute`). */
type Routable = World & {
  registerHandler?: (prefix: typeof QUEUE_PREFIX, handler: (request: Request) => Promise<Response>) => void;
  registerRoute?: (prefix: typeof QUEUE_PREFIX, path: string) => void;
};

export interface RegisterQueueOptions {
  /**
   * The route the jobs this process enqueues carry: a worker in another
   * process (world-postgres) with no handler or route of its own for
   * durable-harness's prefix delivers them there over HTTP, on the app's base
   * URL. Default: `DURABLE_HARNESS_FLOW_ROUTE`, else where `flowHandler()`
   * says it is mounted (the route `withDurableHarness` writes), else
   * `/.well-known/durable-harness/v1/flow`.
   */
  route?: string;
  /** Where the consumer runs a delivery. Default: `world`'s own (every agent made without a `world`). */
  consumer?: World;
}

const REGISTERED = Symbol.for('durable-harness//registered-queues');
const DEFAULT_ROUTED = Symbol.for('durable-harness//default-routed-worlds');
const MOUNTED = Symbol.for('durable-harness//flow-route');

type Globals = { [REGISTERED]?: WeakSet<World>; [DEFAULT_ROUTED]?: Set<Routable>; [MOUNTED]?: string };

/** The route durable-harness's queue is delivered to over HTTP, unless a registration names its own. */
function defaultRoute(): string {
  return process.env.DURABLE_HARNESS_FLOW_ROUTE || (globalThis as Globals)[MOUNTED] || FLOW_ROUTE;
}

/**
 * Where this app mounts `flowHandler()` (the generated route says, when it is
 * not `FLOW_ROUTE`): every World registered with the default route is told
 * again, so a job enqueued from now on carries it.
 */
export function setFlowRoute(route: string): void {
  const g = globalThis as Globals;
  if (g[MOUNTED] === route) return;
  g[MOUNTED] = route;
  if (process.env.DURABLE_HARNESS_FLOW_ROUTE) return;
  for (const world of g[DEFAULT_ROUTED] ?? []) world.registerRoute?.(QUEUE_PREFIX, route);
}

/**
 * Make `world` deliver durable-harness's queue (`__harness_wkf_workflow_`)
 * to this process's agents: in process (`registerHandler`), and, for a job
 * this process enqueues that a worker elsewhere with no handler for the
 * prefix takes, over HTTP to durable-harness's flow route (`registerRoute`),
 * never to the Workflow SDK's. Once per World instance; call it before
 * `world.start()`. A process that starts a World but makes no agents calls
 * `forwardQueue` instead.
 *
 * `getWorld()` does this for the World it makes, and for the Workflow SDK's
 * own World in the same process when there is one (so the Workflow SDK's
 * restart recovery hands durable-harness's sessions back here). Call it
 * yourself on a World you hold, such as the Workflow SDK's in
 * `instrumentation.ts`:
 *
 * ```ts
 * const { getWorld } = await import('workflow/runtime')
 * const { registerQueue } = await import('durable-harness')
 * registerQueue(await getWorld())
 * ```
 *
 * A World with neither method that delivers in a worker of its own (an
 * older world-local or world-postgres) is warned about: it would send
 * durable-harness's messages to the Workflow SDK's flow route.
 * world-vercel delivers by subscription (the Function at the flow route
 * subscribes to `__harness_wkf_workflow_*`): nothing to register.
 */
export function registerQueue(world: World, options: RegisterQueueOptions = {}): void {
  const g = globalThis as Globals;
  const done = (g[REGISTERED] ??= new WeakSet());
  if (done.has(world)) return;
  done.add(world);
  const routable = world as Routable;
  const consumer = options.consumer ?? world;
  if (typeof routable.registerHandler === 'function') routable.registerHandler(QUEUE_PREFIX, queueHandler(consumer));
  route(routable, options.route);
  if (typeof routable.registerHandler !== 'function' && typeof routable.registerRoute !== 'function') warnUnroutable(world);
}

export interface ForwardQueueOptions {
  /**
   * The path the app mounts `flowHandler()` at, on its base URL. Default:
   * `DURABLE_HARNESS_FLOW_ROUTE`, else `/.well-known/durable-harness/v1/flow`
   * (`FLOW_ROUTE`). A Next.js app without the Workflow SDK, whose generated
   * route is at `/.well-known/workflow/v1/flow`, names that one. This
   * worker's route wins over the one a job's producer registered, so it must
   * be the app's.
   */
  route?: string;
}

/**
 * Make `world` send durable-harness's queue (`__harness_wkf_workflow_`) over
 * HTTP to the app's flow route, and run none of it here: for a process that
 * starts a World on the app's database (or data directory) but makes no
 * agents, such as a world-postgres worker of its own or the Workflow SDK's
 * worker. Call it before `world.start()`.
 *
 * `start()` re-enqueues every open run it finds, durable-harness's sessions
 * on durable-harness's prefix. A worker delivers a job to the route it
 * registered for the prefix, else to the one the job's producer registered,
 * else to the Workflow SDK's flow route (`/.well-known/workflow/v1/flow`),
 * which refuses it. With this, the sessions this process re-enqueues, and
 * every job of the prefix its worker takes, go to the app's route. The base
 * URL is the World's own: `WORKFLOW_LOCAL_BASE_URL` (else `PORT` on
 * localhost).
 *
 * ```ts
 * import { createWorld } from '@workflow/world-postgres'
 * import { forwardQueue } from 'durable-harness'
 *
 * const world = createWorld()
 * forwardQueue(world)
 * await world.start()
 * ```
 *
 * In a process that makes agents, use `registerQueue` (or `getWorld()`),
 * which also runs their deliveries in process. world-vercel delivers by
 * subscription: nothing to forward.
 */
export function forwardQueue(world: World, options: ForwardQueueOptions = {}): void {
  const routable = world as Routable;
  if (typeof routable.registerRoute === 'function') route(routable, options.route);
  else warnUnroutable(world);
}

/**
 * Register durable-harness's route on `world`: `path`, else the default,
 * which is told again when `flowHandler()` names another (a `path` is kept,
 * even over a default registered before it).
 */
function route(world: Routable, path: string | undefined): void {
  if (typeof world.registerRoute !== 'function') return;
  world.registerRoute(QUEUE_PREFIX, path ?? defaultRoute());
  const routed = ((globalThis as Globals)[DEFAULT_ROUTED] ??= new Set());
  if (path) routed.delete(world);
  else routed.add(world);
}

/** A World that delivers in a worker of its own but cannot be told durable-harness's route (an older world-local or world-postgres). */
function warnUnroutable(world: World): void {
  if (typeof world.start !== 'function') return;
  console.warn(
    `[durable-harness] This World cannot deliver durable-harness's queue (${QUEUE_PREFIX}) to durable-harness: it has no registerHandler or registerRoute, so its worker would send these messages to the Workflow SDK's flow route. Upgrade @workflow/world-local (5.1.1 or later) or @workflow/world-postgres (5.0.4 or later).`
  );
}
