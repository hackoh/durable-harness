import { monotonicFactory } from 'ulid';
import type { Anchor } from './anchor.ts';
import { encode } from './codec.ts';
import type { CloseInput, DetachInput, SettleInput, StepEnvelope } from './fold.ts';
import { type HostFact, hostOf, isEpochStep } from './lanes.ts';
import { stepNameFor } from './names.ts';
import type { SessionLog } from './session-log.ts';
import type { EffectError, EffectRecord, Settlement } from './types.ts';

const ulid = monotonicFactory();

/**
 * Steps that take effect at their intent (`step_started`, born running):
 * epoch steps (`handoff`, `recover`), facts about another step (`park`,
 * `settle`, `detach`, `chaos`), facts about a drive or a machine
 * (`close`, `host`), and a turn the harness could not run (`unavailable`,
 * unavailable.ts: it places the turn's messages at its intent). Their
 * `step_completed` only closes the step for the dashboards, so any reader
 * that finds one half-written finishes it.
 */
export const isFactStep = (name: string) =>
  isEpochStep(name) ||
  name === 'park' ||
  name === 'settle' ||
  name === 'detach' ||
  name === 'close' ||
  name === 'chaos' ||
  name === 'host' ||
  name === 'unavailable';

export interface CommitFactOptions {
  epoch: number;
  drv?: string;
  /** What holds the drive writing it (anchor.ts). */
  anchor?: Anchor;
  placed?: string[];
  /** For a fenced log (a crash under way): the fence's token. */
  fenceToken?: string;
}

/**
 * Commit a fact step: one born-running step for `key` (first writer wins,
 * fenced if the epoch moved, inert if the fold refuses it), then its outcome.
 * `won: false` means the fold did not accept it; `fenced` says the epoch had
 * moved (a caller may re-read and try again).
 */
export async function commitFact(
  log: SessionLog,
  name: string,
  key: string,
  input: unknown,
  options: CommitFactOptions
): Promise<{ won: boolean; stepId: string; fenced: boolean }> {
  const stepId = `step_${ulid()}`;
  const envelope: StepEnvelope = {
    key,
    replay: 'safe',
    input,
    epoch: options.epoch,
    ...(options.placed?.length ? { placed: options.placed } : {}),
    ...(options.drv ? { drv: options.drv } : {}),
    ...(options.anchor ? { anchor: options.anchor } : {}),
  };
  const write = options.fenceToken ? { fenceToken: options.fenceToken } : {};
  await log.write(
    {
      eventType: 'step_started',
      correlationId: stepId,
      eventData: { stepName: stepNameFor(name), input: encode(envelope) },
    },
    write
  );
  const record = log.state.effects.get(key);
  if (record?.stepId !== stepId) {
    const fenced = log.state.fenced.has(stepId);
    // Inert in every reader's fold; closes the step for the dashboards.
    await log
      .write(
        {
          eventType: 'step_failed',
          correlationId: stepId,
          eventData: { stepName: stepNameFor(name), error: encode({ message: 'superseded' } satisfies EffectError) },
        },
        write
      )
      .catch(() => {});
    return { won: false, stepId, fenced };
  }
  await finishFact(log, record, options.fenceToken);
  return { won: true, stepId, fenced: false };
}

/** A fact step's outcome is its input: write it, unless someone already did. */
export async function finishFact(log: SessionLog, record: EffectRecord, fenceToken?: string): Promise<void> {
  try {
    await log.write(
      {
        eventType: 'step_completed',
        correlationId: record.stepId,
        eventData: { stepName: stepNameFor(record.name), result: encode(record.input) },
      },
      fenceToken ? { fenceToken } : {}
    );
  } catch {
    await log.refresh().catch(() => {});
  }
}

/** Running intents a `park` step handed to an owner outside any drive. */
export const parkedRecords = (records: Iterable<EffectRecord>) =>
  [...records].filter((r) => r.status === 'running' && !!r.park);

/**
 * Whether the drive that parked `record` has let go of it (a `detach`
 * fact), so a settlement needs a drive woken for it. A park written before
 * parks carried anchors counts as detached: nothing would take it otherwise.
 */
export const isDetached = (record: Pick<EffectRecord, 'park' | 'detached' | 'anchor'>): boolean =>
  !!record.park && (!!record.detached || !record.anchor);

/**
 * Let go of a parked step (its parker's inline grace ran out, or the parker
 * died and a recovery found it attached). Accepted only while the step is
 * running, parked, unsettled and attached, so a settlement that landed first
 * wins: `won: false` then means the caller should take that settlement.
 * Retries when the epoch moved under it (a fact about the step, not progress).
 */
export async function commitDetach(
  log: SessionLog,
  record: Pick<EffectRecord, 'key' | 'stepId'>,
  options: { drv?: string; anchor?: Anchor } = {}
): Promise<{ won: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = log.state.effects.get(record.key);
    if (!now || now.stepId !== record.stepId || now.status !== 'running' || !now.park || now.settlement) return { won: false };
    if (now.detached) return { won: true };
    const input: DetachInput = { forKey: record.key, forStepId: record.stepId };
    const { won, fenced } = await commitFact(log, 'detach', `detach:${record.stepId}`, input, {
      epoch: log.state.epoch,
      ...(options.drv ? { drv: options.drv } : {}),
      ...(options.anchor ? { anchor: options.anchor } : {}),
    });
    if (won) return { won: true };
    if (!fenced) break;
    await log.refresh();
  }
  const after = log.state.effects.get(record.key);
  return { won: !!(after?.stepId === record.stepId && after.detached) };
}

/**
 * Record that drive `drv` will write nothing more (anchor.ts): written once,
 * when a drive that wrote anything lets go of its delivery. Any intent of it
 * that is still running then (one whose write the drive gave up on, landing
 * late) is abandoned for every reader. Written at the session's current epoch
 * (a drive that handed the session on still closes), retried if it moves.
 */
export async function commitClose(log: SessionLog, drv: string, options: { anchor?: Anchor; fenceToken?: string } = {}): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (log.state.closed.has(drv)) return true;
    const input: CloseInput = { drv };
    const { won, fenced } = await commitFact(log, 'close', `close:${drv}`, input, {
      epoch: log.state.epoch,
      drv,
      ...(options.anchor ? { anchor: options.anchor } : {}),
      ...(options.fenceToken ? { fenceToken: options.fenceToken } : {}),
    });
    if (won) return true;
    if (!fenced) break;
    await log.refresh();
  }
  return log.state.closed.has(drv);
}

/**
 * Settle a parked intent: commit `settlement` for it, first writer wins.
 *
 * - `won`: this settlement is the intent's outcome now; wake a drive to take it.
 * - `lost`: someone settled it first (theirs stands, and is identical in
 *   practice: every collector reads the same finished command).
 * - `not-open`: the intent is not parked and running any more.
 */
export async function settleParked(
  log: SessionLog,
  record: Pick<EffectRecord, 'key' | 'stepId'>,
  settlement: Settlement,
  options: { drv?: string } = {}
): Promise<'won' | 'lost' | 'not-open'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = log.state.effects.get(record.key);
    if (!now || now.stepId !== record.stepId || now.status !== 'running' || !now.park) return 'not-open';
    if (now.settlement) return 'lost';
    const input: SettleInput = { ...settlement, forKey: record.key, forStepId: record.stepId };
    const { won, fenced } = await commitFact(log, 'settle', `settle:${record.stepId}`, input, {
      epoch: log.state.epoch,
      ...(options.drv ? { drv: options.drv } : {}),
    });
    if (won) return 'won';
    // The epoch moved between our read and our write: read again and retry.
    if (!fenced) break;
    await log.refresh();
  }
  const after = log.state.effects.get(record.key);
  return after?.stepId === record.stepId && after.settlement ? 'lost' : 'not-open';
}

/**
 * Record that a sandbox host (an in-VM daemon) serves this session.
 * Each attach gets its own fact (`host:<vm>:<bootId>:<nonce>`), so a
 * boot that was marked lost can attach again; `hostOf()` resolves per boot.
 * Idempotent: when this exact boot is already the live host it returns
 * `{ won: true }` without writing. Retries if the epoch moved under it (a
 * fact about the machine, not a drive's progress).
 */
export async function commitHost(log: SessionLog, fact: HostFact, options: { drv?: string } = {}): Promise<{ won: boolean }> {
  const { lost: _lost, ...attach } = fact;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = hostOf(log.state);
    if (current && current.vm === attach.vm && current.bootId === attach.bootId) return { won: true };
    const key = `host:${attach.vm}:${attach.bootId}:${ulid()}`;
    const { won, fenced } = await commitFact(log, 'host', key, attach, {
      epoch: log.state.epoch,
      ...(options.drv ? { drv: options.drv } : {}),
    });
    if (won || !fenced) return { won };
    await log.refresh();
  }
  return { won: false };
}

/**
 * Mark a host gone (a failed probe, a takeover): later routing treats the
 * sandbox lane as unavailable until a new attach. Names the boot it observed
 * (`bootId`, default the current host's) so a stale mark never hides a newer
 * boot; a no-op (`false`) when that boot is not the session's live host.
 */
export async function markHostLost(
  log: SessionLog,
  reason: string,
  options: { drv?: string; bootId?: string; vm?: string } = {}
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const host = hostOf(log.state);
    if (!host) return false;
    if (options.bootId && (host.bootId !== options.bootId || (options.vm && host.vm !== options.vm))) return false;
    const key = `host:${host.vm}:${host.bootId}:lost:${ulid()}`;
    const { won, fenced } = await commitFact(
      log,
      'host',
      key,
      { ...host, lost: { reason, at: Date.now() } },
      { epoch: log.state.epoch, ...(options.drv ? { drv: options.drv } : {}) }
    );
    if (won || !fenced) return won;
    await log.refresh();
  }
  return false;
}
