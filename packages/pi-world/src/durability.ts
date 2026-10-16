/**
 * Pi 1.0's durable Harness on a World, as a package: the storage, the
 * wake that finishes what a dead process left, the one-open-Harness-per-
 * session lease. `durable-harness/pi-durable` is built on this.
 */
import type { Harness } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { World } from '@workflow/world';
import type { QueueRoute } from 'harness-world';
import { type Anchor, type AnchorPolicy, defaultAnchors } from 'harness-world/anchor';
import { harnessOfQueue } from 'harness-world/names';
import { QUEUE_PREFIX } from 'harness-world/queue';
import { type Backstop, runWake, WAKE_QUEUE, type WakeOptions, type WakeOutcome, wake, WorldStorage, type WorldStorageOptions } from './index.ts';
export { untilSettled } from './index.ts';
import { JournalReader } from './reader.ts';

export { type Backstop, hasUnfinishedWork, QUEUE_PREFIX, StorageFenced, WAKE_QUEUE, WorldStorage, type WorldStorageOptions } from './index.ts';
export { JournalReader, type PiCommit, type PiEntry, type PiSnapshot, type PiTask } from './reader.ts';
export type { WakeOptions, WakeOutcome };
export type { Anchor, AnchorPolicy } from 'harness-world/anchor';
/** How a World holds queue deliveries (pick the one for yours; `defaultAnchors()` reads the environment). */
export { defaultAnchors, deliveryAnchors, exclusiveAnchors, localAnchors, vercelAnchors } from 'harness-world/anchor';

const ctx = BACKGROUND_CONTEXT;

export interface PiDurabilityOptions extends Omit<WorldStorageOptions, 'name' | 'anchor' | 'backstop' | 'config'>, Pick<WakeOptions, 'maxDriveMs'> {
  /** Where sessions live: any Workflow World. */
  world: World;
  /** The name sessions this creates carry on their runs (`workflow//durable-harness@<version>//<name>`). Default `pi-durable`. */
  name?: string;
  /** How this World holds queue deliveries (harness-world's `AnchorPolicy`). Default `defaultAnchors()`. */
  anchors?: AnchorPolicy;
  /**
   * For a storage opened without an anchor (a request that drives a turn
   * itself): how long it may stay silent with work unfinished before a wake
   * may take the session over (`Backstop.recoverAfterMs`). Default 120 s.
   */
  recoverAfterMs?: number;
  /** For a storage opened without an anchor: handed the promise of each period with work unfinished (a request's `waitUntil`). */
  keepAlive?: Backstop['keepAlive'];
}

/**
 * Opens Pi's Harness on a session's storage:
 * `(id, anchor) => Harness.open(await durability.storage(id, anchor), { models, registry }, ctx)`.
 * `anchor` is what the storage's commits are written under (the delivery opening it).
 */
export type OpenAgent = (sessionId: string, anchor?: Anchor) => Promise<Harness>;

/** One open Harness shared by every route of this process that drives the session. */
export interface AgentLease {
  harness: Harness;
  /** The storage under it, when it was opened through `storage()`. */
  storage?: WorldStorage;
  /** Let go of it; the last release closes the Harness. */
  release(): Promise<void>;
}

/** What one storage of a session is opened with (`PiDurability.storage`). */
export interface StorageOptions {
  backstop?: Backstop;
  /** Overrides the session's recorded trace audience for this storage (see `WorldStorageOptions.traceAudience`). */
  traceAudience?: WorldStorageOptions['traceAudience'];
  /** The trace audience for a session that recorded none. */
  defaultTraceAudience?: WorldStorageOptions['defaultTraceAudience'];
  /** More config to record if this open creates the session (see `WorldStorageOptions.config`). */
  config?: WorldStorageOptions['config'];
}

export interface PiDurability {
  /**
   * The session's Pi `Storage`, journaled in its run's log (created on first
   * open). Pass it to `Harness.open`. `anchor`: what its commits are written
   * under (see `OpenAgent`); a wake's delivery passes its own. Without one
   * (a request driving a turn itself, holding no queue message) the storage
   * is its own backstop: it queues the wake behind its own commits (see
   * `Backstop`; `recoverAfterMs`, `keepAlive`). `backstop` overrides that.
   */
  storage(sessionId: string, anchor?: Anchor, options?: StorageOptions): Promise<WorldStorage>;
  /** Create a session (a workflow run with an empty journal), recording its trace audience and `config` (see `WorldStorageOptions.config`). Returns its id. */
  create(options?: Pick<WorldStorageOptions, 'traceAudience' | 'config'>): Promise<string>;
  /**
   * The session's open Harness in this process, opened with `openAgent` if
   * there is none. Pi allows one owner per session: a second
   * `Harness.open` of it, even in this process, fences the first. Every
   * route that submits should go through this. `anchor`: what the commits
   * made while this lease is the newest are written under.
   */
  acquire(sessionId: string, openAgent: OpenAgent, anchor?: Anchor): Promise<AgentLease>;
  /** Whether this process holds the session open through `acquire`. */
  held(sessionId: string): boolean;
  /** How this World holds queue deliveries (`anchors`, default `defaultAnchors()`). */
  readonly anchors: AnchorPolicy;
  /**
   * The queue consumer: continues sessions a process left unfinished. Each
   * delivery runs under its own queue message (see pi-world's `runWake`);
   * nothing waits on silence. Takes every message on the kernel's prefix
   * (`__harness_wkf_workflow_`): register it on the World
   * (`world.registerHandler(QUEUE_PREFIX, ...)`), or mount it at a route
   * the World delivers that prefix to.
   */
  flow(openAgent: OpenAgent): (request: Request) => Promise<Response>;
  /**
   * The same, as a `route` for `durablePi({ route })` (or the kernel's
   * `durableSessions`), when one flow route serves both variants.
   */
  route(openAgent: OpenAgent, options?: Pick<WakeOptions, 'maxDriveMs'>): QueueRoute;
  /** Queue a wake for a session now (or after `delaySeconds`). */
  wake(sessionId: string, options?: { delaySeconds?: number }): Promise<void>;
  /** One wake delivery's work, without the queue (for scripts and tests). */
  runWake(sessionId: string, openAgent: OpenAgent): Promise<WakeOutcome>;
  /**
   * A read-only follower of the session's journal for UIs: `await
   * reader.refresh()`, then `await reader.snapshot()` (entries, `pi.live`
   * partial, tasks, commits). It never opens the session, so it never fences
   * the owner.
   */
  reader(sessionId: string): JournalReader;
}

interface Held {
  harness: Harness;
  storage?: WorldStorage;
  refs: number;
  closing?: Promise<void>;
}

/**
 * Pi 1.0's durable Harness (`@earendil-works/pi-durable`) on a Workflow
 * World. Pi owns durability: every Pi commit becomes one event in the
 * session's run, Durable Strict (each commit is in the log before Pi moves
 * on). This adds the storage and a wake that finishes work a dead process
 * left behind. A delivery's backstop is the World's queue, redelivering a
 * delivery that died; a writer that holds no queue message opens its storage
 * with `backstop`, which queues the wake behind its own commits (no
 * heartbeats either way).
 *
 * ```ts
 * const durability = piDurability({ world })
 * const openAgent = async (id: string, anchor?: Anchor) => Harness.open(await durability.storage(id, anchor), { models, registry }, ctx)
 * world.registerHandler(QUEUE_PREFIX, durability.flow(openAgent)) // or mount it at your queue route
 * // a request: no anchor, so the storage stands behind its own commits
 * const { harness, release } = await durability.acquire(sessionId, openAgent)
 * ```
 */
export function piDurability(options: PiDurabilityOptions): PiDurability {
  const { world, name = 'pi-durable', maxDriveMs, anchors, recoverAfterMs = 120_000, keepAlive, ...storageOptions } = options;
  const policy = anchors ?? defaultAnchors();
  const ownBackstop: Backstop = { anchors: policy, recoverAfterMs, ...(keepAlive ? { keepAlive } : {}) };
  const open = new Map<string, Promise<Held>>();
  /** The storage under each session's open Harness here, so a lease can set its anchor. */
  const storages = new Map<string, WorldStorage>();

  async function storage(sessionId: string, anchor?: Anchor, options: StorageOptions = {}): Promise<WorldStorage> {
    const backstop = options.backstop ?? (anchor ? undefined : ownBackstop);
    const opened = await WorldStorage.open(world, sessionId, {
      ...storageOptions,
      name,
      ...(anchor ? { anchor } : {}),
      ...(backstop ? { backstop } : {}),
      ...(options.traceAudience ? { traceAudience: options.traceAudience } : {}),
      ...(options.defaultTraceAudience ? { defaultTraceAudience: options.defaultTraceAudience } : {}),
      ...(options.config ? { config: options.config } : {}),
    });
    storages.set(sessionId, opened);
    return opened;
  }

  async function acquire(sessionId: string, openAgent: OpenAgent, anchor?: Anchor): Promise<AgentLease> {
    for (;;) {
      const current = open.get(sessionId);
      if (!current) break;
      const held = await current.catch(() => undefined);
      // A Harness whose storage another process committed past is poisoned,
      // and one whose storage was abandoned (a simulated crash) is dead: open a fresh one.
      if (held && !held.closing && !held.storage?.isFenced && !held.storage?.closed) {
        held.refs++;
        return lease(sessionId, held, anchor);
      }
      if (held?.closing) await held.closing.catch(() => {});
      if (open.get(sessionId) === current) open.delete(sessionId);
    }
    // The storage `storage()` opened for this Harness: the lease sets its anchor.
    storages.delete(sessionId);
    const opening = openAgent(sessionId, anchor).then((harness): Held => {
      const st = storages.get(sessionId);
      return { harness, refs: 0, ...(st ? { storage: st } : {}) };
    });
    open.set(sessionId, opening);
    opening.catch(() => open.delete(sessionId));
    const held = await opening;
    held.refs++;
    return lease(sessionId, held, anchor, true);
  }

  /**
   * A lease on `held`. `anchor`: what commits are written under while it is
   * the newest (pushed on the storage; the lease that opened the storage
   * under it lets go of it the same way). The last release closes the
   * Harness with the anchors as they are, so a delivery's storage leaves its
   * continuation to its wake (`runWake`).
   */
  function lease(sessionId: string, held: Held, anchor?: Anchor, opened = false): AgentLease {
    let released = false;
    const st = held.storage;
    const unset = !anchor || !st ? undefined : st.anchor !== anchor ? st.setAnchor(anchor) : opened ? () => st.releaseAnchor(anchor) : undefined;
    return {
      harness: held.harness,
      ...(st ? { storage: st } : {}),
      async release() {
        if (released) return;
        released = true;
        if (--held.refs > 0) {
          unset?.();
          return;
        }
        held.closing = held.harness.close(ctx);
        try {
          await held.closing;
        } finally {
          unset?.();
          const current = open.get(sessionId);
          if (current && (await current.catch(() => undefined)) === held) open.delete(sessionId);
        }
      },
    };
  }

  /**
   * A wake opens the session through `acquire` too, so a route of this
   * process that submits while the wake drives shares its Harness instead of
   * fencing it. Closing the shared Harness releases the wake's hold.
   */
  const shared = (openAgent: OpenAgent): OpenAgent => async (sessionId, anchor) => {
    const held = await acquire(sessionId, openAgent, anchor);
    return new Proxy(held.harness, {
      get(target, key) {
        if (key === 'close') return () => held.release();
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  /**
   * One wake, under its own message. A session this process holds open is
   * joined, never acked: its holder may already have decided it was done.
   */
  async function deliver(
    runId: string,
    openAgent: OpenAgent,
    meta: { messageId?: string; queueName?: string } | undefined,
    input: { continues?: unknown } | undefined,
    drive = maxDriveMs
  ): Promise<undefined> {
    await runWake(world, runId, shared(openAgent), {
      ...(drive !== undefined ? { maxDriveMs: drive } : {}),
      anchors: policy,
      anchor: policy.own(meta ?? {}),
      ...(typeof input?.continues === 'string' ? { continues: input.continues } : {}),
      held: open.has(runId),
    });
    return undefined;
  }

  const ours = (message: unknown, queueName: string): string | undefined => {
    const m = message as { runId?: unknown; input?: { kind?: unknown } } | undefined;
    if (typeof m?.runId !== 'string') return undefined;
    // A wake this package queued, or a recovery delivery for one of these
    // sessions (on its workflow's queue: `recoverSessions`, or a World's own).
    if (m.input?.kind === 'pi-wake' || queueName === WAKE_QUEUE || harnessOfQueue(queueName) === name) return m.runId;
    return undefined;
  };
  const inputOf = (message: unknown) => (message as { input?: { continues?: unknown } } | undefined)?.input;

  return {
    storage,
    create: (o = {}) => {
      const traceAudience = o.traceAudience ?? storageOptions.traceAudience;
      return WorldStorage.create(world, { name, ...(traceAudience ? { traceAudience } : {}), ...(o.config ? { config: o.config } : {}) });
    },
    acquire,
    held: (sessionId) => open.has(sessionId),
    anchors: policy,
    flow: (openAgent) =>
      world.createQueueHandler(QUEUE_PREFIX, async (message, meta) => {
        const runId = (message as { runId?: unknown } | undefined)?.runId;
        return typeof runId === 'string' ? deliver(runId, openAgent, meta, inputOf(message)) : undefined;
      }),
    route: (openAgent, routeOptions = {}) => (message, meta) => {
      const runId = ours(message, meta.queueName);
      return runId ? deliver(runId, openAgent, meta, inputOf(message), routeOptions.maxDriveMs ?? maxDriveMs) : undefined;
    },
    wake: (sessionId, wakeAt = {}) => wake(world, sessionId, wakeAt.delaySeconds ? { delaySeconds: wakeAt.delaySeconds } : {}),
    runWake: (sessionId, openAgent) =>
      runWake(world, sessionId, shared(openAgent), { ...(maxDriveMs !== undefined ? { maxDriveMs } : {}), anchors: policy, held: open.has(sessionId) }),
    reader: (sessionId) => new JournalReader(world, sessionId),
  };
}
