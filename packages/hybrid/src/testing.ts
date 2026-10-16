import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, createModels } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import {
  type DeliverMeta,
  type DriverOptions,
  deliver,
  durableSessions,
  type Lane,
  type LaneOptions,
  QUEUE_PREFIX,
  type SessionState,
} from 'harness-world';
import { FakeSandboxProvider } from './fake-sandbox.ts';
import { hybridHarness } from './harness.ts';
import { hybridTools } from './tools.ts';

/** Test scaffolding for hybrid sessions on world-local with a fake sandbox. Not part of the package API. */

export type World = DriverOptions['world'];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const forever = () => new Promise<never>(() => {});
export const textOf = (context: Context) => JSON.stringify(context.messages);

/**
 * A process's view of the World; `kill()` is the process dying (nothing it
 * calls returns). `dieOn` kills it the moment it tries a matching event write.
 */
export function hostProcess(base: World, dieOn?: (request: { eventType?: string; eventData?: { stepName?: string } }) => boolean) {
  let dead = false;
  const wrap = <T extends object>(target: T, path = ''): T =>
    new Proxy(target, {
      get(t, key) {
        const value = (t as Record<string | symbol, unknown>)[key];
        if (typeof value === 'function') {
          return async (...args: unknown[]) => {
            if (dead) return forever();
            if (path === 'events' && key === 'create' && dieOn?.(args[1] as never)) {
              dead = true;
              return forever();
            }
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (value && typeof value === 'object' && ['events', 'streams', 'runs', 'steps', 'hooks'].includes(String(key))) {
          return wrap(value as object, String(key));
        }
        return value;
      },
    });
  return { world: wrap(base), kill: () => void (dead = true), get dead() { return dead; } };
}

export async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
}

export function piSetup(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}

export function laneOptions(serves: Lane[], queue: Lane[]): LaneOptions {
  return {
    serves,
    settle: 'browser',
    async wake(_runId, to) {
      queue.push(to);
    },
  };
}

export const PUSH_SECRET = 'test-callback-secret';

export interface HybridSetup {
  world: LocalWorld;
  sessions: ReturnType<typeof durableSessions>;
  sessionId: string;
  sandbox: FakeSandboxProvider;
  tab: DriverOptions;
  server: DriverOptions;
  queue: Lane[];
  pi: ReturnType<typeof piSetup>;
  /** Deliver the tab lane, then every lane woken, until nothing is queued. */
  deliverQueued(meta?: DeliverMeta): Promise<void>;
  /** Drive until idle: the tab's delivery, then every lane it woke. */
  drive(): Promise<void>;
  inspect(): Promise<SessionState>;
}

/**
 * A hybrid Pi session: the tab drives `browser`, `server` drives
 * `function`/`sandbox` with a fake sandbox, both on the session's virtual
 * workspace (in this realm: `isolation: 'process'`). `push` configures a
 * push callback on the fake (`run_on_machine` refuses one).
 */
export async function hybridSetup(
  responses: Parameters<typeof piSetup>[0],
  options: {
    push?: boolean;
    prepare?: (sandbox: FakeSandboxProvider) => void;
    world?: (w: LocalWorld) => World;
    chaos?: boolean;
    /** The server's `maxInvocationMs` (its drives' deadline). */
    maxInvocationMs?: number;
    /** `run_on_machine`'s margin before that deadline. */
    marginMs?: number;
  } = {}
): Promise<HybridSetup> {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-')), recoverActiveRuns: false });
  world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
  const w = options.world?.(world) ?? world;
  const pi = piSetup(responses);
  const sandbox = new FakeSandboxProvider(options.push ? { push: { url: 'https://app.test/api/hybrid/sandbox-result', secret: PUSH_SECRET } } : {});
  options.prepare?.(sandbox);
  const queue: Lane[] = [];
  const tools = hybridTools({ lane: 'sandbox', sandbox, isolation: 'process', ...(options.marginMs !== undefined ? { marginMs: options.marginMs } : {}) });
  const tab: DriverOptions = {
    world: w,
    harness: hybridHarness({ ...pi, lane: 'browser', tools: hybridTools({ lane: 'browser', isolation: 'process' }) }),
    lanes: laneOptions(['browser'], queue),
  };
  const server: DriverOptions = {
    world: w,
    harness: hybridHarness({ ...pi, lane: 'sandbox', tools }),
    lanes: laneOptions(['function', 'sandbox'], queue),
    ...(options.maxInvocationMs !== undefined ? { maxInvocationMs: options.maxInvocationMs } : {}),
    ...(options.chaos ? { chaos: true, crash: () => {} } : {}),
  };
  const sessions = durableSessions({ world: w, harness: tab.harness });
  const { sessionId } = await sessions.start({ harness: 'hybrid' });
  const inspect = () => sessions.inspect(sessionId);
  const deliverQueued = async (meta: DeliverMeta = {}) => {
    while (queue.length) await deliver(queue.shift() === 'browser' ? tab : server, sessionId, meta);
  };
  const drive = async () => {
    queue.push('browser');
    await deliverQueued();
  };
  return { world, sessions, sessionId, sandbox, tab, server, queue, pi, deliverQueued, drive, inspect };
}

export type { LaneOptions };
