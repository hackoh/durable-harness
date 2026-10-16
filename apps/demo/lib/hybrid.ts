import type { World } from '@workflow/world';
import { commitHandoff, currentLane, type Lane, QUEUE_PREFIX, SessionLog } from 'harness-world';

export type WakeResult = { queued: true; queueName: string; idempotencyKey: string; driving?: boolean } | { queued: false; reason: string };

export interface WakeOptions {
  /**
   * The wake's cause, for its idempotency key (`<runId>:<lane>:<epoch>:<cause>`):
   * a submission id, a settlement, a redelivery's message id. Default
   * `handoff`. Keyed by cause so a queue's dedup window never swallows a
   * wake for a new reason (VQS keeps a key for 24 h after it was processed).
   * A full key (one with the run id in it) is used as is.
   */
  key?: string;
  /** A log of the session the caller just refreshed (saves a listing). */
  log?: SessionLog;
}

/** The idempotency key of a lane wake for `cause`. */
function wakeKey(runId: string, lane: Lane, epoch: number, key?: string): string {
  if (key?.startsWith(runId)) return key;
  return `${runId}:${lane}:${epoch}:${key ?? 'handoff'}`;
}

/**
 * Wake a server lane of a hybrid session: the function lane, with one queue
 * message on the server World, which the flow route delivers (`serves:
 * ['function']`).
 *
 * The sandbox lane (the brain-in-VM daemon) is retired: no session enters
 * it now, and one an older log left there is handed to the function lane
 * (`the sandbox lane is retired`), which this then wakes.
 *
 * The browser lane is never woken from here: the tab that owns the session
 * watches its log and drives it itself. A wake for a lane the session is not
 * in is dropped, so a stale or duplicate wake is harmless.
 */
export async function wakeLane(world: World, runId: string, lane: Lane, opts: WakeOptions = {}): Promise<WakeResult> {
  if (lane === 'browser') return { queued: false, reason: 'the browser lane wakes itself from the log' };
  const log = opts.log ?? new SessionLog(world, runId);
  if (!opts.log) await log.refresh();
  const now = currentLane(log.state);
  if (log.state.status !== 'running') return { queued: false, reason: `session is ${log.state.status}` };
  if (now !== lane) return { queued: false, reason: `session is in the ${now} lane` };
  if (lane === 'sandbox') {
    await commitHandoff(log, { from: 'sandbox', to: 'function', reason: 'the sandbox lane is retired' }, log.state.epoch);
    await log.refresh();
    return wakeLane(world, runId, 'function', { log, key: 'sandbox-retired' });
  }
  const queueName = `${QUEUE_PREFIX}hybrid_${lane}` as const;
  const idempotencyKey = wakeKey(runId, lane, log.state.epoch, opts.key);
  await world.queue(queueName, { runId, input: {} }, { idempotencyKey });
  return { queued: true, queueName, idempotencyKey };
}
