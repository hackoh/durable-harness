import type { MessageId, Queue, QueuePrefix, ValidQueueName } from '@workflow/world';
import { wire } from './wire.ts';

type Handler = Parameters<Queue['createQueueHandler']>[1];

interface Message {
  messageId: MessageId;
  queueName: ValidQueueName;
  payload: unknown;
  attempt: number;
  availableAt: number;
  idempotencyKey?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** The queue half of a World, supplied to `createRemoteWorld`. */
export type QueueLike = Pick<Queue, 'queue' | 'createQueueHandler'> &
  Partial<Pick<Queue, 'queueBatch'>> & {
    start?(): void | Promise<void>;
    stop?(): void | Promise<void>;
  };

export interface LocalQueue extends QueueLike {
  /** Resume dispatching after `stop()`. A new queue starts dispatching at once. */
  start(): void;
  /** Stop dispatching and clear timers. Queued messages stay queued. */
  stop(): void;
  /** Resolves once nothing is due or in flight (messages delayed into the future may remain). */
  idle(): Promise<void>;
  /** Messages queued or in flight, for UIs and tests. */
  readonly size: number;
}

export interface LocalQueueOptions {
  /** Deliveries in flight at once. Default 4. */
  concurrency?: number;
  /** Longest retry delay after a handler throws. Default 30s. */
  maxBackoffMs?: number;
  onError?(error: unknown, message: { queueName: string; attempt: number }): void;
}

/**
 * An in-memory queue for a browser tab: the tab is its own consumer, so a
 * session this tab drives never pays a server round trip to be woken.
 *
 * Semantics follow the World queue contract where a tab can: `delaySeconds`,
 * an `idempotencyKey` that collapses duplicates while the first is queued or
 * in flight, handlers chosen by queue-name prefix, and a handler result of
 * `{ timeoutSeconds }` meaning "deliver this again in N seconds". A throwing
 * handler is retried with capped exponential backoff. Nothing is durable:
 * the durable state is the World's log, and a reloaded tab rebuilds its work
 * from that, not from this queue.
 */
export function createLocalQueue(options: LocalQueueOptions = {}): LocalQueue {
  const concurrency = options.concurrency ?? 4;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const handlers = new Map<string, Handler>();
  const messages = new Map<MessageId, Message>();
  const byKey = new Map<string, MessageId>();
  /** Due, waiting for a free slot or for a handler to be registered. */
  const ready: Message[] = [];
  const inflight = new Set<MessageId>();
  let stopped = false;
  let seq = 0;

  const handlerFor = (queueName: string) =>
    [...handlers].find(([prefix]) => queueName.startsWith(prefix))?.[1];

  function schedule(message: Message, delayMs: number) {
    clearTimeout(message.timer);
    message.timer = undefined;
    message.availableAt = Date.now() + Math.max(0, delayMs);
    if (stopped) return; // start() picks it up.
    if (delayMs <= 0) {
      ready.push(message);
      queueMicrotask(pump);
      return;
    }
    message.timer = setTimeout(() => {
      message.timer = undefined;
      ready.push(message);
      pump();
    }, delayMs);
    (message.timer as { unref?: () => void }).unref?.();
  }

  function pump() {
    if (stopped) return;
    for (let i = 0; i < ready.length && inflight.size < concurrency; ) {
      const message = ready[i]!;
      const handler = handlerFor(message.queueName);
      if (!handler) {
        i++; // Parked until a handler for its prefix is registered.
        continue;
      }
      ready.splice(i, 1);
      void deliver(message, handler);
    }
  }

  async function deliver(message: Message, handler: Handler) {
    inflight.add(message.messageId);
    message.attempt++;
    let retryMs: number | undefined;
    try {
      const result = (await handler(message.payload, {
        attempt: message.attempt,
        queueName: message.queueName,
        messageId: message.messageId,
      })) as { timeoutSeconds?: unknown } | undefined;
      if (result && typeof result.timeoutSeconds === 'number') {
        retryMs = result.timeoutSeconds * 1000;
      }
    } catch (err) {
      options.onError?.(err, { queueName: message.queueName, attempt: message.attempt });
      retryMs = Math.min(maxBackoffMs, 250 * 2 ** (message.attempt - 1));
    } finally {
      inflight.delete(message.messageId);
    }
    if (retryMs === undefined) {
      messages.delete(message.messageId);
      if (message.idempotencyKey) byKey.delete(message.idempotencyKey);
    } else {
      schedule(message, retryMs);
    }
    pump();
  }

  const enqueue: Queue['queue'] = async (queueName, payload, opts = {}) => {
    const key = opts.idempotencyKey;
    const existing = key ? byKey.get(key) : undefined;
    if (existing) return { messageId: existing };
    const message: Message = {
      messageId: `msg_local_${Date.now().toString(36)}_${(seq++).toString(36)}` as MessageId,
      queueName,
      // A real queue serializes; so do we, so the caller can't mutate it after.
      payload: structuredClone(payload),
      attempt: 0,
      availableAt: 0,
      ...(key ? { idempotencyKey: key } : {}),
    };
    messages.set(message.messageId, message);
    if (key) byKey.set(key, message.messageId);
    schedule(message, (opts.delaySeconds ?? 0) * 1000);
    return { messageId: message.messageId };
  };

  return {
    queue: enqueue,
    async queueBatch(queueName, batch) {
      return Promise.all(
        batch.map(async ({ message, opts }) => ({
          messageId: (await enqueue(queueName, message, opts)).messageId,
        }))
      );
    },
    createQueueHandler(prefix: QueuePrefix, handler: Handler) {
      handlers.set(prefix, handler);
      queueMicrotask(pump);
      // Deliveries call `handler` directly. The Request form exists for the
      // World interface (a service worker could mount it).
      return async (request: Request) => {
        const result = await handler(wire.parse(await request.text()), {
          attempt: Number(request.headers.get('x-attempt') ?? 1),
          queueName: (request.headers.get('x-queue-name') ?? prefix) as ValidQueueName,
          messageId: (request.headers.get('x-message-id') ?? `msg_local_${seq++}`) as MessageId,
        });
        return new Response(wire.stringify(result ?? null), {
          headers: { 'content-type': 'application/json' },
        });
      };
    },
    start() {
      if (!stopped) return;
      stopped = false;
      ready.length = 0;
      for (const message of messages.values()) {
        if (!inflight.has(message.messageId)) {
          schedule(message, message.availableAt - Date.now());
        }
      }
      pump();
    },
    stop() {
      stopped = true;
      for (const message of messages.values()) {
        clearTimeout(message.timer);
        message.timer = undefined;
      }
    },
    async idle() {
      const busy = () =>
        inflight.size > 0 || (!stopped && ready.some((m) => handlerFor(m.queueName)));
      while (busy()) await new Promise((r) => setTimeout(r, 10));
    },
    get size() {
      return messages.size;
    },
  };
}
