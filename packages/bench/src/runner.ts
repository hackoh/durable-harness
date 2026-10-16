import type { BenchClient } from './recorder.ts';
import { SCENARIOS, type SampleResult, type ScenarioName } from './scenarios.ts';
import { bootstrapMedian, type Summary, summarizeSamples } from './stats.ts';

/**
 * Where a session runs and how durable it is.
 *
 * - `mode`: `server` (a Function drives it), `tab` (this tab drives it; with
 *   durability on its World is IndexedDB), `hybrid` (this tab drives it on
 *   the server's World, and it moves to a Function or a Sandbox for tools
 *   that need one).
 * - `durability`: `off` is the same harness with no World at all (the raw
 *   baseline, in the same place); `on` is today's awaited writes;
 *   `run-ahead` lets the harness run ahead of durability (Server mode only).
 */
export type Durability = 'off' | 'on' | 'run-ahead' | 'native';
export type Mode = 'server' | 'tab' | 'hybrid' | 'sandbox';
/**
 * `pi`, `fx`, `eve` (eve's own harness on Vercel Workflow, `apps/demo/agent`,
 * durable, in a Function), or a process harness the server registered
 * (`claude-code`, `codex`, `opencode`, `ai-sdk`): Server cells only.
 */
export type HarnessName = string;
/** The harnesses with a raw (no World) and a native lane. */
export const RAW_HARNESSES = ['pi', 'fx'];

export interface Cell {
  mode: Mode;
  durability: Durability;
  harness: HarnessName;
}

export const cellKey = (c: Cell) => `${c.mode}/${c.durability}/${c.harness}`;

/** The cell key that selects eve: one cell (`server/on/eve`), whatever harnesses the rest use. */
export const EVE_CELL_KEY = 'server/eve';

/**
 * `mode/durability` keys × harnesses, plus eve's own cell for `server/eve`.
 * A process harness has no Wrapped (no World) or Native lane and runs on the
 * server only: such a cell throws, or with `onSkip` is left out and named.
 */
export function parseCells(keys: string[], harnesses: string[], onSkip?: (message: string) => void): Cell[] {
  return keys.flatMap((k): Cell[] => {
    if (k === EVE_CELL_KEY) return [{ mode: 'server', durability: 'on', harness: 'eve' }];
    const [mode, durability] = k.split('/') as [Mode, Durability];
    return harnesses
      .filter((h) => h !== 'eve')
      .flatMap((harness): Cell[] => {
        const process = !RAW_HARNESSES.includes(harness);
        const why =
          process && durability === 'off'
            ? `${k}: Wrapped (no World) runs Pi and fx only; ${harness} has no raw lane.`
            : process && durability === 'native'
              ? `${k}: no native baseline for ${harness} yet (Native runs Pi and fx).`
              : process && mode !== 'server'
                ? `${k}: ${harness} runs on the server only.`
                : undefined;
        if (!why) return [{ mode, durability, harness }];
        if (!onSkip) throw new Error(why);
        onSkip(why);
        return [];
      });
  });
}
/** Where a cell's harness physically runs. */
export const placeOf = (mode: Mode): 'function' | 'tab' | 'vm' => (mode === 'server' ? 'function' : mode === 'sandbox' ? 'vm' : 'tab');

/** The raw baseline measured in the same place as `cell`. */
export function baselineOf(cell: Cell): Cell {
  // The Sandbox mode's baseline is the Function raw cell (the VM raw lane is a separate run, `--vm-raw`).
  const mode = cell.mode === 'hybrid' ? 'tab' : cell.mode === 'sandbox' ? 'server' : cell.mode;
  return { mode, durability: 'off', harness: cell.harness };
}

/** Which scenarios mean something in a cell. */
export function applies(scenario: ScenarioName, cell: Cell): boolean {
  // Native: plain Pi or fx in a Function, one turn per request: no steer of ours, no lanes, no crash drill.
  if (cell.durability === 'native') return cell.mode === 'server' && (scenario === 'chat' || scenario === 'chat-long' || scenario === 'tool-write' || scenario === 'tool-bash');
  // eve has no lanes to hand off between and no crash drill of ours.
  if (cell.harness === 'eve') return scenario === 'chat' || scenario === 'chat-long' || scenario === 'tool-write' || scenario === 'tool-bash' || scenario === 'steer';
  if (scenario.startsWith('handoff-')) return cell.mode === 'hybrid' && cell.durability !== 'off';
  // The Sandbox mode (home: the session's VM) only exists durable.
  if (cell.mode === 'sandbox') return cell.durability !== 'off' && scenario !== 'crash' && scenario !== 'crash-silent';
  if (scenario === 'crash' || scenario === 'crash-silent') return cell.mode === 'server' && cell.durability !== 'off';
  return true;
}

export interface CellResult {
  cell: Cell;
  scenario: ScenarioName;
  samples: (SampleResult & { error?: string; at: string })[];
  stats: Record<string, Summary>;
}

/** Budgets: over them is a warning in P0–P2. */
export interface Budget {
  scenario: ScenarioName;
  metric: string;
  /** Allowed excess over the same-place raw baseline's p50, ms. */
  overRaw?: number;
  /** Or an absolute ceiling for the p50, ms. */
  absolute?: number;
  label: string;
}

export const BUDGETS: Budget[] = [
  { scenario: 'chat', metric: 'ttft', overRaw: 150, label: 'TTFT ≤ raw + 150 ms' },
  { scenario: 'chat', metric: 'followupTtft', overRaw: 150, label: 'Follow-up TTFT ≤ raw + 150 ms' },
  { scenario: 'tool-write', metric: 'turn', overRaw: 200, label: 'Safe-tool turn ≤ raw + 200 ms' },
  { scenario: 'tool-bash', metric: 'turn', overRaw: 200, label: 'just-bash turn ≤ raw + 200 ms' },
  { scenario: 'tool-write', metric: 'toolGap', overRaw: 150, label: 'Model → tool → model gap ≈ raw' },
  { scenario: 'steer', metric: 'steerToEffect', overRaw: 150, label: 'Steer to effect ≤ raw + 150 ms' },
  { scenario: 'handoff-function', metric: 'tabToServer', absolute: 300, label: 'Tab → Function ≤ 300 ms' },
  { scenario: 'handoff-function', metric: 'serverToTab', absolute: 250, label: 'Function → tab ≤ 250 ms' },
  { scenario: 'handoff-sandbox', metric: 'tabToServer', absolute: 300, label: 'Tab → Sandbox ≤ 300 ms' },
  { scenario: 'handoff-sandbox', metric: 'serverToTab', absolute: 250, label: 'Sandbox → tab ≤ 250 ms' },
  { scenario: 'crash', metric: 'crashToDrive', absolute: 12_000, label: 'Crash drill (proof + self-wake) → recovered drive ≤ 12 s' },
  { scenario: 'crash-silent', metric: 'crashToDrive', absolute: 30_000, label: 'Silent crash (no record) → recovered drive ≤ 30 s' },
];

export interface Comparison {
  scenario: ScenarioName;
  metric: string;
  cell: Cell;
  p50: number;
  p90: number;
  raw?: { p50: number; p90: number };
  /** Which cell the delta is against: the native lane where it ran, else the raw one. */
  against?: string;
  /** p50 − raw p50. */
  delta?: number;
  /** 90% bootstrap interval of the median of per-round differences (rounds interleave the cells), or of the p50 for an absolute budget. */
  interval?: { lo: number; hi: number };
  budget?: string;
  pass?: boolean;
  /** `inconclusive`: the interval spans the budget, so the samples cannot say. */
  verdict?: 'ok' | 'over' | 'inconclusive';
}

export interface BenchMeta {
  startedAt: string;
  finishedAt?: string;
  origin?: string;
  deploymentId?: string | null;
  sha?: string | null;
  region?: string | null;
  world?: string;
  model?: string;
  /** Round trip to a warm Function from where the bench ran. */
  rttMs?: { p50: number; p90: number };
  runner: string;
  n: number;
  warmup: number;
  userAgent?: string;
  /** How the tab's model calls reached AI Gateway: `direct` (a minted token) or `proxy` (`/api/gateway`). */
  gateway?: 'direct' | 'proxy';
  /** Page flags the tab cells ran with (apps/browser flags.ts). */
  drive?: string;
  hints?: 'on' | 'off';
  relay?: string;
}

export interface BenchReport {
  meta: BenchMeta;
  results: CellResult[];
  comparisons: Comparison[];
}

export interface RunOptions {
  cells: Cell[];
  scenarios: ScenarioName[];
  n: number;
  /** Discarded samples per cell and scenario before measuring. Default 1. */
  warmup?: number;
  client(cell: Cell): Promise<BenchClient>;
  meta?: Partial<BenchMeta>;
  rttMs?: number;
  /** `chat`: idle time before the follow-up. Default 3000. */
  idleMs?: number;
  /** Pause between samples. Default 0. */
  pauseMs?: number;
  /** A throttled sample (HTTP 429) is taken again this many times, after `throttleWaitMs` (default 2, 60s). */
  throttleRetries?: number;
  throttleWaitMs?: number;
  onProgress?(p: { scenario: ScenarioName; cell: Cell; round: number; sample?: SampleResult & { error?: string }; warmup: boolean }): void;
  signal?: AbortSignal;
  log?(message: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const harnessFor = (cell: Cell) => (cell.mode === 'hybrid' || cell.mode === 'sandbox' ? (cell.harness === 'fx' ? 'hybrid-fx' : 'hybrid') : cell.harness);

/**
 * Run every applicable (scenario, cell) `n` times. Rounds interleave the
 * cells (round r runs sample r of every cell before sample r+1 of any), so a
 * slow minute at the model provider lands on all of them alike.
 */
export async function runBench(options: RunOptions): Promise<BenchReport> {
  const warmup = options.warmup ?? 1;
  const meta: BenchMeta = { startedAt: new Date().toISOString(), runner: 'unknown', n: options.n, warmup, ...options.meta };
  const clients = new Map<string, Promise<BenchClient>>();
  const clientFor = (cell: Cell) => {
    const k = cellKey(cell);
    if (!clients.has(k)) clients.set(k, options.client(cell));
    return clients.get(k)!;
  };
  const results: CellResult[] = [];
  for (const scenario of options.scenarios) {
    const cells = options.cells.filter((c) => applies(scenario, c) && (c.durability !== 'run-ahead' || c.mode === 'server'));
    const byCell = new Map(cells.map((c) => [cellKey(c), { cell: c, scenario, samples: [], stats: {} } as CellResult]));
    for (let round = -warmup; round < options.n; round++) {
      for (const cell of cells) {
        if (options.signal?.aborted) throw new Error('aborted');
        let sample: SampleResult & { error?: string } = { metrics: {} };
        for (let attempt = 0; ; attempt++) {
          try {
            const client = await clientFor(cell);
            sample = await SCENARIOS[scenario]({ client, harness: harnessFor(cell), ...(options.rttMs !== undefined ? { rttMs: options.rttMs } : {}), ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}), log: options.log });
            break;
          } catch (err) {
            const sessionId = (err as { sessionId?: string } | undefined)?.sessionId;
            sample = { metrics: {}, error: err instanceof Error ? err.message : String(err), ...(sessionId ? { sessionId } : {}) };
            // Rate limited (the World's backend throttles bursts of new
            // sessions): wait it out and take the sample again.
            if (attempt < (options.throttleRetries ?? 2) && /too many requests|\b429\b|throttl/i.test(sample.error!)) {
              options.log?.(`throttled; retrying in ${(options.throttleWaitMs ?? 60_000) / 1000}s`);
              await sleep(options.throttleWaitMs ?? 60_000);
              continue;
            }
            break;
          }
        }
        if (options.pauseMs) await sleep(options.pauseMs);
        options.onProgress?.({ scenario, cell, round, sample, warmup: round < 0 });
        if (round >= 0) byCell.get(cellKey(cell))!.samples.push({ ...sample, at: new Date().toISOString() });
      }
    }
    for (const r of byCell.values()) {
      r.stats = summarizeSamples(r.samples.filter((s) => !s.error));
      results.push(r);
    }
  }
  meta.finishedAt = new Date().toISOString();
  return { meta, results, comparisons: compare(results) };
}

/**
 * Every durable cell's metrics against the baseline in the same place (the
 * native lane where it ran, else the raw one), with a 90% bootstrap interval
 * of the per-round difference, and the budgets: ok when the interval is
 * within the budget, over when it is past it, inconclusive when it spans it.
 */
export function compare(results: CellResult[]): Comparison[] {
  const out: Comparison[] = [];
  const find = (scenario: ScenarioName, cell: Cell) =>
    results.find((r) => r.scenario === scenario && cellKey(r.cell) === cellKey(cell));
  for (const r of results) {
    if (r.cell.durability === 'off' || r.cell.durability === 'native') continue;
    const native = r.cell.mode === 'server' ? find(r.scenario, { mode: 'server', durability: 'native', harness: r.cell.harness }) : undefined;
    const base = native ?? find(r.scenario, baselineOf(r.cell));
    for (const [metric, s] of Object.entries(r.stats)) {
      const raw = base?.stats[metric];
      const budget = BUDGETS.find((b) => b.scenario === r.scenario && b.metric === metric);
      const delta = raw ? s.p50 - raw.p50 : undefined;
      const mine = r.samples.map((x) => (x.error ? undefined : x.metrics[metric]));
      const theirs = base?.samples.map((x) => (x.error ? undefined : x.metrics[metric])) ?? [];
      const diffs = mine.flatMap((v, i) => (v !== undefined && theirs[i] !== undefined && Number.isFinite(v) && Number.isFinite(theirs[i]!) ? [v - theirs[i]!] : []));
      const interval = budget?.absolute !== undefined ? bootstrapMedian(mine.filter((v): v is number => v !== undefined)) : diffs.length ? bootstrapMedian(diffs) : undefined;
      const limit = budget ? (budget.absolute ?? budget.overRaw) : undefined;
      const verdict = budget && interval && limit !== undefined ? (interval.hi <= limit ? 'ok' : interval.lo > limit ? 'over' : 'inconclusive') : undefined;
      const pass = budget
        ? budget.absolute !== undefined
          ? s.p50 <= budget.absolute
          : delta !== undefined && budget.overRaw !== undefined
            ? delta <= budget.overRaw
            : undefined
        : undefined;
      out.push({
        scenario: r.scenario,
        metric,
        cell: r.cell,
        p50: s.p50,
        p90: s.p90,
        ...(raw ? { raw: { p50: raw.p50, p90: raw.p90 }, delta, against: cellKey(base!.cell) } : {}),
        ...(interval ? { interval: { lo: Math.round(interval.lo), hi: Math.round(interval.hi) } } : {}),
        ...(budget ? { budget: budget.label } : {}),
        ...(pass !== undefined ? { pass } : {}),
        ...(verdict ? { verdict } : {}),
      });
    }
  }
  return out;
}

/** A plain-text report: one table per scenario, p50 / p90 per metric and cell, and the budgets. */
export function formatReport(report: BenchReport): string {
  const lines: string[] = [];
  const m = report.meta;
  lines.push(`durable-harness bench · ${m.startedAt}${m.deploymentId ? ` · ${m.deploymentId}` : ''}${m.sha ? ` · ${m.sha.slice(0, 7)}` : ''}`);
  lines.push(`runner ${m.runner} · model ${m.model ?? '?'} · world ${m.world ?? '?'} · n=${m.n} (+${m.warmup} warm-up)${m.rttMs ? ` · Function RTT p50 ${m.rttMs.p50} ms` : ''}${m.gateway ? ` · tab gateway ${m.gateway}` : ''}`);
  const scenarios = [...new Set(report.results.map((r) => r.scenario))];
  for (const scenario of scenarios) {
    const rows = report.results.filter((r) => r.scenario === scenario);
    const metrics = [...new Set(rows.flatMap((r) => Object.keys(r.stats)))];
    lines.push('', `## ${scenario}`);
    const header = ['cell', ...metrics];
    const table = rows.map((r) => {
      const errors = r.samples.filter((s) => s.error).length;
      return [
        `${cellKey(r.cell)}${errors ? ` (${errors} failed)` : ''}`,
        ...metrics.map((k) => {
          const st = r.stats[k];
          return st ? `${st.p50}/${st.p90}${st.missing ? ` (${st.missing} unmeasured)` : ''}` : '–';
        }),
      ];
    });
    lines.push(...renderTable([header, ...table]));
  }
  const budgets = report.comparisons.filter((c) => c.budget);
  if (budgets.length) {
    lines.push('', '## budgets (p50; warnings until P3)');
    lines.push(
      ...renderTable([
        ['scenario', 'metric', 'cell', 'p50', 'base p50', 'delta', '90% interval', 'budget', ''],
        ...budgets.map((c) => [
          c.scenario,
          c.metric,
          cellKey(c.cell),
          String(c.p50),
          c.raw ? `${c.raw.p50}${c.against ? ` (${c.against})` : ''}` : '–',
          c.delta !== undefined ? `${c.delta >= 0 ? '+' : ''}${c.delta}` : '–',
          c.interval ? `${c.interval.lo} to ${c.interval.hi}` : '–',
          c.budget!,
          c.verdict === 'inconclusive' ? 'inconclusive' : c.verdict === 'over' ? 'OVER' : c.verdict === 'ok' ? 'ok' : c.pass === undefined ? '?' : c.pass ? 'ok' : 'OVER',
        ]),
      ])
    );
  }
  lines.push('', 'cells show p50/p90 in ms.');
  return lines.join('\n');
}

function renderTable(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd());
}
