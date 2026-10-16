/**
 * The compare page's model, free of React: which columns run, and what one
 * turn looked like from this page (a timeline of wait / model / tool / gap
 * segments, each tool's gap, and deltas against the baseline column).
 *
 * Every number here is measured in this page's clock from when it sent the
 * message and when each event arrived, the same way for every column, so the
 * columns are comparable whatever runs behind them.
 */

import { DURABILITY_LABEL as PAGE_DURABILITY_LABEL, DURABILITY_TIP } from './copy.ts';
import type { HarnessOption } from './view.ts';

/**
 * A column is three choices, each narrowing the next:
 *
 *   harness     fx | Pi | eve | fx (libfx durable) | a process harness (Claude Code, Codex, ...)
 *   durability  Native | Wrapped | Durable | Strict   (built in: eve always Strict, fx (libfx durable) always Durable)
 *   runtime     Server | This Tab | Hybrid             (what that durability can run on)
 *
 * The URL values stay `none | wrapped | async | strict` and `function | tab |
 * hybrid`: only the words on screen follow the vocabulary (copy.ts).
 *
 * Every choice lives in the column, so any two configurations can sit side
 * by side (fx Strict vs Pi Strict, fx Native vs fx Durable, Pi in a Function vs
 * Pi in the tab, Claude Code vs Codex, ...).
 */
export type BuiltinHarness = 'fx' | 'pi' | 'eve' | 'fx-durable' | 'pi-durable';
/** A built-in harness, or the name of a process harness the server registered (`registerProcessHarnesses`). */
export type Harness = string;
/**
 * - `none`: the stock harness (plain Pi / fx), none of harness-world.
 * - `wrapped`: the harness-world harness with no World: its code, nothing persisted.
 * - `async`: every event written to the World, pipelined behind the harness (internally 'run-ahead').
 * - `strict`: every event write awaited before the harness goes on (internally 'on').
 */
export type Durability = 'none' | 'wrapped' | 'async' | 'strict';
export type Runtime = 'function' | 'tab' | 'hybrid';

export interface ColumnSpec {
  harness: Harness;
  durability: Durability;
  runtime: Runtime;
}

export const HARNESSES: BuiltinHarness[] = ['fx', 'pi', 'eve', 'fx-durable', 'pi-durable'];
export const DURABILITIES: Durability[] = ['none', 'wrapped', 'async', 'strict'];
export const RUNTIMES: Runtime[] = ['function', 'tab', 'hybrid'];

export const HARNESS_LABEL: Record<BuiltinHarness, string> = { fx: 'fx', pi: 'Pi', eve: 'eve', 'fx-durable': 'fx (libfx durable)', 'pi-durable': 'Pi (pi-durable)' };
/** The main page's durability for each of this page's levels (the same words, copy.ts). */
const PAGE_DURABILITY = { none: 'native', wrapped: 'off', async: 'run-ahead', strict: 'on' } as const satisfies Record<Durability, string>;
export const DURABILITY_LABEL: Record<Durability, string> = {
  none: PAGE_DURABILITY_LABEL.native,
  wrapped: PAGE_DURABILITY_LABEL.off,
  async: PAGE_DURABILITY_LABEL['run-ahead'],
  strict: PAGE_DURABILITY_LABEL.on,
};
/** The main page's "Runs in" words ("Function" is the lane, inside sentences). */
export const RUNTIME_LABEL: Record<Runtime, string> = { function: 'Server', tab: 'This Tab', hybrid: 'Hybrid' };

/** One line per durability level, for its option's tooltip. */
export const DURABILITY_HINT: Record<Durability, string> = {
  none: DURABILITY_TIP[PAGE_DURABILITY.none],
  wrapped: DURABILITY_TIP[PAGE_DURABILITY.wrapped],
  async: DURABILITY_TIP[PAGE_DURABILITY.async],
  strict: DURABILITY_TIP[PAGE_DURABILITY.strict],
};

/**
 * The durability levels a built-in harness offers. eve and fx (libfx durable)
 * have one each, built in. eve is Strict: Workflow makes every step durable
 * before the next. fx (libfx durable) is Async: libfx awaits only the prompt
 * and the intent of each tool that is not idempotent, and writes its other
 * records behind the model (libfx's README, "Durability").
 */
const BUILTIN_DURABILITIES: Record<BuiltinHarness, Durability[]> = {
  fx: DURABILITIES,
  pi: DURABILITIES,
  eve: ['strict'],
  'fx-durable': ['async'],
  // Pi 1.0's own durable Harness awaits every commit.
  'pi-durable': ['strict'],
};

/**
 * The harnesses that own their durability and run in their own Vercel
 * Functions: one durability, one runtime, and a column titled by name.
 */
const OWN_DURABILITY: readonly Harness[] = ['eve', 'fx-durable', 'pi-durable'];
export const ownsDurability = (harness: Harness) => OWN_DURABILITY.includes(harness);

/** Where each durability level can run. */
const RUNTIMES_BY_DURABILITY: Record<Durability, Runtime[]> = {
  none: ['function', 'tab'],
  wrapped: ['function', 'tab'],
  // The tab never owns a durable tail: Function only for now.
  async: ['function'],
  strict: ['function', 'tab', 'hybrid'],
};

/**
 * A process harness as a column can run it: the server's `HarnessOption`
 * in this page's terms (its durabilities and runs-in modes mapped to
 * durability levels and runtimes).
 */
export interface ProcessHarness {
  value: string;
  label: string;
  title?: string;
  durabilities: Durability[];
  runtimes: Runtime[];
  /** Why it cannot run on this deployment (a missing credential or binary). */
  disabledReason?: string;
}

/** The main page's durability names, in this page's terms. */
const FROM_PAGE_DURABILITY: Record<string, Durability> = { native: 'none', off: 'wrapped', 'run-ahead': 'async', on: 'strict' };
/** The main page's brains, as runtimes. */
const FROM_PAGE_MODE: Record<string, Runtime> = { server: 'function', tab: 'tab', hybrid: 'hybrid' };
/** What a process harness runs under when its option does not say (as on the main page): Durable On and Strict. */
const PROCESS_DURABILITIES: Durability[] = ['async', 'strict'];

const processHarnesses = new Map<string, ProcessHarness>();

/**
 * Make the columns know the server's process harnesses (`DemoClient.harnesses`).
 * Replaces the previous list. Ones with no durability or runtime a column
 * can use are left out.
 */
export function registerProcessHarnesses(options: HarnessOption[]): void {
  processHarnesses.clear();
  for (const o of options) {
    if (!o || typeof o.value !== 'string' || (HARNESSES as string[]).includes(o.value)) continue;
    const listed = o.durabilities?.map((d) => FROM_PAGE_DURABILITY[d]).filter((d): d is Durability => !!d);
    const durabilities = DURABILITIES.filter((d) => (listed ?? PROCESS_DURABILITIES).includes(d));
    const runtimes = RUNTIMES.filter((r) => (o.modes ?? []).some((m) => FROM_PAGE_MODE[m] === r));
    if (!durabilities.length || !durabilities.some((d) => RUNTIMES_BY_DURABILITY[d].some((r) => runtimes.includes(r)))) continue;
    processHarnesses.set(o.value, {
      value: o.value,
      label: o.label || o.value,
      ...(o.title ? { title: o.title } : {}),
      durabilities,
      runtimes,
      ...(o.disabledReason ? { disabledReason: o.disabledReason } : {}),
    });
  }
}

/** The registered process harnesses, in the server's order. */
export const listProcessHarnesses = (): ProcessHarness[] => [...processHarnesses.values()];
export const processHarness = (harness: Harness): ProcessHarness | undefined => processHarnesses.get(harness);
const isBuiltin = (harness: Harness): harness is BuiltinHarness => (HARNESSES as string[]).includes(harness);
/** A harness a column can run: built in, or registered. */
export const knownHarness = (harness: Harness) => isBuiltin(harness) || processHarnesses.has(harness);

/** What a column calls its harness. */
export const harnessLabel = (harness: Harness) => (isBuiltin(harness) ? HARNESS_LABEL[harness] : (processHarnesses.get(harness)?.label ?? harness));

/** The durability levels a harness offers. */
export function durabilitiesFor(harness: Harness): Durability[] {
  if (isBuiltin(harness)) return BUILTIN_DURABILITIES[harness];
  const p = processHarnesses.get(harness);
  if (!p) return ['strict'];
  // Only the levels with somewhere to run.
  return p.durabilities.filter((d) => RUNTIMES_BY_DURABILITY[d].some((r) => p.runtimes.includes(r)));
}

export function runtimesFor(harness: Harness, durability: Durability): Runtime[] {
  // eve runs in its own service's Functions (withEve), on Vercel Workflow;
  // fx (libfx durable) in the Function libfx's queue delivers to.
  if (ownsDurability(harness)) return ['function'];
  const p = processHarnesses.get(harness);
  if (p) return RUNTIMES_BY_DURABILITY[durability].filter((r) => p.runtimes.includes(r));
  return isBuiltin(harness) ? RUNTIMES_BY_DURABILITY[durability] : ['function'];
}

/** Why a runtime is not offered, for its disabled option's tooltip. */
export function runtimeUnavailable(spec: ColumnSpec, runtime: Runtime): string | undefined {
  if (runtimesFor(spec.harness, spec.durability).includes(runtime)) return undefined;
  if (spec.harness === 'eve') return 'eve runs in its own Vercel Functions only.';
  if (spec.harness === 'fx-durable') return 'libfx runs its durable sessions in Vercel Functions only.';
  if (spec.harness === 'pi-durable') return "Pi's own durable Harness runs on the server only.";
  if (!isBuiltin(spec.harness) && RUNTIMES_BY_DURABILITY[spec.durability].includes(runtime))
    return `${harnessLabel(spec.harness)} runs on the server only (in its own process, next to the Function).`;
  if (spec.durability === 'async') return 'Durable runs on the server only, for now: the tab never owns a durable tail.';
  return `Hybrid moves a turn between lanes, which needs the durable log: Strict only.`;
}

/** The nearest valid spec: a durability the harness has, a runtime that durability runs on. */
export function normalizeSpec(spec: ColumnSpec): ColumnSpec {
  const durabilities = durabilitiesFor(spec.harness);
  const durability = durabilities.includes(spec.durability) ? spec.durability : durabilities.at(-1)!;
  const runtimes = runtimesFor(spec.harness, durability);
  const runtime = runtimes.includes(spec.runtime) ? spec.runtime : runtimes[0]!;
  return { harness: spec.harness, durability, runtime };
}

/** The internal lane kind behind a spec (the loaders and `/bench` cells use these). */
export type LaneKind = 'native' | 'off' | 'run-ahead' | 'on' | 'eve' | 'fx-durable' | 'pi-durable';
export function laneKind(spec: ColumnSpec): LaneKind {
  if (spec.harness === 'eve') return 'eve';
  if (spec.harness === 'fx-durable') return 'fx-durable';
  if (spec.harness === 'pi-durable') return 'pi-durable';
  return ({ none: 'native', wrapped: 'off', async: 'run-ahead', strict: 'on' } as const)[spec.durability];
}

/** Short title: `fx · Strict · Function`, or `eve`. */
export function columnTitle(spec: ColumnSpec): string {
  if (ownsDurability(spec.harness)) return harnessLabel(spec.harness);
  return `${harnessLabel(spec.harness)} · ${DURABILITY_LABEL[spec.durability]} · ${RUNTIME_LABEL[spec.runtime]}`;
}

/** One sentence on what actually runs in the column. `local`: the server is this machine (`next dev`), not a Vercel Function. */
export function describeColumn(spec: ColumnSpec, local?: boolean): string {
  if (spec.harness === 'eve') return 'eve on Vercel Workflow: its own durability, every step durable. Model time is a lower bound, so its overhead reads low.';
  if (spec.harness === 'fx-durable') return "libfx's own durable sessions: libfx waits for the prompt and for each unsafe tool; the rest trails.";
  if (spec.harness === 'pi-durable') return "Pi 1.0's own durable Harness on the server's World: Pi awaits every commit.";
  const h = harnessLabel(spec.harness);
  const server = local === undefined ? 'in a Vercel Function (locally: on this server)' : local ? 'on this server' : 'in a Vercel Function';
  const where = spec.runtime === 'tab' ? 'in this tab' : spec.runtime === 'hybrid' ? 'moving between this tab and a Function' : server;
  if (!isBuiltin(spec.harness)) {
    const title = processHarnesses.get(spec.harness)?.title;
    const first = title?.split(/(?<=[.:])\s/)[0]?.replace(/[:.]$/, '');
    const writes = spec.durability === 'async' ? 'Writes trail the agent.' : 'Every write awaited.';
    return `${first ?? `${h} in a process of its own`}. ${writes}`;
  }
  if (spec.durability === 'none') return `${h} as shipped, ${where}. Nothing recorded.`;
  if (spec.durability === 'wrapped') return "durable-harness's code with no World. Nothing recorded.";
  if (spec.durability === 'async') return `${h} ${where}. Writes trail the agent.`;
  return `${h} ${where}. Every write awaited.`;
}

/**
 * /compare's columns for one main-page session (its "Measure on Compare"
 * link): its harness at each durability it has, Native first, on the
 * session's runtime where that durability runs there (else on the server).
 * pi-durable and fx-durable own their durability: Pi or fx Native next to
 * them. Undefined when fewer than two columns would be left.
 */
export function measureColumns(harness: Harness, mode: 'server' | 'tab' | 'hybrid'): string | undefined {
  if (harness === 'pi-durable' || harness === 'fx-durable') return `${harness === 'pi-durable' ? 'pi' : 'fx'}:none:function,${harness}`;
  if (!knownHarness(harness)) return undefined;
  const runtime: Runtime = mode === 'tab' ? 'tab' : mode === 'hybrid' ? 'hybrid' : 'function';
  const levels: Durability[] = ['none', 'async', 'strict'];
  const cols = levels
    .filter((d) => durabilitiesFor(harness).includes(d))
    .map((d) => ({ harness, durability: d, runtime: runtimesFor(harness, d).includes(runtime) ? runtime : ('function' as const) }));
  return cols.length >= MIN_COLUMNS ? serializeColumns(cols) : undefined;
}

/** What durability costs Pi: Native, Durable and Strict, all in a Function, Native the baseline. */
export const DEFAULT_COLUMNS: ColumnSpec[] = [
  { harness: 'pi', durability: 'none', runtime: 'function' },
  { harness: 'pi', durability: 'async', runtime: 'function' },
  { harness: 'pi', durability: 'strict', runtime: 'function' },
];

/** The setup row: one harness at the levels picked, on one runtime. It generates the columns. */
export interface Setup {
  harness: Harness;
  levels: Durability[];
  runtime: Runtime;
}

/** The ladder, in order: what the setup row offers and the columns follow. */
export const LADDER: Durability[] = ['none', 'async', 'strict', 'wrapped'];

/** The columns a setup makes: its harness at each level it offers, on its runtime where that level runs there (else the server). */
export function columnsFor(setup: Setup): ColumnSpec[] {
  const have = durabilitiesFor(setup.harness);
  return LADDER.filter((d) => setup.levels.includes(d) && have.includes(d)).map((d) => ({
    harness: setup.harness,
    durability: d,
    runtime: runtimesFor(setup.harness, d).includes(setup.runtime) ? setup.runtime : runtimesFor(setup.harness, d)[0]!,
  }));
}

/**
 * The setup behind these columns, if one made them: one harness that does
 * not own its durability, each level once, in ladder order. Otherwise the
 * page reads "Custom comparison".
 */
export function setupOf(cols: ColumnSpec[]): Setup | undefined {
  const h = cols[0]?.harness;
  if (!h || ownsDurability(h) || cols.some((c) => c.harness !== h)) return undefined;
  const levels = cols.map((c) => c.durability);
  if (new Set(levels).size !== levels.length) return undefined;
  const runtime = cols.find((c) => c.runtime !== 'function')?.runtime ?? 'function';
  const setup = { harness: h, levels, runtime };
  return serializeColumns(columnsFor(setup)) === serializeColumns(cols) ? setup : undefined;
}

/** Whether a harness has a Native baseline here (process harnesses and the AI SDK do not, yet). */
export const hasNative = (harness: Harness) => durabilitiesFor(harness).includes('none');
export const NO_NATIVE = 'No native baseline yet';

/** Named setups (Setups ▾). */
export const SETUPS: { id: string; label: string; detail: string; cols: string }[] = [
  { id: 'ladder', label: 'Durability ladder', detail: 'Pi Native, Durable and Strict, in a Function', cols: 'pi:none:function,pi:async:function,pi:strict:function' },
  { id: 'across', label: 'Across harnesses at Strict', detail: 'fx, Pi and eve, every write awaited', cols: 'fx:strict:function,pi:strict:function,eve' },
  { id: 'pi-own', label: 'Own durability vs kernel', detail: 'Pi Native, Pi Durable, Pi (pi-durable)', cols: 'pi:none:function,pi:async:function,pi-durable' },
  { id: 'fx-own', label: 'fx: kernel vs libfx durable', detail: 'fx Native, fx Durable, fx (libfx durable)', cols: 'fx:none:function,fx:async:function,fx-durable' },
  { id: 'tab', label: 'This Tab vs Server', detail: 'Pi Strict in this tab and in a Function', cols: 'pi:strict:tab,pi:strict:function' },
];

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;

const LEGACY_KIND: Record<string, Durability> = { native: 'none', off: 'wrapped', 'run-ahead': 'async', on: 'strict' };

/**
 * `fx:strict:function,pi:none:tab,eve,codex:async:function` ⇄ specs. Invalid
 * choices repair to the nearest valid one; a process harness this page does
 * not know (yet: `registerProcessHarnesses`) is left out. The old shape (`native,on:tab` with a page-wide
 * `harness`) still opens, with that harness in every column.
 */
export function parseColumns(s: string | null | undefined, legacyHarness?: string | null): ColumnSpec[] {
  if (!s) return DEFAULT_COLUMNS;
  const out: ColumnSpec[] = [];
  for (const part of s.split(',')) {
    const [a, b, c] = part.trim().split(':');
    if (a && knownHarness(a)) {
      const durability = (DURABILITIES as string[]).includes(b ?? '') ? (b as Durability) : 'strict';
      out.push(normalizeSpec({ harness: a, durability, runtime: (c ?? 'function') as Runtime }));
    } else if (a && a in LEGACY_KIND) {
      out.push(normalizeSpec({ harness: legacyHarness === 'fx' ? 'fx' : 'pi', durability: LEGACY_KIND[a]!, runtime: (b ?? 'function') as Runtime }));
    }
  }
  return out.length >= MIN_COLUMNS ? out.slice(0, MAX_COLUMNS) : DEFAULT_COLUMNS;
}

export const serializeColumns = (cols: ColumnSpec[]) => cols.map((c) => (ownsDurability(c.harness) ? c.harness : `${c.harness}:${c.durability}:${c.runtime}`)).join(',');

export const PRESETS = [
  { id: 'chat', label: 'Chat', text: 'Reply with one short sentence: what is 2+2?' },
  { id: 'write', label: 'One File Write', text: "Create a file named notes.txt containing exactly 'hi', then reply 'done'." },
  { id: 'command', label: 'One Command', text: "Run the shell command `echo hi`, then reply 'done'." },
  {
    id: 'three',
    label: 'Three Tools',
    text: "Do these one at a time: run the shell command `echo one`; create two.txt containing 'two'; run `cat two.txt`. Then reply 'done'.",
  },
  // The non-idempotent example tool (replay: 'never'), which every harness has: Durable waits for durability before it.
  { id: 'pay', label: 'Unsafe Payment', text: "Pay alice@example.com $5 with memo 'demo' using unsafe_make_payment, then reply 'paid'." },
] as const;

/** A prompt's name on screen: its preset's label, or the start of a custom one. */
export function promptLabel(text: string): string {
  const preset = PRESETS.find((p) => p.text === text);
  if (preset) return preset.label;
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? `Custom: ${one.slice(0, 39)}…` : `Custom: ${one}`;
}

/** A live event as this page saw it arrive. */
export interface Arrival {
  at: number;
  e: { type?: string; name?: string; [k: string]: unknown };
}

export type SegmentKind = 'wait' | 'model' | 'tool' | 'gap' | 'tail';

export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
}

export interface ToolGap {
  name: string;
  /** tool_start → tool_end: the tool itself. */
  toolMs?: number;
  /**
   * Model → tool → model, as the page sees it: the tool's start to the next
   * output of the model after it (the tool, whatever the harness adds around
   * it, and the next model call's first token).
   */
  gapMs?: number;
}

export interface TurnView {
  sentAt: number;
  /**
   * Durable lanes: send → the harness's own idle, before its last writes
   * were durable. The turn itself ends later, at the kernel's idle mark.
   */
  harnessIdle?: number;
  /** A warm-up turn (Repeat's first round), left out of the summary. */
  warmup?: boolean;
  /** The session refused the message as not ready (still starting) this long before accepting it: before `sentAt`, in no number. */
  notReadyMs?: number;
  /** Where the time went (compare-breakdown.ts), when computed. */
  breakdown?: import('./compare-breakdown.ts').Breakdown;
  /** When the turn ended (durable lanes: the kernel's idle mark; eve: turn.completed; None: its idle), or undefined while it runs. */
  endAt?: number;
  ttft?: number;
  turn?: number;
  segments: Segment[];
  tools: ToolGap[];
}

/**
 * Where a turn ends, the same point for every lane: when the column is done
 * with it. A durable lane's turn ends at the kernel's idle mark (`durableAt`:
 * everything the turn wrote is durable, and the column stops showing
 * "running"), the point eve's `turn.completed` marks; the harness's own,
 * earlier idle is kept as `harnessIdle`. A lane without that mark (None)
 * ends at its idle.
 */
export function turnEnd(t: { sentAt: number; idleAt?: number; durableAt?: number; durableEndAt?: number }): { endAt?: number; harnessIdle?: number } {
  if (t.durableAt === undefined && t.durableEndAt === undefined) return t.idleAt !== undefined ? { endAt: t.idleAt } : {};
  // The absolute end, unrounded: an output in the same chunk as the idle mark stays inside the turn.
  const endAt = t.durableEndAt ?? t.sentAt + t.durableAt!;
  const durable = endAt - t.sentAt;
  const harnessIdle = t.idleAt !== undefined ? Math.round(t.idleAt - t.sentAt) : undefined;
  return { endAt, ...(harnessIdle !== undefined && harnessIdle < Math.round(durable) ? { harnessIdle } : {}) };
}

const isOutput = (a: Arrival) => a.e.type === 'text' || a.e.type === 'tool_start';

/**
 * One turn's timeline from the events that arrived between its send and its
 * idle: `wait` until the first output, `model` while the model streams,
 * `tool` while a tool runs, `gap` from a tool's end to the model's next
 * output, `tail` from the last output to idle. `now` closes an open turn.
 */
export function turnView(sentAt: number, arrivals: Arrival[], endAt: number | undefined, now: number): TurnView {
  const segments: Segment[] = [];
  const tools: ToolGap[] = [];
  const stop = endAt ?? now;
  let cursor = sentAt;
  let state: SegmentKind = 'wait';
  let firstAt: number | undefined;
  let lastOutAt: number | undefined;
  const open: OpenTool[] = [];
  const push = (kind: SegmentKind, end: number) => {
    if (end > cursor) segments.push({ kind, start: cursor, end });
    cursor = Math.max(cursor, end);
  };
  for (const a of arrivals) {
    if (a.at < sentAt || a.at > stop) continue;
    const t = a.e.type;
    if (isOutput(a)) {
      firstAt ??= a.at;
      lastOutAt = a.at;
    }
    if (t === 'text') {
      if (state !== 'model') {
        push(state === 'tool' ? 'tool' : state, a.at);
        state = 'model';
      }
      closeGaps(open, tools, a.at);
    } else if (t === 'tool_start') {
      push(state === 'tool' ? 'tool' : state, a.at);
      closeGaps(open, tools, a.at);
      state = 'tool';
      tools.push({ name: String(a.e.name ?? 'tool') });
      open.push({ name: String(a.e.name ?? 'tool'), start: a.at, gi: tools.length - 1 });
    } else if (t === 'tool_end') {
      const o = open.find((x) => x.end === undefined && x.name === a.e.name) ?? open.find((x) => x.end === undefined);
      if (o) {
        o.end = a.at;
        tools[o.gi]!.toolMs = Math.round(a.at - o.start);
        // The model's next output can reach the page before the tool's end
        // does (a lane that reports the end once it is durable): the gap is
        // measured to that output either way.
        if (o.nextOut !== undefined) {
          tools[o.gi]!.gapMs = Math.round(o.nextOut - o.start);
          open.splice(open.indexOf(o), 1);
        }
      }
      if (state === 'tool' && open.every((x) => x.end !== undefined)) {
        push('tool', a.at);
        state = 'gap';
      }
    }
  }
  if (state === 'model' && endAt !== undefined && lastOutAt !== undefined) {
    // Streamed to its last output, then settled until idle.
    push('model', lastOutAt);
    push('tail', stop);
  } else push(state, stop);
  return {
    sentAt,
    ...(endAt !== undefined ? { endAt, turn: Math.round(endAt - sentAt) } : {}),
    ...(firstAt !== undefined ? { ttft: Math.round(firstAt - sentAt) } : {}),
    segments,
    tools,
  };
}

interface OpenTool {
  name: string;
  start: number;
  end?: number;
  /** The first output of the model after this tool started. */
  nextOut?: number;
  gi: number;
}

/** An output arrived: it is the next output for every open tool that has none yet; ended ones are measured and closed. */
function closeGaps(open: OpenTool[], tools: ToolGap[], at: number) {
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i]!;
    o.nextOut ??= at;
    if (o.end === undefined) continue;
    tools[o.gi]!.gapMs = Math.round(o.nextOut - o.start);
    open.splice(i, 1);
  }
}

export interface Delta {
  ms: number;
  /** Relative change; left out when the base is too small for one to mean anything. */
  pct?: number;
}

/**
 * A percentage of a base under this is noise (a 69 ms tool overhead going to
 * -91 ms read as "-232%"): the delta is shown in ms only.
 */
export const PCT_MIN_BASE_MS = 100;

/** `value` against the baseline column's `base`: +ms and +%. */
export function deltaOf(value: number | undefined, base: number | undefined): Delta | undefined {
  if (value === undefined || base === undefined) return undefined;
  const ms = Math.round(value - base);
  return base >= PCT_MIN_BASE_MS ? { ms, pct: Math.round(((value - base) / base) * 100) } : { ms };
}

export const fmtPct = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;

/** The median of per-turn deltas over the turns both columns finished. */
export function medianDelta(values: (number | undefined)[], bases: (number | undefined)[]): Delta | undefined {
  const diffs: number[] = [];
  const rel: number[] = [];
  for (let i = 0; i < Math.min(values.length, bases.length); i++) {
    const v = values[i];
    const b = bases[i];
    if (v === undefined || b === undefined) continue;
    diffs.push(v - b);
    if (b >= PCT_MIN_BASE_MS) rel.push((v - b) / b);
  }
  if (!diffs.length) return undefined;
  const mid = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  const ms = Math.round(mid(diffs));
  // A relative change only when most bases were big enough to carry one.
  return rel.length * 2 > diffs.length ? { ms, pct: Math.round(mid(rel) * 100) } : { ms };
}

/** Sum of each tool's gap in a turn (a turn with no tool has none). */
export function gapTotal(v: TurnView): number | undefined {
  const gaps = v.tools.map((t) => t.gapMs).filter((g): g is number => g !== undefined);
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) : undefined;
}
