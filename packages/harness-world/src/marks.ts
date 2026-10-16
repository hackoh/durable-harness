/**
 * Timing marks.
 *
 * Every process that drives a session writes `{ type: 'mark', ... }` lines
 * to the session's `live` stream at the moments a benchmark or the UI needs
 * to see: a submission committed, an intent acked, a model request going
 * out, its first token, a tool starting and ending, a handoff, a recovery,
 * going idle, and every write's ack latency.
 *
 * `t` is wall-clock milliseconds with sub-millisecond precision
 * (`performance.timeOrigin + performance.now()`), in the clock of the
 * process that wrote the mark. Clocks of different processes are never
 * compared: `pid` names the process (one per JS realm), so a reader can take
 * `t` for its own marks and its own arrival time for everyone else's.
 */

export type MarkName =
  | 'submit'
  | 'drive.start'
  | 'intent'
  | 'model.request'
  | 'model.first_token'
  | 'model.done'
  | 'tool.start'
  | 'tool.end'
  | 'handoff.sent'
  | 'handoff.picked'
  /** A tab's read found the session handed back to its lane (before it drives it). */
  | 'handoff.noticed'
  | 'ack'
  | 'rewind'
  | 'recover.start'
  | 'recover.done'
  | 'idle'
  /** A drive gave its delivery up early (durability stalled, a write hung, its deadline): a continuation carries on. */
  | 'release'
  /** A live-stream write that took longer than its deadline (streams.ts). */
  | 'stream.put_slow';

export interface Mark {
  type: 'mark';
  name: MarkName;
  /** Wall clock of the writing process, ms. */
  t: number;
  /** The writing process (see `PROCESS_ID`). */
  pid: string;
  runId: string;
  /** The lane the writer drives in, for sessions that move. */
  lane?: string;
  /** The drive (`drv_…`) that wrote it, when a drive did. */
  drv?: string;
  /** The effect's memo key and step name, for effect marks. */
  key?: string;
  effect?: string;
  /** Submissions an intent placed (a steer lands where it is placed). */
  placed?: string[];
  /** The durable log position the writer had folded when it wrote this. */
  durableSlot?: number;
  /** `ack`: the event type and slot that committed, and how long the write took. */
  eventType?: string;
  slot?: number;
  lagMs?: number;
  /**
   * End marks (`model.done`, `tool.end`): `t` is when the work itself ended,
   * before its outcome was committed; `commitMs` is how long the commit took
   * after that (0 when it is pipelined).
   */
  commitMs?: number;
  /** Whatever else a mark carries (a handoff's `from`/`to`, a rewind's `cause`). */
  [extra: string]: unknown;
}

/** Wall-clock ms with the resolution of `performance.now()`. */
export function markTime(): number {
  const p = globalThis.performance;
  return p && typeof p.timeOrigin === 'number' ? p.timeOrigin + p.now() : Date.now();
}

/** This JS realm, for `Mark.pid`. */
export const PROCESS_ID: string = (() => {
  const g = globalThis as { __harnessPid?: string };
  g.__harnessPid ??= `p_${Math.random().toString(36).slice(2, 10)}`;
  return g.__harnessPid;
})();

export function isMark(value: unknown): value is Mark {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'mark';
}

/** Build a mark for `runId` now. */
export function mark(runId: string, name: MarkName, fields: Partial<Omit<Mark, 'type' | 'name' | 'runId'>> = {}): Mark {
  return { type: 'mark', name, t: markTime(), pid: PROCESS_ID, runId, ...fields };
}

/**
 * This process's age, and whether this is the first time it does `tag`
 * (its first drive, its first submit): marks carry it so a reader can flag a
 * turn that paid for a new instance (lazy module evaluation on the first
 * request) rather than reading it as harness latency.
 */
export function processInfo(tag: string): { procMs?: number; fresh?: true } {
  const g = globalThis as { __harnessFirstUse?: Set<string> };
  const used = (g.__harnessFirstUse ??= new Set());
  const fresh = !used.has(tag);
  used.add(tag);
  const up = (globalThis as { process?: { uptime?: () => number } }).process?.uptime?.();
  return { ...(typeof up === 'number' ? { procMs: Math.round(up * 1000) } : {}), ...(fresh ? { fresh: true as const } : {}) };
}
