/**
 * /compare's results, free of React: one record per finished round per
 * column, which rounds count, and the table the page shows (and copies, and
 * downloads). A round went to every column at the same instant, so columns
 * are compared round by round (`pairedDiff`), never pool against pool.
 */
import { quantile } from 'harness-world-bench/stats';
import { type Breakdown, pairedDiff } from './compare-breakdown.ts';
import type { TurnView } from './compare-model.ts';
import { fmtDelta, fmtSeconds } from './latency.ts';

export type FlagKey =
  | 'newInstance'
  | 'reconnect'
  | 'deliveryStall'
  | 'slowWrite'
  | 'rewind'
  | 'doubleDrive'
  | 'recovered'
  | 'differentWork'
  | 'modelTail'
  | 'firstOutputTrails'
  | 'slow';

/** The flags "Exclude cold starts, stalls and recoveries" leaves out: none of them is the lane's steady cost. */
export const EXCLUDING: readonly FlagKey[] = ['newInstance', 'reconnect', 'deliveryStall', 'slowWrite', 'rewind', 'doubleDrive', 'recovered', 'differentWork'];
/** Events that say something about reliability (Details: per 100 rounds). */
export const RELIABILITY: readonly FlagKey[] = ['recovered', 'reconnect', 'doubleDrive', 'rewind'];
/** A round whose overhead is over this, with no other flag, is flagged Slow (counted). */
export const SLOW_MS = 500;

/** One finished round in one column: what the table, the copy and the download are made of. */
export interface RoundRecord {
  /** Its place in the run: the same in every column (each round goes to all of them at once). */
  seq: number;
  prompt: string;
  warmup: boolean;
  firstOutput?: number;
  turn?: number;
  harnessIdle?: number;
  /** The first model call's own time to the output the page first showed. */
  model?: number;
  overhead?: number;
  turnOverhead?: number;
  toolOverhead?: number;
  turnModel?: number;
  turnTool?: number;
  /** Model calls (only for a lane that marks them) and tool calls. */
  modelCalls?: number;
  toolCalls: number;
  writes?: number;
  ackP50?: number;
  /** Each flag: a count, or how many ms (a stall, a slow write, a model tail, a slow overhead). */
  flags: Partial<Record<FlagKey, number>>;
  /** The reply's last line, to say whether every round replied the same. */
  reply?: string;
}

export const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? quantile(s, 0.5) : undefined;
};
export const p90 = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? quantile(s, 0.9) : undefined;
};

/** A finished turn as a record (undefined while it runs). */
export function recordOf(v: TurnView, o: { seq: number; prompt: string; reply?: string }): RoundRecord | undefined {
  if (v.turn === undefined) return undefined;
  const b: Breakdown | undefined = v.breakdown;
  const f = b?.flags ?? {};
  const flags: RoundRecord['flags'] = {};
  if (f.newInstance) flags.newInstance = 1;
  if (f.reconnect) flags.reconnect = f.reconnect;
  if (f.deliveryStallMs) flags.deliveryStall = f.deliveryStallMs;
  if (f.slowPutMs) flags.slowWrite = f.slowPutMs;
  if (f.rewind) flags.rewind = f.rewind;
  if (f.doubleDrive) flags.doubleDrive = 1;
  if (f.recovered) flags.recovered = 1;
  if (f.modelTailMs) flags.modelTail = f.modelTailMs;
  if (f.firstOutputTrailsMs) flags.firstOutputTrails = f.firstOutputTrailsMs;
  if (b?.overheadMs !== undefined && b.overheadMs > SLOW_MS && !b.flagged) flags.slow = b.overheadMs;
  const toolOverheads = (b?.tools ?? []).map((t) => t.overheadMs).filter((x): x is number => x !== undefined);
  const toolOverhead = median(toolOverheads);
  const put = <K extends keyof RoundRecord>(k: K, x: RoundRecord[K] | undefined) => (x === undefined ? {} : { [k]: x });
  return {
    seq: o.seq,
    prompt: o.prompt,
    warmup: !!v.warmup,
    ...put('firstOutput', v.ttft),
    turn: v.turn,
    ...put('harnessIdle', v.harnessIdle),
    ...put('model', b?.modelMs),
    ...put('overhead', b?.overheadMs),
    ...put('turnOverhead', b?.turnOverheadMs),
    ...put('toolOverhead', toolOverhead === undefined ? undefined : Math.round(toolOverhead)),
    ...put('turnModel', b?.turnModelMs),
    ...put('turnTool', b?.turnToolMs),
    ...put('modelCalls', b?.modelCalls),
    toolCalls: v.tools.length,
    ...put('writes', b?.writes),
    ...put('ackP50', b?.ackP50),
    flags,
    ...put('reply', o.reply),
  };
}

/**
 * Different work: a round where a column made a different number of tool
 * calls (or, where both mark them, model calls) than the baseline column in
 * the same round. Its time is not the same work's time.
 */
export function withDifferentWork(columns: RoundRecord[][], baseIndex: number): RoundRecord[][] {
  const base = new Map((columns[baseIndex] ?? []).map((r) => [r.seq, r]));
  return columns.map((rs, i) =>
    i === baseIndex
      ? rs
      : rs.map((r) => {
          const b = base.get(r.seq);
          const differs = !!b && (b.toolCalls !== r.toolCalls || (b.modelCalls !== undefined && r.modelCalls !== undefined && b.modelCalls !== r.modelCalls));
          if (!differs) return r.flags.differentWork ? { ...r, flags: { ...r.flags, differentWork: undefined } } : r;
          return { ...r, flags: { ...r.flags, differentWork: 1 } };
        })
  );
}

export const excluded = (r: RoundRecord, exclude: boolean) => r.warmup || (exclude && EXCLUDING.some((k) => !!r.flags[k]));

/** The rounds of one prompt that count. */
export const countedOf = (rs: RoundRecord[], prompt: string, exclude: boolean) => rs.filter((r) => r.prompt === prompt && !excluded(r, exclude));

/** Prompts in the order they were first run. */
export function promptsOf(columns: RoundRecord[][]): string[] {
  const out: string[] = [];
  for (const r of columns.flat().sort((a, b) => a.seq - b.seq)) if (!out.includes(r.prompt)) out.push(r.prompt);
  return out;
}

export type Metric = 'overhead' | 'turnOverhead' | 'toolOverhead';
export const METRICS: readonly Metric[] = ['overhead', 'turnOverhead', 'toolOverhead'];

/**
 * How much a cell says, by how many rounds it has (DB-P1-2): under 5 the
 * value only, with "run more"; 5 to 9 a Δ with no interval; 10 or more the
 * Δ, its interval and a verdict.
 */
export type Tier = 'few' | 'delta' | 'interval';
export const tierOf = (n: number): Tier => (n < 5 ? 'few' : n < 10 ? 'delta' : 'interval');

export type Cell =
  | { kind: 'empty' }
  | { kind: 'not-measured' }
  | { kind: 'value'; value: number; n: number; tier: Tier }
  | { kind: 'delta'; value?: number; ms: number; lo: number; hi: number; clear: boolean; n: number; tier: Tier };

export interface ColumnSummary {
  /** Rounds of this prompt that finished (warm-ups aside), and the ones counted. */
  finished: number;
  counted: number;
  /** Counted rounds that were flagged but kept (not excluding), by flag; and excluded rounds by flag. */
  flags: Partial<Record<FlagKey, number>>;
  cells: Record<Metric, Cell>;
}

const valuesOf = (rs: RoundRecord[], m: Metric) => rs.map((r) => r[m]).filter((x): x is number => x !== undefined);

/**
 * The table for one prompt: the baseline column's values, every other
 * column's paired Δ against it.
 */
export function summarize(columns: RoundRecord[][], baseIndex: number, prompt: string, exclude: boolean): ColumnSummary[] {
  const counted = columns.map((rs) => countedOf(rs, prompt, exclude));
  const base = counted[baseIndex] ?? [];
  return columns.map((rs, i) => {
    const mine = counted[i]!;
    const finished = rs.filter((r) => r.prompt === prompt && !r.warmup);
    const flags: ColumnSummary['flags'] = {};
    for (const r of finished) for (const [k, v] of Object.entries(r.flags)) if (v) flags[k as FlagKey] = (flags[k as FlagKey] ?? 0) + 1;
    const cells = {} as Record<Metric, Cell>;
    for (const m of METRICS) {
      const xs = valuesOf(mine, m);
      // A column that finished rounds but measured none of this: its harness reports no model timing.
      if (!xs.length) {
        cells[m] = mine.length && m !== 'toolOverhead' ? { kind: 'not-measured' } : { kind: 'empty' };
        continue;
      }
      const value = Math.round(median(xs)!);
      if (i === baseIndex) {
        cells[m] = { kind: 'value', value, n: xs.length, tier: tierOf(xs.length) };
        continue;
      }
      const byRound = new Map(base.map((r) => [r.seq, r[m]]));
      const diffs = mine.flatMap((r) => {
        const b = byRound.get(r.seq);
        return r[m] !== undefined && b !== undefined ? [r[m]! - b] : [];
      });
      if (!diffs.length) {
        cells[m] = { kind: 'value', value, n: xs.length, tier: tierOf(xs.length) };
        continue;
      }
      const d = pairedDiff(diffs);
      cells[m] = { kind: 'delta', value, ms: d.ms, lo: d.lo, hi: d.hi, clear: !d.withinNoise, n: d.n, tier: tierOf(d.n) };
    }
    return { finished: finished.length, counted: mine.length, flags, cells };
  });
}

/** The model's own time to first token over every counted round of the columns that report it: the noise floor. */
export function noiseFloor(columns: RoundRecord[][], prompt: string, exclude: boolean): { p50?: number; columns: number[] } {
  const contributing: number[] = [];
  const xs: number[] = [];
  columns.forEach((rs, i) => {
    const ms = countedOf(rs, prompt, exclude)
      .map((r) => r.model)
      .filter((x): x is number => x !== undefined);
    if (ms.length) contributing.push(i);
    xs.push(...ms);
  });
  const p = median(xs);
  return { ...(p !== undefined ? { p50: Math.round(p) } : {}), columns: contributing };
}

/** Overhead per turn against the round's place in the run: ms per round (least squares). Undefined under 5 rounds. */
export function slope(rs: RoundRecord[]): number | undefined {
  const pts = rs.filter((r) => r.turnOverhead !== undefined).map((r, i) => [i, r.turnOverhead!] as const);
  if (pts.length < 5) return undefined;
  const n = pts.length;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  if (!sxx) return undefined;
  return pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx;
}

/** Reliability events per 100 rounds (warm-ups aside). */
export function reliabilityPer100(rs: RoundRecord[]): number | undefined {
  const rounds = rs.filter((r) => !r.warmup);
  if (!rounds.length) return undefined;
  const events = rounds.reduce((n, r) => n + RELIABILITY.reduce((m, k) => m + (r.flags[k] ? 1 : 0), 0), 0);
  return (events / rounds.length) * 100;
}

/** What one cell says, in words: "112 ms", "+48 ms (+21 to +77 ms) clear", "−8 ms within noise", "n = 3, run more". */
export function cellText(c: Cell, harness?: string): { main: string; note?: string } {
  if (c.kind === 'empty') return { main: '' };
  if (c.kind === 'not-measured') return { main: `Not measured: ${harness ?? 'this harness'} reports no model timings yet` };
  if (c.kind === 'value') return c.tier === 'few' ? { main: fmtSeconds(c.value), note: `n = ${c.n}, run more` } : { main: fmtSeconds(c.value) };
  if (c.tier === 'few') return { main: fmtDelta(c.ms), note: `n = ${c.n}, run more` };
  if (c.tier === 'delta') return { main: fmtDelta(c.ms) };
  return c.clear ? { main: `${fmtDelta(c.ms)} (${fmtDelta(c.lo)} to ${fmtDelta(c.hi)})`, note: 'clear' } : { main: fmtDelta(c.ms), note: 'within noise' };
}

export const ROW_LABEL: Record<Metric, string> = {
  overhead: 'Overhead to first output',
  turnOverhead: 'Overhead per turn',
  toolOverhead: 'Overhead per tool call',
};

/** "18 of 20", "18 of 20 · 1 recovered". */
export function countedText(s: ColumnSummary): string {
  const recovered = s.flags.recovered ?? 0;
  return `${s.counted} of ${s.finished}${recovered ? ` · ${recovered} recovered` : ''}`;
}

export interface ExportColumn {
  letter: string;
  title: string;
  /** "Native", "Durable", ... (the column's level, or its title). */
  short: string;
  harness: string;
  model?: string;
}

/**
 * The results as Markdown: the table, then one line per column against the
 * baseline, then where it ran.
 */
export function resultsMarkdown(o: {
  heading: string;
  prompt: string;
  columns: ExportColumn[];
  summary: ColumnSummary[];
  baseIndex: number;
  meta: string;
}): string {
  const { columns, summary, baseIndex } = o;
  const head = `| ${o.heading} | ${columns.map((c, i) => `${c.letter} ${c.short}${i === baseIndex ? ' (baseline)' : ''}`).join(' | ')} |`;
  const rule = `| --- | ${columns.map(() => '---:').join(' | ')} |`;
  const rows = METRICS.map((m) => `| ${ROW_LABEL[m]} | ${summary.map((s, i) => {
    const t = cellText(s.cells[m], columns[i]!.harness);
    return t.note ? `${t.main} ${t.note}` : t.main || '–';
  }).join(' | ')} |`);
  rows.push(`| Rounds counted | ${summary.map(countedText).join(' | ')} |`);
  const base = columns[baseIndex]!;
  const lines = columns.flatMap((c, i) => {
    if (i === baseIndex) return [];
    const s = summary[i]!;
    const part = (m: Metric, what: string) => {
      const cell = s.cells[m];
      if (cell.kind !== 'delta') return undefined;
      if (cell.tier !== 'interval') return `${what} ${fmtDelta(cell.ms)}`;
      return cell.clear ? `${what} ${fmtDelta(cell.ms)} (90% interval ${fmtDelta(cell.lo)} to ${fmtDelta(cell.hi)})` : `${what} within noise`;
    };
    const parts = [part('turnOverhead', 'per turn'), part('overhead', 'first output'), part('toolOverhead', 'per tool call')].filter(Boolean);
    return [`- ${c.letter} ${c.title} vs ${base.letter} ${base.title} · ${o.prompt} · n = ${s.counted} of ${s.finished}: ${parts.length ? parts.join('; ') : 'nothing to compare yet'}.`];
  });
  return [head, rule, ...rows, '', ...lines, '', o.meta].join('\n');
}
