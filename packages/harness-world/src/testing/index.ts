/**
 * Test helpers for the queue-as-backstop model (anchor.ts). Node only.
 *
 * - `hostProcess(world)`: a World as one process sees it. `kill()` is that
 *   process dying (nothing it calls ever returns, so it writes nothing),
 *   `freeze()` / `thaw()` a process paused (a debugger, a frozen VM).
 * - `leasedWorld(world)`: an in-memory broker in front of a World's queue
 *   that behaves like a leased queue (VQS): a delivery holds its message's
 *   lease while its handler runs (the queue library's renewal, not ours), a
 *   delivery that dies or freezes loses it, and the broker then redelivers
 *   the same messageId with `attempt + 1`. Storage and streams are the
 *   World's own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { World } from '@workflow/world';
import { dropDrive } from '../anchor.ts';

const forever = () => new Promise<never>(() => {});

type Gate = () => Promise<void>;

/** World methods that are not I/O: never gated. */
const SYNC = new Set(['createQueueHandler', 'registerHandler', 'registerRoute']);

/** Wrap every async method of `target` (and its storage sub-objects) behind `gate`. */
function gated<T extends object>(target: T, gate: Gate): T {
  return new Proxy(target, {
    get(t, key) {
      const value = (t as Record<string | symbol, unknown>)[key];
      // Synchronous registration: not World I/O.
      if (typeof value === 'function' && SYNC.has(String(key))) return (value as (...a: unknown[]) => unknown).bind(t);
      if (typeof value === 'function') {
        return async (...args: unknown[]) => {
          await gate();
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      if (value && typeof value === 'object' && ['events', 'streams', 'runs', 'steps', 'hooks'].includes(String(key))) {
        return gated(value as object, gate);
      }
      return value;
    },
  });
}

export interface HostProcess {
  world: World;
  kill(): void;
  freeze(): void;
  thaw(): void;
  readonly dead: boolean;
}

/** A World as one process sees it (see the module comment). */
export function hostProcess(base: World): HostProcess {
  let dead = false;
  let frozen: Promise<void> | undefined;
  let thaw = () => {};
  const gate = async () => {
    if (dead) return forever();
    if (frozen) await frozen;
    if (dead) return forever();
  };
  return {
    world: gated(base, gate),
    kill() {
      dead = true;
    },
    freeze() {
      frozen = new Promise((r) => (thaw = r));
    },
    thaw() {
      frozen = undefined;
      thaw();
    },
    get dead() {
      return dead;
    },
  };
}

export interface BrokerMessage {
  messageId: string;
  queueName: string;
  payload: unknown;
  idempotencyKey?: string;
  /** Deliveries so far. */
  attempt: number;
  /** When it may be delivered next (ms). */
  availableAt: number;
  /** Held by a delivery whose lease runs until `leaseUntil`. */
  leaseUntil?: number;
  holder?: LeasedDelivery;
  acked: boolean;
}

export interface LeasedDelivery {
  messageId: string;
  queueName: string;
  attempt: number;
  payload: unknown;
  /** Resolves with the handler's result (never, for a killed delivery). */
  done: Promise<unknown>;
  readonly state: 'running' | 'acked' | 'failed' | 'killed' | 'lost';
  /** The process running this delivery dies: its World calls never return, its lease lapses. */
  kill(): void;
  /** Pause it (World calls wait, the lease stops renewing). */
  freeze(): void;
  thaw(): void;
}

export interface Broker {
  /** Every message sent, in order. */
  sent(): BrokerMessage[];
  /** Messages that may be delivered now. */
  available(): BrokerMessage[];
  /** Every delivery so far. */
  deliveries(): LeasedDelivery[];
  /** Deliver one message now (by id, or the next available one). */
  deliver(messageId?: string): LeasedDelivery | undefined;
  /**
   * Deliver what is available, and what becomes available, until nothing is
   * left to deliver or running, or `timeoutMs` passes. Returns the deliveries.
   */
  drain(options?: { timeoutMs?: number; filter?: (m: BrokerMessage) => boolean }): Promise<LeasedDelivery[]>;
}

export interface LeasedWorldOptions {
  /** A delivery's lease: renewed while it runs; lapses this long after it dies or freezes. Default 300 ms. */
  visibilityMs?: number;
  /** How long a queue "second" (delaySeconds, timeoutSeconds) lasts here. Default 1000 ms. */
  secondMs?: number;
  /**
   * How `{ timeoutSeconds }` comes back: the same message with `attempt + 1`
   * (world-local, postgres, Cloudflare) or a new message (world-vercel).
   */
  resend?: 'same' | 'new';
  /** Retry delay after a handler throws (ms). Default 20. */
  retryMs?: number;
}

export type LeasedWorld = World & { broker: Broker };

/** A World whose queue is an in-memory leased broker (see the module comment). */
export function leasedWorld(base: World, options: LeasedWorldOptions = {}): LeasedWorld {
  const visibilityMs = options.visibilityMs ?? 300;
  const secondMs = options.secondMs ?? 1000;
  const retryMs = options.retryMs ?? 20;
  const messages: BrokerMessage[] = [];
  const keys = new Map<string, BrokerMessage>();
  const all: LeasedDelivery[] = [];
  const handlers: Array<{ prefix: string; handler: (message: unknown, meta: { attempt: number; queueName: string; messageId: string }) => Promise<unknown> }> = [];
  const als = new AsyncLocalStorage<{ gate: Gate }>();
  let seq = 0;

  const gate: Gate = async () => {
    const store = als.getStore();
    if (store) await store.gate();
  };
  const world = gated(base, gate) as LeasedWorld;

  const queue = async (queueName: string, payload: unknown, opts: { idempotencyKey?: string; delaySeconds?: number } = {}) => {
    await gate();
    if (opts.idempotencyKey) {
      const existing = keys.get(opts.idempotencyKey);
      if (existing) return { messageId: existing.messageId };
    }
    const message: BrokerMessage = {
      messageId: `msg_${String(++seq).padStart(6, '0')}`,
      queueName,
      payload,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      attempt: 0,
      availableAt: Date.now() + (opts.delaySeconds ?? 0) * secondMs,
      acked: false,
    };
    messages.push(message);
    if (opts.idempotencyKey) keys.set(opts.idempotencyKey, message);
    return { messageId: message.messageId };
  };

  const isAvailable = (m: BrokerMessage, now = Date.now()) =>
    !m.acked && m.availableAt <= now && (!m.holder || (m.leaseUntil !== undefined && m.leaseUntil <= now));

  function deliver(messageId?: string): LeasedDelivery | undefined {
    const now = Date.now();
    const message = messageId ? messages.find((m) => m.messageId === messageId) : messages.find((m) => isAvailable(m, now));
    if (!message || !isAvailable(message, now)) return undefined;
    // The latest registration for a prefix wins (as world-local's registerHandler).
    const handler = handlers.findLast((h) => message.queueName.startsWith(h.prefix));
    if (!handler) throw new Error(`leasedWorld: no handler for ${message.queueName}`);
    // A holder whose lease lapsed has lost the message: it can no longer ack
    // it. It stands for another instance (a frozen one, cut off), so this
    // process's record of its drive does not hold the redelivery back.
    if (message.holder && message.holder.state === 'running') {
      (message.holder as unknown as { lost(): void }).lost();
      const runId = (message.payload as { runId?: unknown } | undefined)?.runId;
      if (typeof runId === 'string') dropDrive(self, runId, `msg:${message.messageId}`);
    }
    message.attempt++;
    let state: LeasedDelivery['state'] = 'running';
    let dead = false;
    let frozen: Promise<void> | undefined;
    let release = () => {};
    const renew = () => {
      if (state === 'running' && !frozen && !dead && message.holder === delivery) message.leaseUntil = Date.now() + visibilityMs;
    };
    const timer = setInterval(renew, Math.max(5, visibilityMs / 3));
    (timer as { unref?: () => void }).unref?.();
    const deliveryGate: Gate = async () => {
      if (dead) return forever();
      if (frozen) await frozen;
      if (dead) return forever();
    };
    const meta = { attempt: message.attempt, queueName: message.queueName, messageId: message.messageId };
    const delivery: LeasedDelivery & { lost(): void } = {
      messageId: message.messageId,
      queueName: message.queueName,
      attempt: message.attempt,
      payload: message.payload,
      done: Promise.resolve(),
      get state() {
        return state;
      },
      kill() {
        dead = true;
        if (state === 'running') state = 'killed';
        clearInterval(timer);
        // The process died with it: so did its record of the drive it ran.
        const runId = (message.payload as { runId?: unknown } | undefined)?.runId;
        if (typeof runId === 'string') dropDrive(self, runId, `msg:${message.messageId}`);
      },
      freeze() {
        frozen = new Promise((r) => (release = r));
      },
      thaw() {
        frozen = undefined;
        release();
      },
      lost() {
        if (state === 'running') state = 'lost';
        clearInterval(timer);
      },
    };
    message.holder = delivery;
    message.leaseUntil = Date.now() + visibilityMs;
    delivery.done = als
      .run({ gate: deliveryGate }, () => handler.handler(message.payload, meta))
      .then(
        async (result) => {
          clearInterval(timer);
          if (dead || state !== 'running' || message.holder !== delivery) return result; // lost the lease: the ack fails
          const timeoutSeconds = (result as { timeoutSeconds?: unknown } | undefined)?.timeoutSeconds;
          if (typeof timeoutSeconds === 'number') {
            if (options.resend === 'new') {
              message.acked = true;
              await queue(message.queueName, message.payload, { delaySeconds: timeoutSeconds });
            } else {
              message.holder = undefined;
              message.availableAt = Date.now() + timeoutSeconds * secondMs;
            }
          } else {
            message.acked = true;
          }
          state = 'acked';
          return result;
        },
        (error: unknown) => {
          clearInterval(timer);
          if (!dead && state === 'running' && message.holder === delivery) {
            state = 'failed';
            message.holder = undefined;
            message.availableAt = Date.now() + retryMs;
          }
          return error;
        }
      );
    all.push(delivery);
    return delivery;
  }

  const broker: Broker = {
    sent: () => [...messages],
    available: () => messages.filter((m) => isAvailable(m)),
    deliveries: () => [...all],
    deliver,
    async drain(o = {}) {
      const started: LeasedDelivery[] = [];
      const end = Date.now() + (o.timeoutMs ?? 5000);
      for (;;) {
        const now = Date.now();
        for (const m of messages) {
          if ((o.filter?.(m) ?? true) && isAvailable(m, now)) {
            const d = deliver(m.messageId);
            if (d) started.push(d);
          }
        }
        const running = all.filter((d) => d.state === 'running');
        const waiting = messages.some((m) => !m.acked && (o.filter?.(m) ?? true) && (!m.holder || m.holder.state !== 'running'));
        if (running.length === 0 && !waiting) return started;
        if (Date.now() > end) return started;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };

  const self: LeasedWorld = new Proxy(world, {
    get(t, key) {
      if (key === 'broker') return broker;
      if (key === 'queue') return queue;
      if (key === 'createQueueHandler') {
        return (prefix: string, handler: (typeof handlers)[number]['handler']) => {
          handlers.push({ prefix, handler });
          return async () => new Response('leasedWorld delivers in process', { status: 501 });
        };
      }
      return (t as unknown as Record<string | symbol, unknown>)[key];
    },
  }) as LeasedWorld;
  return self;
}
