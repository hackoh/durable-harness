import { batchTranscript } from 'harness-world-process/records';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CrashGlyph, preloaded } from './bits.tsx';
import { armedText, prearmedText } from './copy.ts';
import { type CrashInfo, cite, type LogIndex, modelText, modelToolCalls } from './lanes.ts';
import type { RowCtx } from './Rows.tsx';
import type { ChaosSpec, EffectView, Lane, LedgerEntry, SessionView } from './view.ts';

// The row components and the Markdown renderer arrive together, with the
// page, in their own chunk. They are held in a module variable rather than
// React.lazy: a lazy component suspends on its first render even when its
// chunk is already here, and the fallback it swaps out moves the rows. The
// page shows transcript rows once they're ready (`useRowsReady`).
const rows = preloaded(() => import('./Rows.tsx'));
export const useRowsReady = () => !!rows.use();

export type Item =
  | { t: 'user'; key: string; subId?: string; text: string; steer: boolean; queued: boolean; withdrawn: boolean; lane?: Lane }
  | { t: 'model'; key: string; effect: EffectView; lane?: Lane }
  /** `model`: the call that asked for it, when that call said nothing else (its row folds into this one). */
  | { t: 'tool'; key: string; effect: EffectView; lane?: Lane; crashed?: boolean; model?: EffectView }
  | { t: 'handoff'; key: string; effect: EffectView; from: Lane; to: Lane; reason: string }
  /** `told`: what the harness was told after it (a process harness's recovery note, folded in). */
  | { t: 'crash'; key: string; effect: EffectView; crash?: CrashInfo; told?: string }
  | { t: 'fs'; key: string; effect: EffectView; paths: string[]; lane?: Lane }
  | { t: 'checkpoint'; key: string; effect: EffectView; lane?: Lane }
  /** A process harness's assistant message (a `transcript` journal entry); `calls` are its tool effects' keys. */
  | { t: 'message'; key: string; effect: EffectView; text: string; calls: string[]; lane?: Lane }
  /** A message a process harness sent its model itself (a recovery note). */
  | { t: 'note'; key: string; effect: EffectView; text: string; synthetic: string; lane?: Lane };

/** The transcript is a fold of the log: one item per effect, plus the inbox. */
export function buildItems(view: SessionView, lanes: Map<string, Lane>, crashList: CrashInfo[]): Item[] {
  const subs = new Map(view.submissions.map((s) => [s.id, s]));
  const shown = new Set<string>();
  const items: Item[] = [];
  /** A process harness's session (harness-world-process: its turns end with a transcript entry). */
  const processSession = view.turnOpen !== undefined;
  const pushSub = (id: string, lane?: Lane) => {
    const s = subs.get(id);
    if (!s || shown.has(id) || s.kind === 'chaos' || s.kind === 'withdraw') return;
    shown.add(id);
    items.push({ t: 'user', key: `sub:${id}`, subId: id, text: s.text ?? '', steer: s.kind === 'steer', queued: false, withdrawn: false, lane });
  };
  for (const e of view.effects) {
    const lane = lanes.get(e.key);
    const placed: string[] = e.placed.length
      ? e.placed
      : e.name === 'turn' && Array.isArray(e.input?.submissions)
        ? e.input.submissions.map((s: any) => s.id)
        : [];
    for (const id of placed) pushSub(id, lane);
    if (!placed.length && e.name === 'steer' && typeof e.input?.text === 'string')
      items.push({ t: 'user', key: e.key, text: e.input.text, steer: true, queued: false, withdrawn: false, lane });
    if (!placed.length && e.name === 'model' && Array.isArray(e.input?.appended)) {
      e.input.appended.forEach((m: any, i: number) => {
        if (m?.role !== 'user') return;
        const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join('');
        items.push({ t: 'user', key: `${e.key}:u${i}`, text, steer: false, queued: false, withdrawn: false, lane });
      });
    }
    if (e.name === 'model') {
      // A process harness's model step (written only around a crash drill) has no text of
      // its own: its messages are journal entries, and its live text streams in a row of its own.
      if (!processSession) items.push({ t: 'model', key: e.key, effect: e, lane });
    } else if (e.name.startsWith('tool.')) items.push({ t: 'tool', key: e.key, effect: e, lane });
    else if (e.name === 'handoff') {
      const h = e.output ?? e.input ?? {};
      items.push({ t: 'handoff', key: e.key, effect: e, from: h.from, to: h.to, reason: String(h.reason ?? '') });
    } else if (e.name === 'chaos' && e.status === 'completed')
      items.push({ t: 'crash', key: e.key, effect: e, crash: crashList.find((c) => c.key === e.key) });
    else if (e.name === 'fs') items.push({ t: 'fs', key: e.key, effect: e, paths: e.input?.paths ?? Object.keys(e.output?.files ?? {}), lane });
    // A sandbox command's settlement carries the files it changed: shown like an fs step.
    else if (e.name === 'settle' && Array.isArray(e.input?.paths) && e.input.paths.length)
      items.push({ t: 'fs', key: e.key, effect: e, paths: e.input.paths, lane });
    else if (e.name === 'checkpoint') items.push({ t: 'checkpoint', key: e.key, effect: e, lane });
    // A process harness's normalized transcript (harness-world-process), one row per entry.
    else if (e.name === 'journal' && e.status === 'completed') {
      batchTranscript(e.input).forEach((entry, i) => {
        const key = `${e.key}:${i}`;
        if (entry.type !== 'message') return;
        if (entry.role === 'user') items.push({ t: 'note', key, effect: e, text: entry.text, synthetic: entry.synthetic, lane });
        else if (entry.text || !entry.toolCalls?.length)
          items.push({ t: 'message', key, effect: e, text: entry.text, calls: (entry.toolCalls ?? []).map((c) => `tool:${c.id}`), lane });
      });
    }
  }
  // A message comes before the tool calls it made, even when its batch
  // landed after a replay-safe call (only a never call waits for it).
  // Codex's rows stay in log order: its message after a call is its own.
  if (view.harness !== 'codex')
    for (const m of items.filter((i): i is Extract<Item, { t: 'message' }> => i.t === 'message' && i.calls.length > 0)) {
      const first = items.findIndex((i) => i.t === 'tool' && m.calls.includes(i.effect.key));
      const at = items.indexOf(m);
      if (first >= 0 && first < at) {
        items.splice(at, 1);
        items.splice(first, 0, m);
      }
    }
  for (const s of view.submissions) {
    if (shown.has(s.id) || s.kind === 'chaos' || s.kind === 'withdraw') continue;
    items.push({
      t: 'user',
      key: `sub:${s.id}`,
      subId: s.id,
      text: s.text ?? '',
      steer: s.kind === 'steer',
      queued: !s.placed && !s.withdrawn,
      withdrawn: s.withdrawn,
    });
  }
  // A process harness's notes to itself: the environment note stays in the
  // log; a recovery note folds into the crash row it follows (in its turn).
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.t !== 'note') continue;
    if (it.synthetic !== 'recovery') {
      items.splice(i, 1);
      continue;
    }
    for (let j = i - 1; j >= 0; j--) {
      const prev = items[j]!;
      if (prev.t === 'user' && !prev.steer) break;
      if (prev.t === 'crash') {
        if (!prev.told) items[j] = { ...prev, told: it.text };
        items.splice(i, 1);
        break;
      }
    }
  }
  // A model call that said nothing but which tools to call is the tool row's
  // ("model 0.9 s"), not a row of its own. Not a call a crash killed: its row
  // is where the crash row goes.
  const killed = new Set(crashList.map((c) => c.killedKey));
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.t !== 'model' || it.effect.status !== 'completed' || killed.has(it.effect.key)) continue;
    if (modelText(it.effect)) continue;
    const next = items[i + 1];
    if (next?.t !== 'tool' || next.model) continue;
    // Its tool calls, or (a view that keeps them apart: fx (libfx durable)) the tool row right after it.
    items[i + 1] = { ...next, model: it.effect };
    items.splice(i, 1);
  }
  // A crash reads as a child of the step it killed. A step it killed that
  // was run again shows the rerun: the crash row goes before it, so the
  // recovered output follows the crash. A step left interrupted: after it.
  for (const crash of items.filter((i): i is Extract<Item, { t: 'crash' }> => i.t === 'crash')) {
    const killedKey = crash.crash?.killedKey ?? crash.effect.output?.crashedDuring;
    const at = items.findIndex((i) => i.t !== 'user' && i.t !== 'crash' && i.effect.key === killedKey);
    if (at < 0) continue;
    const victim = items[at]!;
    if (victim.t === 'tool' && crash.crash?.state !== 'replayed') items[at] = { ...victim, crashed: true };
    items.splice(items.indexOf(crash), 1);
    const before = crash.crash?.state === 'replayed';
    let to = items.findIndex((i) => i.key === victim.key) + (before ? 0 : 1);
    if (!before) while (items[to]?.t === 'crash') to++;
    items.splice(to, 0, crash);
  }
  return items;
}

/**
 * The kind column's width, in the row's `ch`: the longest label it shows
 * (the harness's name, or a tool's such as `update_todos`), so none is cut
 * off, up to a limit past which a long tool name ellipsizes. A tool name is
 * set in 12 px Geist Mono, about 0.8 of the row's `ch` per character.
 */
export function kindWidth(harnessName: string, items: Item[]): number {
  let w = Math.max(5, harnessName.length);
  for (const i of items) if (i.t === 'tool') w = Math.max(w, Math.ceil((i.effect.name.length - 'tool.'.length) * 0.8));
  return Math.min(w, 18);
}

/** Log positions an item cites. */
export function itemIndexes(item: Item, index: LogIndex): number[] {
  if (item.t === 'user') return item.subId ? [index.byEvent.get(item.subId)].filter((n): n is number => n !== undefined) : [];
  return index.byStep.get(item.effect.stepId) ?? [];
}

/** Step ids an item's events belong to (for highlighting log rows). */
export function itemSteps(item: Item): string[] {
  return item.t === 'user' ? [] : [item.effect.stepId];
}

export interface TranscriptProps extends Omit<RowCtx, 'selectedKey' | 'tabKey' | 'ledger'> {
  /** The session's side effects (the unsafe tools' ledger): a payment row says how many times it ran. */
  ledger?: LedgerEntry[];
  items: Item[];
  /** A process harness is generating: show its live text in a row of its own (its model call is a step only around a crash drill, and has no text). */
  streaming?: boolean;
  armed?: ChaosSpec;
  /** The armed crash is for the next session started (none is open). */
  prearmed?: boolean;
  /** The armed crash has fired: the process is gone. */
  armedFired?: boolean;
  selectedKey?: string;
  /** Changes when the open session changes: reset scroll. */
  sessionKey: string;
  /** Bumped when the user moves the session on (send, steer, Try): follow the newest row again. */
  followKey: number;
  notes: { tone?: 'error'; text: ReactNode; key: string }[];
  empty?: ReactNode;
  scrollTo?: { key: string; n: number; pin?: boolean };
  /** Shown right after the row with this key (each finished turn's caption). */
  captions?: Map<string, ReactNode>;
}

const flash = (el: HTMLElement) => {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
};

/**
 * Scrolling, explicitly (`overflow-anchor: none`):
 * - follow: stick to the newest row while the reader is at the bottom;
 * - pin: when a crash resolves, hold its row (and the step it killed) near
 *   the top, however much the model writes after it, until the reader
 *   scrolls or moves the session on;
 * - otherwise stay put and count the rows that landed below the fold.
 */
export function Transcript(props: TranscriptProps) {
  const { items, armed, notes, empty, sessionKey, scrollTo, followKey } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pin = useRef<string | undefined>(undefined);
  const [unseen, setUnseen] = useState(0);
  const Rows = rows.use();

  const tabKey = items.some((i) => i.key === props.selectedKey) ? props.selectedKey : items[0]?.key;
  const ctx: RowCtx = {
    mode: props.mode,
    world: props.world,
    harnessName: props.harnessName,
    times: props.times,
    index: props.index,
    live: props.live,
    frozenAt: props.frozenAt,
    selectedKey: props.selectedKey,
    tabKey,
    onSelect: props.onSelect,
    onHover: props.onHover,
    onCite: props.onCite,
    onOpenFile: props.onOpenFile,
    ...(props.ledger ? { ledger: props.ledger } : {}),
  };

  /** Rows whose top is below the visible area. */
  const countBelow = useCallback(() => {
    const el = scroller.current;
    const box = inner.current;
    if (!el || !box) return;
    const bottom = el.scrollTop + el.clientHeight;
    let n = 0;
    for (let c = box.lastElementChild as HTMLElement | null; c; c = c.previousElementSibling as HTMLElement | null) {
      if (c.offsetTop < bottom - 4) break;
      if (c.dataset.key) n++;
    }
    setUnseen((prev) => (prev === n ? prev : n));
  }, []);

  const applyPin = useCallback(() => {
    const el = scroller.current;
    const key = pin.current;
    if (!el || !key) return false;
    const row = inner.current?.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(key)}"]`);
    if (!row) return false;
    // Show the killed step above the crash row when both fit.
    const prev = row.previousElementSibling as HTMLElement | null;
    const both = prev?.dataset.key ? row.offsetTop + row.offsetHeight - prev.offsetTop : Number.POSITIVE_INFINITY;
    const top = both <= el.clientHeight * 0.7 ? prev!.offsetTop : row.offsetTop;
    el.scrollTop = Math.max(0, top - 16);
    return true;
  }, []);

  const settle = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (pin.current) applyPin();
    else if (follow.current) el.scrollTop = el.scrollHeight;
    countBelow();
  }, [applyPin, countBelow]);

  const toLatest = useCallback(() => {
    pin.current = undefined;
    follow.current = true;
    settle();
  }, [settle]);

  useLayoutEffect(() => {
    pin.current = undefined;
    follow.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnseen(0);
  }, [sessionKey]);

  // The user moved the session on: show what happens next.
  const lastFollowKey = useRef(followKey);
  useLayoutEffect(() => {
    if (lastFollowKey.current === followKey) return;
    lastFollowKey.current = followKey;
    toLatest();
  }, [followKey, toLatest]);

  // New rows. A crash that just resolved pins its row; a crash or note that
  // just appeared is news, so it releases a pin and follows.
  const seen = useRef<{ session: string; crashes: Map<string, string>; notes: Set<string> }>({ session: '', crashes: new Map(), notes: new Set() });
  useLayoutEffect(() => {
    const prev = seen.current;
    const fresh = prev.session !== sessionKey;
    const crashes = new Map<string, string>();
    let resolved: string | undefined;
    let appeared = false;
    for (const it of items) {
      if (it.t !== 'crash') continue;
      const st = it.crash?.state ?? 'waiting';
      crashes.set(it.key, st);
      const was = prev.crashes.get(it.key);
      if (fresh) continue;
      if (was === undefined) appeared = true;
      if (st !== 'waiting' && was !== st) resolved = it.key;
    }
    const noteKeys = new Set(notes.map((n) => n.key));
    if (!fresh) for (const k of noteKeys) if (!prev.notes.has(k)) appeared = true;
    // Only once the session's first rows are in does "new" mean new.
    seen.current = { session: items.length || notes.length ? sessionKey : '', crashes, notes: noteKeys };
    if (resolved) {
      pin.current = resolved;
      follow.current = false;
      const row = inner.current?.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(resolved)}"]`);
      if (row) flash(row);
    } else if (appeared) {
      pin.current = undefined;
      follow.current = true;
    }
    settle();
  }, [items, armed, notes, sessionKey, settle]);

  // Streaming text, Markdown and expanded output change heights: keep the
  // pin (or the bottom) where it was.
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(el);
    return () => ro.disconnect();
  }, [settle]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = inner.current?.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(scrollTo.key)}"]`);
    if (!el) return;
    if (scrollTo.pin) {
      pin.current = scrollTo.key;
      follow.current = false;
      settle();
    } else {
      pin.current = undefined;
      el.scrollIntoView({ block: 'nearest' });
    }
    flash(el);
  }, [scrollTo, settle]);

  // Anything the reader does to scroll ends a pin.
  const release = () => {
    pin.current = undefined;
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (!pin.current) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    countBelow();
  };

  return (
    <div className="t-frame" style={{ position: 'relative', minHeight: 0, display: 'grid' }}>
      <div
        className="scroll transcript"
        // The kind column fits the longest label it shows: the harness's name, or a tool's (up to a limit).
        style={{ '--kind-w': `${kindWidth(props.harnessName, props.items)}ch` } as React.CSSProperties}
        ref={scroller}
        onScroll={onScroll}
        onWheel={release}
        onTouchMove={release}
        onPointerDown={(ev) => {
          // A drag on the scrollbar (the pointer lands outside the content).
          if (ev.target === ev.currentTarget) release();
        }}
        onKeyDown={(ev) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(ev.key)) release();
        }}
        role="log"
        aria-label="Transcript"
      >
        <div ref={inner}>
          {empty}
          {Rows &&
            items.map((item) => {
              const t = item.t === 'user' ? undefined : ctx.times.get(item.effect.stepId);
              const chip = props.captions?.get(item.key);
              const row = (
                <Rows.Row
                  key={item.key}
                  item={item}
                  ctx={ctx}
                  sig={Rows.rowSig(item)}
                  cites={cite(itemIndexes(item, ctx.index))}
                  started={t?.started}
                  ended={t?.ended}
                  selected={ctx.selectedKey === item.key}
                  tab={tabKey === item.key}
                  ledger={props.ledger?.length ?? 0}
                />
              );
              return chip ? [row, chip] : row;
            })}
          {Rows && props.streaming && <Rows.StreamRow ctx={ctx} />}
          {armed && (
            // The crash as one object: armed here, then the crash row (killed, then back).
            <div className="t-crash" data-state={props.armedFired ? 'fired' : 'armed'} data-key="crash:armed">
              <div className="t-kind">
                <CrashGlyph armed={!props.armedFired} />
              </div>
              <div className="t-content">
                <p className="crash-text">
                  {props.armedFired ? 'Crash fired: waiting for the process to come back.' : props.prearmed ? prearmedText(armed) : armedText(armed)}
                </p>
              </div>
            </div>
          )}
          {notes.map((n) => (
            <div key={n.key} className="note" data-tone={n.tone}>
              {n.text}
            </div>
          ))}
        </div>
      </div>
      {unseen > 0 && (
        <button type="button" className="btn float jump" onClick={toLatest}>
          Jump to Latest ({unseen})
        </button>
      )}
    </div>
  );
}
