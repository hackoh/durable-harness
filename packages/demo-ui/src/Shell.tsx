import { lazy, type ReactElement, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAINS, defaultHandsFor, PI_DURABLE_HANDS, drillScope, filesOf, fitCrash, handsChoices, isHands, parseMode, pickHands, readAxes, scenariosFor, sessionHands } from './axes.ts';
import { Composer, ScenarioRow } from './Composer.tsx';
import { measureColumns, registerProcessHarnesses } from './compare-model.ts';
import { ControlBar, type CrashButtonState, harnessDisabledReason } from './ControlBar.tsx';
import {
  crashDisarmedText,
  crashUnrecorded,
  DELAYS,
  DURABILITY_LABEL,
  errorCopy,
  FX_JSPI_OFF,
  FX_ON_SERVER,
  GATEWAY_401,
  HANDS_FIXED,
  LOADING,
  LOST_NOW,
  lostServer,
  OWN_CRASH_SHARED,
  RUN_AHEAD_SERVER_ONLY,
  SESSION_FAILED,
  SESSION_MISSING,
  type Scenario,
  storedIn,
  tabCrashToast,
  UNREACHABLE,
} from './copy.ts';
import { EmptyState } from './EmptyState.tsx';
import { FX_DURABLE_ASYNC, FX_DURABLE_NATIVE, FX_DURABLE_OFF, FX_DURABLE_SERVER_ONLY, FX_DURABLE_TIP, FxDurablePanel } from './FxDurable.tsx';
import { PI_DURABLE_NATIVE, PI_DURABLE_OFF, PI_DURABLE_SERVER_ONLY, PI_DURABLE_STRICT, PI_DURABLE_TIP, PiDurablePanel } from './PiDurable.tsx';
import { preloaded } from './bits.tsx';
import { isNetworkError, messageOf, trackerFor, useClients, useMedia, useSession, useSessionList, useTracker } from './hooks.ts';
import { median, type TurnTiming } from './latency.ts';
import type { Highlight, Selection } from './Inspector.tsx';
import type { LaneRailProps } from './LaneRail.tsx';
import { crashes, inFlight, laneOf, logIndex, nowState, statusWord, stepTimes } from './lanes.ts';
import { type MineEntry, openingHarness, readMine, titleOf, withEntry, writeMine } from './registry.ts';
import { SessionHeader } from './SessionHeader.tsx';
import { TopBar } from './TopBar.tsx';
import { buildItems, type Item, itemSteps, Transcript, useRowsReady } from './Transcript.tsx';
import {
  agentRunsUrl,
  BUILTIN_HARNESSES,
  type ChaosSpec,
  type ClientLoaders,
  type CrashSettings,
  type DemoClient,
  type Durability,
  type Hands,
  type HarnessOption,
  harnessLabel,
  isFx,
  isHybrid,
  type Lane,
  type Mode,
  movesLanes,
  type RawClientLoaders,
  registerHarnessLabels,
  type SessionRow,
  undurable,
  type WorldName,
} from './view.ts';

const MODES: readonly Mode[] = BRAINS;

// The inspector loads alongside the first paint, in its own chunk: it keeps
// the page's first chunk inside its budget.
const loadInspector = () => import('./Inspector.tsx');
const Inspector = lazy(() => loadInspector().then((m) => ({ default: m.Inspector })));
// The session list too: its rows wait on a fetch anyway.
const loadList = () => import('./SessionList.tsx');
const SessionList = lazy(() => loadList().then((m) => ({ default: m.SessionList })));
if (typeof window !== 'undefined') {
  void loadInspector();
  void loadList();
}

// The rail too; nothing is drawn until it is here (it shows only once the session has a step).
const rail = preloaded(() => import('./LaneRail.tsx'));
function LaneRail(props: LaneRailProps) {
  const m = rail.use();
  return m ? <m.LaneRail {...props} /> : null;
}

/** A harness name (`HarnessOption.value`). */
type Harness = string;
/**
 * The harnesses that own their durability (Server mode only, one durability
 * each): each is its own client under its own key, with its own notes.
 */
interface OwnHarness {
  key: string;
  option: HarnessOption;
  /** The one durability it runs under: Strict (`on`) or Durable (`run-ahead`). */
  durability: 'on' | 'run-ahead';
  serverOnly: Record<Mode, string>;
  off: string;
  native: string;
  /** Why it has no other durability (the other of Strict and Durable). */
  only: string;
  /** The session header's writes readout. */
  writes: (commits: number | undefined) => { lead: string; figures: string[] };
  /** What the event log's rows are, after where they are stored. */
  stored: string;
  Panel: () => ReactElement;
}
const OWN_HARNESSES: Record<string, OwnHarness> = {
  'pi-durable': {
    key: 'server:pi-durable',
    option: {
      value: 'pi-durable',
      label: 'Pi (pi-durable)',
      title: PI_DURABLE_TIP,
      modes: ['server'],
      durabilities: ['on'],
      // Every hands but Virtual + machine, until pi-durable's machine hands are designed (docs/workspaces.md §8).
      ...PI_DURABLE_HANDS,
    },
    durability: 'on',
    serverOnly: PI_DURABLE_SERVER_ONLY,
    off: PI_DURABLE_OFF,
    native: PI_DURABLE_NATIVE,
    only: PI_DURABLE_STRICT,
    writes: (commits) => ({ lead: 'Pi awaits every commit', figures: commits !== undefined ? [`${commits} commits`] : [] }),
    stored: "One row per Pi commit (a hook_received on the session's journal hook); step_ labels mark the commit that started or finished a model call or tool.",
    Panel: PiDurablePanel,
  },
  'fx-durable': {
    key: 'server:fx-durable',
    option: { value: 'fx-durable', label: 'fx (libfx durable)', title: FX_DURABLE_TIP, modes: ['server'], durabilities: ['run-ahead'], crashes: ['tool', 'model', 'any'] },
    // libfx awaits only the prompt and an unsafe tool's intent: the rest trails, which is Durable.
    durability: 'run-ahead',
    serverOnly: FX_DURABLE_SERVER_ONLY,
    off: FX_DURABLE_OFF,
    native: FX_DURABLE_NATIVE,
    only: FX_DURABLE_ASYNC,
    writes: () => ({ lead: 'libfx awaits the prompt and unsafe tools', figures: [] }),
    stored: "One row per line of the session's stream (session.stream); a run of text is one model row. Times are when this page received each line.",
    Panel: FxDurablePanel,
  },
};
// The session list and header name these sessions by their full label ("Pi (pi-durable)", not "Pi").
registerHarnessLabels(Object.values(OWN_HARNESSES).map((o) => o.option));

/** What a process harness runs under when its option does not say. */
const PROCESS_DURABILITIES: Durability[] = ['on', 'run-ahead'];

const store = {
  get(key: string): string | undefined {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string | undefined) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  },
};

const DURABILITIES: Durability[] = ['off', 'on', 'run-ahead', 'native'];

function readUrl() {
  const q = new URLSearchParams(location.search);
  // `?mode=` is the brain (`sandbox`, the retired brain-in-VM mode, is Server with Sandbox hands), `?hands=` the hands.
  const axes = readAxes(q);
  const durability = q.get('durability') as Durability | null;
  return {
    mode: axes.brain,
    hands: axes.hands,
    harness: q.get('harness') ?? undefined,
    // `off` (Wrapped) is reachable from the URL only.
    durability: durability && DURABILITIES.includes(durability) ? durability : undefined,
    session: q.get('session') ?? undefined,
    event: q.get('event') ?? undefined,
  };
}

const boot = (() => {
  const url =
    typeof location === 'undefined'
      ? { mode: undefined, hands: undefined, harness: undefined, durability: undefined, session: undefined, event: undefined }
      : readUrl();
  // The URL, then what this browser chose last (an old `sandbox` is Server now), then Server.
  const mode: Mode = url.mode ?? parseMode(store.get('how:mode')).brain ?? 'server';
  let crash: { mode: Mode; at: number } | undefined;
  try {
    const raw = sessionStorage.getItem('how:crash');
    if (raw) {
      sessionStorage.removeItem('how:crash');
      crash = JSON.parse(raw);
    }
  } catch {}
  return { url, mode, crash };
})();

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export interface ShellProps {
  loaders: ClientLoaders;
  /** Wrapped (durability off: the same harnesses with no World), where a mode has it. */
  rawLoaders?: RawClientLoaders;
  /** Native: plain Pi / fx without durable-harness, where a mode has it. */
  nativeLoaders?: RawClientLoaders;
  /** "Pi (pi-durable)": Pi 1.0's own durable Harness on the server's World (Server mode). */
  piDurableLoader?: () => Promise<{ createClient(): Promise<DemoClient> }>;
  /** "fx (libfx durable)": libfx's own durable sessions on the server's World (Server mode). */
  fxDurableLoader?: () => Promise<{ createClient(): Promise<DemoClient> }>;
  /** The model the server runs (the Event Log drawer's header). */
  model: string;
}

/** Run-ahead needs a Node process to own the pipeline: Server only, for now. */
const runAheadModes: Mode[] = ['server'];
/** The durability a mode opens with: Durable where it runs, else Strict. */
const defaultDurability = (m: Mode): Durability => (runAheadModes.includes(m) ? 'run-ahead' : 'on');
const storedDurability = (m: Mode): Durability | undefined => {
  const d = store.get(`how:durability:${m}`) as Durability | undefined;
  // Wrapped (`off`) is reachable from the URL only: a stored one opens as the mode's default.
  return d && DURABILITIES.includes(d) && d !== 'off' ? d : undefined;
};
/** Clients are keyed by mode, plus `:off`, `:run-ahead` or `:native`. */
const keyOf = (m: Mode, d: Durability) => (d === 'on' ? m : `${m}:${d}`);

/**
 * A first visit, before the server has listed its process harnesses: Claude
 * Code's option, so a link that names it (`harness=claude-code`) opens on
 * Claude Code instead of showing Pi for a moment (a reload in that moment
 * kept Pi in the URL). The server's list replaces it; where Claude Code
 * can't run, the page falls back to Pi.
 */
const PROVISIONAL_PROCESS: HarnessOption = {
  value: 'claude-code',
  label: 'Claude Code',
  title: 'Claude Code (the Claude Agent SDK and its claude CLI) in a process of its own.',
  modes: ['server'],
  process: true,
};

/** The server's process harnesses as last seen, so the picker can show them before the server answers. */
function storedProcessHarnesses(): HarnessOption[] {
  try {
    const list = JSON.parse(store.get('how:process-harnesses') ?? '[]') as HarnessOption[];
    const valid = Array.isArray(list) ? list.filter((h) => h && typeof h.value === 'string' && Array.isArray(h.modes)) : [];
    const known = valid.length ? valid : [PROVISIONAL_PROCESS];
    registerHarnessLabels(known);
    registerProcessHarnesses(known);
    return known;
  } catch {
    return [PROVISIONAL_PROCESS];
  }
}

/** A finished turn's own numbers: from the send to its first output, and to its durable end. */
const fmtCaption = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
function turnCaptions(items: Item[], turns: TurnTiming[]): Map<string, ReactNode> {
  const out = new Map<string, ReactNode>();
  for (const t of turns) {
    const turn = t.durableAt ?? t.turn;
    if (t.kind !== 'prompt' || !t.subId || t.firstOutput === undefined || turn === undefined) continue;
    const at = items.findIndex((i) => i.t === 'user' && i.subId === t.subId);
    if (at < 0) continue;
    let end = items.findIndex((i, n) => n > at && i.t === 'user' && !i.steer);
    if (end < 0) end = items.length;
    let anchor: Item | undefined;
    let crashed = false;
    for (let n = at + 1; n < end; n++) {
      const it = items[n]!;
      if (it.t === 'crash') crashed = true;
      if (it.t === 'model' || it.t === 'message') anchor = it;
    }
    // A crashed turn's numbers are not the session's: its crash row says "back after".
    if (!anchor || crashed) continue;
    out.set(
      anchor.key,
      <div className="t-caption num" key={`caption:${t.subId}`}>
        First output {fmtCaption(t.firstOutput)} · turn {fmtCaption(turn)}
      </div>
    );
  }
  return out;
}

export function Shell({ loaders, rawLoaders, nativeLoaders, piDurableLoader, fxDurableLoader, model }: ShellProps) {
  const ownLoaders = useMemo<Record<string, () => Promise<{ createClient(): Promise<DemoClient> }>>>(
    () => ({ ...(piDurableLoader ? { 'pi-durable': piDurableLoader } : {}), ...(fxDurableLoader ? { 'fx-durable': fxDurableLoader } : {}) }),
    [piDurableLoader, fxDurableLoader]
  );
  // The server's process harnesses (Claude Code, Codex, ...): from its registry, via the server client.
  // The same list names a harness that owns its durability when it cannot run on this server, with the reason.
  const [processHarnesses, setProcessHarnesses] = useState<HarnessOption[]>(storedProcessHarnesses);
  /** Why the server says the harness `h`, one that owns its durability, cannot run there, if it does. */
  const ownDisabled = (h: Harness): string | undefined => (h in OWN_HARNESSES ? processHarnesses.find((p) => p.value === h)?.disabledReason : undefined);
  /** The harness `h` if it owns its durability, this page has its client, and the server can run it. */
  const ownOf = (h: Harness | undefined): OwnHarness | undefined => (h && ownLoaders[h] && !ownDisabled(h) ? OWN_HARNESSES[h] : undefined);
  const extraLoaders = useMemo(() => Object.fromEntries(Object.entries(ownLoaders).map(([h, load]) => [OWN_HARNESSES[h]!.key, load])), [ownLoaders]);
  const { entries, load, prefetch } = useClients(loaders, rawLoaders, nativeLoaders, extraLoaders);
  const available = (m: Mode, d: Durability) =>
    d === 'off' ? !!rawLoaders?.[m] : d === 'native' ? !!nativeLoaders?.[m] : d === 'run-ahead' ? runAheadModes.includes(m) : true;
  const resolve = (m: Mode, d: Durability | undefined): Durability => (d && available(m, d) ? d : defaultDurability(m));
  const [mode, setMode] = useState<Mode>(boot.mode);
  const [durabilities, setDurabilities] = useState<Record<Mode, Durability | undefined>>(() => {
    const d = { server: storedDurability('server'), tab: storedDurability('tab'), hybrid: storedDurability('hybrid') };
    if (boot.url.durability) d[boot.mode] = boot.url.durability;
    return d;
  });
  const [harnesses, setHarnesses] = useState<Record<Mode, Harness>>(() => {
    const h = (m: Mode): Harness => {
      const v = openingHarness(m === boot.mode ? boot.url.harness : undefined, store.get(`how:harness:${m}`));
      return v in OWN_HARNESSES && !(m === 'server' && ownLoaders[v]) ? 'pi' : v;
    };
    return { server: h('server'), tab: h('tab'), hybrid: h('hybrid') };
  });
  // The hands a new session gets, per brain and harness (`how:hands:<brain>:<harness>`); the URL's for the page's first.
  const [handsWanted, setHandsWanted] = useState<Record<string, Hands | undefined>>(() =>
    boot.url.hands ? { [`${boot.mode}:${boot.url.harness ?? ''}`]: boot.url.hands, [`${boot.mode}:*`]: boot.url.hands } : {}
  );
  const wantedHands = (m: Mode, h: Harness): Hands | undefined => {
    const stored = store.get(`how:hands:${m}:${h}`);
    return handsWanted[`${m}:${h}`] ?? handsWanted[`${m}:*`] ?? (isHands(stored) ? stored : undefined);
  };
  const harnessList = useMemo(
    () => [
      ...BUILTIN_HARNESSES,
      ...Object.keys(ownLoaders).map((h) => {
        const reason = ownDisabled(h);
        return reason ? { ...OWN_HARNESSES[h]!.option, disabledReason: reason } : OWN_HARNESSES[h]!.option;
      }),
      ...processHarnesses.filter((h) => !(h.value in OWN_HARNESSES)),
    ],
    // biome-ignore lint/correctness/useExhaustiveDependencies: ownDisabled reads processHarnesses
    [ownLoaders, processHarnesses]
  );
  // pi-durable and fx-durable are their own clients (the harness owns durability): one durability each, Server only.
  const own = mode === 'server' ? ownOf(harnesses.server) : undefined;
  // A process harness runs durably only (its child's session lives in the log).
  const processChoice = processHarnesses.find((h) => h.value === harnesses[mode] && h.modes.includes(mode) && !h.disabledReason);
  const processDurabilities = processChoice ? (processChoice.durabilities ?? PROCESS_DURABILITIES) : undefined;
  const resolved = resolve(mode, durabilities[mode]);
  const durability: Durability = own
    ? own.durability
    : processDurabilities && !processDurabilities.includes(resolved)
      ? processDurabilities.includes(defaultDurability(mode))
        ? defaultDurability(mode)
        : processDurabilities[0]!
      : resolved;
  const clientKey = own ? own.key : keyOf(mode, durability);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key the page opened with
  const bootKey = useMemo(() => clientKey, []);
  const [sessions, setSessions] = useState<Partial<Record<string, string>>>(() => ({
    [bootKey]: boot.url.session ?? (boot.url.mode ? undefined : store.get(`how:last:${bootKey}`)),
  }));
  // The crash settings survive the reload a tab-lane crash causes.
  const [crashSpec, setCrashSpecState] = useState<CrashSettings>(() => {
    try {
      const saved = JSON.parse(store.get('how:crash-spec') ?? 'null');
      if (saved && ['tool', 'model', 'any', 'sandbox'].includes(saved.at) && DELAYS.some((d) => d.value === saved.afterMs))
        return { kind: 'process', at: saved.at, afterMs: saved.afterMs, ...(saved.kind ? { kind: saved.kind } : {}), ...(saved.silent === true ? { silent: true } : {}) };
    } catch {}
    return { at: 'tool', kind: 'process', afterMs: 1500 };
  });
  const setCrashSpec = useCallback((spec: CrashSettings) => {
    setCrashSpecState(spec);
    store.set('how:crash-spec', JSON.stringify(spec));
  }, []);
  const [prearm, setPrearm] = useState<ChaosSpec>();
  const [arming, setArming] = useState(false);
  const [selection, setSelection] = useState<Selection | undefined>(() =>
    boot.url.event ? { kind: 'event', eventId: boot.url.event } : undefined
  );
  const [hover, setHover] = useState<Highlight>();
  const [inspectorTab, setInspectorTab] = useState<'log' | 'files'>('log');
  // The drawers: Sessions (left) closed by default; the Event Log (right) as this browser left it.
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // A phone does not reopen the drawer on load: there it covers the session.
  const [logOpen, setLogOpenState] = useState(
    () => !!boot.url.event || (store.get('how:inspector') === '1' && !globalThis.matchMedia?.('(max-width: 639px)').matches)
  );
  const setLogOpen = useCallback((open: boolean | ((o: boolean) => boolean)) => {
    setLogOpenState((prev) => {
      const next = typeof open === 'function' ? open(prev) : open;
      store.set('how:inspector', next ? '1' : '0');
      return next;
    });
  }, []);
  const [showAll, setShowAll] = useState(false);
  const [mine, setMine] = useState<MineEntry[]>(() => (typeof window === 'undefined' ? [] : readMine()));
  const [sending, setSending] = useState(false);
  // A message on its way: shown as a queued row at once, until the log has it. A crash
  // drill's message waits for the crash to be armed and for the drill Function to take it.
  const [outgoing, setOutgoing] = useState<{ id: string; text: string; steer: boolean; known: number }>();
  // One draft per mode and session, so text never follows you somewhere else.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string>();
  const [blocked, setBlocked] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [announce, setAnnounce] = useState('');
  const [scrollTo, setScrollTo] = useState<{ key: string; n: number; pin?: boolean }>();
  // Bumped by anything the user does to move the session on (send, steer,
  // an example): the transcript follows the newest row again.
  const [followKey, setFollowKey] = useState(0);
  const [worldHint, setWorldHint] = useState<WorldName | undefined>(() => store.get('how:world') as WorldName | undefined);
  const started = useRef(new Set<string>());
  const composer = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<() => number>(() => 3000);
  /** The Event Log drawer pushes the transcript from here up; below, it overlays. */
  const wide = useMedia('(min-width: 1280px)');
  const compact = useMedia('(max-width: 639px)');

  useEffect(() => load(clientKey), [clientKey, load]);
  const entry = entries[clientKey];
  const client = entry?.status === 'ready' ? entry.client : undefined;
  const world: WorldName | undefined = mode === 'tab' ? 'browser' : (client?.worldName ?? worldHint);
  useEffect(() => {
    if (client && client.worldName !== 'browser') {
      setWorldHint(client.worldName);
      store.set('how:world', client.worldName);
    }
    if (client?.harnesses) {
      registerHarnessLabels(client.harnesses);
      registerProcessHarnesses(client.harnesses);
      setProcessHarnesses(client.harnesses);
      store.set('how:process-harnesses', JSON.stringify(client.harnesses));
    }
  }, [client]);

  const sessionId = sessions[clientKey];
  const draftKey = `${clientKey}:${sessionId ?? ''}`;
  const text = drafts[draftKey] ?? '';
  const setDraft = useCallback((key: string, value: string) => setDrafts((d) => ({ ...d, [key]: value })), []);
  const setText = useCallback((value: string) => setDraft(draftKey, value), [setDraft, draftKey]);
  const list = useSessionList(client);
  const data = useSession(client, sessionId, pollRef);
  const mdReady = useRowsReady();
  const { view, events } = data;

  // A session id (from a link, or restored from storage) that this World
  // does not have: only the session's own read can say so (the list holds
  // the World's latest runs only, so a miss there means nothing).
  const [missing, setMissing] = useState<string>();
  useEffect(() => {
    if (!data.notFound || !sessionId || started.current.has(sessionId)) return;
    setMissing(sessionId);
    setSessions((s) => ({ ...s, [clientKey]: undefined }));
  }, [data.notFound, sessionId, clientKey]);

  // ---------- derived ----------
  const lanes = useMemo(() => laneOf(view?.effects ?? [], mode), [view, mode]);
  const times = useMemo(() => stepTimes(events), [events]);
  const index = useMemo(() => logIndex(events), [events]);
  const crashList = useMemo(() => crashes(view, lanes, times, mode), [view, lanes, times, mode]);
  const now = useMemo(
    () => (view ? nowState(view, mode, world, lanes, times, crashList, data.driving) : undefined),
    [view, mode, world, lanes, times, crashList, data.driving]
  );
  // Rows wait for the Markdown renderer (it loads with the page, in parallel
  // with the first read), so prose never swaps from plain text and moves.
  const items = useMemo(() => {
    const built = view && mdReady ? buildItems(view, lanes, crashList) : [];
    if (!view || !mdReady || !outgoing || outgoing.id !== sessionId || view.submissions.slice(outgoing.known).some((sub) => sub.text === outgoing.text)) return built;
    return [...built, { t: 'user', key: 'outgoing', text: outgoing.text, steer: outgoing.steer, queued: true, withdrawn: false } satisfies Item];
  }, [view, lanes, crashList, mdReady, outgoing, sessionId]);
  const waitingCrash = crashList.find((c) => c.state === 'waiting');
  // A process harness generating between its steps: its live text gets a row of its own
  // (a model step, written only around a crash drill, has no row: its text streams here too).
  const streaming = !!view?.turnOpen && view.status === 'running' && !waitingCrash && !view.effects.some((e) => inFlight(e) && e.name !== 'model');

  // Fast while something is in flight; a crash nobody has picked up for a
  // while backs off, so a stranded run is never polled twice a second forever.
  // Idle, the live stream pushes every commit: the poll is a slow fallback,
  // unless the Event Log is open.
  pollRef.current = () => {
    if (!now?.busy) return logOpen ? 3000 : 30_000;
    const waited = waitingCrash?.crashAt !== undefined ? Date.now() - waitingCrash.crashAt : 0;
    return waited > 60_000 ? 5000 : waited > 20_000 ? 2000 : 500;
  };
  const itemByStep = useMemo(() => {
    const m = new Map<string, Item>();
    for (const it of items) {
      if (it.t === 'user') {
        if (it.subId) m.set(it.subId, it);
      } else m.set(it.effect.stepId, it);
    }
    return m;
  }, [items]);

  // fx in the tab is libfx's Wasm build, which needs JSPI; Server runs the
  // native addon. Hybrid works either way: without JSPI the tab hands each
  // fx turn to the server lane (and says so).
  const fxOff = mode === 'tab' && !!client && !client.fxAvailable;
  // Why a harness cannot be picked right now, beyond the modes it runs in.
  const harnessDisabled: Record<string, string | undefined> = {
    ...(fxOff ? { fx: FX_JSPI_OFF } : {}),
    ...(mode !== 'server' ? Object.fromEntries(Object.keys(ownLoaders).map((h) => [h, OWN_HARNESSES[h]!.serverOnly[mode]])) : {}),
  };
  const chosen = harnessList.find((h) => h.value === harnesses[mode]);
  const harness: Harness =
    harnesses[mode]! in OWN_HARNESSES && !own
      ? 'pi'
      : chosen && !harnessDisabledReason(chosen, mode, harnessDisabled[chosen.value])
        ? chosen.value
        : 'pi';
  const harnessName = own ? own.option.label : harnessLabel(view?.harness ?? harness);
  // The crashes the session's harness (or the picker's, before a session) fires: a process
  // harness whose model traffic bypasses harness-world-process's proxy has no model step.
  const shownOption = harnessList.find((h) => h.value === (view?.harness ?? harness));
  const crashTargets = shownOption?.crashes;

  // ---------- hands ----------
  // The picker's harness, as an option (one that owns its durability is its own).
  const pickedOption = own ? own.option : (harnessList.find((h) => h.value === harness) ?? BUILTIN_HARNESSES[0]!);
  const handsCtx = client?.sandboxReason ? { sandboxOff: client.sandboxReason } : {};
  // Native and Wrapped run the harness as shipped: their hands are its defaults.
  const handsFixedReason = undurable(durability) ? HANDS_FIXED : undefined;
  const hands: Hands = handsFixedReason ? defaultHandsFor(pickedOption, mode) : pickHands(pickedOption, mode, wantedHands(mode, harness), handsCtx);
  const handsList = handsChoices(pickedOption, mode, handsCtx);
  // The open session's own hands (its log's), else the ones its first prompt will get.
  const activeHands: Hands = sessionId && view ? sessionHands(view) : hands;
  // The drills that fire for the session's harness and hands, and where its Files panel reads.
  const scope = drillScope(activeHands);
  const filesSource = filesOf(activeHands);
  const fittedCrash = fitCrash(crashSpec, crashTargets, scope);
  // A session that opens shows its hands in the picker (its harness's choice from now on).
  const syncedHands = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!view?.hands || !sessionId || syncedHands.current === sessionId) return;
    syncedHands.current = sessionId;
    const h = isHybrid(view.harness) ? (isFx(view.harness) ? 'fx' : 'pi') : view.harness;
    if (!h) return;
    setHandsWanted((prev) => ({ ...prev, [`${mode}:${h}`]: view.hands }));
  }, [view?.hands, view?.harness, sessionId, mode]);
  const commits = (view as { commits?: number } | undefined)?.commits;

  // ---------- latency ----------
  const tracker = useTracker(client, sessionId);
  // Cheap, and the tracker re-renders the page when a timing lands.
  const captions = turnCaptions(items, tracker?.turns ?? []);
  const acks = tracker?.durable.recent ?? [];
  const aheadMs = tracker?.durable.ahead ?? [];
  const p50 = (xs: number[]) => `${Math.round(median(xs) ?? 0)} ms`;
  const writes = own
    ? own.writes(commits)
    : durability === 'run-ahead'
      ? { lead: 'Writes trail the agent', figures: acks.length ? [`ack p50 ${p50(acks)}`, ...(aheadMs.length ? [`lag p50 ${p50(aheadMs)}`] : [])] : [] }
      : durability === 'on'
        ? { lead: 'Every write awaited', figures: acks.length ? [`ack p50 ${p50(acks)}`, `${tracker?.durable.acks ?? 0} writes`] : [] }
        : undefined;

  // ---------- the server went away ----------
  // A network failure (never an HTTP error) on the open session's reads
  // (two in a row) or on the list's (it polls every 3s while failing).
  const netDown =
    mode !== 'tab' &&
    ((isNetworkError(data.error) && data.failures >= 2) || (isNetworkError(list.error) && !sessionId));
  const [lostAt, setLostAt] = useState<number>();
  useEffect(() => {
    setLostAt((at) => (netDown ? (at ?? Date.now()) : undefined));
  }, [netDown]);
  const lost = netDown && lostAt !== undefined;
  const localWorld = world === 'local' || world === 'postgres';

  // ---------- crash control ----------
  // Fired: the crash went off and the killed step hasn't been picked up yet
  // (or the process that would record it is gone). The button says so too.
  const crashFired = !!sessionId && ((lost && !!view?.armedChaos) || !!waitingCrash);
  const crashState: CrashButtonState = arming
    ? 'arming'
    : crashFired
      ? 'fired'
      : sessionId
        ? view?.armedChaos
          ? 'armed'
          : 'idle'
        : prearm
          ? 'armed'
          : 'idle';

  // ---------- a crash its turn never reached ----------
  // A crash is armed for the next matching step of a turn. A turn that ends
  // without one (a prompt with no tool call) would leave it armed, to fire in
  // some later, unrelated turn: it is withdrawn when its turn goes idle, and
  // the page says why.
  const armWatch = useRef<{ id?: string; busy: boolean }>({ busy: false });
  const [disarmed, setDisarmed] = useState<{ id: string; text: string }>();
  const refreshSession = data.refresh;
  useEffect(() => {
    const w = armWatch.current;
    const armed = view?.armedChaos;
    if (!sessionId || !armed) {
      armWatch.current = { busy: false };
      return;
    }
    if (w.id !== sessionId) {
      armWatch.current = { id: sessionId, busy: !!now?.busy };
      return;
    }
    if (now?.busy) {
      w.busy = true;
      return;
    }
    if (!w.busy || !client?.disarm || crashFired) return;
    w.busy = false;
    const id = sessionId;
    void client.disarm(id).then(
      () => {
        setDisarmed({ id, text: crashDisarmedText(armed.at, armed.kind) });
        refreshSession();
      },
      () => {}
    );
  }, [sessionId, view?.armedChaos, now?.busy, client, crashFired, refreshSession]);

  // ---------- URL + storage ----------
  const selectedEventId = selection?.kind === 'event' ? selection.eventId : undefined;
  const shownHarness = own ? own.option.value : harness;
  useEffect(() => {
    const q = new URLSearchParams();
    q.set('mode', mode);
    q.set('harness', shownHarness);
    q.set('hands', activeHands);
    q.set('durability', durability);
    if (sessionId) q.set('session', sessionId);
    if (sessionId && selectedEventId) q.set('event', selectedEventId);
    const next = `${location.pathname.replace(/\/browser\/index\.html$/, '/')}?${q}`;
    if (next !== location.pathname + location.search) history.replaceState(null, '', next);
    store.set('how:mode', mode);
    store.set(`how:last:${clientKey}`, sessionId);
  }, [mode, shownHarness, activeHands, durability, clientKey, sessionId, selectedEventId]);

  // ---------- actions ----------
  const openSession = useCallback(
    (id: string | undefined) => {
      setMissing(undefined);
      setSessions((s) => ({ ...s, [clientKey]: id }));
      setSelection(undefined);
      setSessionsOpen(false);
      setActionError(undefined);
    },
    [clientKey]
  );

  const switchMode = useCallback(
    (m: Mode) => {
      if (m === mode) return;
      const k = m === 'server' && ownOf(harnesses.server) ? ownOf(harnesses.server)!.key : keyOf(m, resolve(m, durabilities[m]));
      setSessions((s) => (k in s ? s : { ...s, [k]: store.get(`how:last:${k}`) }));
      setMode(m);
      setSelection(undefined);
      setActionError(undefined);
      setBlocked(undefined);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: resolve follows the loaders
    [mode, durabilities, rawLoaders, nativeLoaders, harnesses, ownLoaders]
  );

  const setDurability = useCallback(
    (d: Durability) => {
      if (own || !available(mode, d) || d === durability) return;
      if (processDurabilities && !processDurabilities.includes(d)) return;
      const k = keyOf(mode, d);
      setSessions((s) => (k in s ? s : { ...s, [k]: store.get(`how:last:${k}`) }));
      setDurabilities((prev) => ({ ...prev, [mode]: d }));
      store.set(`how:durability:${mode}`, d);
      setSelection(undefined);
      setActionError(undefined);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: available follows the loaders
    [mode, durability, rawLoaders, nativeLoaders, own, processDurabilities]
  );

  const setHarness = (h: Harness) => {
    const target = mode === 'server' ? ownOf(h) : undefined;
    if (h in OWN_HARNESSES && !target) return;
    // A harness that owns its durability keeps its sessions under its own client: switching in or out opens that client's last session.
    if (target?.key !== own?.key) {
      const k = target ? target.key : keyOf(mode, resolve(mode, durabilities[mode]));
      setSessions((s) => (k in s ? s : { ...s, [k]: store.get(`how:last:${k}`) }));
      setSelection(undefined);
      setActionError(undefined);
    }
    setHarnesses((prev) => ({ ...prev, [mode]: h }));
    store.set(`how:harness:${mode}`, h);
  };

  /** The hands the picker's harness gives a new session, from now on. */
  const setHands = (h: Hands) => {
    if (handsFixedReason || handsList.find((c) => c.hands === h)?.reason) return;
    setHandsWanted((prev) => ({ ...prev, [`${mode}:${harness}`]: h, [`${mode}:*`]: undefined }));
    store.set(`how:hands:${mode}:${harness}`, h);
  };

  /** One of this browser's sessions, as it was started: its mode, harness and durability come back with it. */
  const openEntry = (e: MineEntry) => {
    setMode(e.mode);
    setHarnesses((prev) => ({ ...prev, [e.mode]: e.harness }));
    store.set(`how:harness:${e.mode}`, e.harness);
    if (e.hands) setHandsWanted((prev) => ({ ...prev, [`${e.mode}:${e.harness}`]: e.hands }));
    if (!(e.harness in OWN_HARNESSES)) {
      setDurabilities((prev) => ({ ...prev, [e.mode]: e.durability }));
      if (e.durability !== 'off') store.set(`how:durability:${e.mode}`, e.durability);
    }
    setMissing(undefined);
    setSessions((s) => ({ ...s, [e.key]: e.id }));
    setSelection(undefined);
    setSessionsOpen(false);
    setActionError(undefined);
  };
  /** A session from the deployment's list: opened here, with the picker on its harness when this mode offers it. */
  const openRow = (row: SessionRow) => {
    const option = harnessList.find((h) => h.value === row.harness);
    if (option && !harnessDisabledReason(option, mode, harnessDisabled[option.value]) && !(row.harness in OWN_HARNESSES)) {
      setHarnesses((prev) => ({ ...prev, [mode]: row.harness }));
    }
    openSession(row.id);
  };

  const newSession = useCallback(() => {
    openSession(undefined);
    requestAnimationFrame(() => composer.current?.focus());
  }, [openSession]);

  const remember = (id: string, prompt: string, at: number) => {
    setMine((list) => {
      const next = withEntry(list, { id, mode, harness: shownHarness, durability, key: clientKey, prompt: titleOf(prompt), sentAt: Math.round(at), ...(handsFixedReason ? {} : { hands }) });
      writeMine(next);
      return next;
    });
  };

  async function startWith(prompt: string, crash?: ChaosSpec) {
    if (!client) return;
    const wanted = crash ?? prearm;
    // No session is open here: the scope is the new session's hands'.
    const spec = wanted && fitCrash(wanted, crashTargets, scope);
    const h = movesLanes(mode) ? (harness === 'fx' ? 'hybrid-fx' : 'hybrid') : harness;
    const startOptions = handsFixedReason ? {} : { hands };
    const fromKey = draftKey;
    setFollowKey((n) => n + 1);
    setSending(true);
    setActionError(undefined);
    setDisarmed(undefined);
    try {
      let id: string;
      let opened = false;
      const t0 = performance.timeOrigin + performance.now();
      if (spec && client.chaosEnabled) {
        id = await client.start(h, undefined, startOptions);
        started.current.add(id);
        // Open the session now: arming and the drill Function's first answer take a few seconds, and the prompt shows meanwhile.
        remember(id, prompt, Date.now());
        sent(id, prompt, false, 0);
        openSession(id);
        opened = true;
        await client.chaos(id, spec);
        trackerFor(client, id).sent('prompt');
        await client.send(id, prompt, 'prompt', { crash: (spec.kind ?? 'process') === 'process' });
      } else {
        id = await client.start(h, prompt, startOptions);
        started.current.add(id);
        trackerFor(client, id).sent('prompt', t0);
      }
      remember(id, prompt, Date.now());
      setPrearm(undefined);
      setDraft(fromKey, '');
      if (!opened) openSession(id);
      void list.refresh();
    } catch (e) {
      setOutgoing(undefined);
      setActionError(messageOf(e));
    } finally {
      setSending(false);
    }
  }

  /** Show a message as queued until the log has it (or for a few seconds, if this view never lists it). `known`: the session's submissions before it. */
  const sent = (id: string, text: string, steer: boolean, known: number) => {
    const next = { id, text, steer, known };
    setOutgoing(next);
    setTimeout(() => setOutgoing((o) => (o === next ? undefined : o)), 20_000);
  };

  async function sendText(kind: 'prompt' | 'steer', value = text, crash?: ChaosSpec) {
    const body = value.trim();
    if (!client || !body) return;
    if (!sessionId) return startWith(body, crash);
    const fromKey = draftKey;
    setFollowKey((n) => n + 1);
    setSending(true);
    setActionError(undefined);
    setDisarmed(undefined);
    try {
      sent(sessionId, body, kind === 'steer', view?.submissions.length ?? 0);
      if (crash && client.chaosEnabled) await client.chaos(sessionId, fitCrash(crash, crashTargets, scope));
      // An armed crash (just now, or earlier with the Crash button) fires where the turn runs: a drill's Function, on a server that has one.
      const armed = crash ?? view?.armedChaos;
      trackerFor(client, sessionId).sent(kind);
      await client.send(sessionId, body, kind, { crash: !!armed && (armed.kind ?? 'process') === 'process' });
      if (value === text) setDraft(fromKey, '');
      data.refresh();
    } catch (e) {
      setOutgoing(undefined);
      setActionError(messageOf(e));
    } finally {
      setSending(false);
    }
  }

  const pickScenario = (s: Scenario) => void sendText('prompt', s.prompt, s.crash);

  // Native and Wrapped record nothing: a crash there would only lose the turn.
  const crashDisabled = undurable(durability) ? crashUnrecorded(durability === 'off') : undefined;
  const chaosEnabled = (client ? client.chaosEnabled : true) && !crashDisabled;

  const arm = useCallback(async () => {
    if (!client || !chaosEnabled) return;
    if (!sessionId) {
      setPrearm((p) => (p ? undefined : { ...crashSpec }));
      return;
    }
    if (crashFired) return;
    // Armed: the same click disarms it.
    if (view?.armedChaos) {
      if (!client.disarm) return;
      setArming(true);
      try {
        await client.disarm(sessionId);
        data.refresh();
      } catch (e) {
        setActionError(messageOf(e));
      } finally {
        setArming(false);
      }
      return;
    }
    setArming(true);
    try {
      // Fitted to the session's hands (`fitCrash`): only a drill that fires for it is armed.
      await client.chaos(sessionId, fittedCrash);
      data.refresh();
    } catch (e) {
      setActionError(messageOf(e));
      setArming(false);
    }
  }, [client, chaosEnabled, sessionId, crashSpec, fittedCrash, view?.armedChaos, crashFired, data]);
  // Arming lasts until the log says so (armed, or already fired).
  const firedCount = crashList.length;
  useEffect(() => {
    if (!arming) return;
    if (view?.armedChaos) setArming(false);
    const t = setTimeout(() => setArming(false), 4000);
    return () => clearTimeout(t);
  }, [arming, view?.armedChaos, firedCount]);

  // ---------- selection ----------
  const selectItem = useCallback((item: Item) => {
    setSelection({ kind: 'row', key: item.key, stepIds: itemSteps(item), eventIds: item.t === 'user' && item.subId ? [item.subId] : [] });
  }, []);
  const hoverItem = useCallback((item: Item | undefined) => {
    setHover(item ? { steps: new Set(itemSteps(item)), events: new Set(item.t === 'user' && item.subId ? [item.subId] : []) } : undefined);
  }, []);
  const itemRef = useRef(itemByStep);
  itemRef.current = itemByStep;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const reveal = useCallback((key: string, pin?: boolean) => setScrollTo((s) => ({ key, n: (s?.n ?? 0) + 1, pin })), []);
  const selectEvent = useCallback(
    (id: string | undefined) => {
      if (!id) return setSelection(undefined);
      setSelection({ kind: 'event', eventId: id });
      const ev = eventsRef.current.find((e) => e.eventId === id);
      const item = (ev?.correlationId && itemRef.current.get(ev.correlationId)) || itemRef.current.get(id);
      if (item) reveal(item.key);
    },
    [reveal]
  );
  const onCite = useCallback(
    (indexes: number[]) => {
      const first = eventsRef.current[Math.min(...indexes) - 1];
      if (!first) return;
      setInspectorTab('log');
      setLogOpen(true);
      setSelection({ kind: 'event', eventId: first.eventId });
    },
    [setLogOpen]
  );
  const openFile = useCallback(
    (path: string) => {
      setSelection({ kind: 'file', path });
      setInspectorTab('files');
      setLogOpen(true);
    },
    [setLogOpen]
  );
  const showInTranscript = useCallback(
    (id: string) => {
      const item = itemRef.current.get(id);
      if (!item) return;
      selectItem(item);
      reveal(item.key);
      // An overlaying drawer covers the transcript: get out of the way.
      if (!wide) setLogOpen(false);
    },
    [reveal, selectItem, wide, setLogOpen]
  );
  const railSelect = useCallback(
    (effectKey: string) => {
      const item = [...itemRef.current.values()].find((i) => i.key === effectKey);
      if (!item) return;
      selectItem(item);
      reveal(item.key);
    },
    [reveal, selectItem]
  );

  const selectedKey = useMemo(() => {
    if (selection?.kind === 'row') return selection.key;
    if (selection?.kind === 'event') {
      const ev = events.find((e) => e.eventId === selection.eventId);
      return ((ev?.correlationId && itemByStep.get(ev.correlationId)) || itemByStep.get(selection.eventId))?.key;
    }
    return undefined;
  }, [selection, events, itemByStep]);

  const highlight: Highlight = useMemo(() => {
    const steps = new Set<string>(hover?.steps ?? []);
    const evs = new Set<string>(hover?.events ?? []);
    if (selection?.kind === 'row') {
      for (const s of selection.stepIds) steps.add(s);
      for (const e of selection.eventIds) evs.add(e);
    } else if (selection?.kind === 'event') {
      const ev = events.find((e) => e.eventId === selection.eventId);
      if (ev?.correlationId && ev.eventType.startsWith('step_')) steps.add(ev.correlationId);
    }
    return { steps, events: evs };
  }, [hover, selection, events]);

  // ---------- keyboard ----------
  const keyRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  const lastKey = useRef({ key: '', at: 0 });
  keyRef.current = (ev) => {
    if (ev.key === 'Escape') {
      if (sessionsOpen) setSessionsOpen(false);
      else if (logOpen && !wide) setLogOpen(false);
      else setSelection(undefined);
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target)) return;
    // A held key must not toggle a crash (or modes) on and off.
    const t = performance.now();
    if (ev.repeat || (lastKey.current.key === ev.key && t - lastKey.current.at < 250)) return;
    lastKey.current = { key: ev.key, at: t };
    if (ev.key === '1' || ev.key === '2' || ev.key === '3') switchMode(MODES[Number(ev.key) - 1]!);
    else if (ev.key === 'n' || ev.key === 'N') {
      ev.preventDefault();
      newSession();
    } else if (ev.key === 'x' || ev.key === 'X') void arm();
  };
  useEffect(() => {
    const on = (ev: KeyboardEvent) => keyRef.current(ev);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ---------- tab-crash recovery toast ----------
  const crashBoot = useRef(boot.crash && boot.crash.mode === mode ? boot.crash : undefined);
  useEffect(() => {
    if (!crashBoot.current || !view || !items.length) return;
    const c = crashBoot.current;
    crashBoot.current = undefined;
    setToast(tabCrashToast(c.mode, world));
    const last = items.filter((i) => i.t === 'crash').at(-1);
    if (last) reveal(last.key, true);
  }, [view, items, reveal, world]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- another tab holds the in-tab queue ----------
  useEffect(() => {
    if (!client?.blocked) return;
    let stop = false;
    const t = setTimeout(async () => {
      const reason = await client.blocked!();
      if (!stop) setBlocked(reason);
    }, 800);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [client]);

  // ---------- announcements ----------
  const lastAnnounced = useRef<string>('');
  useEffect(() => {
    if (!view) return;
    const handoffs = view.effects.filter((e) => e.name === 'handoff' && e.status === 'completed');
    const lastHandoff = handoffs.at(-1)?.output?.to as Lane | undefined;
    const sig = `${view.id}:${handoffs.length}:${crashList.map((c) => c.state).join()}`;
    if (sig === lastAnnounced.current) return;
    const prev = lastAnnounced.current;
    lastAnnounced.current = sig;
    if (!prev.startsWith(view.id)) return;
    const c = crashList.at(-1);
    if (c && c.state === 'waiting' && !prev.endsWith(crashList.map((x) => x.state).join())) setAnnounce('Crashed');
    else if (c && c.state !== 'waiting') setAnnounce('Recovered');
    else if (lastHandoff) setAnnounce(lastHandoff === 'browser' ? 'Back in this tab' : `Moved to ${lastHandoff === 'function' ? 'Function' : 'Sandbox'}`);
  }, [view, crashList]);

  // ---------- notes ----------
  const notes: { key: string; tone?: 'error'; text: ReactNode }[] = [];
  if (entry?.status === 'error') notes.push({ key: 'load', tone: 'error', text: errorCopy(mode, entry.error, 'load') });
  if (blocked) notes.push({ key: 'blocked', tone: 'error', text: blocked });
  if (lost) {
    if (localWorld) {
      const crashed = !!view?.armedChaos || crashList.some((c) => c.state === 'waiting');
      const n = lostServer(world, mode, crashed, client?.serverPort ?? (typeof location === 'undefined' ? '' : location.port));
      notes.push({
        key: 'lost',
        text: (
          <>
            {n.lead} Start it again: <code className="cmd">{n.command}</code>
            <br />
            <span className="muted">{n.tail}</span>
          </>
        ),
      });
    } else notes.push({ key: 'lost', text: UNREACHABLE });
  } else if (data.error && !isNetworkError(data.error) && data.failures >= 2) {
    notes.push({ key: 'read', tone: 'error', text: errorCopy(mode, data.error, 'read') });
  }
  if (actionError && !lost) notes.push({ key: 'action', tone: 'error', text: errorCopy(mode, actionError, 'read') });
  if (missing && !sessionId) notes.push({ key: 'missing', text: SESSION_MISSING });
  if (disarmed && disarmed.id === sessionId && !view?.armedChaos) notes.push({ key: 'disarmed', text: disarmed.text });
  if (view?.status === 'failed' && view.failure) notes.push({ key: 'failed', tone: 'error', text: `${SESSION_FAILED} ${view.failure}` });
  if (movesLanes(mode) && view?.harness === 'hybrid-fx' && view.status === 'running' && client && !client.fxAvailable)
    notes.push({ key: 'fx-server', text: FX_ON_SERVER });
  if (view?.effects.some((e) => e.name === 'model' && e.status === 'failed' && /\b40[13]\b/.test(String(e.error?.message ?? ''))))
    notes.push({ key: 'gw', tone: 'error', text: GATEWAY_401 });

  // ---------- header ----------
  let nowText: string;
  if (!entry || entry.status === 'loading') nowText = LOADING[mode];
  else if (entry.status === 'error') nowText = 'Not connected';
  else if (lost) nowText = LOST_NOW;
  else if (!sessionId) nowText = 'New session';
  else if (!view) nowText = 'Loading the session…';
  else nowText = now!.text;
  const nowTone = waitingCrash && view?.status === 'running' ? 'crash' : undefined;
  const status = lost ? undefined : statusWord(now, view, !!waitingCrash);

  const hasSession = !!sessionId;
  const armedSpec = sessionId ? view?.armedChaos : prearm;
  // The examples the session's hands can run (`scenariosFor`): its VM's drills with Sandbox hands, a machine's with Virtual + machine.
  const scenarios = scenariosFor(mode, activeHands);
  const demo = scenarios.find((s) => s.primary);
  const sessionKey = `${clientKey}:${sessionId ?? ''}`;
  const title = useMemo(() => {
    const first = view?.submissions.find((s) => s.kind === 'prompt' && s.text);
    return first?.text ? titleOf(first.text) : mine.find((e) => e.id === sessionId)?.prompt;
  }, [view, mine, sessionId]);
  const compareCols = measureColumns(own ? own.option.value : (view?.harness ?? harness), mode);
  const compareHref = compareCols ? `/compare?cols=${compareCols}` : undefined;
  const processOption = processHarnesses.find((h) => h.value === (view?.harness ?? harness));

  const laneName = useCallback(
    (lane: Lane | undefined, hook: boolean) => {
      if (hook || !lane) return 'the client';
      if (lane === 'browser') return 'This tab';
      // The retired brain-in-VM lane, which an older session's log can name.
      if (lane === 'sandbox') return 'the retired Sandbox lane';
      return world === 'local' || world === 'postgres' ? 'the server' : 'the Function';
    },
    [world]
  );
  const loadPayload = useCallback(
    (eventId: string) => (client && sessionId ? client.event(sessionId, eventId) : Promise.resolve(undefined)),
    [client, sessionId]
  );

  const skeleton = hasSession && (!view || !mdReady) && entry?.status !== 'error' && (
    <div aria-hidden="true">
      {[180, 320, 240, 280].map((w, i) => (
        <div key={i} className="t-row">
          <span className="skel" style={{ width: 32, marginTop: 6 }} />
          <span className="skel" style={{ width: w, marginTop: 6 }} />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
  const OwnPanel = own?.Panel;
  const empty = hasSession ? (
    skeleton
  ) : (
    <EmptyState
      mode={mode}
      world={world}
      {...(OwnPanel ? { note: <OwnPanel /> } : {})}
      {...(demo ? { onDemo: () => pickScenario(demo) } : {})}
      {...(demo && demo.needs !== 'shell' ? { demoLabel: demo.label } : {})}
      {...(crashDisabled ? { demoDisabled: crashDisabled } : {})}
      busy={!client || sending}
    />
  );
  const pushLog = wide && logOpen;

  return (
    <div className="app" data-log={pushLog || undefined}>
      <TopBar />
      <ControlBar
        mode={mode}
        durability={durability}
        onDurability={setDurability}
        {...(own
          ? { nativeDisabledReason: own.native }
          : processChoice && !processDurabilities?.includes('native')
            ? { nativeDisabledReason: `No native ${processChoice.label} yet.` }
            : nativeLoaders?.[mode]
              ? {}
              : {
                  nativeDisabledReason:
                    mode === 'hybrid'
                      ? 'Hybrid moves a session between lanes on one log; plain Pi and fx have no log to move, so there is no native Hybrid.'
                      : 'No native harness in this mode.',
                })}
        {...(own
          ? own.durability === 'on'
            ? { runAheadDisabledReason: own.only }
            : { strictDisabledReason: own.only }
          : runAheadModes.includes(mode)
            ? {}
            : { runAheadDisabledReason: RUN_AHEAD_SERVER_ONLY })}
        world={world}
        onMode={switchMode}
        onPrefetch={prefetch}
        harness={shownHarness}
        onHarness={setHarness}
        harnesses={harnessList}
        harnessDisabled={harnessDisabled}
        hands={hands}
        onHands={setHands}
        handsChoices={handsList}
        {...(handsFixedReason ? { handsFixedReason } : {})}
        compact={compact}
        crash={{
          mode,
          world,
          enabled: chaosEnabled,
          ...(crashDisabled ? { disabledReason: crashDisabled } : {}),
          spec: fittedCrash,
          onSpec: setCrashSpec,
          ...(crashTargets ? { targets: crashTargets } : {}),
          state: crashState,
          prearm: !sessionId,
          onArm: () => void arm(),
          ...(own ? { note: OWN_CRASH_SHARED } : {}),
          scope,
        }}
      />
      <div className="work">
        <main className="main">
          <SessionHeader
            fresh={!hasSession}
            {...(title ? { title } : {})}
            harness={harnessName}
            durability={DURABILITY_LABEL[durability]}
            now={nowText}
            {...(status ? { short: status } : {})}
            {...(nowTone ? { tone: nowTone } : {})}
            {...(now?.since !== undefined ? { since: now.since } : {})}
            {...(lost && lostAt !== undefined ? { until: lostAt } : {})}
            {...(hasSession && writes ? { writes } : {})}
            {...(hasSession && compareHref ? { compareHref } : {})}
            sessionCount={mine.length}
            sessionsOpen={sessionsOpen}
            onSessions={() => setSessionsOpen((o) => !o)}
            {...(hasSession ? { eventCount: events.length } : {})}
            logOpen={logOpen}
            onLog={() => setLogOpen((o) => !o)}
          />
          <LaneRail
            mode={mode}
            world={world}
            view={view}
            lanes={lanes}
            crashList={crashList}
            times={times}
            armed={crashFired ? undefined : armedSpec}
            narrow={compact}
            sessionKey={sessionKey}
            onSelect={railSelect}
          />
          <Transcript
            items={items}
            streaming={streaming}
            armed={armedSpec}
            prearmed={!sessionId && !!prearm}
            armedFired={crashFired}
            followKey={followKey}
            frozenAt={lost ? lostAt : undefined}
            notes={notes}
            empty={empty}
            sessionKey={sessionKey}
            scrollTo={scrollTo}
            mode={mode}
            world={world}
            harnessName={harnessName}
            times={times}
            index={index}
            live={data.live}
            selectedKey={selectedKey}
            onSelect={selectItem}
            onHover={hoverItem}
            onCite={onCite}
            onOpenFile={openFile}
            captions={captions}
            {...(view?.ledger ? { ledger: view.ledger } : {})}
          />
          <ScenarioRow
            scenarios={scenarios}
            onPick={pickScenario}
            disabled={!client || sending}
            limit={compact ? 1 : 4}
            {...(crashDisabled ? { crashDisabled } : {})}
          />
          <Composer
            ref={composer}
            text={text}
            onText={setText}
            hasSession={hasSession}
            harnessName={harnessName}
            sending={sending}
            canSteer={hasSession && !!now?.running}
            disabled={!client}
            onSend={() => void sendText('prompt')}
            onSteer={() => void sendText('steer')}
            onFocus={() => client?.warm?.(sessionId ?? undefined)}
          />
        </main>
        <Suspense fallback={null}>
          <Inspector
            mode={mode}
            world={world}
            {...(durability === 'off'
              ? { stored: 'Wrapped: nothing is stored. These are the events it would have written.' }
              : durability === 'native'
                ? { stored: 'Native: nothing is recorded. These rows are what this page saw.' }
                : own
                  ? { stored: `${storedIn(mode, world)}. ${own.stored}` }
                  : {})}
            hasSession={hasSession}
            view={view}
            events={events}
            lanes={lanes}
            index={index}
            selection={selection}
            highlight={highlight}
            tab={inspectorTab}
            onTab={setInspectorTab}
            onSelectEvent={selectEvent}
            onSelectFile={openFile}
            onShowInTranscript={showInTranscript}
            loadPayload={loadPayload}
            laneName={laneName}
            sessionKey={sessionKey}
            {...(sessionId ? { runId: sessionId } : {})}
            {...(sessionId && client?.agentRuns && !undurable(durability) ? { agentRunsUrl: agentRunsUrl(client.agentRuns, sessionId) } : {})}
            model={processOption?.model ?? model}
            open={logOpen}
            onClose={() => setLogOpen(false)}
            files={filesSource}
            driveChanges={data.driveChanges}
            {...(own || durability === 'native' || durability === 'off' ? { noDocs: true } : {})}
          />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <SessionList
          mine={mine}
          {...(list.rows ? { all: list.rows } : {})}
          showAll={showAll}
          onShowAll={setShowAll}
          offline={entry?.status !== 'error' && !!list.error}
          {...(sessionId ? { current: sessionId } : {})}
          {...(status ? { currentStatus: status } : {})}
          open={sessionsOpen}
          onOpen={openEntry}
          onOpenRow={openRow}
          onNew={newSession}
          onClose={() => setSessionsOpen(false)}
        />
      </Suspense>
      {(sessionsOpen || (logOpen && !wide)) && (
        <div
          className="scrim"
          aria-hidden="true"
          onClick={() => {
            setSessionsOpen(false);
            if (!wide) setLogOpen(false);
          }}
        />
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {toast && (
        <div className="toast float" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
