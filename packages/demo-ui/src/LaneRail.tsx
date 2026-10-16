import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { laneLabel } from './copy.ts';
import { type CrashInfo, fmtDuration, fmtRecovery, isRailEffect, LANE_ORDER, litLanes, type StepTimes, unplaced } from './lanes.ts';
import { type ChaosSpec, type EffectView, type Lane, type Mode, movesLanes, type SessionView, type WorldName } from './view.ts';

/**
 * The session's log drawn as one line across three tracks. X is step order,
 * not time: each effect is one column. The line jogs at a handoff, breaks
 * with a red mark where a process was killed, runs dashed red while the
 * process is gone, and picks up again in the lane that redrove the step.
 */

const X0 = 20;
const MIN_COL = 24;
const MAX_COL = 56;
/** Room after the head for its halo and the armed ring (labels add their own). */
const TAIL = 48;
const CHAR_W = 6.2;

type Kind = 'model' | 'tool' | 'tick' | 'handoff' | 'crash' | 'gap' | 'waitCrash' | 'redrive' | 'pickup' | 'rest' | 'parked' | 'settled';

interface Col {
  id: string;
  x: number;
  lane: Lane;
  kind: Kind;
  effect?: EffectView;
  status?: string;
  attempt?: number;
  faded?: boolean;
  /** How the segment arriving at this column is drawn. */
  inStyle?: 'crash' | 'pickup' | 'parked';
  interrupted?: boolean;
  crash?: CrashInfo;
}

interface Label {
  x: number;
  lane: Lane;
  below: boolean;
  text: string;
  color: string;
}

/** A label before placement: crash and recovery labels carry a shorter form and are never cut. */
interface LabelDraft extends Omit<Label, 'text'> {
  texts: string[];
  keep: boolean;
}

const inFlightStatus = (status: string) => status === 'running' || status === 'pending';

const markKind = (name: string): Kind => (name === 'model' ? 'model' : name.startsWith('tool.') ? 'tool' : name === 'handoff' ? 'handoff' : 'tick');

function buildCols(view: SessionView, lanes: Map<string, Lane>, crashList: CrashInfo[]): Omit<Col, 'x'>[] {
  const cols: Omit<Col, 'x'>[] = [];
  const recovered = new Set(crashList.filter((c) => c.state !== 'waiting').map((c) => c.killedKey));
  const rail = view.effects.filter((e) => isRailEffect(e.name));
  rail.forEach((e, i) => {
    const lane = lanes.get(e.key) ?? 'browser';
    if (e.name === 'chaos') {
      const crash = crashList.find((c) => c.key === e.key);
      if (!crash) return;
      cols.push({ id: e.key, lane: crash.lane, kind: 'crash', effect: e, crash });
      // The process is gone: two columns of broken red line.
      cols.push({ id: `${e.key}:gap`, lane: crash.lane, kind: 'gap', inStyle: 'crash' });
      const k = view.effects.find((x) => x.key === crash.killedKey);
      if (crash.state === 'waiting' || !k) cols.push({ id: `${e.key}:wait`, lane: crash.lane, kind: 'waitCrash', inStyle: 'crash', crash });
      else
        cols.push({
          id: `${e.key}:redrive`,
          lane: lanes.get(k.key) ?? crash.lane,
          kind: 'redrive',
          effect: k,
          status: k.status,
          attempt: k.attempt,
          inStyle: 'crash',
          interrupted: !!k.error?.interrupted,
          crash,
        });
      return;
    }
    const kind = markKind(e.name);
    if (recovered.has(e.key)) cols.push({ id: e.key, lane, kind, effect: e, status: 'killed', attempt: 1, faded: true });
    else cols.push({ id: e.key, lane, kind, effect: e, status: e.status, attempt: e.attempt, interrupted: !!e.error?.interrupted });
    // A detached sandbox command: the VM runs it with nothing driving, drawn
    // dashed from the call to where its result was collected.
    if (e.park && !(e.settlement?.by === 'inline')) {
      if (e.settlement) cols.push({ id: `${e.key}:settled`, lane, kind: 'settled', effect: e, inStyle: 'parked' });
      else if (inFlightStatus(e.status)) cols.push({ id: `${e.key}:parked`, lane, kind: 'parked', effect: e, inStyle: 'parked' });
    }
    if (e.name === 'handoff' && e.status === 'completed' && i === rail.length - 1 && view.status === 'running') {
      const to = e.output?.to as Lane | undefined;
      if (!to) return;
      if (to !== 'browser' || unplaced(view).length) cols.push({ id: `${e.key}:pickup`, lane: to, kind: 'pickup', inStyle: 'pickup' });
      else cols.push({ id: `${e.key}:rest`, lane: to, kind: 'rest' });
    }
  });
  return cols;
}

interface Seg {
  d: string;
  lane: Lane | 'crash';
  dashed?: boolean;
  draw?: boolean;
  id: string;
}

function jog(x1: number, y1: number, x2: number, y2: number): string {
  if (y1 === y2) return `M${x1} ${y1}H${x2}`;
  const xm = (x1 + x2) / 2;
  const r = 4;
  const s = y2 > y1 ? 1 : -1;
  return `M${x1} ${y1}H${xm - r}Q${xm} ${y1} ${xm} ${y1 + s * r}V${y2 - s * r}Q${xm} ${y2} ${xm + r} ${y2}H${x2}`;
}

/** A handoff's turn, from the first bend on: the run before it stays in the source lane's color. */
function turn(x1: number, y1: number, x2: number, y2: number): { bendX: number; d: string } {
  const xm = (x1 + x2) / 2;
  const r = 4;
  const s = y2 > y1 ? 1 : -1;
  return { bendX: xm - r, d: `M${xm - r} ${y1}Q${xm} ${y1} ${xm} ${y1 + s * r}V${y2 - s * r}Q${xm} ${y2} ${xm + r} ${y2}H${x2}` };
}

function buildSegs(cols: Col[], ys: Record<Lane, number>): Seg[] {
  const segs: Seg[] = [];
  let run: { lane: Lane; x1: number; x2: number } | undefined;
  const flush = () => {
    if (run && run.x2 > run.x1) segs.push({ id: `run${run.x1}`, d: `M${run.x1} ${ys[run.lane]}H${run.x2}`, lane: run.lane });
    run = undefined;
  };
  cols.forEach((c, i) => {
    const prev = cols[i - 1];
    if (!prev) {
      run = { lane: c.lane, x1: c.x, x2: c.x };
      return;
    }
    if (c.inStyle) {
      flush();
      segs.push({
        id: `${c.id}:in`,
        d: jog(prev.x, ys[prev.lane], c.x, ys[c.lane]),
        lane: c.inStyle === 'crash' ? 'crash' : c.lane,
        dashed: true,
      });
      run = { lane: c.lane, x1: c.x, x2: c.x };
      return;
    }
    if (c.lane === prev.lane && run) {
      run.x2 = c.x;
      return;
    }
    // Each track carries only its own lane's color: the source run reaches
    // the first bend, the target's color takes over from there.
    const t = turn(prev.x, ys[prev.lane], c.x, ys[c.lane]);
    if (run) run.x2 = Math.max(run.x2, t.bendX);
    flush();
    segs.push({ id: `${c.id}:jog`, d: t.d, lane: c.lane, draw: true });
    run = { lane: c.lane, x1: c.x, x2: c.x };
  });
  flush();
  return segs;
}

/** Lane colors where a session moves between lanes; one lane is drawn in ink. Red only for a kill. */
let mono = false;
const stroke = (lane: Lane | 'crash') =>
  lane === 'crash' ? 'var(--crash)' : mono ? 'var(--ink)' : lane === 'browser' ? 'var(--lane-tab)' : lane === 'function' ? 'var(--lane-fn)' : 'var(--lane-box)';

/** The tool a handoff was for, out of the kernel's reason ("tool.x needs the y lane"). */
const handoffTool = (reason: unknown) => /^(?:tool\.)?([\w-]+) needs/.exec(String(reason ?? ''))?.[1];

function buildLabels(cols: Col[], col: number, single: boolean): Label[] {
  const drafts: LabelDraft[] = [];
  for (const c of cols) {
    if (c.kind === 'handoff' && c.effect?.status === 'completed') {
      const to = c.effect.output?.to as Lane | undefined;
      const tool = handoffTool(c.effect.output?.reason);
      // Past the jog's vertical, above the target track.
      if (to && to !== 'browser' && tool)
        drafts.push({ x: Math.round(c.x + col / 2 + 8), lane: to, below: false, texts: [tool], color: stroke(to), keep: false });
    } else if (c.kind === 'crash' && c.crash) {
      const s = Math.round(c.crash.afterMs / 100) / 10;
      const texts =
        c.crash.kind === 'drop-callback'
          ? ['report dropped', 'dropped']
          : c.crash.kind === 'sandbox-vm'
            ? [`VM stopped ${s} s in`, 'VM stopped']
            : c.crash.kind === 'relay-drop'
              ? [`relay dropped ${s} s in`, 'relay dropped']
              : c.crash.kind === 'sandbox-new-vm'
                ? ['new VM', 'new VM']
                : c.crash.kind === 'sandbox-zombie'
                  ? ['zombie VM', 'zombie']
                  : [`killed ${s} s in`, `killed ${s} s`];
      drafts.push({ x: c.x + 12, lane: c.lane, below: true, texts, color: 'var(--crash)', keep: true });
    } else if (c.kind === 'redrive' && c.crash?.recoveryMs !== undefined) {
      const t = fmtRecovery(c.crash.recoveryMs);
      // Clear of the running head's halo.
      drafts.push({ x: c.x + 14, lane: c.lane, below: single, texts: [`back after ${t}`, `back ${t}`], color: 'var(--graphite)', keep: true });
    } else if (c.kind === 'waitCrash') {
      const sandbox = c.crash?.parked;
      drafts.push({
        x: c.x + 14,
        lane: c.lane,
        below: single,
        texts: sandbox ? ['waiting for the sandbox result', 'waiting'] : ['waiting to be redelivered', 'waiting'],
        color: 'var(--graphite)',
        keep: true,
      });
    } else if (c.kind === 'parked') {
      drafts.push({ x: c.x + 12, lane: c.lane, below: true, texts: ['running detached in the VM', 'detached'], color: stroke(c.lane), keep: true });
    } else if (c.kind === 'settled' && c.effect?.settlement) {
      const by = c.effect.settlement.by;
      drafts.push({ x: c.x + 10, lane: c.lane, below: true, texts: [`reported by ${by}`, by], color: stroke(c.lane), keep: false });
    }
  }
  // Per line, left to right. Crash and recovery labels always show (the
  // short form if the long one doesn't fit, overflowing if need be); tool
  // names fit in what's left, cut or dropped.
  const out: Label[] = [];
  const ends = new Map<string, number>();
  drafts.sort((a, b) => a.x - b.x);
  drafts.forEach((l, i) => {
    const line = `${l.lane}:${l.below}`;
    const later = drafts.slice(i + 1).filter((n) => n.lane === l.lane && n.below === l.below);
    const next = (l.keep ? later.find((n) => n.keep) : later[0])?.x;
    // Nor across the line where it leaves this track (the jog's vertical).
    const leave = cols.findIndex((c, j) => j > 0 && c.x > l.x && c.lane !== l.lane && cols[j - 1]!.x <= c.x);
    const jogX = leave > 0 ? (cols[leave - 1]!.x + cols[leave]!.x) / 2 : Number.POSITIVE_INFINITY;
    const room = Math.min(next !== undefined ? next - l.x - 10 : Number.POSITIVE_INFINITY, jogX - l.x - 6);
    const chars = Math.floor(room / CHAR_W);
    if (l.x < (ends.get(line) ?? Number.NEGATIVE_INFINITY) + 6 && !l.keep) return;
    let text: string | undefined;
    if (l.keep) text = l.texts.find((t) => t.length <= chars) ?? l.texts.at(-1)!;
    else if (chars >= l.texts[0]!.length) text = l.texts[0];
    else if (chars >= 7) text = `${l.texts[0]!.slice(0, chars - 1)}…`;
    if (!text) return;
    out.push({ x: l.x, lane: l.lane, below: l.below, text, color: l.color });
    ends.set(line, l.x + text.length * CHAR_W);
  });
  return out;
}

function Mark({ c, y, pop }: { c: Col; y: number; pop: boolean }) {
  const color = stroke(c.lane);
  const running = c.status === 'running' || c.status === 'pending';
  // A tool that exited non-zero is a result, not a failure: only a model call that failed is red.
  const failed = c.status === 'failed' && !c.interrupted && c.effect?.name === 'model';
  const fill = failed ? 'var(--crash)' : color;
  const x = c.x;
  const shapeKind = c.kind === 'redrive' ? markKind(c.effect?.name ?? 'tick') : c.kind;
  let shape: React.ReactNode = null;
  if (c.kind === 'crash') {
    shape = (
      <g className={pop ? 'pop' : undefined}>
        <circle cx={x} cy={y} r={9} fill="var(--crash)" />
        <path d={`M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7`} stroke="#fff" strokeWidth={2} strokeLinecap="round" />
      </g>
    );
  } else if (c.kind === 'waitCrash') {
    shape = <circle cx={x} cy={y} r={4} fill="var(--wash)" stroke="var(--crash)" strokeWidth={1.5} />;
  } else if (c.kind === 'pickup' || c.kind === 'parked') {
    shape = <circle cx={x} cy={y} r={5} fill="var(--wash)" stroke={color} strokeWidth={2} strokeDasharray="2 2" />;
  } else if (c.kind === 'settled') {
    shape = <circle cx={x} cy={y} r={3} fill={color} />;
  } else if (c.kind === 'rest' || c.kind === 'handoff' || c.kind === 'gap') {
    shape = null;
  } else if (shapeKind === 'model') {
    shape = <circle cx={x} cy={y} r={5} fill={failed || c.interrupted ? fill : 'var(--paper)'} stroke={fill} strokeWidth={2} />;
  } else if (shapeKind === 'tool') {
    shape = <rect x={x - 5} y={y - 5} width={10} height={10} rx={1.5} fill={fill} />;
  } else {
    shape = <rect x={x - 1} y={y - 5} width={2} height={10} fill={fill} />;
  }
  return (
    <g opacity={c.faded ? 0.35 : 1}>
      {running && <circle className="halo" cx={x} cy={y} r={10} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.4} />}
      {(c.attempt ?? 1) >= 2 && !c.faded && <circle cx={x} cy={y} r={8} fill="none" stroke={fill} strokeWidth={1.5} />}
      {shape}
    </g>
  );
}

export interface LaneRailProps {
  mode: Mode;
  world?: WorldName;
  view?: SessionView;
  lanes: Map<string, Lane>;
  crashList: CrashInfo[];
  times: Map<string, StepTimes>;
  armed?: ChaosSpec;
  narrow: boolean;
  sessionKey: string;
  onSelect(effectKey: string): void;
}

export const LaneRail = memo(function LaneRail(props: LaneRailProps) {
  const { mode, world, view, lanes, crashList, times, armed, narrow, sessionKey, onSelect } = props;
  // Server and This Tab run in one lane: one line, no lane names. Hybrid and Sandbox draw all three.
  const single = !movesLanes(mode);
  mono = single;
  const singleY = 16;
  const ys: Record<Lane, number> = single
    ? { browser: singleY, function: singleY, sandbox: singleY }
    : narrow
      ? { browser: 20, function: 44, sandbox: 68 }
      : { browser: 28, function: 62, sandbox: 96 };
  const labelW = single ? 0 : narrow ? 72 : 104;
  const lit = litLanes(mode);

  const plot = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [plotW, setPlotW] = useState(600);
  const [fade, setFade] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string }>();

  const geoKey = view
    ? view.effects.map((e) => `${e.key}${e.status}${e.attempt}`).join() +
      crashList.map((c) => `${c.state}${c.recoveryMs}`).join() +
      view.status +
      unplaced(view).length
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: geometry depends only on the key
  const raw = useMemo(() => (view ? buildCols(view, lanes, crashList) : []), [geoKey, mode]);
  // Columns widen to fill the band (up to MAX_COL), and scroll past MIN_COL.
  const slots = raw.length + (armed ? 1 : 0);
  const col = slots ? Math.max(MIN_COL, Math.min(MAX_COL, (plotW - X0 - TAIL) / slots)) : MAX_COL;
  const cols = useMemo(() => raw.map((c, i) => ({ ...c, x: Math.round(X0 + i * col) })), [raw, col]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ys follows narrow
  const segs = useMemo(() => buildSegs(cols, ys), [cols, narrow]);
  const labels = useMemo(() => (narrow && !single ? [] : buildLabels(cols, col, single)), [cols, col, narrow, single]);
  // One lane: 32 px, and a line under it for the crash's words when there is one (48 px on a phone either way).
  const height = single ? (labels.length || narrow ? 48 : 32) : narrow ? 88 : 120;

  // Animate only what is new since the session was opened.
  const seen = useRef<{ session: string; ids: Set<string> }>({ session: '', ids: new Set() });
  const fresh = new Set<string>();
  if (seen.current.session !== sessionKey || !view) {
    seen.current = { session: view ? sessionKey : '', ids: new Set([...segs.map((s) => s.id), ...cols.map((c) => c.id)]) };
  } else {
    for (const s of segs) if (!seen.current.ids.has(s.id)) fresh.add(s.id);
    for (const c of cols) if (!seen.current.ids.has(c.id)) fresh.add(c.id);
  }
  useEffect(() => {
    for (const id of fresh) seen.current.ids.add(id);
  });

  const head = cols.at(-1);
  const armedX = armed ? (head ? Math.round(head.x + col) : X0) : undefined;
  const armedLane: Lane = head?.lane ?? (mode === 'server' ? 'function' : 'browser');
  const labelEnd = labels.reduce((m, l) => Math.max(m, l.x + l.text.length * CHAR_W + 16), 0);
  const contentW = Math.max((head?.x ?? X0) + (armed ? col : 0) + TAIL, labelEnd);

  // The plot mounts with the session's first step (nothing draws before it): measure it from then on.
  const drawn = !!head || !!armed;
  useLayoutEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPlotW(el.clientWidth));
    ro.observe(el);
    setPlotW(el.clientWidth);
    return () => ro.disconnect();
  }, [drawn]);
  useLayoutEffect(() => {
    follow.current = true;
    setTip(undefined);
  }, [sessionKey]);
  useLayoutEffect(() => {
    const el = plot.current;
    if (el && follow.current) el.scrollLeft = el.scrollWidth;
    if (el) setFade(el.scrollLeft > 0);
  }, [cols.length, armedX, plotW, contentW]);

  const width = Math.max(plotW, contentW);

  const describe = (c: Col) => {
    const e = c.effect;
    if (c.kind === 'crash' && c.crash) {
      const killed = c.crash.effectName.startsWith('tool.') ? c.crash.effectName.slice(5) : c.crash.effectName;
      const after =
        c.crash.state === 'waiting' ? 'waiting to be redelivered' : c.crash.recoveryMs !== undefined ? `back after ${fmtRecovery(c.crash.recoveryMs)}` : '';
      return [`Crash ${c.crash.afterMs / 1000}s into ${killed}`, laneLabel(c.lane, mode, world), after].filter(Boolean).join(', ');
    }
    if (!e) return c.kind === 'pickup' ? `Waiting for ${laneLabel(c.lane, mode, world)}` : 'Waiting for the queue';
    if (c.kind === 'parked') return `${e.name.slice(5)} running in the Sandbox VM, no function attached`;
    if (c.kind === 'settled') return `${e.name.slice(5)} result collected (${e.settlement?.by ?? 'collected'})`;
    const t = times.get(e.stepId);
    const dur = t?.started !== undefined ? fmtDuration((t.ended ?? Date.now()) - t.started) : '';
    const name = e.name.startsWith('tool.') ? e.name.slice(5) : e.name;
    const attempt = c.faded ? 1 : (c.attempt ?? e.attempt);
    return [name, laneLabel(c.lane, mode, world), `attempt ${attempt}`, dur].filter(Boolean).join(', ');
  };

  const markEls = cols.filter((c) => c.kind !== 'rest' && c.kind !== 'handoff' && c.kind !== 'gap');
  const focusSibling = (el: Element, dir: 1 | -1) => {
    const all = Array.from(el.parentElement?.querySelectorAll<SVGGElement>('.mark') ?? []);
    const i = all.indexOf(el as SVGGElement);
    all[i + dir]?.focus();
  };
  const showTip = (c: Col) => setTip({ x: c.x, y: ys[c.lane], text: describe(c) });

  // Tooltips stay inside the plot: never over the lane labels, flipped
  // inward near either edge, below the mark on the top track.
  const tipLeft = tip ? tip.x - (plot.current?.scrollLeft ?? 0) : 0;
  const align = tip ? (tipLeft < 120 ? 'start' : tipLeft > plotW - 120 ? 'end' : 'mid') : 'mid';

  // Nothing to draw until the session has a step.
  if (!head && !armed) return null;

  return (
    <div className="rail" data-single={single || undefined} aria-label={single ? 'Timeline: each step of the session' : 'Lane rail: where each step of the session ran'}>
      {!single && (
        <div className="rail-labels">
          {LANE_ORDER.map((l) => (
            <span key={l} data-lane={l} style={{ top: ys[l] }} {...(lit.has(l) ? {} : { 'data-off': '' })}>
              {laneLabel(l, mode, world, narrow)}
            </span>
          ))}
        </div>
      )}
      <div
        className="rail-plot"
        ref={plot}
        {...(fade ? { 'data-fade': '' } : {})}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          follow.current = el.scrollWidth - el.scrollLeft - el.clientWidth < 24;
          setFade(el.scrollLeft > 0);
          setTip(undefined);
        }}
      >
        <svg width={width} height={height} role="group">
          {(single ? LANE_ORDER.filter((l) => lit.has(l)) : LANE_ORDER).map((l) => (
            <line
              key={l}
              x1={0}
              x2={width}
              y1={ys[l]}
              y2={ys[l]}
              strokeWidth={1}
              {...(lit.has(l) ? { stroke: single ? 'var(--hairline)' : stroke(l), strokeOpacity: single ? 1 : 0.3 } : { stroke: 'var(--hairline)', strokeDasharray: '3 3' })}
            />
          ))}
          {segs.map((s) => (
            <path
              key={s.id}
              d={s.d}
              fill="none"
              stroke={stroke(s.lane)}
              strokeWidth={s.lane === 'crash' ? 2 : 2.5}
              strokeLinecap="round"
              {...(s.dashed ? { strokeDasharray: s.lane === 'crash' ? '3 5' : '4 4' } : {})}
              {...(s.draw && fresh.has(s.id) ? { pathLength: 1, className: 'draw' } : {})}
            />
          ))}
          {labels.map((l) => (
            <text key={`${l.x}:${l.lane}:${l.below}`} className="rail-label" x={l.x} y={ys[l.lane] + (l.below ? (single ? 24 : 21) : -10)} fill={l.color}>
              {l.text}
            </text>
          ))}
          {markEls.map((c) => (
            <g
              key={c.id}
              className="mark"
              role="button"
              tabIndex={0}
              aria-label={describe(c)}
              onMouseEnter={() => showTip(c)}
              onMouseLeave={() => setTip(undefined)}
              onFocus={() => showTip(c)}
              onBlur={() => setTip(undefined)}
              onClick={() => c.effect && onSelect(c.effect.key)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  if (c.effect) onSelect(c.effect.key);
                } else if (ev.key === 'ArrowRight') {
                  ev.preventDefault();
                  focusSibling(ev.currentTarget, 1);
                } else if (ev.key === 'ArrowLeft') {
                  ev.preventDefault();
                  focusSibling(ev.currentTarget, -1);
                } else if (ev.key === 'Escape') setTip(undefined);
              }}
            >
              <rect className="hit" x={c.x - 12} y={ys[c.lane] - 13} width={24} height={26} rx={4} />
              <Mark c={c} y={ys[c.lane]} pop={fresh.has(c.id)} />
            </g>
          ))}
          {armedX !== undefined && (
            <circle cx={armedX} cy={ys[armedLane]} r={7} fill="none" stroke="var(--crash)" strokeWidth={1.5} strokeDasharray="3 2.5">
              <title>Crash armed</title>
            </circle>
          )}
        </svg>
      </div>
      {tip && (
        <div
          className="tip float"
          data-align={align}
          {...(tip.y === ys.browser && !single ? { 'data-below': '' } : single ? { 'data-below': '' } : {})}
          style={{ left: labelW + tipLeft, top: tip.y }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
});
