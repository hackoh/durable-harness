import type { World } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { armedChaos, type ChaosKind, type ChaosOutput, type ChaosSpec, chaosKey, chaosKind, chaosMatches, isSessionDrill } from './chaos.ts';
import { commitFact, isDetached, parkedRecords } from './facts.ts';
import { currentLane, type LaneOptions } from './lanes.ts';
import { harnessOf } from './names.ts';
import { OWNER_QUEUE, QUEUE_NAME as SESSION_QUEUE } from './queue.ts';
import { SessionLog } from './session-log.ts';
import { JsonLinesWriter, liveStreamName } from './streams.ts';
import type { EffectRecord, Harness, SessionState, Submission } from './types.ts';

/**
 * Owners: who drives a *parked* intent.
 *
 * An effect can hand its running intent to something outside any drive (a
 * command running detached in a sandbox VM): it commits a `park` step naming
 * the owner and stops its drive. From then on no function waits on it. The
 * owner reports back (a push from the VM), and in any case the queue polices
 * it: a per-step owner check is armed on every park. It asks the owner's
 * `OwnerPolicy` what state the work is in (running, finished but not
 * reported, lost) and the policy collects, recovers, or asks to look again.
 * That is the work's state, read from the Sandbox API, not a drive's
 * liveness. A collected result is a `settle` step; a drive re-enters the
 * effect and commits the outcome in the harness's own shape: the parking
 * drive itself while it is still attached (its inline grace), else a drive
 * the settler wakes once the parker has detached (a `detach` fact).
 */
export { OWNER_QUEUE } from './queue.ts';

const ulid = monotonicFactory();

export type OwnerVerdict =
  /** Still working: look again in `recheckSeconds`. */
  | { state: 'running'; recheckSeconds: number }
  /** Settled (collected, or recovered as interrupted). */
  | { state: 'settled' }
  /** Could not tell (the owner is unreachable right now). */
  | { state: 'unknown'; recheckSeconds: number }
  /** A Drop Callback crash discarded the report this check was about to collect: stop this chain. */
  | { state: 'dropped' };

export interface OwnerContext {
  world: World;
  /** The session's log, freshly read. Settle through it. */
  log: SessionLog;
  record: EffectRecord;
  owner: unknown;
  /** `check`: the per-step owner check (`backstop` in policies written for the retired backstop). */
  mode: 'check' | 'backstop';
  say: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OwnerPolicy {
  /** The `ParkOwner.kind` this policy polices. */
  kind: string;
  check(c: OwnerContext): Promise<OwnerVerdict>;
  /** Carry out an armed sandbox crash (`kind` other than `process`) that the fold accepted. */
  fireChaos?(c: OwnerContext & { spec: ChaosSpec; kind: ChaosKind }): Promise<void>;
}

export type OwnerMessage =
  | { kind: 'owner-check'; stepId: string; nonce: string }
  | { kind: 'chaos-fire'; stepId: string; submission: string; nonce: string };

/** Arm one owner check for a parked step. `tag` separates chains (one per park, plus extras after a crash). */
export async function armOwnerCheck(world: World, runId: string, stepId: string, delaySeconds: number, tag = '0'): Promise<void> {
  const input: OwnerMessage = { kind: 'owner-check', stepId, nonce: `oc_${ulid()}` };
  await world.queue(
    OWNER_QUEUE,
    { runId, input },
    { idempotencyKey: `${runId}:owner:${stepId}:${tag}`, ...(delaySeconds > 0 ? { delaySeconds: Math.ceil(delaySeconds) } : {}) }
  );
}

/** Arm the firing of a sandbox crash against a parked step. */
export async function armChaosFire(world: World, runId: string, stepId: string, submission: string, delaySeconds: number): Promise<void> {
  const input: OwnerMessage = { kind: 'chaos-fire', stepId, submission, nonce: `cf_${ulid()}` };
  await world.queue(
    OWNER_QUEUE,
    { runId, input },
    { idempotencyKey: `${runId}:chaos-fire:${submission}:${stepId}`, ...(delaySeconds > 0 ? { delaySeconds: Math.ceil(delaySeconds) } : {}) }
  );
}

export interface OwnerDriverOptions {
  world: World;
  harness: Harness | Harness[];
  lanes?: LaneOptions;
  owners?: OwnerPolicy[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

function lanesFor(options: OwnerDriverOptions, state: SessionState): LaneOptions | undefined {
  const harness = [options.harness].flat().find((h) => h.name === harnessOf(state.workflowName));
  return harness?.lanes ?? options.lanes;
}

const policyFor = (options: OwnerDriverOptions, record: EffectRecord) =>
  options.owners?.find((p) => p.kind === record.park?.kind);

/**
 * Wake a drive to take a settlement: the session's current lane, or (a
 * session that never moves) its own queue. Keyed per step (and attempt), so
 * a queue's dedup window never swallows a re-wake after a lost one.
 */
export async function wakeSettled(
  options: OwnerDriverOptions,
  state: SessionState,
  stepId: string,
  attempt: string | number = 0
): Promise<void> {
  const runId = state.runId;
  const idempotencyKey = `${runId}:settled:${stepId}:${attempt}`;
  const lanes = lanesFor(options, state);
  if (lanes) {
    const lane = currentLane(state, lanes.initial);
    await lanes.wake(runId, lane, { from: lane, to: lane, reason: 'settled' }, { idempotencyKey });
    return;
  }
  await options.world.queue(SESSION_QUEUE, { runId, input: {} }, { idempotencyKey });
}

/**
 * Whether the drive that parked `record` is still attached to it: it has not
 * committed a `detach` (an ownership fact, written once, read from the log).
 * An attached parker takes a settlement itself (its inline grace), so a wake
 * would start a second drive at the same epoch; if it died attached, its own
 * delivery comes back and re-enters the step. Async for callers written
 * against the earlier signature.
 */
export async function parkerAttached(_world: World, _runId: string, record: EffectRecord): Promise<boolean> {
  return record.status === 'running' && !!record.park && !isDetached(record);
}

/**
 * Wake a drive to take a settlement this caller just committed, unless the
 * parking drive is still attached (it takes the settlement itself). `state`
 * must be the fold right after the settle committed: the log orders a
 * `detach` against the `settle`, so either the parker's detach lost (it takes
 * the settlement) or it landed first (this wakes). Returns whether it woke.
 * A fold that reads past the settle may already show the step finished: a
 * drive took the settlement, so there is nothing to wake.
 */
export async function wakeAfterSettle(options: OwnerDriverOptions, state: SessionState, record: EffectRecord): Promise<boolean> {
  const now = state.effects.get(record.key);
  if (now && now.stepId === record.stepId && now.status === 'running' && !isDetached(now)) {
    options.log?.('owner: the parking drive is still attached; it takes the settlement', { runId: state.runId, stepId: record.stepId });
    return false;
  }
  if (now && now.stepId === record.stepId && (now.status === 'completed' || now.status === 'failed')) {
    options.log?.('owner: a drive already took the settlement', { runId: state.runId, stepId: record.stepId });
    return false;
  }
  await wakeSettled(options, state, record.stepId, `settle:${now?.settlement?.at ?? record.settlement?.at ?? 0}`);
  return true;
}

/**
 * If a Drop Callback crash is armed for this parked step, fire it: commit
 * the chaos step (accepted only while the step is unsettled) and report
 * whether it took. Whoever would have announced the result discards it.
 */
export async function claimDropCallback(log: SessionLog, record: EffectRecord): Promise<boolean> {
  const armed = armedChaos(log.state);
  if (!armed || chaosKind(armed.chaos) !== 'drop-callback' || !chaosMatches(armed.chaos, record.name)) return false;
  return fireChaosStep(log, record, armed, 'drop-callback');
}

/** Commit a v2 chaos step against `record` for an armed submission. `true` if the fold accepted it. */
export async function fireChaosStep(
  log: SessionLog,
  record: EffectRecord,
  armed: Submission & { chaos: ChaosSpec },
  kind: ChaosKind,
  extra: Partial<ChaosOutput> = {}
): Promise<boolean> {
  const startedAt = record.startedAt?.getTime();
  const input: ChaosOutput = {
    v: 2,
    kind,
    crashedDuring: record.key,
    stepId: record.stepId,
    effect: record.name,
    afterMs: startedAt ? Math.round(Math.max(0, Date.now() - startedAt) / 100) * 100 : (armed.chaos.afterMs ?? 0),
    ...(typeof record.park?.cmdId === 'string' ? { cmdId: record.park.cmdId } : {}),
    ...extra,
  };
  const { won } = await commitFact(log, 'chaos', chaosKey(armed), input, { epoch: log.state.epoch, placed: [armed.id] });
  return won;
}

/**
 * Cadence of owner checks, from how long the work has been running (server
 * clocks only; a queue redelivery carries no counter we could trust).
 */
function cadence(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 5;
  if (elapsedMs < 30_000) return 10;
  if (elapsedMs < 60_000) return 20;
  return 30;
}

/**
 * A parked step that has settled but whose drive has not taken the
 * settlement yet. Detached: wake a drive (keyed by the settlement, so it is
 * sent once). Attached: nothing, the parker takes it, or its delivery comes
 * back and does. Nothing to look at again either way.
 */
async function nudgeSettled(options: OwnerDriverOptions, log: SessionLog, record: EffectRecord, _observer: string): Promise<undefined> {
  if (!isDetached(record)) return undefined;
  await wakeSettled(options, log.state, record.stepId, `settle:${record.settlement?.at ?? 0}`);
  options.log?.('owner: woke a drive for a settled step', { runId: log.runId, stepId: record.stepId });
  return undefined;
}

/**
 * Police one parked step (an owner check). Returns how long to wait before
 * looking again, or `undefined` when there is nothing left to watch for this
 * step.
 */
export async function policeParked(
  options: OwnerDriverOptions,
  log: SessionLog,
  record: EffectRecord,
  mode: 'check' | 'backstop',
  observer: string
): Promise<number | undefined> {
  const say = options.log ?? (() => {});
  if (record.status !== 'running' || !record.park) return undefined;
  if (record.settlement) return nudgeSettled(options, log, record, observer);
  const policy = policyFor(options, record);
  if (!policy) {
    say('owner: no policy for a parked step', { runId: log.runId, stepId: record.stepId, kind: record.park.kind });
    return 30;
  }
  const verdict = await policy.check({ world: options.world, log, record, owner: record.park, mode, say });
  if (verdict.state === 'dropped') return undefined;
  if (verdict.state === 'settled') {
    await log.refresh();
    const now = log.state.effects.get(record.key);
    if (now?.stepId === record.stepId && now.status === 'running' && now.settlement) {
      // Not while the parking drive is still attached (its inline grace):
      // it takes the settlement itself, and a wake would race it. A parker
      // that died attached is its own delivery's to re-enter.
      await wakeAfterSettle(options, log.state, now);
    }
    return undefined;
  }
  return Math.max(0, verdict.recheckSeconds);
}

/** One delivery of an owner check. */
export async function ownerCheck(
  options: OwnerDriverOptions,
  runId: string,
  message: Extract<OwnerMessage, { kind: 'owner-check' }>
): Promise<{ timeoutSeconds: number } | undefined> {
  const log = new SessionLog(options.world, runId);
  await log.refresh();
  if (log.state.status !== 'running') return;
  const record = log.state.effectOrder.find((r) => r.stepId === message.stepId);
  if (!record || record.status !== 'running' || !record.park) return;
  const again = await policeParked(options, log, record, 'check', `owner:${message.nonce}`);
  if (again === undefined) return;
  const startedAt = typeof record.park.startedAt === 'number' ? record.park.startedAt : Date.now();
  // A policy that long-polled asks for 0-1s; otherwise back off with age.
  const delay = again <= 1 ? Math.max(1, again) : Math.min(again, cadence(Date.now() - startedAt));
  return { timeoutSeconds: Math.max(1, Math.ceil(delay)) };
}

/** One delivery of a `chaos-fire` message: carry out an armed sandbox crash, if it still applies. */
export async function fireOwnerChaos(
  options: OwnerDriverOptions,
  runId: string,
  message: Extract<OwnerMessage, { kind: 'chaos-fire' }>
): Promise<void> {
  const say = options.log ?? (() => {});
  const log = new SessionLog(options.world, runId);
  await log.refresh();
  const record = log.state.effectOrder.find((r) => r.stepId === message.stepId);
  const armed = armedChaos(log.state);
  if (!record || record.status !== 'running' || !record.park || record.settlement) {
    say('chaos: the target finished first; the crash stays armed', { runId, stepId: message.stepId });
    return;
  }
  if (!armed || armed.id !== message.submission) return;
  const kind = chaosKind(armed.chaos);
  // A drill on the session's own sandbox is its drive's (`DriveContext.drills`), never a parked command's owner's.
  if (kind === 'process' || kind === 'drop-callback' || isSessionDrill(armed.chaos)) return;
  const policy = policyFor(options, record);
  if (!policy?.fireChaos) return;
  if (!(await fireChaosStep(log, record, armed, kind))) {
    say('chaos: not accepted (the target settled first)', { runId, stepId: record.stepId });
    return;
  }
  const live = new JsonLinesWriter(options.world, runId, liveStreamName(runId));
  live.write({ type: 'chaos', kind, crashedDuring: record.key, effect: record.name });
  await live.flush();
  say(`chaos: ${kind}`, { runId, stepId: record.stepId });
  await policy.fireChaos({ world: options.world, log, record, owner: record.park, mode: 'check', say, spec: armed.chaos, kind });
  // Look soon, on a chain of its own: the kill should be noticed in seconds.
  await armOwnerCheck(options.world, runId, record.stepId, 2, `chaos:${message.submission}`);
}

export { parkedRecords };
