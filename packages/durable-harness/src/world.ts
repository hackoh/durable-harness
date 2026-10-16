import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isVercelWorldTarget, resolveWorkflowTargetWorld } from '@workflow/utils';
import type { World } from '@workflow/world';
import { recoverSessions } from 'harness-world';
import { enableVercelWebSockets, setVercelChannelOpener } from 'harness-world/vercel-channel';
import { registerQueue } from './registry.ts';
import { QUEUE_NAMESPACE } from './routing.ts';

/**
 * The World sessions live on, chosen the way the Workflow SDK chooses one
 * (`@workflow/core`'s `getWorld()`): `WORKFLOW_TARGET_WORLD` names it
 * (`vercel`, `local`, or a package / file exporting `createWorld()`), else
 * Vercel's World inside a Vercel deployment (`VERCEL_DEPLOYMENT_ID`) and
 * world-local everywhere else (`WORKFLOW_LOCAL_DATA_DIR`, default
 * `.workflow-data`). Resolved when the process first needs it, not at build.
 *
 * One per process (on `globalThis`, so every bundled copy and every Next.js
 * layer shares it). On a World whose queue runs in this process (world-local,
 * world-postgres) this process consumes durable-harness's queue itself, on its
 * own prefix (`registerQueue`), and starts the World once; then it
 * re-enqueues the sessions a killed server left mid-turn (`recoverSessions`).
 * No `instrumentation.ts`. When the Workflow SDK's World is in this process
 * too, it is given durable-harness's queue as well (see `registerQueue`).
 */
export function getWorld(): Promise<World> {
  const g = globalThis as { [KEY]?: Promise<World> };
  g[KEY] ??= createWorld().catch((error) => {
    g[KEY] = undefined;
    throw error;
  });
  return g[KEY].then((world) => {
    shareWithWorkflowSdk(world);
    return world;
  });
}

const KEY = Symbol.for('durable-harness//world');

/** Which World `getWorld()` makes here: `vercel`, `local`, or a module specifier. */
export function worldTarget(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkflowTargetWorld(env);
}

async function createWorld(): Promise<World> {
  warnNamespace();
  const target = worldTarget();
  if (isVercelWorldTarget(target)) {
    const { createWorld, openEventsChannel } = await import('@workflow/world-vercel');
    // A drive this process runs itself (the chat route's) writes its events
    // over world-vercel's WebSocket while the session's channel is open; a
    // queue delivery opens its own. HARNESS_EVENTS=http keeps HTTP. Its queue
    // delivers by subscription: the Function at the flow route subscribes to
    // `__harness_wkf_workflow_*` (vercel.json), nothing to register here.
    enableVercelWebSockets();
    setVercelChannelOpener(openEventsChannel);
    return createWorld();
  }
  if (target === 'local') {
    const { createWorld } = await import('@workflow/world-local');
    // Its own recovery off: it would re-enqueue every active run in the data
    // directory through this instance (the Workflow SDK's and libfx's
    // included), and sessions from before durable-harness had a namespace on
    // the Workflow SDK's prefix. `recoverSessions` re-enqueues sessions alone.
    const world = createWorld({ ...(process.env.WORKFLOW_LOCAL_DATA_DIR ? { dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR } : {}), recoverActiveRuns: false });
    start(world, false);
    return world;
  }
  // A custom World (world-postgres, or your own): loaded from the app, as
  // @workflow/core loads it. Its own recovery sends the sessions that recorded
  // durable-harness's namespace to this prefix; `recoverSessions` takes the
  // ones from before.
  const mod = await loadModule(target);
  const make = typeof mod === 'function' ? mod : (mod.createWorld ?? mod.default);
  const world = (typeof make === 'function' ? await make() : make) as World | undefined;
  if (!world || typeof world.events?.create !== 'function') {
    throw new Error(`durable-harness: WORKFLOW_TARGET_WORLD=${target} must export createWorld() or a default World`);
  }
  start(world, true);
  return world;
}

const STARTED = Symbol.for('durable-harness//started');

/**
 * Register durable-harness's queue on `world`, start it once, and re-enqueue
 * the sessions a dead process left mid-turn. Not awaited: the first request
 * does not wait for recovery to be queued.
 */
function start(world: World, unrecorded: boolean): void {
  registerQueue(world);
  const g = globalThis as { [STARTED]?: WeakSet<World> };
  const started = (g[STARTED] ??= new WeakSet());
  if (started.has(world) || typeof world.start !== 'function') return;
  started.add(world);
  world
    .start()
    .then(() => recoverSessions(world, { unrecorded }))
    .catch((error: unknown) => console.error('[durable-harness] the World did not start', error));
}

/** Where `@workflow/core` keeps the Workflow SDK's World (`getWorld()` from `workflow/runtime`). A private symbol: read best effort. */
const WORKFLOW_WORLD = Symbol.for('@workflow/world//cache');

/**
 * The Workflow SDK's World, when this process has made one (an app that also
 * uses `withWorkflow`), gets durable-harness's queue too. Its restart recovery
 * re-enqueues durable-harness's sessions on durable-harness's prefix through
 * its own queue: without a handler or route there, world-local would post
 * them to the Workflow SDK's flow route, which refuses them, and retry. Our
 * own instance recovers our sessions either way; this only spares the
 * retries. Checked on every `getWorld()` (world-local and world-postgres read
 * registrations on each delivery attempt, so a late one takes the next).
 */
function shareWithWorkflowSdk(ours: World): void {
  const theirs = (globalThis as { [WORKFLOW_WORLD]?: World })[WORKFLOW_WORLD];
  if (theirs && theirs !== ours && typeof theirs === 'object') registerQueue(theirs, { consumer: ours });
}

const WARNED_NAMESPACE = Symbol.for('durable-harness//warned-namespace');

/** The Workflow SDK on durable-harness's namespace would consume durable-harness's queue. */
function warnNamespace(): void {
  const g = globalThis as { [WARNED_NAMESPACE]?: boolean };
  if (g[WARNED_NAMESPACE] || process.env.WORKFLOW_QUEUE_NAMESPACE !== QUEUE_NAMESPACE) return;
  g[WARNED_NAMESPACE] = true;
  console.warn(
    `[durable-harness] WORKFLOW_QUEUE_NAMESPACE is '${QUEUE_NAMESPACE}', durable-harness's own queue namespace: the Workflow SDK's messages and durable-harness's would share one prefix. Pick another namespace for the Workflow SDK.`
  );
}

async function loadModule(specifier: string): Promise<any> {
  const fromApp = createRequire(pathToFileURL(`${process.cwd()}/package.json`).href);
  try {
    return fromApp(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier);
  } catch {
    const resolved = specifier.startsWith('.') || specifier.startsWith('/')
      ? pathToFileURL(specifier.startsWith('/') ? specifier : `${process.cwd()}/${specifier}`).href
      : pathToFileURL(fromApp.resolve(specifier)).href;
    return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ resolved);
  }
}
