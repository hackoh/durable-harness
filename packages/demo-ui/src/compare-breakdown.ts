/**
 * Where a turn's time went, per column (`/compare`): the model's own time
 * (from the marks of the process that called it), the harness's overhead
 * around it, and flags for the things that are neither (a new instance, a
 * dropped or stalled live stream, a slow stream write, a rewind or a second
 * drive). Then the summary statistics a comparison needs once the model's
 * noise is in view: percentiles, a bootstrap interval for the difference in
 * overhead, and the pooled model noise floor.
 *
 * Pure functions over the arrivals a column recorded (`Arrival`: when this
 * page saw each event, marks included), so they are testable on their own.
 */
import { quantile } from 'harness-world-bench/stats';
import type { Arrival, TurnView } from './compare-model.ts';

export interface ModelCall {
  key?: string;
  pid: string;
  /** Server clock (the calling process's), ms. */
  reqT: number;
  firstT?: number;
  doneT?: number;
  /** Page clock, when each mark arrived. */
  reqAt: number;
  firstAt?: number;
  doneAt?: number;
}

export interface TurnFlags {
  /** A request of this turn ran on a new instance (its first request of that kind). */
  newInstance?: boolean;
  /** The live stream was re-opened during the turn (server-side resume or a browser reconnect). */
  reconnect?: number;
  /** The worst delivery lag above the session's floor, when over 1 s. */
  deliveryStallMs?: number;
  /** Live-stream writes that missed their deadline, and the slowest. */
  slowPutMs?: number;
  /** Run-ahead rewinds, or a second drive placing this turn. */
  rewind?: number;
  doubleDrive?: boolean;
  /** The slowest model call's time to first token, when over the tail threshold. */
  modelTailMs?: number;
  /**
   * The turn was recovered: a `recover*` or `release` mark, a drive that
   * started more than 5 s after the send, or a different drive finishing it
   * than the one that started it.
   */
  recovered?: boolean;
  /**
   * The first output reached this page this long after the model's first
   * token, when over 1 s: the lane's text stopped streaming (it arrives
   * when its write is durable), so its overhead includes the wait.
   */
  firstOutputTrailsMs?: number;
}

export interface ToolBreakdown {
  /** The next model call's own time to its visible output. */
  nextModelMs?: number;
  /** The tool itself (its own marks, else as the page saw it). */
  execMs?: number;
  /** Hop start → next model request less the tool, in the driving process: the harness's own time around the tool. */
  oursMs?: number;
  /**
   * What the harness (and durability) added to the whole model → tool →
   * model hop: next output − hop start − the tool − the next model call's
   * own time. The hop starts at the work that ended right before the tool
   * (the model call that asked for it, `model.done`, or the previous tool's
   * `tool.end`), a server mark on the page clock (`t + offset`), so the
   * writes a lane makes between the model and the tool (its response, the
   * tool's intent) count like the ones after it, and a `tool_start` that
   * reached the page late does not shorten the hop. Without marks: gap −
   * next model − tool.
   */
  overheadMs?: number;
  /** Which point the overhead was measured from. */
  from?: 'model.done' | 'tool.end' | 'tool_start';
}

export interface Breakdown {
  calls: ModelCall[];
  /** The first model call's own time, request → the output the page first showed. */
  modelMs?: number;
  /** First output − model time: everything that is not the model. */
  overheadMs?: number;
  /** The wait before the first output, split: inbound + pre-model, model, delivery (approximate page clock). */
  pre?: number;
  model?: number;
  delivery?: number;
  tools: ToolBreakdown[];
  /**
   * What the whole turn cost beyond the model and the tools: send → harness
   * idle, minus every model call's own duration (request → done) and every
   * tool's run time. The model's variance is taken out of the turn, so this
   * is the harness (and durability) per turn, comparable across columns.
   */
  turnOverheadMs?: number;
  /** Sum of the turn's model calls (request → done) and of its tools. */
  turnModelMs?: number;
  turnToolMs?: number;
  flags: TurnFlags;
  /** A flag that makes this turn's numbers unrepresentative of the lane (excluded from the summary). */
  flagged: boolean;
  /** Model calls the turn made (its `model.request` marks); undefined for a lane that reports none. */
  modelCalls?: number;
  /** Durable writes the turn acknowledged (`ack` marks), and their median latency. */
  writes?: number;
  ackP50?: number;
}

/** A drive that starts this long after the send is a recovery, not the turn's own start. */
export const LATE_DRIVE_MS = 5000;

export const STALL_MS = 1000;
export const MODEL_TAIL_MS = 2500;
/** A turn whose overhead is over this is a stall (the A/B counts them). */
export const OVERHEAD_STALL_MS = 500;

const isMark = (a: Arrival, name?: string) => a.e.type === 'mark' && (name === undefined || a.e.name === name);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * When a mark was written, on its own clock: `t`, unless the mark is
 * back-dated to when its work ended (`model.done` / `tool.end` carry
 * `commitMs`, written that much after `t`). A delivery stall is measured
 * from this, so a slow commit is not read as a slow stream.
 */
const writtenAt = (e: Arrival['e']) => Number(e.t) + (num(e.commitMs) ?? 0);

/**
 * The page-clock offset of a column's server marks: the smallest
 * `arrival − t` seen. It folds clock skew and the fastest delivery
 * together, so `t + offset` is the earliest the page could have seen a mark,
 * and `arrival − t − offset` is how late one was.
 */
export function markOffset(arrivals: Arrival[]): number | undefined {
  let min: number | undefined;
  for (const a of arrivals) {
    const t = num(a.e.t);
    if (t === undefined || a.e.type !== 'mark') continue;
    const lag = a.at - writtenAt(a.e);
    if (min === undefined || lag < min) min = lag;
  }
  return min;
}

/**
 * `markOffset` per writing process (`pid`): processes have their own clocks
 * (another instance, or this page for a mark it made itself), so each
 * maps onto the page clock with its own offset. Marks without a pid share
 * the `''` entry.
 */
export function markOffsets(arrivals: Arrival[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of arrivals) {
    const t = num(a.e.t);
    if (t === undefined || a.e.type !== 'mark') continue;
    const pid = String(a.e.pid ?? '');
    const lag = a.at - writtenAt(a.e);
    const min = out.get(pid);
    if (min === undefined || lag < min) out.set(pid, lag);
  }
  return out;
}

/** Model calls whose request arrived in [from, to]. */
export function modelCalls(arrivals: Arrival[], from: number, to: number): ModelCall[] {
  const calls: ModelCall[] = [];
  for (const a of arrivals) {
    if (a.at < from || a.at > to || a.e.type !== 'mark') continue;
    const pid = String(a.e.pid ?? '');
    const key = typeof a.e.key === 'string' ? a.e.key : undefined;
    const t = num(a.e.t);
    if (t === undefined) continue;
    if (a.e.name === 'model.request') {
      calls.push({ ...(key ? { key } : {}), pid, reqT: t, reqAt: a.at });
      continue;
    }
    const field = a.e.name === 'model.first_token' ? 'first' : a.e.name === 'model.done' ? 'done' : undefined;
    if (!field) continue;
    const c =
      calls.find((x) => x.pid === pid && key !== undefined && x.key === key && x[`${field}T`] === undefined) ??
      calls.find((x) => x.pid === pid && x[`${field}T`] === undefined);
    if (!c) continue;
    c[`${field}T`] = t;
    c[`${field}At`] = a.at;
  }
  return calls;
}

/** The call's own time to the output the page showed at `outAt`: to its first token, or to its end when that output only came after it (a tool call, fx's text). */
export function visibleModelMs(call: ModelCall | undefined, outAt: number): number | undefined {
  if (!call) return undefined;
  if (call.doneT !== undefined && call.doneAt !== undefined && call.doneAt <= outAt) return Math.round(call.doneT - call.reqT);
  if (call.firstT !== undefined) return Math.round(call.firstT - call.reqT);
  return undefined;
}

/**
 * The model call behind an output: the last requested before it that
 * reported back (a first token or an end). A request that never did (a step
 * a drill opened around the same call, marked without its stream) is not it.
 */
const callBefore = (calls: ModelCall[], at: number) => {
  const before = calls.filter((c) => c.reqAt <= at);
  return before.filter((c) => c.firstT !== undefined || c.doneT !== undefined).at(-1) ?? before.at(-1);
};

/**
 * One turn's breakdown. `drvs`: the drives that placed it (the tracker's),
 * for the double-drive flag. `offsets`: per-process clock offsets
 * (`markOffsets`, computed once per column); `offset` forces one for all.
 */
export function breakdown(view: TurnView, arrivals: Arrival[], opts: { offset?: number; offsets?: Map<string, number>; drvs?: string[] } = {}): Breakdown {
  const from = view.sentAt;
  const to = view.endAt ?? Number.POSITIVE_INFINITY;
  const offsets = opts.offset === undefined ? (opts.offsets ?? markOffsets(arrivals)) : undefined;
  // The page-clock offset for a process's marks.
  const offsetOf = (pid: unknown): number | undefined => opts.offset ?? offsets!.get(String(pid ?? ''));
  const calls = modelCalls(arrivals, from, to);
  const flags: TurnFlags = {};
  const out: Breakdown = { calls, tools: [], flags, flagged: false };

  const firstOut = arrivals.find((a) => a.at >= from && a.at <= to && (a.e.type === 'text' || a.e.type === 'tool_start'));
  if (firstOut) {
    const call = callBefore(calls, firstOut.at);
    const modelMs = visibleModelMs(call, firstOut.at);
    if (modelMs !== undefined) {
      out.modelMs = modelMs;
      if (view.ttft !== undefined) out.overheadMs = Math.round(view.ttft - modelMs);
      const offset = call ? offsetOf(call.pid) : undefined;
      if (call?.firstT !== undefined && offset !== undefined) {
        const trail = firstOut.at - (call.firstT + offset);
        if (trail > STALL_MS) flags.firstOutputTrailsMs = Math.round(trail);
      }
      if (call && offset !== undefined) {
        const reqPage = Math.max(from, Math.min(firstOut.at, call.reqT + offset));
        const modelEnd = Math.min(firstOut.at, reqPage + modelMs);
        out.pre = Math.round(reqPage - from);
        out.model = Math.round(modelEnd - reqPage);
        out.delivery = Math.round(firstOut.at - modelEnd);
      }
    }
  }

  // Tools: each gap is tool + harness + the next model call + delivery.
  const toolStarts = arrivals.filter((a) => a.at >= from && a.at <= to && a.e.type === 'tool_start');
  const toolMarks = arrivals.filter((a) => a.at >= from && a.at <= to && (isMark(a, 'tool.start') || isMark(a, 'tool.end')));
  // Where work ended (server clock, per process), for each hop's start.
  const workEnds = arrivals.filter((a) => a.at >= from && a.at <= to && (isMark(a, 'model.done') || isMark(a, 'tool.end')) && num(a.e.t) !== undefined);
  view.tools.forEach((tool, i) => {
    const tb: ToolBreakdown = {};
    const start = toolStarts[i];
    const ms = toolMarks.filter((m) => m.e.name === 'tool.start').at(i);
    const me = toolMarks.filter((m) => m.e.name === 'tool.end').at(i);
    if (ms && me && num(me.e.t) !== undefined && num(ms.e.t) !== undefined) tb.execMs = Math.round(Number(me.e.t) - Number(ms.e.t));
    else if (tool.toolMs !== undefined) tb.execMs = tool.toolMs;
    if (start && tool.gapMs !== undefined) {
      const nextOutAt = start.at + tool.gapMs;
      // The next model call: the first requested after the tool ended (server
      // clock, when the tool has a tool.end mark from the same process), else
      // the first whose request arrived inside the gap.
      const endT0 = me ? num(me.e.t) : undefined;
      const mePid = me ? String(me.e.pid ?? '') : undefined;
      const next =
        (endT0 !== undefined ? calls.find((c) => c.pid === mePid && c.reqT >= endT0 && c.reqAt <= nextOutAt) : undefined) ??
        calls.find((c) => c.reqAt >= start.at && c.reqAt <= nextOutAt);
      tb.nextModelMs = visibleModelMs(next, nextOutAt);
      // The hop's start: the last work that ended, in the tool's process, at
      // or before the tool started (the model call that asked for it, or the
      // tool before it in the same response).
      const startT = ms ? num(ms.e.t) : undefined;
      const msPid = ms ? String(ms.e.pid ?? '') : undefined;
      const hop =
        startT !== undefined
          ? workEnds.filter((w) => String(w.e.pid ?? '') === msPid && Number(w.e.t) <= startT && w !== me).at(-1)
          : undefined;
      const hopT = hop ? Number(hop.e.t) : undefined;
      const exec = tb.execMs ?? 0;
      if (next && hopT !== undefined && next.pid === msPid) tb.oursMs = Math.round(next.reqT - hopT - exec);
      if (tb.nextModelMs !== undefined) {
        const endT = me ? num(me.e.t) : undefined;
        const hopOffset = hop ? offsetOf(hop.e.pid) : undefined;
        const endOffset = me ? offsetOf(me.e.pid) : undefined;
        if (hopT !== undefined && hopOffset !== undefined) {
          // The whole hop, from the work before the tool, on the page clock:
          // every write in it counts, wherever the lane puts it, and it does
          // not depend on when the tool events were delivered.
          tb.overheadMs = Math.round(nextOutAt - (hopT + hopOffset) - exec - tb.nextModelMs);
          tb.from = hop!.e.name === 'model.done' ? 'model.done' : 'tool.end';
        } else if (endT !== undefined && endOffset !== undefined) {
          // No mark before the tool: from the tool's own end.
          tb.overheadMs = Math.round(nextOutAt - (endT + endOffset) - tb.nextModelMs);
          tb.from = 'tool.end';
        } else {
          tb.overheadMs = Math.round(tool.gapMs - tb.nextModelMs - (tb.execMs ?? 0));
          tb.from = 'tool_start';
        }
      }
    }
    out.tools.push(tb);
  });

  // Flags.
  let stall = 0;
  let resumes = 0;
  let slow = 0;
  let rewinds = 0;
  let recovered = false;
  let firstDrive: string | undefined;
  let lastIdleDrive: string | undefined;
  const acks: number[] = [];
  for (const a of arrivals) {
    if (a.at < from || a.at > to) continue;
    if (a.e.type === 'mark') {
      const name = String(a.e.name ?? '');
      if (name.startsWith('recover') || name === 'release') recovered = true;
      if (name === 'drive.start') {
        if (a.at - from > LATE_DRIVE_MS) recovered = true;
        if (typeof a.e.drv === 'string') firstDrive ??= a.e.drv;
      }
      if (name === 'idle' && typeof a.e.drv === 'string') lastIdleDrive = a.e.drv;
      if (name === 'ack' && num(a.e.lagMs) !== undefined) acks.push(Number(a.e.lagMs));
    }
    if (a.e.fresh === true) flags.newInstance = true;
    if ((a.e.type === 'stream' && a.e.name === 'resumed') || a.e.type === 'reconnect') resumes++;
    if (a.e.type === 'rewind' || isMark(a, 'rewind')) rewinds++;
    if (isMark(a, 'stream.put_slow')) slow = Math.max(slow, num(a.e.ms) ?? 0);
    // How late this mark reached the page, against the fastest its own
    // process managed, from when it was written (not a back-dated `t`).
    const offset = offsetOf(a.e.pid);
    if (offset !== undefined && num(a.e.t) !== undefined && a.e.type === 'mark') stall = Math.max(stall, a.at - writtenAt(a.e) - offset);
  }
  if (resumes) flags.reconnect = resumes;
  if (stall > STALL_MS) flags.deliveryStallMs = Math.round(stall);
  if (slow) flags.slowPutMs = Math.round(slow);
  if (rewinds) flags.rewind = rewinds;
  if ((opts.drvs?.length ?? 0) > 1) flags.doubleDrive = true;
  if (firstDrive !== undefined && lastIdleDrive !== undefined && firstDrive !== lastIdleDrive) recovered = true;
  if (recovered) flags.recovered = true;
  if (calls.length) out.modelCalls = calls.length;
  if (acks.length) {
    out.writes = acks.length;
    out.ackP50 = Math.round(quantile([...acks].sort((x, y) => x - y), 0.5));
  }
  const worst = Math.max(0, ...calls.map((c) => (c.firstT !== undefined ? c.firstT - c.reqT : 0)));
  if (worst > MODEL_TAIL_MS) flags.modelTailMs = Math.round(worst);
  if (view.turn !== undefined && calls.length > 0 && calls.every((c) => c.doneT !== undefined)) {
    const modelSum = calls.reduce((t, c) => t + (c.doneT! - c.reqT), 0);
    const toolSum = out.tools.reduce((t, x, i) => t + (x.execMs ?? view.tools[i]?.toolMs ?? 0), 0);
    out.turnModelMs = Math.round(modelSum);
    out.turnToolMs = Math.round(toolSum);
    out.turnOverheadMs = Math.round(view.turn - modelSum - toolSum);
  }
  out.flagged = !!(flags.newInstance || flags.reconnect || flags.deliveryStallMs || flags.slowPutMs || flags.rewind || flags.doubleDrive || flags.recovered);
  return out;
}

/**
 * The p-th percentile (0–100), interpolated: the same quantile /bench
 * reports (harness-world-bench's, numpy's default), so an even count's
 * median is the mean of the two middle values.
 */
export function percentile(xs: number[], p: number): number | undefined {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? quantile(s, p / 100) : undefined;
}

const med = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** A small seeded PRNG, so a bootstrap is repeatable. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export interface DiffInterval {
  /** median(a) − median(b). */
  ms: number;
  lo: number;
  hi: number;
  /** The 90% interval spans zero: the samples cannot tell the two apart. */
  withinNoise: boolean;
}

/** median(a) − median(b), with a 90% bootstrap interval. */
export function medianDiff(a: number[], b: number[], rounds = 1000, seed = 7): DiffInterval | undefined {
  if (!a.length || !b.length) return undefined;
  const r = rng(seed);
  const pick = (xs: number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!);
  const diffs: number[] = [];
  for (let i = 0; i < rounds; i++) diffs.push(med(pick(a)) - med(pick(b)));
  diffs.sort((x, y) => x - y);
  const lo = Math.round(quantile(diffs, 0.05));
  const hi = Math.round(quantile(diffs, 0.95));
  return { ms: Math.round(med(a) - med(b)), lo, hi, withinNoise: lo <= 0 && hi >= 0 };
}

/**
 * Paired by round: each round went to every column at the same instant, so
 * the difference that matters is per round. The median of the per-round
 * differences, with a 90% bootstrap interval over rounds (resampling the
 * pairs, so the model's swing from round to round, shared by both columns,
 * stays out of it).
 */
export function pairedDiff(diffs: number[], rounds = 1000, seed = 7): DiffInterval & { n: number } {
  const n = diffs.length;
  if (!n) return { ms: 0, lo: 0, hi: 0, withinNoise: true, n: 0 };
  const r = rng(seed);
  const meds: number[] = [];
  for (let i = 0; i < rounds; i++) meds.push(med(Array.from({ length: n }, () => diffs[Math.floor(r() * n)]!)));
  meds.sort((x, y) => x - y);
  const lo = Math.round(quantile(meds, 0.05));
  const hi = Math.round(quantile(meds, 0.95));
  return { ms: Math.round(med(diffs)), lo, hi, withinNoise: lo <= 0 && hi >= 0, n };
}

/** How often two single draws from `xs` differ by more than `ms` (the noise a single send compares against). */
export function pairDisagreement(xs: number[], ms = 1000): number | undefined {
  if (xs.length < 2) return undefined;
  let over = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      n++;
      if (Math.abs(xs[i]! - xs[j]!) > ms) over++;
    }
  }
  return over / n;
}
