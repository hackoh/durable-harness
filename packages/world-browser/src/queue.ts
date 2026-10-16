import type { MessageId, Queue, QueuePrefix, ValidQueueName } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { Bus } from './bus.ts';
import { req, STORES, transact } from './idb.ts';

const ulid = monotonicFactory();

interface QueuedMessage {
  messageId: MessageId;
  queueName: ValidQueueName;
  payload: unknown;
  availableAt: number;
  attempt: number;
  idempotencyKey?: string;
}

type Handler = (
  message: unknown,
  meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
) => Promise<unknown>;

export interface BrowserQueue extends Queue {
  /** Start consuming (only in the tab that wins the leader lock). */
  start(): void;
  stop(): void;
}

/**
 * A durable queue in IndexedDB. A message is deleted only after its handler
 * returns, so a tab closed mid-delivery leaves it in place, and the next tab
 * to open redelivers it. Exactly one tab consumes at a time: the one holding
 * the `navigator.locks` lock. Other tabs only enqueue and wait their turn.
 */
export function createQueue(db: IDBDatabase, bus: Bus, lockName: string, concurrency = 4): BrowserQueue {
  const handlers = new Map<string, Handler>();
  const inflight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leader = false;
  let stopped = false;
  let releaseLock: (() => void) | undefined;

  async function enqueue(queueName: ValidQueueName, payload: unknown, opts: { delaySeconds?: number; idempotencyKey?: string } = {}) {
    const message: QueuedMessage = {
      messageId: `msg_${ulid()}` as MessageId,
      queueName,
      payload,
      availableAt: Date.now() + (opts.delaySeconds ?? 0) * 1000,
      attempt: 0,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    };
    const id = await transact(db, [STORES.queue], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.queue);
      if (opts.idempotencyKey) {
        const existing = await req(store.index('idempotencyKey').get(opts.idempotencyKey));
        if (existing) return existing.messageId as MessageId;
      }
      store.put(message);
      return message.messageId;
    });
    bus.emit({ type: 'queued' });
    return { messageId: id };
  }

  async function pump(): Promise<void> {
    if (!leader || stopped) return;
    clearTimeout(timer);
    const all: QueuedMessage[] = await req(db.transaction(STORES.queue).objectStore(STORES.queue).getAll());
    const now = Date.now();
    const due = all.filter((m) => m.availableAt <= now && !inflight.has(m.messageId));
    due.sort((a, b) => a.availableAt - b.availableAt);
    for (const message of due.slice(0, Math.max(0, concurrency - inflight.size))) {
      void deliver(message);
    }
    const next = all.filter((m) => m.availableAt > now).sort((a, b) => a.availableAt - b.availableAt)[0];
    if (next) timer = setTimeout(() => void pump(), Math.min(next.availableAt - now, 2_147_000_000));
  }

  async function deliver(message: QueuedMessage) {
    const handler = [...handlers].find(([prefix]) => message.queueName.startsWith(prefix))?.[1];
    if (!handler) return;
    inflight.add(message.messageId);
    let reschedule: number | undefined;
    try {
      const result = (await handler(message.payload, {
        attempt: message.attempt + 1,
        queueName: message.queueName,
        messageId: message.messageId,
      })) as { timeoutSeconds?: number } | undefined;
      if (result && typeof result.timeoutSeconds === 'number') reschedule = result.timeoutSeconds * 1000;
    } catch (err) {
      console.error('[world-browser] delivery failed, will retry', err);
      reschedule = Math.min(30_000, 1000 * 2 ** message.attempt);
    } finally {
      inflight.delete(message.messageId);
    }
    // A tab closed mid-delivery leaves the message in place for the next
    // leader (see above): its database is gone, so there is nothing to record.
    if (stopped) return;
    await transact(db, [STORES.queue], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.queue);
      if (reschedule === undefined) store.delete(message.messageId);
      else store.put({ ...message, attempt: message.attempt + 1, availableAt: Date.now() + reschedule });
    }).catch((err) => {
      if (!stopped) console.error('[world-browser] could not record a delivery', err);
    });
    void pump();
  }

  bus.on((m) => {
    if (m.type === 'queued') void pump();
  });

  return {
    async getDeploymentId() {
      return 'browser';
    },
    queue: (queueName, message, opts) => enqueue(queueName, message, opts),
    createQueueHandler(prefix: QueuePrefix, handler: Handler) {
      handlers.set(prefix, handler);
      void pump();
      // Deliveries call `handler` directly; the Request form exists so the
      // World interface is satisfied and a service worker could mount it.
      return async (request: Request) => {
        const body = await request.json();
        const result = await handler(body, {
          attempt: Number(request.headers.get('x-attempt') ?? 1),
          queueName: (request.headers.get('x-queue-name') ?? prefix) as ValidQueueName,
          messageId: (request.headers.get('x-message-id') ?? `msg_${ulid()}`) as MessageId,
        });
        return Response.json(result ?? { ok: true });
      };
    },
    start() {
      stopped = false;
      const locks = (globalThis.navigator as Navigator | undefined)?.locks;
      if (!locks) {
        leader = true;
        void pump();
        return;
      }
      void locks.request(lockName, () => {
        leader = true;
        void pump();
        // Hold the lock until stop() or the tab goes away.
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      });
    },
    stop() {
      stopped = true;
      leader = false;
      clearTimeout(timer);
      releaseLock?.();
    },
  };
}
