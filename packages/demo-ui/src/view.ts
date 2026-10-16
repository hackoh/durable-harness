/**
 * What the UI shows, and what it needs from "wherever the World is". Types
 * and a few pure name predicates only: this module is in the page's first chunk, so it must not pull in a
 * World, a harness, or just-bash. The projection from a fold lives in
 * `fold-view.ts` (the `./view` export), which only servers and the lazy
 * in-tab clients import.
 */

/**
 * Where a session is driven, from least to most capable. `sandbox` is the
 * retired brain-in-VM lane (docs/workspaces.md §8): an older session's log
 * can name it, and the kernel keeps it, but this demo never drives it.
 */
export type Lane = 'browser' | 'function' | 'sandbox';

/**
 * Where the agent's brain runs (the page's `?mode=`): a Function (Server),
 * this tab (Tab), or both, moving between them (Hybrid). The brain and its
 * log never run in a Vercel Sandbox: that is a session's hands (`Hands`).
 */
export type Brain = 'server' | 'tab' | 'hybrid';
/** The page's name for the brain, kept from when it was the "Runs in" choice. */
export type Mode = Brain;
/** Brains whose sessions move between lanes on one log (Hybrid: the tab and a Function). */
export const movesLanes = (mode: Mode | undefined) => mode === 'hybrid';

/**
 * Where the model's commands and files go (the page's `?hands=`):
 *
 * - `none`: nowhere: the app's own tools only (Claude Code and Codex: tool-less, still in a VM);
 * - `virtual`: `virtual()`, just-bash in the Function, the files in the session's log;
 * - `ephemeral`: `virtual({ durable: false })`, the same in memory, cleared every turn;
 * - `machine`: `virtual()` plus `run_on_machine`, a command in a Vercel Sandbox VM of the session's, its files synced from the log and back;
 * - `sandbox`: `sandbox()`, the commands and files in this session's Vercel Sandbox VM (its Drive at `/workspace`); the brain and its log stay in a Function.
 */
export type Hands = 'none' | 'virtual' | 'ephemeral' | 'machine' | 'sandbox';

/**
 * How durable a session is: `off` runs the same
 * harness with no World at all (the raw baseline, in the same place);
 * `on` awaits every durable write; `run-ahead` (Server mode)
 * lets the harness run ahead of durability; `native` runs plain Pi / fx with
 * none of harness-world at all (no harness, no World, no queue).
 */
export type Durability = 'off' | 'on' | 'run-ahead' | 'native';
/** Durabilities that record nothing (no World): nothing resumes after a reload. */
export const undurable = (d: Durability | undefined) => d === 'off' || d === 'native';

export type WorldName = 'vercel' | 'local' | 'postgres' | 'browser';

/** Harness names that move between lanes (Pi's `hybrid`, fx's `hybrid-fx`). */
export const isHybrid = (harness: string | undefined) => harness === 'hybrid' || harness === 'hybrid-fx';
/** fx, standalone or hybrid. */
export const isFx = (harness: string | undefined) => harness === 'fx' || harness === 'hybrid-fx' || harness === 'fx-durable';
/**
 * A harness the picker offers. Pi, fx and pi-durable are built in
 * (`BUILTIN_HARNESSES`); process harnesses (Claude Code, Codex, OpenCode,
 * Cursor) come from the server's registry (`DemoClient.harnesses`, read
 * from `GET /api/sessions`), so a port adds one without touching the UI.
 */
export interface HarnessOption {
  /** The harness name sessions start with (runs are `workflow//durable-harness@<version>//<value>`). */
  value: string;
  label: string;
  /** Tooltip. */
  title: string;
  /** The brains it takes (the page's `?mode=`). */
  modes: Mode[];
  /** The model it calls (AI Gateway's id), when the server says. */
  model?: string;
  /** Why it cannot run on this deployment at all (a missing credential or binary). */
  disabledReason?: string;
  /** The durabilities it runs under. Default: every one. */
  durabilities?: Durability[];
  /**
   * A process harness: driven by the kernel through harness-world-process,
   * its transcript is the normalized `transcript` journal stream.
   */
  process?: boolean;
  /**
   * The "Crash during" targets that fire for it. Default: every one. A
   * process harness whose model traffic does not go through
   * harness-world-process's gateway proxy has no model step to crash in.
   */
  crashes?: ChaosSpec['at'][];
  /** The hands it takes, in the order the picker shows them. Default `['virtual']`. */
  hands?: Hands[];
  /** The hands a new session gets when the page names none it takes. Default `virtual` (Hybrid: `machine`, where it takes it). */
  defaultHands?: Hands;
  /** Why it can't take one of its `hands` here (not built yet, no Sandbox credentials). */
  handsDisabled?: Partial<Record<Hands, string>>;
}

/**
 * Where a session's files are, for the Files panel (from its hands, `filesOf`):
 *
 * - `log`: in the log (a `virtual()` workspace: the `hw.workspace` manifest, `readWorkspace`);
 * - `drive`: on the session's Drive (`sandbox()`): the panel shows its last
 *   snapshot (`hw.sandbox-files`, `readDriveManifest`), plus the paths the
 *   calls named since, from the live stream; the Drive is the source of truth;
 * - `ephemeral`: in memory, a turn at a time (`virtual({ durable: false })`): nothing to show;
 * - `none`: no hands, so no files.
 */
export type FilesSource = 'log' | 'drive' | 'ephemeral' | 'none';

const ALL_MODES: Mode[] = ['server', 'tab', 'hybrid'];
const ALL_HANDS: Hands[] = ['none', 'virtual', 'ephemeral', 'machine', 'sandbox'];
/** Why Pi and fx can't take `sandbox()` hands yet: their tools on the session's VM are another change (the Function-tier harnesses' `sandbox()`). */
const sandboxComing = (label: string, factory: string) => `Coming with ${factory}: ${label}'s tools on this session's Vercel Sandbox VM aren't wired up yet. Its brain would stay in the Function.`;
export const BUILTIN_HARNESSES: HarnessOption[] = [
  {
    value: 'pi',
    label: 'Pi',
    title: 'Pi (pi-agent-core 1.0) on the durable-harness kernel: its log, its adapter, every brain, hands and durability.',
    modes: ALL_MODES,
    hands: ALL_HANDS,
    handsDisabled: { sandbox: sandboxComing('Pi', 'createCodingTools(sandbox())') },
  },
  {
    value: 'fx',
    label: 'fx',
    title: "fx (libfx's engine) on the durable-harness kernel, with every brain, hands and durability. A demo harness: durable-harness's fx support is fx (libfx durable).",
    modes: ALL_MODES,
    hands: ALL_HANDS,
    handsDisabled: { sandbox: sandboxComing('fx', 'fxTools(sandbox())') },
  },
];

const labels = new Map<string, string>();
/** Make `harnessLabel` know the server's process harnesses. */
export function registerHarnessLabels(options: HarnessOption[]): void {
  for (const o of options) labels.set(o.value, o.label);
}

/** What a session list or header calls its harness. */
export const harnessLabel = (harness: string | undefined) => (harness && labels.get(harness)) ?? (isFx(harness) ? 'fx' : 'Pi');

/**
 * What an armed crash kills (see harness-world chaos.ts). `sandbox-command`
 * and `drop-callback` (and `sandbox-vm` at `sandbox`) target an older hybrid
 * session's parked sandbox_exec (the page no longer offers them:
 * `run_on_machine` waits for its command inside the call); `sandbox-vm` at a
 * tool, `relay-drop`, `sandbox-new-vm` and `sandbox-zombie` a session whose
 * hands are its own sandbox (`sandbox()`).
 */
export type ChaosKind = 'process' | 'sandbox-vm' | 'sandbox-command' | 'drop-callback' | 'sandbox-new-vm' | 'sandbox-zombie' | 'relay-drop';

export interface ChaosSpec {
  /** `sandbox`: the next machine command (`run_on_machine`), or (`sandbox-new-vm`, `sandbox-zombie`) the next turn's attach of the session's sandbox. */
  at: 'tool' | 'model' | 'any' | 'sandbox';
  /** Default `process` (Kill Function). */
  kind?: ChaosKind;
  afterMs?: number;
  /** `process` only: kill with no record of the kill, so recovery waits for the queue's own redelivery. */
  silent?: boolean;
}

/** The crash control's settings: every field set but the silent kill. */
export type CrashSettings = Required<Omit<ChaosSpec, 'silent'>> & Pick<ChaosSpec, 'silent'>;

/** A parked sandbox_exec's result, as the UI shows it. */
export interface SettlementView {
  /** `backstop`: collected by the retired backstop (sessions written before 2026-10-07). */
  by: 'inline' | 'push' | 'check' | 'backstop' | 'tether';
  ok: boolean;
  exitCode?: number;
  /** Workspace paths the command changed. */
  files: string[];
}

export interface SessionRow {
  id: string;
  harness: string;
  status: string;
  createdAt: string | Date;
}

export interface EffectView {
  key: string;
  stepId: string;
  name: string;
  status: string;
  attempt: number;
  input: any;
  output: any;
  error?: any;
  /** Start of the latest attempt (ISO). */
  startedAt?: string;
  /** Submission ids this effect placed into the transcript. */
  placed: string[];
  /** The drive that wrote the intent (a crash names the drive it killed). */
  driver?: string;
  /** Set while (and after) a sandbox command owns this running step. */
  park?: { kind: string; cmdId?: string; push?: boolean; sandbox?: string };
  settlement?: SettlementView;
}

export interface SubmissionView {
  id: string;
  kind: string;
  text?: string;
  placed: boolean;
  withdrawn: boolean;
}

export interface SessionView {
  id: string;
  harness?: string;
  /** Its hands, as its `run_created` recorded them (`config.hands`); absent for a session started before the hands axis. */
  hands?: Hands;
  status: string;
  /** Why the session failed (`run_failed`), when it did. */
  failure?: string;
  eventCount: number;
  /** Where a hybrid session is driven right now (a fold of its handoff steps). */
  lane?: Lane;
  submissions: SubmissionView[];
  /** An armed crash that has not fired yet. */
  armedChaos?: ChaosSpec;
  /**
   * A process harness's session: whether its current turn is open (placed,
   * and not ended by a `turn` transcript entry). Absent for other harnesses.
   */
  turnOpen?: boolean;
  /**
   * A harness that owns its durability (pi-durable, fx): its own log shows a
   * turn in progress, between the steps this view can show.
   */
  working?: boolean;
  effects: EffectView[];
  /** The workspace's files, path to text (a binary file, its size: `(binary file, 25 bytes)`). */
  files: Record<string, string>;
  /**
   * A `sandbox()` session's Drive as of its last snapshot (`readDriveManifest`,
   * added by the server): absent before the first, or for a session whose
   * files are in the log.
   */
  drive?: DriveView;
  /**
   * Files of a document-backed workspace kept in the session's blob stream
   * (over 4 KB), path to hash: `withLedger` reads them into `files`.
   */
  blobFiles?: Record<string, string>;
  /** Steps that lost a first-writer-wins race for their memo key. */
  supersededStepIds: string[];
  /**
   * The session's documents (`defineDoc`, such as the demo's `demo.todos`),
   * as the log holds them; the kernel's own (`hw.*`) are left out.
   */
  docs?: DocView[];
  /**
   * External side effects of the unsafe example tools, read from the
   * session's ledger (outside the log and the workspace). Present only for
   * sessions that called one.
   */
  ledger?: LedgerEntry[];
}

/** The Drive's last snapshot (`hw.sandbox-files`), as the Files panel shows it. */
export interface DriveView {
  /** When it was taken (ms since the epoch). */
  at: number;
  /** Some paths are not in it (its 500-entry and 48 KB bounds, or a deadline). */
  truncated: boolean;
  files: DriveFileView[];
}

export interface DriveFileView {
  /** `/workspace/...`. */
  path: string;
  bytes: number;
  mtimeMs: number;
  directory?: true;
  link?: true;
  /** A directory listed by name only (`node_modules`, `.git`). */
  skipped?: true;
  binary?: true;
  /** Its text, when the snapshot keeps it (small UTF-8 files). */
  text?: string;
}

/** A mutating call on the Drive since the last snapshot, from the live stream (`drive_files`). */
export interface DriveChange {
  tool: string;
  callId: string;
  /** The paths it named; none for a shell command (it may have changed anything). */
  paths?: string[];
  t: number;
}

/** A document in the log: its kind, the revision the log is at, its value. */
export interface DocView {
  kind: string;
  revision: number;
  value: unknown;
}

/** One external side effect (harness-world-hands `LedgerRecord`). */
export interface LedgerEntry {
  ref: string;
  tool: string;
  /** The tool call's memo key: the same across every attempt of one call. */
  callKey: string;
  stepId?: string;
  input: Record<string, unknown>;
  at: number;
}

/** One row of the raw log. Payloads are fetched on demand with `event()`. */
export interface EventView {
  eventId: string;
  eventType: string;
  correlationId?: string;
  stepName?: string;
  createdAt: string;
  /** 1-based position in the log. */
  index: number;
}

export interface EventPage {
  events: Omit<EventView, 'index'>[];
  cursor?: string;
}

/**
 * A client's `inspect` throws this for a session its World does not have
 * (the server answers 404). Recognised by its `notFound` flag, never by
 * `instanceof`: a lazy client chunk may carry its own copy of this module.
 */
export class SessionNotFound extends Error {
  readonly notFound = true;
  constructor(readonly sessionId: string) {
    super(`No session ${sessionId} on this deployment.`);
  }
}
export const isSessionNotFound = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { notFound?: unknown }).notFound === true;

export interface SendOptions {
  crash?: boolean;
}

/** How a client starts a session. */
export interface StartOptions {
  /** Where the model's commands and files go (`Hands`). */
  hands?: Hands;
}

/** What a client may say about a message it sent (harness-world-bench's `SendReceipt`). */
export interface SendReceipt {
  /**
   * How long the session refused the message as not ready yet (eve's `409
   * session_not_ready` while a prewarmed session's inbox starts), until the
   * attempt it accepted: the session starting, which the other lanes pay in
   * `start()`. A turn's clock starts after it.
   */
  notReadyMs?: number;
}

/** Where a deployment's sessions show in Vercel Agent Runs (the server says, on Vercel only). */
export interface AgentRunsLink {
  /** `https://vercel.com/<team>/<project>/observability/agent-runs` */
  base: string;
  environment: string;
}

export interface DemoClient {
  mode: Mode;
  /** What this client runs. Default `on`. */
  durability?: Durability;
  worldName: WorldName;
  /** Whether arming a crash does anything (the server may run with HARNESS_CHAOS=0). */
  chaosEnabled: boolean;
  /** Whether fx can run (in the tab it needs WebAssembly JSPI). */
  fxAvailable: boolean;
  /** The process harnesses this server registered (Server mode). */
  harnesses?: HarnessOption[];
  /** The port the server answered on (a dev proxy in front of it has a port of its own). */
  serverPort?: string;
  /** On Vercel: where this client's sessions show in Agent Runs. */
  agentRuns?: AgentRunsLink;
  /** Why this server can't make Vercel Sandbox VMs (the `machine` and `sandbox` hands), when it can't. */
  sandboxReason?: string;
  list(): Promise<SessionRow[]>;
  /**
   * Without a prompt the session starts idle (used to arm a crash before the
   * first prompt). `hands`: recorded on its `run_created` (`config.hands`);
   * without them the server picks the harness's default.
   */
  start(harness: string, prompt?: string, options?: StartOptions): Promise<string>;
  /**
   * `crash`: a crash is armed for the turn this message starts (or joins):
   * a server that runs drills in a Function of their own sends it there.
   */
  send(id: string, text: string, kind: 'prompt' | 'steer', options?: SendOptions): Promise<void | SendReceipt>;
  inspect(id: string): Promise<SessionView>;
  /** Events after `cursor`, without payloads. */
  events(id: string, cursor?: string): Promise<EventPage>;
  /** One event's decoded payload. */
  event(id: string, eventId: string): Promise<unknown>;
  /** Live events. `onReady`, if the client supports it (`signalsReady`), fires once the subscription is attached. */
  live(id: string, onEvent: (event: any) => void, onReady?: () => void): () => void;
  signalsReady?: boolean;
  /**
   * Hints: `onHint` fires when a commit lands, so a read now finds it. With
   * hints (or `livePushes`), the page's refresh follows them and its busy
   * poll is only a fallback (5 s).
   */
  hints?(id: string, onHint: () => void): () => void;
  /** Every commit also shows up on `live` (as a mark): refreshing on live events is enough. */
  livePushes?: boolean;
  /** Composer focus / first keystroke: warm what the next send needs. Fire and forget. */
  warm?(id?: string): void;
  /** Arm a crash of whatever process drives the session (see harness-world chaos.ts). */
  chaos(id: string, spec: ChaosSpec): Promise<void>;
  /** Withdraw a crash still armed (it never fired). Clients without it leave a crash armed. */
  disarm?(id: string): Promise<void>;
  /** Set when something outside this client blocks it (another tab holds the queue). */
  blocked?(): Promise<string | undefined>;
  /** Release what the client keeps open (subscriptions, timers). A page that is done with a client calls it; the client is not used after. */
  close?(): void;
}

/** Each mode's client module, imported on demand (prefetch = just the import). */
/** `durability`: `run-ahead` asks the client for sessions that run ahead of durability. */
export type ClientOptions = { durability?: 'run-ahead' };
export type ClientLoaders = Record<Mode, () => Promise<{ createClient(options?: ClientOptions): Promise<DemoClient> }>>;

/** Durability off, per mode where it exists (a raw harness cannot move between lanes, so not Hybrid). */
export type RawClientLoaders = Partial<Record<Mode, () => Promise<{ createClient(): Promise<DemoClient> }>>>;

/** A session's page in Vercel Agent Runs (its run id is the session id). */
export function agentRunsUrl(link: AgentRunsLink, runId: string): string {
  return `${link.base}/${encodeURIComponent(runId)}?environment=${encodeURIComponent(link.environment)}`;
}
