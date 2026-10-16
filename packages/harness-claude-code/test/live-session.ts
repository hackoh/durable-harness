/**
 * A session for the live drills (`live-drills.test.ts`, and the driver
 * process `live-driver.ts` that L4 kills): Claude Code with its own tools on,
 * in a real Vercel Sandbox VM booted from `snapshot`, on the Drive and VM
 * named `name`, through the real session factory and relay, the model
 * through `gatewayUrl` (the test's logging proxy in front of the AI
 * Gateway). Credentials are the linked project's development OIDC token
 * (`@vercel/oidc`, `harness-sandbox/probes/lib.ts`); nothing here reads or
 * prints one. Each model request is also described to `tunnel` as it
 * leaves the relay, before the drive's gateway handler (names and beta
 * values only, and the body's model).
 */
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DurableSessions, durableSessions, QUEUE_PREFIX } from 'harness-world';
import { gatewayCredential, type GatewayHandler, type SessionMachine } from 'harness-world-process';
import { kernelSandbox, sandboxSession } from 'harness-world-sandbox';
import { TAGS } from '../../harness-sandbox/probes/lib.ts';
import { claudeCodeHarness } from '../src/harness.ts';

/** One model request as it came out of the VM's model port: never a header's value but `anthropic-beta`'s, never the body but its model. */
export interface TunnelEntry {
  method: string;
  path: string;
  query: string;
  headers: string[];
  betas: string[];
  model?: string;
}

export interface LiveSessionOptions {
  dataDir: string;
  snapshot: string;
  name: string;
  gatewayUrl: string;
  model: string;
  smallModel?: string;
  recover?: boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
  onAttach?: (machine: SessionMachine) => void;
  tunnel?: (entry: TunnelEntry) => void;
}

export interface LiveSession {
  world: LocalWorld;
  sessions: DurableSessions;
  /** Every delivery that failed (a non-2xx answer to the queue: a redelivery). */
  failed: { status: number; body: string }[];
}

/** Describe each request to `tunnel`, then hand it to the drive's handler. */
function logged(handler: GatewayHandler, tunnel: (entry: TunnelEntry) => void): GatewayHandler {
  return (request, signal) => {
    const url = new URL(request.path, 'http://vm');
    let model: string | undefined;
    try {
      const body = JSON.parse(new TextDecoder().decode(request.body)) as { model?: unknown };
      if (typeof body.model === 'string') model = body.model;
    } catch {}
    tunnel({
      method: request.method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      headers: Object.keys(request.headers).map((h) => h.toLowerCase()).sort(),
      betas: String(Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'anthropic-beta')?.[1] ?? '').split(',').map((b) => b.trim()).filter(Boolean),
      ...(model ? { model } : {}),
    });
    return handler(request, signal);
  };
}

export async function liveSession(o: LiveSessionOptions): Promise<LiveSession> {
  // The test seam (the names) is guarded like the stand-in.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  const acquire = sandboxSession({
    spec: { image: { snapshot: o.snapshot }, vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 1024 ** 3, budget: { vmSeconds: 3600 } },
    tags: TAGS,
    log: o.log,
    test: { name: () => o.name },
  });
  const bound = kernelSandbox(acquire);
  const world = createWorld({ dataDir: o.dataDir, recoverActiveRuns: o.recover ?? false });
  const sessions = durableSessions({
    world,
    harness: claudeCodeHarness({
      builtins: true,
      model: o.model,
      ...(o.smallModel ? { smallModel: o.smallModel } : {}),
      sandbox: {
        ...bound,
        attach: async (ctx, request) => {
          const machine = await bound.attach(ctx, { ...request, ...(request.model && o.tunnel ? { model: logged(request.model, o.tunnel) } : {}) });
          o.onAttach?.(machine);
          return machine;
        },
        network: 'allow-all',
        budget: { turnUsd: 0.5, sessionUsd: 2 },
        commandTimeoutMs: 120_000,
      },
      gatewayUrl: o.gatewayUrl,
      credential: gatewayCredential,
      instructions: 'Keep answers short. Run commands exactly as given. Never repeat a command that was interrupted: say so instead.',
      log: o.log,
    }),
  });
  const failed: LiveSession['failed'] = [];
  world.registerHandler(QUEUE_PREFIX, async (request: Request) => {
    const response = await sessions.handler(request);
    if (response.status >= 300) failed.push({ status: response.status, body: (await response.clone().text()).slice(0, 300) });
    return response;
  });
  await world.start?.();
  return { world, sessions, failed };
}
