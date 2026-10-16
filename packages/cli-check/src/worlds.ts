import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { ulid } from 'ulid';
import type { Target } from './cli.ts';

/**
 * The Worlds a check runs on. Each scenario gets its own storage: a data
 * directory on world-local, a job queue prefix on world-postgres (one shared
 * database). A storage can be opened more than once, one World instance at a
 * time, the way a second process opens the same World after a crash.
 */

/** `vercel` is read through a deployment of apps/demo (test/vercel.test.ts), not selectable here. */
export type WorldName = 'local' | 'postgres' | 'vercel';
export const WORLD_NAMES: readonly WorldName[] = ['local', 'postgres'];

export type RequestHandler = (request: Request) => Promise<Response>;

export interface OpenWorld {
  world: World;
  /** Deliver this World's queue messages for `prefix` to `handler`, and start its queue. */
  serve(prefix: string, handler: RequestHandler): Promise<void>;
  /**
   * Wait until this World's queue holds no message due soon. A World instance
   * closed under a delivery (the check's stand-in for a dead process) can have
   * that delivery come back to the next instance after the session settled:
   * world-postgres fails a job its worker shut down under, and retries it a
   * few seconds later. Its redelivery fences (a `recover` step), so the check
   * judges a recovered session once nothing more is coming.
   */
  drained(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface Storage {
  name: WorldName;
  /** How the CLI reads this storage. */
  target: Target;
  /** A new World instance on this storage. `recover`: re-deliver its active runs on start (a restarted process). */
  open(options?: { recover?: boolean }): Promise<OpenWorld>;
}

/** Where data directories and reports go (`CLI_CHECK_OUT`, default a temp dir), so CI can upload them. */
export function outDir(): string {
  const dir = process.env.CLI_CHECK_OUT ?? join(tmpdir(), 'harness-cli-check');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The Worlds this run checks: `CLI_CHECK_WORLDS` (comma separated, default `local`). */
export function selectedWorlds(): WorldName[] {
  const names = (process.env.CLI_CHECK_WORLDS ?? 'local').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) if (!WORLD_NAMES.includes(name as WorldName)) throw new Error(`CLI_CHECK_WORLDS: unknown World "${name}"`);
  return names as WorldName[];
}

/** Why a World cannot run here, or undefined. */
export function worldSkipReason(name: WorldName): string | undefined {
  if (name === 'postgres' && !postgresUrl()) return 'world-postgres needs WORKFLOW_POSTGRES_URL (a database with the World migrations applied)';
  return undefined;
}

export const postgresUrl = (): string | undefined => process.env.WORKFLOW_POSTGRES_URL;

export function storageFor(name: WorldName, scenario: string): Storage {
  if (name === 'vercel') throw new Error('world-vercel sessions are driven through a deployment (test/vercel.test.ts)');
  return name === 'local' ? localStorage(scenario) : postgresStorage(scenario);
}

function localStorage(scenario: string): Storage {
  const dataDir = join(outDir(), 'local', `${scenario}-${ulid().toLowerCase()}`);
  mkdirSync(dataDir, { recursive: true });
  return {
    name: 'local',
    target: { world: 'local', dataDir },
    async open({ recover = false } = {}) {
      const world = createLocalWorld({ dataDir, recoverActiveRuns: recover });
      return {
        world,
        async serve(prefix, handler) {
          world.registerHandler(prefix, handler);
          await world.start?.();
        },
        // world-local delivers in process: a closed instance's delivery is gone with it, and `start()` re-delivers at once.
        drained: async () => {},
        close: async () => {
          await world.close?.();
        },
      };
    },
  };
}

/**
 * world-postgres delivers its queue over HTTP to the app's flow route
 * (`WORKFLOW_LOCAL_BASE_URL`, read per delivery), so one loopback server per
 * process stands in for the app and hands each request to the handler of the
 * World open in it. Each scenario's World works its own job queue
 * (`jobPrefix`), so World instances in other test processes on the same
 * database never take its deliveries.
 */
let front: { server: Server; handler?: RequestHandler } | undefined;
async function loopbackFront(): Promise<NonNullable<typeof front>> {
  if (front) return front;
  const state: { server?: Server; handler?: RequestHandler } = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (!state.handler) return void res.writeHead(503).end('no World is open in this process');
    try {
      const response = await state.handler(
        new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.server = server;
  front = state as NonNullable<typeof front>;
  return front;
}

function postgresStorage(scenario: string): Storage {
  const url = postgresUrl();
  if (!url) throw new Error(worldSkipReason('postgres'));
  const jobPrefix = `clicheck_${scenario.replace(/[^a-z0-9]/gi, '_')}_${ulid().toLowerCase()}_`;
  return {
    name: 'postgres',
    target: { world: 'postgres', url },
    async open() {
      const http = await loopbackFront();
      const { createWorld } = await import('@workflow/world-postgres');
      // `start()` re-delivers every active run in the database to this World's
      // queue; sessions of other scenarios find no harness here and are skipped.
      const world = createWorld({ connectionString: url, jobPrefix, queueConcurrency: 20, pollInterval: 200 });
      let served = false;
      return {
        world,
        async serve(_prefix, handler) {
          http.handler = handler;
          served = true;
          await world.start();
        },
        drained: (timeoutMs = 30_000) => graphileDrained(url, jobPrefix, timeoutMs),
        close: async () => {
          await world.close?.();
          if (served) http.handler = undefined;
        },
      };
    },
  };
}

/** Until no graphile job of this job queue is due within the next 15 s (a retry of a failed delivery is due within seconds). */
async function graphileDrained(url: string, jobPrefix: string, timeoutMs: number): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const started = Date.now();
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from graphile_worker._private_jobs j
           join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier like $1 and j.run_at < now() + interval '15 seconds'`,
        [`${jobPrefix}%`]
      );
      if (rows[0]!.n === 0 || Date.now() - started > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await client.end().catch(() => {});
  }
}
