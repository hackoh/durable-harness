import type { World } from '@workflow/world';
import type { WorldCall } from './run-scope.ts';
import {
  encodeFrame,
  FRAME,
  serializeError,
  statusForError,
  type WireError,
  wire,
} from './wire.ts';

/**
 * The storage and stream calls a remote World may make, one entry per World
 * method. Everything not listed is refused: in particular the queue, which
 * stays on each side of the wire (see `createRemoteWorld`).
 */
export const OPS = [
  'runs.get',
  'runs.list',
  'steps.get',
  'steps.list',
  'hooks.get',
  'hooks.getByToken',
  'hooks.list',
  'events.create',
  'events.list',
  'events.get',
  'events.listByCorrelationId',
  'streams.write',
  'streams.writeMulti',
  'streams.close',
  'streams.getChunks',
  'streams.getInfo',
  'streams.list',
  'getDeploymentId',
] as const;

export { mintRunToken, RUN_TOKEN_HEADER, type RunScopeOptions, type RunTokenClaims, runOf, runScope, verifyRunToken, type WorldCall } from './run-scope.ts';

/** `info` (specVersion and friends, read once per client) and the live tail. */
export type Op = (typeof OPS)[number] | 'info' | 'streams.get';

/** What `info` returns: the parts of the fronted World a client mirrors. */
export interface RemoteWorldInfo {
  specVersion: number;
  deploymentId: string;
  capabilities?: {
    hookRetention?: { active: boolean };
    hookResumeDedup?: boolean;
    hookForceClaim?: boolean;
  };
}

/** Resume position for a `streams.get` tail after a reconnect. */
export interface StreamResume {
  /** Bytes of the stream (from `startIndex`) the client already has. */
  skipBytes?: number;
}

export interface WorldHandlerOptions {
  /**
   * Refuse a call (401) unless this returns true. Called once the request
   * is parsed, with the call it carries, so a check can be about the run
   * the call touches (`runScope`). Default: allow.
   */
  authorize?(req: Request, call: WorldCall): boolean | Promise<boolean>;
  /** Restrict the ops this endpoint serves. Default: all of them. */
  ops?: readonly Op[];
  /**
   * Longest one `streams.get` response stays open. The client reconnects
   * where it left off, so this only needs to sit under the platform's
   * function duration limit. Default 240s.
   */
  maxStreamMs?: number;
  /**
   * Called after an op succeeded, before the response goes out (so a
   * client that waits for the response also waits for this). A failure is
   * reported through `onError`, never to the client: the op itself is
   * committed. The demo sends a server lane's wake here when a tab commits a
   * handoff into it (or a submission while the session is in one); a tab
   * whose own wake did not land keeps retrying it, and a tab that went away
   * is covered by its tether's tab-lost callback.
   */
  onCommitted?(op: Op, args: unknown[], value: unknown): void | Promise<void>;
  onError?(error: unknown, op: Op): void;
}

// `never[]`: each entry spreads positional args it trusts the client to have
// shaped like the World method's own parameters; the World validates them.
type Call = (world: World, args: never[]) => Promise<unknown>;

const CALLS: Record<Exclude<Op, 'streams.get'>, Call> = {
  info: async (world) =>
    ({
      specVersion: world.specVersion,
      deploymentId: await world.getDeploymentId(),
      capabilities: pickCapabilities(world),
    }) satisfies RemoteWorldInfo,
  getDeploymentId: (world) => world.getDeploymentId(),
  'runs.get': (world, [id, params]) => world.runs.get(id, params),
  'runs.list': (world, [params]) => world.runs.list(params),
  'steps.get': (world, [runId, stepId, params]) => world.steps.get(runId, stepId, params),
  'steps.list': (world, [params]) => world.steps.list(params),
  'hooks.get': (world, [hookId, params]) => world.hooks.get(hookId, params),
  'hooks.getByToken': (world, [token, params]) => world.hooks.getByToken(token, params),
  'hooks.list': (world, [params]) => world.hooks.list(params),
  'events.create': (world, [runId, data, params]) => world.events.create(runId, data, params),
  'events.list': (world, [params]) => world.events.list(params),
  'events.get': (world, [runId, eventId, params]) => world.events.get(runId, eventId, params),
  'events.listByCorrelationId': (world, [params]) =>
    world.events.listByCorrelationId(params),
  'streams.write': (world, [runId, name, chunk]) => world.streams.write(runId, name, chunk),
  'streams.writeMulti': async (world, [runId, name, chunks]) => {
    const all = chunks as (string | Uint8Array)[];
    if (world.streams.writeMulti) return world.streams.writeMulti(runId, name, all);
    for (const chunk of all) await world.streams.write(runId, name, chunk);
  },
  'streams.close': (world, [runId, name]) => world.streams.close(runId, name),
  'streams.getChunks': (world, [runId, name, options]) =>
    world.streams.getChunks(runId, name, options),
  'streams.getInfo': (world, [runId, name]) => world.streams.getInfo(runId, name),
  'streams.list': (world, [runId]) => world.streams.list(runId),
};

function pickCapabilities(world: World): RemoteWorldInfo['capabilities'] {
  const c = world.capabilities;
  if (!c) return undefined;
  return {
    ...(c.hookRetention ? { hookRetention: c.hookRetention } : {}),
    ...(c.hookResumeDedup !== undefined ? { hookResumeDedup: c.hookResumeDedup } : {}),
    ...(c.hookForceClaim !== undefined ? { hookForceClaim: c.hookForceClaim } : {}),
  };
}

/**
 * Front a World over HTTP, for `createRemoteWorld` on the other side.
 *
 * `POST { op, args }` calls one storage or stream method and answers
 * `{ value }` or, with an error status, `{ error }`; bodies use `wire` so
 * bytes and dates survive. `streams.get` (POST with `resume`, or
 * `GET ?op=streams.get&runId&name&startIndex&skipBytes`) answers a framed,
 * long-lived body that tails the stream; see `FRAME`.
 */
export function createWorldHandler(
  world: World,
  options: WorldHandlerOptions = {}
): (req: Request) => Promise<Response> {
  const allowed = new Set<Op>(options.ops ?? [...OPS, 'info', 'streams.get']);
  const maxStreamMs = options.maxStreamMs ?? 240_000;

  return async (req) => {
    let op: string;
    let args: unknown[];
    let resume: StreamResume = {};
    if (req.method === 'GET') {
      const q = new URL(req.url).searchParams;
      op = q.get('op') ?? '';
      const startIndex = q.get('startIndex');
      args = [q.get('runId'), q.get('name'), startIndex === null ? undefined : Number(startIndex)];
      resume = { skipBytes: Number(q.get('skipBytes') ?? 0) };
    } else if (req.method === 'POST') {
      let body: { op?: unknown; args?: unknown; resume?: StreamResume };
      try {
        body = wire.parse(await req.text()) as typeof body;
      } catch {
        return invalid('body is not valid JSON');
      }
      if (typeof body?.op !== 'string') return invalid('missing "op"');
      if (body.args !== undefined && !Array.isArray(body.args)) return invalid('"args" must be an array');
      op = body.op;
      args = (body.args as unknown[] | undefined) ?? [];
      resume = body.resume ?? {};
    } else {
      return fail(405, { name: 'WorkflowWorldError', message: `method ${req.method} not allowed` });
    }

    if (!allowed.has(op as Op)) return invalid(`op "${op}" is not allowed`);
    if (options.authorize && !(await options.authorize(req, { op, args }))) {
      return fail(401, { name: 'WorkflowWorldError', message: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    try {
      if (op === 'streams.get') {
        const [runId, name, startIndex] = args as [string, string, number | undefined];
        if (typeof runId !== 'string' || typeof name !== 'string') {
          return invalid('streams.get needs runId and name');
        }
        return await tail(world, runId, name, startIndex, resume, req.signal, maxStreamMs);
      }
      const value = await CALLS[op as Exclude<Op, 'streams.get'>](world, args as never[]);
      if (options.onCommitted) {
        try {
          await options.onCommitted(op as Op, args, value);
        } catch (err) {
          options.onError?.(err, op as Op);
        }
      }
      return json(200, { value });
    } catch (err) {
      const error = serializeError(err);
      return fail(statusForError(error), error);
    }
  };
}

function json(status: number, body: unknown): Response {
  return new Response(wire.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function fail(status: number, error: WireError): Response {
  return json(status, { error });
}

function invalid(message: string): Response {
  return fail(400, { name: 'WorkflowWorldError', message, code: 'INVALID_ARGUMENT' });
}

const encoder = new TextEncoder();

/**
 * Tail one stream as a framed body. Resumption counts bytes, not chunks,
 * because a World's live read need not preserve chunk boundaries
 * (world-vercel's is a plain byte stream): the client reconnects with the
 * same absolute `startIndex` and the number of bytes it already has.
 */
async function tail(
  world: World,
  runId: string,
  name: string,
  startIndex: number | undefined,
  resume: StreamResume,
  signal: AbortSignal,
  maxStreamMs: number
): Promise<Response> {
  let start = startIndex ?? 0;
  if (start < 0) {
    const info = await world.streams.getInfo(runId, name);
    start = Math.max(0, info.tailIndex + 1 + start);
  }
  const upstream = (await world.streams.get(runId, name, start)).getReader();
  let skip = Math.max(0, resume.skipBytes ?? 0);
  let cut = false;
  let finished = false;
  const stop = () => {
    cut = true;
    void upstream.cancel().catch(() => {});
  };
  const timer = setTimeout(stop, maxStreamMs);
  (timer as { unref?: () => void }).unref?.();
  signal.addEventListener('abort', stop, { once: true });
  const cleanup = () => {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await upstream.read();
        } catch (err) {
          cleanup();
          if (cut) {
            controller.enqueue(encodeFrame(FRAME.reconnect));
          } else {
            const payload = encoder.encode(wire.stringify(serializeError(err)));
            controller.enqueue(encodeFrame(FRAME.error, payload));
          }
          controller.close();
          return;
        }
        if (result.done) {
          cleanup();
          // A cancel we caused ends the read as `done` too: not the stream's end.
          controller.enqueue(encodeFrame(cut ? FRAME.reconnect : FRAME.end));
          controller.close();
          return;
        }
        let chunk = result.value;
        if (skip > 0) {
          if (skip >= chunk.length) {
            skip -= chunk.length;
            continue;
          }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.length === 0) continue;
        controller.enqueue(encodeFrame(FRAME.data, chunk));
        return;
      }
    },
    cancel() {
      cleanup();
      stop();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.harness-world-remote.frames',
      // A live tail: nothing between here and the reader may buffer it
      // (a compressing proxy holds chunks until its window fills, so
      // tokens arrive in bursts).
      'cache-control': 'no-store, no-transform',
      'content-encoding': 'identity',
      'x-accel-buffering': 'no',
      // Where the tail began, so a client that asked for a negative
      // startIndex can reconnect to the same absolute position.
      'x-stream-start': String(start),
    },
  });
}
