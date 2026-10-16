import type { World } from '@workflow/world';
import type { QueueLike } from './local-queue.ts';
import type { WorldCall } from './run-scope.ts';
import type { Op, RemoteWorldInfo, StreamResume } from './server.ts';
import { FRAME, FrameReader, rehydrateError, type WireError, wire } from './wire.ts';

export { createLocalQueue } from './local-queue.ts';
export { withLocalQueue } from './with-local-queue.ts';
export type { LocalQueue, LocalQueueOptions, QueueLike } from './local-queue.ts';
export type { Op, RemoteWorldInfo } from './server.ts';
export { RUN_TOKEN_HEADER, runOf, type WorldCall } from './run-scope.ts';
export { wire } from './wire.ts';

export interface RemoteWorldOptions {
  /** The endpoint `createWorldHandler` is mounted at, e.g. `/api/world`. */
  baseUrl: string;
  /** Default: the global `fetch`. Tests pass the handler itself. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Sent with every request (auth). A function is called per request, with
   * the call it carries, so a client can send the token of the run it is
   * about (`runOf`, `RUN_TOKEN_HEADER`).
   */
  headers?: HeadersInit | ((call: WorldCall) => HeadersInit | Promise<HeadersInit>);
  /**
   * The queue half of this World. Storage and streams live on the server;
   * the queue does not. In a tab that is usually `createLocalQueue()`, so the
   * tab drives the sessions it owns without a server hop, and a queue that
   * forwards selected messages to the server can wrap it.
   */
  queue: QueueLike;
  /**
   * Consecutive failed reconnects (no bytes received) a stream tail tolerates
   * before it errors. Default 5.
   */
  maxStreamReconnects?: number;
}

export type RemoteWorld = World & {
  /** What the server reported about the World it fronts. */
  readonly remote: RemoteWorldInfo;
};

/**
 * A World whose storage and streams are another process's World, reached over
 * HTTP through `createWorldHandler`. Every read and write lands in the same
 * log the server's own drivers use, which is the point: a session can move
 * between a browser tab and a server function without either side owning a
 * copy of it.
 *
 * Async because `specVersion` belongs to the fronted World: it is read once,
 * before anything is written.
 */
export async function createRemoteWorld(options: RemoteWorldOptions): Promise<RemoteWorld> {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const maxReconnects = options.maxStreamReconnects ?? 5;
  const { queue } = options;

  async function headers(call: WorldCall): Promise<Headers> {
    const h = new Headers(
      typeof options.headers === 'function' ? await options.headers(call) : options.headers
    );
    h.set('content-type', 'application/json');
    return h;
  }

  async function post(body: { op: string; args?: unknown[]; resume?: StreamResume }, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: await headers({ op: body.op, args: body.args ?? [] }),
      body: wire.stringify(body),
      ...(signal ? { signal } : {}),
    };
    return doFetch(options.baseUrl, init);
  }

  async function failure(response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    let error: WireError | undefined;
    try {
      error = (wire.parse(text) as { error?: WireError }).error;
    } catch {
      // Not ours: a platform error page, a proxy timeout, ...
    }
    return rehydrateError(
      error ?? {
        name: 'WorkflowWorldError',
        message: `remote World answered ${response.status}: ${text.slice(0, 300)}`,
        status: response.status,
      },
      response.status
    );
  }

  async function call<T>(op: Exclude<Op, 'streams.get'>, ...args: unknown[]): Promise<T> {
    const response = await post({ op, args });
    if (!response.ok) throw await failure(response);
    return (wire.parse(await response.text()) as { value: T }).value;
  }

  const info = await call<RemoteWorldInfo>('info');
  let deployment = { id: info.deploymentId, at: Date.now() };

  /** Open one tail response; resolves once the server has answered. */
  async function openTail(
    runId: string,
    name: string,
    startIndex: number | undefined,
    resume: StreamResume,
    signal: AbortSignal
  ): Promise<{ frames: FrameReader; start: number }> {
    const response = await post({ op: 'streams.get', args: [runId, name, startIndex], resume }, signal);
    if (!response.ok) throw await failure(response);
    if (!response.body) throw new Error('harness-world-remote: stream response has no body');
    const start = Number(response.headers.get('x-stream-start') ?? startIndex ?? 0);
    return { frames: new FrameReader(response.body.getReader()), start };
  }

  function tail(runId: string, name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
    const abort = new AbortController();
    return openTail(runId, name, startIndex, {}, abort.signal).then((first) => {
      let frames: FrameReader | undefined = first.frames;
      const start = first.start;
      let received = 0;
      let failures = 0;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            if (!frames) {
              try {
                ({ frames } = await openTail(runId, name, start, { skipBytes: received }, abort.signal));
              } catch (err) {
                if (abort.signal.aborted) return;
                if (++failures > maxReconnects) {
                  controller.error(err);
                  return;
                }
                await sleep(Math.min(5_000, 250 * 2 ** (failures - 1)));
                continue;
              }
            }
            let frame: Awaited<ReturnType<FrameReader['next']>>;
            try {
              frame = await frames.next();
            } catch {
              frame = undefined; // The connection dropped mid-body.
            }
            if (abort.signal.aborted) return;
            if (frame?.type === FRAME.data) {
              received += frame.payload.length;
              failures = 0;
              controller.enqueue(frame.payload);
              return;
            }
            if (frame?.type === FRAME.end) {
              controller.close();
              return;
            }
            if (frame?.type === FRAME.error) {
              const error = wire.parse(new TextDecoder().decode(frame.payload)) as WireError;
              controller.error(rehydrateError(error));
              return;
            }
            // `reconnect` (the server's time budget) or a dropped connection.
            frames = undefined;
            if (frame?.type !== FRAME.reconnect) {
              if (++failures > maxReconnects) {
                controller.error(new Error(`harness-world-remote: lost stream ${name}`));
                return;
              }
              await sleep(Math.min(5_000, 250 * 2 ** (failures - 1)));
            }
          }
        },
        async cancel() {
          abort.abort();
          await frames?.cancel();
        },
      });
    });
  }

  const world: RemoteWorld = {
    remote: info,
    specVersion: info.specVersion,
    ...(info.capabilities ? { capabilities: info.capabilities } : {}),

    async getDeploymentId() {
      // Cached briefly: a session start reads it, and a tab should not pay a
      // round trip for a value that changes only on redeploy.
      if (Date.now() - deployment.at > 60_000) {
        deployment = { id: await call<string>('getDeploymentId'), at: Date.now() };
      }
      return deployment.id;
    },
    queue: (name, message, opts) => queue.queue(name, message, opts),
    ...(queue.queueBatch
      ? { queueBatch: (name, messages) => queue.queueBatch!(name, messages) }
      : {}),
    createQueueHandler: (prefix, handler) => queue.createQueueHandler(prefix, handler),
    async start() {
      await queue.start?.();
    },
    async close() {
      await queue.stop?.();
    },

    runs: {
      get: ((id: string, params?: unknown) => call('runs.get', id, params)) as World['runs']['get'],
      list: ((params?: unknown) => call('runs.list', params)) as World['runs']['list'],
    },
    steps: {
      get: ((runId: string, stepId: string, params?: unknown) =>
        call('steps.get', runId, stepId, params)) as World['steps']['get'],
      list: ((params: unknown) => call('steps.list', params)) as World['steps']['list'],
    },
    events: {
      create: ((runId: string | null, data: unknown, params?: unknown) =>
        call('events.create', runId, data, params)) as World['events']['create'],
      get: (runId, eventId, params) => call('events.get', runId, eventId, params),
      list: (params) => call('events.list', params),
      listByCorrelationId: (params) => call('events.listByCorrelationId', params),
    },
    hooks: {
      get: (hookId, params) => call('hooks.get', hookId, params),
      getByToken: (token, params) => call('hooks.getByToken', token, params),
      list: (params) => call('hooks.list', params),
    },
    streams: {
      write: (runId, name, chunk) => call('streams.write', runId, name, chunk),
      writeMulti: (runId, name, chunks) => call('streams.writeMulti', runId, name, chunks),
      close: (runId, name) => call('streams.close', runId, name),
      get: (runId, name, startIndex) => tail(runId, name, startIndex),
      list: (runId) => call('streams.list', runId),
      getChunks: (runId, name, opts) => call('streams.getChunks', runId, name, opts),
      getInfo: (runId, name) => call('streams.getInfo', runId, name),
    },
  };
  return world;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
