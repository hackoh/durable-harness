import { crashWaitText, laneLabel } from './copy.ts';
import type { ChaosKind, EffectView, EventView, Lane, Mode, SessionView, WorldName } from './view.ts';

/**
 * Everything the page derives from a fold plus the raw log: which lane ran
 * each effect, when each step started and ended, what happened to each
 * crash, and the one-line "now" the session header shows. Pure functions.
 */

export const LANE_ORDER: Lane[] = ['browser', 'function', 'sandbox'];

/** An effect in flight: created (pending) or started (running), not yet committed. */
export const inFlight = (e: { status: string }) => e.status === 'running' || e.status === 'pending';

export const startLane = (mode: Mode): Lane => (mode === 'server' ? 'function' : 'browser');

/** Lanes a brain can drive (the sandbox lane is retired: no brain drives it). */
export function litLanes(mode: Mode): Set<Lane> {
  if (mode === 'server') return new Set(['function']);
  if (mode === 'tab') return new Set(['browser']);
  return new Set(['browser', 'function']);
}

/** Effects the rail and transcript draw (fx's `turn`/`steer` only place submissions). */
export const isRailEffect = (name: string) =>
  name === 'model' || name.startsWith('tool.') || name === 'handoff' || name === 'chaos' || name === 'fs' || name === 'checkpoint';

/** Where a sandbox result came from, in a sentence. */
export function settledBy(by: string | undefined): string {
  if (by === 'push') return 'the sandbox reported it';
  if (by === 'check') return 'the result check collected it from the Sandbox API';
  if (by === 'backstop') return 'the (retired) backstop collected it from the Sandbox API';
  if (by === 'tether') return "the sandbox lane's tether collected it";
  if (by === 'inline') return 'the function was still attached';
  return 'it was collected';
}

/**
 * The lane each effect ran in. Each completed handoff moves the session for
 * the effects after it; the handoff itself belongs to the lane it left.
 */
export function laneOf(effects: EffectView[], mode: Mode): Map<string, Lane> {
  const out = new Map<string, Lane>();
  let lane = startLane(mode);
  for (const e of effects) {
    out.set(e.key, lane);
    if (e.name === 'handoff' && e.status === 'completed' && e.output?.to) lane = e.output.to as Lane;
  }
  return out;
}

export interface StepTimes {
  started?: number;
  ended?: number;
}

/** Start of the latest attempt and end of each step, from the log's timestamps. */
export function stepTimes(events: EventView[]): Map<string, StepTimes> {
  const out = new Map<string, StepTimes>();
  for (const e of events) {
    if (!e.correlationId || !e.eventType.startsWith('step_')) continue;
    const t = Date.parse(e.createdAt);
    let rec = out.get(e.correlationId);
    if (!rec) out.set(e.correlationId, (rec = {}));
    if (e.eventType === 'step_created') rec.started ??= t;
    else if (e.eventType === 'step_started') {
      rec.started = t;
      rec.ended = undefined;
    } else if (e.eventType === 'step_completed' || e.eventType === 'step_failed') rec.ended = t;
  }
  return out;
}

export function startOf(e: EffectView, times: Map<string, StepTimes>): number | undefined {
  return times.get(e.stepId)?.started ?? (e.startedAt ? Date.parse(e.startedAt) : undefined);
}

export type CrashKind = ChaosKind;

/** A drill on a session's own sandbox (D1-D4): its Function lived, and re-attached. */
export const sessionDrill = (kind: CrashKind, parked: boolean) => !parked && kind !== 'process';

export interface CrashInfo {
  /** The chaos effect's key. */
  key: string;
  stepId: string;
  kind: CrashKind;
  killedKey: string;
  effectName: string;
  afterMs: number;
  /** Lane of the process that died (or of the sandbox command). */
  lane: Lane;
  crashAt?: number;
  killedAttempt: number;
  /**
   * - `waiting`: something the crash left open has not been picked up yet.
   * - `replayed` / `interrupted`: the killed step was retried / given an interrupted result.
   * - `clear`: a Kill Function crash left nothing open (the session carried on).
   * - `collected`: a sandbox crash (or a Kill Function during a parked command) was resolved from the sandbox.
   */
  state: 'waiting' | 'replayed' | 'interrupted' | 'clear' | 'collected';
  recoveryMs?: number;
  attempt?: number;
  /** The interrupted result carries output the tool printed before it died. */
  partial: boolean;
  /** What the dead drive still has open, by label ("Checkpoint for turn 9"), while waiting. */
  open: string[];
  /** Who collected a sandbox result (`push`, `check`, `backstop`). */
  resolvedBy?: string;
  /** The killed sandbox command's exit code, when it reported one. */
  exitCode?: number;
  /** A Kill Function whose target was a parked sandbox command (it kept running). */
  parkedTarget?: boolean;
  /** Resolved by a parked sandbox command's own outcome (a hybrid sandbox_exec), not by a drive coming back. */
  parked?: boolean;
}

/** A person's name for an open step. */
export function openLabel(e: EffectView): string {
  if (e.name === 'checkpoint') {
    const n = Number(String(e.key).split(':')[1]);
    return Number.isFinite(n) ? `Checkpoint for turn ${n + 1}` : 'A checkpoint';
  }
  if (e.name === 'model') return 'The model call';
  if (e.name.startsWith('tool.')) return e.name.slice(5);
  if (e.name === 'turn') return 'The turn';
  return e.name;
}

const settleOf = (view: SessionView, target: EffectView) =>
  view.effects.find((e) => e.name === 'settle' && e.input?.forStepId === target.stepId);

export function crashes(view: SessionView | undefined, lanes: Map<string, Lane>, times: Map<string, StepTimes>, mode: Mode): CrashInfo[] {
  if (!view) return [];
  const out: CrashInfo[] = [];
  for (const c of view.effects) {
    if (c.name !== 'chaos' || c.status !== 'completed' || !c.output) continue;
    const kind = (c.output.kind ?? 'process') as CrashKind;
    const killedKey = c.output.crashedDuring as string;
    const k = view.effects.find((e) => e.key === killedKey);
    const crashAt = times.get(c.stepId)?.ended ?? (c.startedAt ? Date.parse(c.startedAt) : undefined);
    const since = (t: number | undefined) => (t !== undefined && crashAt !== undefined ? Math.max(0, t - crashAt) : undefined);
    // Everything the killed drive still has open (a v2 crash names its drive).
    const driver = c.output.driver as string | undefined;
    const openNow = view.effects.filter(
      (e) => e.key !== c.key && inFlight(e) && !e.park && (e.key === killedKey || (!!driver && e.driver === driver))
    );
    const base = {
      key: c.key,
      stepId: c.stepId,
      kind,
      killedKey,
      effectName: String(c.output.effect ?? k?.name ?? 'a step'),
      afterMs: Number(c.output.afterMs ?? 0),
      lane: (c.output.lane as Lane | undefined) ?? (k && lanes.get(k.key)) ?? lanes.get(c.key) ?? startLane(mode),
      crashAt,
      open: openNow.map(openLabel),
    };
    const kStart = k ? startOf(k, times) : undefined;
    const partial = !!k && partialText(k.error).trim().length > 0;
    const settle = k ? settleOf(view, k) : undefined;
    const settledAt = settle ? startOf(settle, times) : undefined;

    // A sandbox crash, or a Kill Function while the command was parked: the
    // command's own outcome is what resolves it. (A drill on a session's own
    // sandbox is resolved like a kill: by the drive, which re-attached.)
    if (k?.park || kind === 'sandbox-command' || kind === 'drop-callback' || (kind === 'sandbox-vm' && !k)) {
      const s = k?.settlement;
      const info = { ...base, killedAttempt: k?.attempt ?? 1, partial, parkedTarget: kind === 'process', parked: true };
      if (!k || (!s && inFlight(k))) {
        // A Kill Function crash may also have left other steps open; either way the command still owes its result.
        out.push({ ...info, state: 'waiting' });
        continue;
      }
      const recoveryMs = since(settledAt ?? times.get(k.stepId)?.ended);
      out.push({
        ...info,
        state: s && !s.ok ? 'interrupted' : 'collected',
        ...(recoveryMs !== undefined ? { recoveryMs } : {}),
        ...(s ? { resolvedBy: s.by } : {}),
        ...(s?.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      });
      continue;
    }

    if (k && k.status === 'failed' && k.error?.interrupted) {
      // Recovered when a driver came back and moved on: the first step
      // started after the crash. (A reloaded tab can record the interrupted
      // result within milliseconds; the time that matters is the comeback.)
      let back: number | undefined;
      if (crashAt !== undefined)
        for (const [stepId, t] of times)
          if (stepId !== c.stepId && stepId !== k.stepId && t.started !== undefined && t.started > crashAt)
            back = back === undefined ? t.started : Math.min(back, t.started);
      const end = back ?? times.get(k.stepId)?.ended;
      out.push({ ...base, killedAttempt: k.attempt, state: 'interrupted', recoveryMs: since(end), partial });
    } else if (k && k.attempt >= 2 && kStart !== undefined && crashAt !== undefined && kStart > crashAt) {
      out.push({ ...base, killedAttempt: k.attempt - 1, state: 'replayed', recoveryMs: kStart - crashAt, attempt: k.attempt, partial });
    } else if (openNow.length === 0 && view.status === 'running' && (!k || !inFlight(k))) {
      // Nothing the dead drive had open is still open: no one is waiting on anything.
      out.push({ ...base, killedAttempt: k?.attempt ?? 1, state: 'clear', partial });
    } else if (openNow.length === 0 && view.status !== 'running') {
      out.push({ ...base, killedAttempt: k?.attempt ?? 1, state: 'clear', partial });
    } else {
      out.push({ ...base, killedAttempt: k?.attempt ?? 1, state: 'waiting', partial });
    }
  }
  return out;
}

export interface NowState {
  text: string;
  /** Key of the effect whose duration the header ticks. */
  runningKey?: string;
  since?: number;
  /** Something is in flight: poll fast, allow steering. */
  busy: boolean;
  /** An effect is running right now. */
  running: boolean;
}

export const unplaced = (view: SessionView) =>
  view.submissions.filter((s) => !s.placed && !s.withdrawn && s.kind !== 'withdraw' && s.kind !== 'chaos');

export function nowState(
  view: SessionView,
  mode: Mode,
  world: WorldName | undefined,
  lanes: Map<string, Lane>,
  times: Map<string, StepTimes>,
  crashList: CrashInfo[],
  /** A drive is working right now, by the session's live marks (`SessionData.driving`). */
  driving = false
): NowState {
  const running = view.effects.find(inFlight);
  const queued = unplaced(view);
  const waitingCrash = crashList.find((c) => c.state === 'waiting');
  const base = { busy: true, running: !!running };
  if (waitingCrash && view.status === 'running') {
    if (waitingCrash.parked) return { ...base, text: 'Waiting for the sandbox command to be collected', since: waitingCrash.crashAt };
    if (sessionDrill(waitingCrash.kind, false)) return { ...base, text: 'Waiting for the Function to re-attach to the sandbox', since: waitingCrash.crashAt };
    return { ...base, text: crashWaitText(world, waitingCrash.lane), since: waitingCrash.crashAt };
  }
  const last = view.effects.filter((e) => isRailEffect(e.name)).at(-1);
  if (last?.name === 'handoff' && last.status === 'completed' && view.status === 'running') {
    const to = last.output?.to as Lane | undefined;
    if (to && to !== 'browser') return { ...base, text: `Waiting for the ${laneLabel(to, mode, world)} to pick it up` };
  }
  if (running) {
    const since = startOf(running, times);
    if (running.name.startsWith('tool.')) {
      const lane = lanes.get(running.key) ?? startLane(mode);
      if (running.park && !running.settlement)
        return { ...base, text: `Running in the Sandbox, nothing attached: ${running.name.slice(5)}`, runningKey: running.key, since };
      return { ...base, text: `Running in ${laneLabel(lane, mode, world)}: ${running.name.slice(5)}`, runningKey: running.key, since };
    }
    if (running.name === 'model') return { ...base, text: 'Streaming a model response', runningKey: running.key, since };
    return { ...base, text: `Running ${running.name}`, runningKey: running.key, since };
  }
  // A process harness between its tool calls: its CLI is working (its model call is not a step, except around a crash drill).
  if ((view.turnOpen || view.working) && view.status === 'running') return { ...base, text: 'Working on the turn' };
  // A drive is working on the turn the log does not show yet (its writes trail it: the model call
  // after a crash's recovery, a Durable turn's first steps).
  if (driving && view.status === 'running') return { ...base, running: true, text: 'Working on the turn' };
  if (queued.length && view.status === 'running')
    return { ...base, text: `Queued: ${queued.length} ${queued.length === 1 ? 'message' : 'messages'} in the inbox` };
  if (view.status === 'running') return { busy: false, running: false, text: 'Idle, waiting for a message' };
  if (view.status === 'completed') return { busy: false, running: false, text: 'Done' };
  if (view.status === 'failed') return { busy: false, running: false, text: 'Failed' };
  return { busy: false, running: false, text: view.status[0]!.toUpperCase() + view.status.slice(1) };
}

/** The one word for what a session is doing: the header's sentence and the list's row agree. */
export function statusWord(now: NowState | undefined, view: SessionView | undefined, crashWaiting: boolean): string | undefined {
  if (!view || !now) return undefined;
  if (crashWaiting && view.status === 'running') return 'Killed';
  if (now.running) return 'Running';
  if (now.busy) return now.text.startsWith('Queued') ? 'Queued' : 'Running';
  if (view.status === 'running') return 'Idle';
  if (view.status === 'completed') return 'Done';
  if (view.status === 'failed') return 'Failed';
  return undefined;
}

/** Log positions (1-based) per step and per submission event, for citations. */
export interface LogIndex {
  byStep: Map<string, number[]>;
  byEvent: Map<string, number>;
}

export function logIndex(events: EventView[]): LogIndex {
  const byStep = new Map<string, number[]>();
  const byEvent = new Map<string, number>();
  for (const e of events) {
    byEvent.set(e.eventId, e.index);
    if (e.correlationId) {
      const list = byStep.get(e.correlationId);
      if (list) list.push(e.index);
      else byStep.set(e.correlationId, [e.index]);
    }
  }
  return { byStep, byEvent };
}

export function cite(indexes: number[] | undefined): string {
  if (!indexes?.length) return '';
  const lo = Math.min(...indexes);
  const hi = Math.max(...indexes);
  return lo === hi ? `#${lo}` : `#${lo}–${hi}`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** A finished step's duration: never "0.0 s" for a step that took some time. */
export function fmtDone(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 100 ? 'under 0.1 s' : fmtDuration(ms);
}

/** A recovery time: never "0.0 s", which reads as if nothing died. */
export function fmtRecovery(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return ms < 100 ? 'under 0.1 s' : fmtDuration(ms);
}

export function fmtRelative(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtOffset(ms: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${fmtDuration(ms)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** First 9 characters, an ellipsis, the last 5. */
export const midId = (id: string) => (id.length <= 16 ? id : `${id.slice(0, 9)}…${id.slice(-5)}`);

/** Text of a model effect's committed response, for Pi and fx. */
export function modelText(e: EffectView): string {
  const out = e.output;
  if (!out) return '';
  if (typeof out.text === 'string') return out.text;
  if (Array.isArray(out.content))
    return out.content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('');
  return '';
}

export function modelToolCalls(e: EffectView): string[] {
  const out = e.output;
  const calls: string[] = [];
  // Pi's `toolCall` parts, the AI SDK's `tool-call` parts.
  if (Array.isArray(out?.content))
    for (const c of out.content) if (c?.type === 'toolCall' || c?.type === 'tool-call') calls.push(String(c.name ?? c.toolName ?? 'a tool'));
  if (Array.isArray(out?.toolCalls)) for (const c of out.toolCalls) calls.push(String(c.name ?? c.toolName ?? c.function?.name ?? 'a tool'));
  return calls;
}

export function toolText(output: any): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  const texts = output?.content?.filter?.((c: any) => c.type === 'text').map((c: any) => c.text);
  return texts?.length ? texts.join('\n') : JSON.stringify(output, null, 2);
}

/**
 * What a tool printed before it was interrupted. Progress chunks are
 * `{ stream, data }` output or bookkeeping (`{ command }`, `{ phase }`);
 * Pi wraps each one as JSON text.
 */
export function partialText(error: any): string {
  const parts = error?.partial;
  if (!Array.isArray(parts)) return '';
  const unwrap = (s: string): string => {
    if (!s.startsWith('{')) return s;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        if (typeof o.data === 'string') return o.data;
        if ('phase' in o || 'command' in o || 'sandbox' in o) return '';
      }
    } catch {}
    return s;
  };
  const text = (p: any): string => {
    if (typeof p === 'string') return unwrap(p);
    if (typeof p?.data === 'string') return p.data;
    if (typeof p?.text === 'string') return unwrap(p.text);
    if (typeof p?.chunk === 'string') return p.chunk;
    if (Array.isArray(p?.content)) return p.content.map(text).join('');
    return '';
  };
  return parts.map(text).join('');
}
