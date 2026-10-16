import type { Event } from '@workflow/world';
import type { Anchor } from './anchor.ts';
import { decode } from './codec.ts';
import { type Capability, isEpochStep } from './lanes.ts';
import { effectNameOf } from './names.ts';
import type { ChaosOutput } from './chaos.ts';
import { foldInBandEdits, foldOutOfBandEdits, isDocsEnvelope } from './docs.ts';
import type {
  EffectError,
  EffectRecord,
  Lane,
  ParkOwner,
  ReplayPolicy,
  SessionState,
  Settlement,
  Submission,
} from './types.ts';

/** What the kernel stores as a step's input: the harness input plus its memo key. */
export interface StepEnvelope {
  key: string;
  replay: ReplayPolicy;
  placed?: string[];
  input: unknown;
  /**
   * The writer's epoch (`SessionState.epoch`) when it committed this intent.
   * A step whose epoch is not the log's epoch at that point is fenced.
   * Absent in logs written before epochs existed: never fenced.
   */
  epoch?: number;
  /** The `pending` step this intent retries, for a retry written as a new step. */
  retryOf?: string;
  /** `EffectOptions.requires`, so a takeover can tell which lane can finish it. */
  requires?: Lane;
  /** `EffectOptions.needs`. */
  needs?: Capability[];
  /** The drive that wrote this intent (`EffectRecord.driver`). */
  drv?: string;
  /** What holds that drive (anchor.ts): written once, with the step. */
  anchor?: Anchor;
  /**
   * Run-ahead chain fence (pipelined-log.ts). `chain` names one pipelined
   * attempt of a drive (a restart mints a new one); `seq` counts its
   * intents. Once an intent carrying `seq` is ineffective, every later
   * intent of the same chain is inert: it was issued against a speculative
   * view that included the one that did not happen. Envelopes without `seq`
   * (old logs, cleanup and fact writes) are never fenced by chain.
   */
  chain?: string;
  seq?: number;
}

/** A `park` step's input. */
export interface ParkInput {
  forKey: string;
  forStepId: string;
  owner: ParkOwner;
}

/** A `settle` step's input: the settlement, and the parked step it settles. */
export type SettleInput = Settlement & { forKey: string; forStepId: string };

/** A `detach` step's input: the parked step its parker let go of. */
export interface DetachInput {
  forKey: string;
  forStepId: string;
}

/** A `close` step's input: the drive that will write nothing more. */
export interface CloseInput {
  drv: string;
}

/** Called once per folded event: whether it changed the fold (see `fold`). */
export type FoldSink = (event: Event, effective: boolean) => void;

export interface RunEnvelope {
  harness: string;
  config?: unknown;
}

export interface SubmissionPayload {
  kind: Submission['kind'];
  text?: string;
  target?: string;
  chaos?: Submission['chaos'];
  /**
   * The sender's id for this submission. A resend after an ambiguous failure
   * carries the same nonce, and only its first `hook_received` counts.
   */
  nonce?: string;
  /**
   * Client-minted submission id. When present it *is* the submission's id
   * (not the event id), so an owner can place a submission before its
   * `hook_received` has a slot, and a resend is a duplicate by `cid`.
   */
  cid?: string;
}

export function emptyState(runId: string): SessionState {
  return {
    runId,
    status: 'pending',
    submissions: [],
    placed: new Set(),
    withdrawn: new Set(),
    effects: new Map(),
    effectOrder: [],
    superseded: new Set(),
    epoch: 0,
    fenced: new Set(),
    fencedChains: new Set(),
    eventCount: 0,
    closed: new Set(),
    docs: new Map(),
    docEdits: new Map(),
  };
}

/**
 * Fold events into session state. Pure apart from mutating `state`, and
 * incremental: folding a log in two halves equals folding it at once.
 *
 * The fold is the only reader of the log's semantics. A harness never looks
 * at events directly; it sees the transcript and memo table this produces.
 *
 * Several rules keep one session single-writer even when two drivers (a tab
 * that looks dead, the function that took over from it) both write:
 *
 * - First writer wins per memo key: a later step for the same key is ignored.
 * - Fencing: a step whose envelope epoch is not the log's current epoch was
 *   written by a driver that had not seen the latest handoff. Ignored.
 * - An outcome (`step_completed` / `step_failed` / `step_retrying`) applies
 *   only to a `running` record. A late result racing a recovery's
 *   interrupted result, a stale release, a duplicate resolution: whichever
 *   landed first stands, and the rest are inert.
 * - A retry is a new step naming the released one (`retryOf`); it replaces
 *   that record in place, so `effectOrder` still holds one record per key.
 * - Facts about another step take effect at their intent and only if their
 *   target is in the right state at that point in the log: a `park` needs a
 *   running, unparked target; a `settle` a running, parked, unsettled one;
 *   a `detach` a running, parked, unsettled, attached one; a v2 `chaos` a
 *   running, unsettled one. Otherwise they are inert. So a `detach` and a
 *   `settle` racing for one parked step are ordered by the log: exactly one
 *   of the parker (its detach lost) and the settler (its settle followed a
 *   detach) goes on to take the settlement.
 *
 * Documents (docs.ts): an outcome that applies (its record was running)
 * applies the edits its envelope carries at its slot, rebased path by path
 * on whatever landed since they were computed; an inert outcome applies
 * none. An out-of-band edit (a `hook_received` on the docs hook, the first
 * `:docs` hook wins) applies only on the revision it names, all of its edits
 * or none, and a second copy of one (same `id`) is inert.
 *
 * `onEvent` learns, per event, whether it had any effect, so a writer can
 * tell another live driver's writes from a fenced or inert one's.
 */
export function fold(state: SessionState, events: Event[], onEvent?: FoldSink): SessionState {
  const byStepId = new Map<string, EffectRecord>();
  for (const record of state.effectOrder) byStepId.set(record.stepId, record);

  for (const event of events) {
    state.eventCount++;
    let effective = true;
    switch (event.eventType) {
      case 'run_created': {
        const env = decode(event.eventData.input) as RunEnvelope;
        state.workflowName = event.eventData.workflowName;
        state.config = env?.config;
        break;
      }
      case 'run_started':
        state.status = 'running';
        break;
      case 'run_completed':
        state.status = 'completed';
        break;
      case 'run_failed': {
        state.status = 'failed';
        const error = decode(event.eventData.error) as { message?: string } | undefined;
        state.failure = { message: error?.message ?? String(error) };
        break;
      }
      case 'run_cancelled':
        state.status = 'cancelled';
        break;
      case 'hook_created':
        if (event.eventData.token.endsWith(':inbox') && !state.inbox) {
          state.inbox = {
            hookId: event.correlationId,
            token: event.eventData.token,
          };
        } else if (event.eventData.token.endsWith(':docs')) {
          // The first `:docs` hook wins; a later one changes nothing.
          if (state.docsHook) effective = false;
          else state.docsHook = { hookId: event.correlationId, token: event.eventData.token };
        }
        break;
      // A second writer of a hook's token (two first out-of-band edits at
      // once): the World answers with this instead, and the first stands.
      case 'hook_conflict':
        effective = false;
        break;
      case 'hook_received': {
        if (state.docsHook && event.correlationId === state.docsHook.hookId) {
          let payload: unknown;
          try {
            payload = decode(event.eventData.payload);
          } catch {
            payload = undefined;
          }
          effective = foldOutOfBandEdits(state, payload, state.eventCount) === 'applied';
          break;
        }
        if (event.correlationId !== state.inbox?.hookId) break;
        let payload: SubmissionPayload;
        try {
          payload = decode(event.eventData.payload) as SubmissionPayload;
        } catch {
          // Not ours (a hook written through a public webhook route, which an
          // older session's inbox may still be): inert, rather than a fold
          // that throws for good.
          effective = false;
          break;
        }
        if (!payload || typeof payload !== 'object' || typeof (payload as { kind?: unknown }).kind !== 'string') {
          effective = false;
          break;
        }
        // A resend of a submission that had landed after all: log order says
        // which copy is the submission, so every reader drops the same one.
        if (payload.nonce && state.submissions.some((s) => s.nonce === payload.nonce)) break;
        if (payload.cid && state.submissions.some((s) => s.id === payload.cid)) break;
        const submission: Submission = {
          id: payload.cid ?? event.eventId,
          kind: payload.kind,
          text: payload.text,
          target: payload.target,
          ...(payload.chaos ? { chaos: payload.chaos } : {}),
          ...(payload.nonce ? { nonce: payload.nonce } : {}),
          receivedAt: new Date(event.createdAt),
        };
        state.submissions.push(submission);
        // A withdraw only lands if its target is still unplaced. Whether it
        // landed is itself a pure function of log order, so every reader
        // agrees on it.
        if (
          submission.kind === 'withdraw' &&
          submission.target &&
          !state.placed.has(submission.target)
        ) {
          state.withdrawn.add(submission.target);
        }
        break;
      }
      case 'step_created': {
        const env = decode(event.eventData.input) as StepEnvelope;
        const record: EffectRecord = {
          key: env.key,
          stepId: event.correlationId,
          name: effectNameOf(event.eventData.stepName),
          replay: env.replay,
          input: env.input,
          status: 'pending',
          attempt: 0,
          placed: env.placed ?? [],
          ...(env.requires ? { requires: env.requires } : {}),
          ...(env.needs ? { needs: env.needs } : {}),
          ...(env.retryOf ? { retryOf: env.retryOf } : {}),
          ...(env.drv ? { driver: env.drv } : {}),
          ...(env.anchor ? { anchor: env.anchor } : {}),
        };
        byStepId.set(record.stepId, record);
        const chained = env.chain !== undefined && env.seq !== undefined;
        // Chain fence: an earlier intent of this pipelined chain did not
        // happen, so this one was issued against a view that never existed.
        if (chained && state.fencedChains.has(env.chain!)) {
          state.superseded.add(record.stepId);
          effective = false;
          break;
        }
        // Fenced: written by a driver whose view predates a handoff.
        if (env.epoch !== undefined && env.epoch !== state.epoch) {
          state.fenced.add(record.stepId);
          state.superseded.add(record.stepId);
          if (chained) state.fencedChains.add(env.chain!);
          effective = false;
          break;
        }
        // A fact about another step: only if that step is in the right state now.
        const target = factTarget(state, byStepId, record);
        if (target === null) {
          state.superseded.add(record.stepId);
          effective = false;
          break;
        }
        const current = state.effects.get(env.key);
        // A retry replaces the released record it names, in place.
        if (current && env.retryOf) {
          if (current.status !== 'pending' || current.stepId !== env.retryOf) {
            state.superseded.add(record.stepId);
            if (chained) state.fencedChains.add(env.chain!);
            effective = false;
            break;
          }
          record.attempt = current.attempt;
          // The retry stands for the same placement as the call it replaces.
          if (record.placed.length === 0) record.placed = current.placed;
          record.startedEpoch = state.epoch;
          state.effects.set(env.key, record);
          state.effectOrder[state.effectOrder.indexOf(current)] = record;
          state.superseded.add(current.stepId);
          break;
        }
        // First writer wins: a later step for the same key lost a race
        // between two drivers and is ignored by every reader. So is a step
        // that placed a submission withdrawn ahead of it in the log: the
        // withdraw committed first, so it wins, and the step never happened.
        if (current || record.placed.some((id) => state.withdrawn.has(id))) {
          state.superseded.add(record.stepId);
          if (chained) state.fencedChains.add(env.chain!);
          effective = false;
          break;
        }
        state.effects.set(env.key, record);
        state.effectOrder.push(record);
        for (const id of record.placed) state.placed.add(id);
        // A handoff moves the session the moment its intent is accepted.
        record.startedEpoch = state.epoch;
        if (isEpochStep(record.name)) state.epoch++;
        if (target && record.name === 'park') target.park = (record.input as ParkInput).owner;
        if (target && record.name === 'settle') {
          const { forKey: _k, forStepId: _s, ...settlement } = record.input as SettleInput;
          target.settlement = settlement as Settlement;
        }
        if (target && record.name === 'detach') target.detached = true;
        if (record.name === 'close') {
          const drv = (record.input as CloseInput | undefined)?.drv;
          if (drv) state.closed.add(drv);
        }
        break;
      }
      case 'step_started': {
        const record = live(state, byStepId, event.correlationId);
        // Only a pending record starts: a duplicate start of a running one,
        // or a start of a finished one, changes nothing.
        if (!record || record.status !== 'pending') {
          effective = false;
          break;
        }
        record.status = 'running';
        record.attempt++;
        record.startedAt = new Date(event.createdAt);
        // A legacy in-place retry starts in whatever epoch the log is in now.
        if (record.attempt > 1) record.startedEpoch = state.epoch;
        break;
      }
      case 'step_retrying': {
        const record = live(state, byStepId, event.correlationId);
        if (record?.status !== 'running') {
          effective = false;
          break;
        }
        record.status = 'pending';
        break;
      }
      case 'step_completed': {
        const record = live(state, byStepId, event.correlationId);
        if (record?.status !== 'running') {
          effective = false;
          break;
        }
        record.status = 'completed';
        const result = decode(event.eventData.result);
        if (isDocsEnvelope(result)) {
          record.output = result.value;
          const docs = foldInBandEdits(state, result.docs, state.eventCount, { step: record.stepId, key: record.key });
          if (docs.length > 0) record.docs = docs;
        } else record.output = result;
        break;
      }
      case 'step_failed': {
        const record = live(state, byStepId, event.correlationId);
        if (record?.status !== 'running') {
          effective = false;
          break;
        }
        record.status = 'failed';
        record.error = decode(event.eventData.error) as EffectError;
        break;
      }
      default:
        break;
    }
    onEvent?.(event, effective);
  }
  return state;
}

/**
 * For a fact step (`park`, `settle`, `detach`, v2 `chaos`): the record it is about,
 * or `null` if that record is not in a state the fact can apply to.
 * `undefined` for any other step.
 */
function factTarget(
  state: SessionState,
  byStepId: Map<string, EffectRecord>,
  record: EffectRecord
): EffectRecord | null | undefined {
  let forStepId: string | undefined;
  if (record.name === 'park' || record.name === 'settle' || record.name === 'detach') forStepId = (record.input as ParkInput | undefined)?.forStepId;
  else if (record.name === 'chaos' && (record.input as ChaosOutput | undefined)?.v === 2) forStepId = (record.input as ChaosOutput).stepId;
  else return undefined;
  const target = forStepId ? live(state, byStepId, forStepId) : undefined;
  if (!target || state.effects.get(target.key) !== target || target.status !== 'running') return null;
  if (record.name === 'park') return target.park ? null : target;
  if (record.name === 'settle') return target.park && !target.settlement ? target : null;
  if (record.name === 'detach') return target.park && !target.settlement && !target.detached ? target : null;
  return target.settlement ? null : target;
}

/** The record a step event applies to, unless its step lost, was fenced, or was replaced. */
function live(state: SessionState, byStepId: Map<string, EffectRecord>, stepId: string): EffectRecord | undefined {
  if (state.superseded.has(stepId)) return undefined;
  return byStepId.get(stepId);
}

export function pendingSubmissions(state: SessionState): Submission[] {
  return state.submissions.filter(
    (s) =>
      s.kind !== 'withdraw' &&
      s.kind !== 'chaos' &&
      !state.placed.has(s.id) &&
      !state.withdrawn.has(s.id)
  );
}
