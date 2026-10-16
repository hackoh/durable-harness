/**
 * The sessions of this Worker, on the Cloudflare Durable Objects World
 * (vercel/workflow#4682). Each session is one run, and each run is one
 * Durable Object (`RunObject`): it stores the session's event log, holds its
 * queue messages as alarms, and drives the session in its own isolate by
 * handing each message to `sessions.handler`, the kernel's queue consumer.
 */
import { setupCloudflareWorld } from '@workflow/world-cloudflare';
import { durableSessions, type DurableSessions, exclusiveAnchors } from 'harness-world';
import { aiSdkHarness } from './ai-sdk.ts';
import { echoHarness } from './echo.ts';
import { fxHarness } from './fx.ts';
import { piDurable } from './pi-durable.ts';
import { piHarness } from './pi.ts';
import { probeRoute } from './probe.ts';
import { workspaceHarness } from './workspace.ts';

const env = (name: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

/**
 * Runs are pinned to the build that created them: a run object holds the
 * messages of a run another build started. Bump it when a change must not
 * drive the sessions an older build left (wrangler.jsonc `vars`).
 */
export const DEPLOYMENT_ID = env('HARNESS_DEPLOYMENT_ID') ?? 'dpl_harness_cloudflare';

export const world = setupCloudflareWorld({
  deploymentId: DEPLOYMENT_ID,
  // The run object delivers every queue message by calling this route in its
  // own isolate. harness-world's handler is the World's `createQueueHandler`
  // route, so it serves the delivery directly. Built lazily: `sessions` is
  // defined below, and the first delivery comes long after module load.
  createFlowRoute: () => (request) => sessions.handler(request),
  // QuickJS is core's VM for `"use workflow"` code; the kernel runs none.
  quickjs: { quickjs: {}, encoding: {}, headers: {}, url: {}, structuredClone: {} },
  setWorld: () => {},
});

/** Pi variant A: Pi's own Harness, sharing the flow route through `route`. */
export const piA = piDurable(world);
const probe = probeRoute(world);

export const sessions: DurableSessions = durableSessions({
  world,
  // Messages the kernel does not own: Pi variant A's, and the contract probes'.
  route: (message, meta) => probe(message) ?? piA.route(message, meta),
  harness: [piHarness(), aiSdkHarness(), fxHarness(), echoHarness(), workspaceHarness()],
  // The run object delivers one flow message at a time: an intent anchored to
  // any other message names a delivery that is not running, so it is gone.
  anchors: exclusiveAnchors(),
  contendedDelaySeconds: 2,
  log: env('HARNESS_DEBUG') === '1' ? (message, fields) => console.log('[harness]', message, JSON.stringify(fields)) : undefined,
});
