import type { World } from '@workflow/world';
import { queueHandler, setFlowRoute } from './registry.ts';
import { getWorld } from './world.ts';

/**
 * The flow route's handler: every agent made in this process, on the
 * environment's World, where the queue delivers durable-harness's prefix
 * (`__harness_wkf_workflow_`). A message goes to the agent whose session it
 * is. `withDurableHarness` generates the route that mounts it in a Next.js
 * app; on Vercel Functions, `api/flow.ts`; on a server, mount it at
 * `/.well-known/durable-harness/v1/flow` (`FLOW_ROUTE`).
 *
 * `route`: the path it is mounted at, when not `FLOW_ROUTE`: every job this
 * process enqueues on a World that delivers over HTTP from a worker in
 * another process (world-postgres) carries it (`registerQueue`). A process
 * that starts a World but makes no agents is told with
 * `forwardQueue(world, { route })`.
 */
export function flowHandler(options: { route?: string } = {}): (request: Request) => Promise<Response> {
  if (options.route) setFlowRoute(options.route);
  let handler: Promise<(request: Request) => Promise<Response>> | undefined;
  return async (request) => {
    handler ??= getWorld().then((world: World) => queueHandler(world));
    return (await handler)(request);
  };
}
