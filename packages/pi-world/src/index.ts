import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { World } from '@workflow/world';
import { type Anchor, type AnchorPolicy, anchorKey, claimDrive, defaultAnchors, judgeAnchor, releaseDrive } from 'harness-world/anchor';
import { QUEUE_PREFIX } from 'harness-world/queue';
import { monotonicFactory } from 'ulid';
import { hasUnfinishedWork, journalHead, wake, WorldStorage, type WorldStorageOptions } from './storage.ts';

export {
  type Backstop,
  hasUnfinishedWork,
  type JournalHead,
  journalHead,
  StorageFenced,
  WAKE_QUEUE,
  wake,
  WorldStorage,
  type WorldStorageOptions,
} from './storage.ts';
export type { Anchor, AnchorPolicy } from 'harness-world/anchor';
/** The kernel's queue prefix, which every pi-world consumer takes (`registerHandler(QUEUE_PREFIX, ...)`). */
export { QUEUE_PREFIX } from 'harness-world/queue';

const ctx = BACKGROUND_CONTEXT;
const ulid = monotonicFactory();

/**
 * Opens Pi's Harness on a session: `Harness.open(await worldStorage(world, id, { anchor }), ...)`.
 * `anchor` is what the storage's commits are written under (the delivery
 * opening it); an `openAgent` that shares an already open Harness sets it
 * with `storage.setAnchor` instead.
 */
export type OpenAgent = (sessionId: string, anchor?: Anchor) => Promise<Harness>;

export interface WakeOptions {
  /** The longest one wake drives before it closes and continues, in ms. Default 10 minutes. */
  maxDriveMs?: number;
  /**
   * This delivery's anchor: its own queue message (`policy.own(meta)`). A
   * wake without one (a script) gets a fresh one, which nothing redelivers.
   */
  anchor?: Anchor;
  /** The anchor (`anchorKey`) a continuation handed this wake (its payload's `continues`). */
  continues?: string;
  /** How this World holds deliveries (harness-world's `AnchorPolicy`). Default `defaultAnchors()`. */
  anchors?: AnchorPolicy;
  /**
   * This process holds the session open already (a route's shared Harness):
   * join it rather than judge it. A wake that acked because another drive of
   * this process looked busy could lose work that drive had already decided
   * it was done with.
   */
  held?: boolean;
}

export type WakeOutcome =
  /** No unfinished task: nothing to do. */
  | { kind: 'idle' }
  /**
   * The session is held by a delivery that is not proven gone: it takes the
   * work if it lives, and its own message comes back if it died. Ack.
   */
  | { kind: 'covered'; why: string }
  /**
   * Opened the session and drove it; `unfinished` when runnable work remains,
   * in which case a continuation was sent (`continued`) that takes over this
   * wake's anchor.
   */
  | { kind: 'resumed'; unfinished: boolean; continued?: boolean };

/**
 * One wake of a session. Nothing here is judged by time or silence:
 *
 * - No unfinished task: `idle`.
 * - Otherwise the newest commit's anchor is judged (harness-world's
 *   `judgeAnchor`): a writer that closed after it, this delivery's own
 *   message (a redelivery: whoever held it lost the lease), a continuation's
 *   grant, a passed deadline or the World's own proof (a dead pid, a free
 *   Web Lock, another message on a one-delivery-per-run object) means open
 *   it, `resume()`, wait until idle, and close; anything else is `covered`.
 * - A wake that stops with runnable work left (its drive budget) sends a
 *   continuation that takes its anchor over, and acks.
 */
export async function runWake(world: World, sessionId: string, openAgent: OpenAgent, options: WakeOptions = {}): Promise<WakeOutcome> {
  const policy = options.anchors ?? defaultAnchors();
  const own = options.anchor ?? policy.own({});
  const head = await journalHead(world, sessionId, ctx);
  if (!head.unfinished) return { kind: 'idle' };
  if (!options.held && !head.closed) {
    const verdict = await judgeAnchor(
      { world, policy, own, state: { runId: sessionId }, ...(options.continues ? { continues: options.continues } : {}) },
      head.last?.anchor
    );
    if (verdict.v === 'covered') return { kind: 'covered', why: verdict.why };
  }
  // One wake per session per process; another one landing meanwhile has this one look once more.
  const claim = claimDrive(world, sessionId, { drv: `piwake_${ulid()}`, anchor: own });
  if (!claim) return { kind: 'covered', why: 'a wake of this process drives it' };
  let unfinished = false;
  let rerun = false;
  try {
    const harness = await openAgent(sessionId, own);
    try {
      const deadline = Date.now() + (options.maxDriveMs ?? 600_000);
      for (;;) {
        unfinished = await untilSettled(harness, deadline);
        if (!unfinished || Date.now() >= deadline || !claim.rerun) break;
        claim.rerun = false;
      }
    } finally {
      await harness.close(ctx);
    }
  } finally {
    rerun = releaseDrive(world, sessionId, claim);
  }
  // A wake that landed after this one's last look: look once more (its work is in the journal).
  if (!unfinished && rerun && (await hasUnfinishedWork(world, sessionId, ctx))) return runWake(world, sessionId, openAgent, { ...options, anchor: own });
  if (!unfinished) return { kind: 'resumed', unfinished };
  // I4: a drive that lets go with work left hands its anchor to the next one.
  const key = anchorKey(own);
  await wake(world, sessionId, { continues: key, idempotencyKey: `${sessionId}:pi-cont:${key}:${head.eventCount}` });
  return { kind: 'resumed', unfinished, continued: true };
}

/**
 * Run `harness` until no task it can run is left (or `deadline`, ms since
 * the epoch), and say whether runnable work is left. Pi's `waitForIdle()`
 * waits for the conversations' own work only: background work (a
 * compaction Pi starts on its own, a background subagent's tasks, any task
 * created with `background: true`) keeps no conversation busy, so a drive
 * that closed the Harness there would abort that work and hand it to the
 * next wake, which would do the same, forever. So every live task is waited
 * for, except work this process cannot run: a task whose definition is not
 * installed here (`blocked`), and a task that waits only on such work. That
 * is not worth waking for again, and waiting for it would never end.
 */
export async function untilSettled(harness: Harness, deadline?: number): Promise<boolean> {
  const bounded = () => (deadline === undefined ? ctx : withAbortSignal(AbortSignal.timeout(Math.max(1, deadline - Date.now())), ctx));
  harness.resume();
  for (;;) {
    const runnable = progressing((await harness.inspect(ctx)).tasks);
    if (runnable.length === 0) return false;
    if (deadline !== undefined && Date.now() >= deadline) return true;
    // One of them settling may start or end others: look again then.
    const settled = await Promise.race(runnable.map((id) => harness.waitForTask(id, bounded()))).then(
      () => true,
      () => false
    );
    // Refused (the deadline, a closed or poisoned Harness): what is left is the caller's to judge.
    if (!settled) return (await harness.inspect(ctx).then((i) => progressing(i.tasks).length > 0, () => true));
  }
}

type Inspected = Awaited<ReturnType<Harness['inspect']>>['tasks'][number];

/**
 * The live tasks that can still make progress here: ready or running ones,
 * and the ones waiting (or completing) on such a task. A task completing on
 * owned work this list cannot see (a conversation it owns) counts.
 */
function progressing(tasks: readonly Inspected[]): Inspected['record']['id'][] {
  const live = new Map(tasks.map((t) => [String(t.record.id), t]));
  const memo = new Map<string, boolean>();
  const moves = (id: string, seen: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const t = live.get(id);
    // Not live any more: whatever waits on it is about to move.
    if (!t) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    let result: boolean;
    const state = t.state;
    if (state.kind === 'blocked') result = false;
    else if (state.kind === 'waiting') result = state.on.some((on) => moves(String(on), seen));
    else if (state.kind === 'completing') {
      const owned = tasks.filter((o) => o.record.owner !== undefined && String(o.record.owner) === id);
      result = owned.length === 0 || owned.some((o) => moves(String(o.record.id), seen));
    } else result = true;
    memo.set(id, result);
    return result;
  };
  return tasks.filter((t) => moves(String(t.record.id), new Set())).map((t) => t.record.id);
}

/**
 * A World-backed Pi `Storage` for one session (a workflow run), created on
 * first open. Pass it straight to Pi's `Harness.open`.
 *
 * ```ts
 * const openAgent = async (id: string, anchor?: Anchor) => Harness.open(await worldStorage(world, id, { anchor }), { models, registry }, ctx)
 * ```
 */
export function worldStorage(world: World, sessionId: string, options?: WorldStorageOptions): Promise<WorldStorage> {
  return WorldStorage.open(world, sessionId, options);
}

/** Create a new session and return its id. */
worldStorage.create = (world: World, options?: Pick<WorldStorageOptions, 'name'>): Promise<string> =>
  WorldStorage.create(world, options);

/** Queue a wake for a session now (or after `delaySeconds`). */
worldStorage.wake = wake;

/**
 * The queue route that continues sessions a process left unfinished:
 * `export const POST = worldStorage.wakeHandler(world, openAgent)`.
 *
 * It takes every message on the kernel's prefix (`__harness_wkf_workflow_`):
 * wakes, continuations, and a restart's recovery (`recoverSessions`, or a
 * World's own for a run that recorded the namespace).
 * Each delivery runs under its own message (`policy.own(meta)`); see
 * `runWake` for what it does. It never asks the queue to come back later.
 */
worldStorage.wakeHandler = (world: World, openAgent: OpenAgent, options: Omit<WakeOptions, 'anchor' | 'continues' | 'held'> = {}) => {
  const policy = options.anchors ?? defaultAnchors();
  return world.createQueueHandler(QUEUE_PREFIX, async (message, meta) => {
    const { runId, input } = message as { runId?: string; input?: { continues?: unknown } };
    if (!runId) return;
    await runWake(world, runId, openAgent, {
      ...options,
      anchors: policy,
      anchor: policy.own(meta ?? {}),
      ...(typeof input?.continues === 'string' ? { continues: input.continues } : {}),
    });
    return undefined;
  });
};
