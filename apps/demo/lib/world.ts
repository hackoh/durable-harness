import type { World } from '@workflow/world';
import { QUEUE_PREFIX } from 'harness-world/queue';

/**
 * The route the kernel's queue is delivered to (app/.well-known/durable-harness/v1/flow),
 * not the Workflow SDK's: world-local and world-postgres send the kernel's
 * prefix there over HTTP once it is registered (on Vercel the route's
 * Function subscribes to the topic instead).
 */
export const FLOW_ROUTE = '/.well-known/durable-harness/v1/flow';

export type WorldName = 'local' | 'postgres' | 'vercel';

export function worldName(): WorldName {
  const name = process.env.HARNESS_WORLD ?? (process.env.VERCEL ? 'vercel' : 'local');
  if (name !== 'local' && name !== 'postgres' && name !== 'vercel') {
    throw new Error(`HARNESS_WORLD must be local, postgres or vercel (got ${name})`);
  }
  return name;
}

/**
 * world-local's data directory: the app's World under HARNESS_WORLD=local,
 * and libfx's too (lib/fx-durable-world.ts). Relative to the server's cwd for
 * both; left unresolved here, since a path.resolve would make the build trace
 * the whole project into every Function.
 */
export const localDataDir = () => process.env.WORKFLOW_LOCAL_DATA_DIR ?? '.workflow-data';

const g = globalThis as { __harnessWorld?: Promise<World> };

/**
 * The process's World. The only line in the app that knows which one it is:
 * everything else is written against the `World` interface.
 */
export function getWorld(): Promise<World> {
  g.__harnessWorld ??= (async () => {
    switch (worldName()) {
      case 'local': {
        const { createWorld } = await import('@workflow/world-local');
        // Its own recovery off: instrumentation.ts re-enqueues the sessions
        // alone (`recoverSessions`), never libfx's runs in the same directory.
        const world = createWorld({ dataDir: localDataDir(), recoverActiveRuns: false });
        world.registerRoute(QUEUE_PREFIX, FLOW_ROUTE);
        return world;
      }
      case 'postgres': {
        const { createWorld } = await import('@workflow/world-postgres');
        const world = createWorld();
        world.registerRoute(QUEUE_PREFIX, FLOW_ROUTE);
        return world;
      }
      case 'vercel': {
        // Event writes go over world-vercel's WebSocket (its default since
        // 5.1.0; HARNESS_EVENTS=http turns it off), but only while the run's
        // channel is open. The flow route's deliveries open one; a drive this
        // process runs itself (the drive route) needs the opener, which
        // harness-world can't import (it doesn't depend on world-vercel), so
        // the app hands over its own. HARNESS_STREAMS=ws also writes streams
        // (live text deltas, marks) over world-vercel's experimental WebSocket
        // stream protocol; off by default, since on beta.52 it hung about 1 in
        // 10 durable fx turns waiting for the first output.
        if (process.env.HARNESS_STREAMS === 'ws') process.env.WORKFLOW_STREAMS_TRANSPORT ??= 'ws';
        const { createWorld, openEventsChannel } = await import('@workflow/world-vercel');
        const { enableVercelWebSockets, setVercelChannelOpener } = await import('harness-world/vercel-channel');
        enableVercelWebSockets();
        setVercelChannelOpener(openEventsChannel);
        return createWorld();
      }
    }
  })();
  return g.__harnessWorld;
}
