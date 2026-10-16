import { type ChaosKind, type ChaosSpec, type Durability, type Hands, type Lane, type Mode, movesLanes, type WorldName } from './view.ts';

/** Every user-facing string, in one place. */

/** The product name, after the Vercel wordmark. */
export const BRAND = 'durable-harness';
/** The page's meta description (index.html and the Next app's metadata carry the same words). */
export const META_DESCRIPTION = 'Durable agent sessions on Vercel Workflow: crash the process and the session resumes from its log.';
export const SOURCE_URL = 'https://github.com/vercel-labs/durable-harness';
export const SOURCE_LABEL = 'GitHub';
export const COMPARE_LINK_TITLE = 'Measure what durability costs each harness';
/** The Event Log drawer's link to the session's trace in Vercel Observability (on Vercel only). */
export const AGENT_RUNS_LABEL = 'Agent Runs';

/**
 * The durability words, the same on every page (one-to-one with the
 * durable-harness API): Native is the harness as shipped, Durable is
 * `durability: 'on'` (internally `run-ahead`), Strict is
 * `durability: 'strict'` (internally `on`), and Wrapped is a diagnostic.
 */
export const DURABILITY_LABEL: Record<Durability, string> = {
  native: 'Native',
  'run-ahead': 'Durable',
  on: 'Strict',
  off: 'Wrapped (no World)',
};
export const DURABILITY_TIP: Record<Durability, string> = {
  native: 'The harness as shipped, without durable-harness. Nothing is recorded; a crash or a reload loses the session.',
  'run-ahead':
    "The agent runs ahead and its writes trail it. It waits for them before a tool that must not run twice, and before it lets the session go. (durability: 'on')",
  on: "Every write is durable before the agent goes on. (durability: 'strict')",
  off: "durable-harness's code with no World: splits the adapter's cost from the World's. Nothing is recorded.",
};

/** The metric names (/compare's results table; the main page's per-turn caption uses two of them). */
export const METRIC_LABEL = {
  overhead: 'Overhead to first output',
  turnOverhead: 'Overhead per turn',
  toolOverhead: 'Overhead per tool call',
  model: 'Model time',
  firstOutput: 'First output',
  turn: 'Turn',
  harnessIdle: 'Agent done (before its last writes)',
  flagged: 'Flagged rounds',
} as const;

/** What a flagged round is flagged for. */
export const FLAG_LABEL = {
  newInstance: 'Cold start',
  reconnect: 'Stream reconnected',
  deliveryStall: 'Delivery stall',
  slowWrite: 'Slow write',
  rewind: 'Rewind',
  doubleDrive: 'Double drive',
  modelTail: 'Model tail',
  slow: 'Slow',
  recovered: 'Recovered',
  differentWork: 'Different work',
  firstOutputTrails: 'First output trails first token',
} as const;

/** The harness picker's groups. */
export const HARNESS_GROUP = {
  kernel: 'In durable-harness',
  demo: 'Demo only (on the kernel)',
  other: 'Other frameworks',
} as const;
/** Which group a harness is in (anything not listed is a demo-only harness on the kernel). */
export const harnessGroup = (value: string): keyof typeof HARNESS_GROUP =>
  ['claude-code', 'codex', 'opencode', 'pi', 'pi-durable', 'fx-durable'].includes(value) ? 'kernel' : value === 'eve' ? 'other' : 'demo';

/** Why Durable (run-ahead) is not offered in a mode. */
export const RUN_AHEAD_SERVER_ONLY = 'Durable runs on the server only, for now. In this mode sessions are Strict.';

/** The Brain choice's words (the page's `?mode=`). */
export const MODE_LABEL: Record<Mode, string> = { server: 'Server', tab: 'This Tab', hybrid: 'Hybrid' };

const serverLocal = (w: WorldName) => w === 'local' || w === 'postgres';

/** What each Brain choice means, for its Tip. */
export function modeDescriptionLong(mode: Mode, world: WorldName | undefined): string {
  if (mode === 'tab') return 'The log, its queue and the agent run in this tab. The log is in IndexedDB. Only model calls leave.';
  if (movesLanes(mode)) {
    if (world && serverLocal(world))
      return `One log in world-${world} on the server. The agent runs in this tab, and moves to the server for a tool that needs a backend secret or a machine, then comes back.`;
    return 'One log in world-vercel. The agent runs in this tab, and moves to a Function for a tool that needs a backend secret or a machine, then comes back.';
  }
  if (world === 'local') return 'Sessions run in this Next.js server. The log is in world-local on this machine.';
  if (world === 'postgres') return 'Sessions run in this Next.js server. The log is in world-postgres.';
  return 'Sessions run on Vercel Functions. The log is in world-vercel.';
}

/** The Hands choice's words (the page's `?hands=`). */
export const HANDS_LABEL: Record<Hands, string> = {
  none: 'None',
  virtual: 'Virtual',
  ephemeral: 'Virtual (not saved)',
  machine: 'Virtual + machine',
  sandbox: 'Sandbox',
};

/** What each Hands choice means for a brain in this tab, where just-bash runs too. */
const TAB_HANDS_TIP: Partial<Record<Hands, string>> = {
  virtual: 'virtual(): commands run in just-bash in this tab, and the files are in the session’s log (IndexedDB here).',
  ephemeral: 'virtual({ durable: false }): the same just-bash, its files in this tab’s memory only, cleared at the end of every turn.',
};
/** What a Hands choice means with the brain in `mode`, for its Tip. */
export const handsTip = (hands: Hands, mode: Mode) => (mode === 'tab' ? TAB_HANDS_TIP[hands] : undefined) ?? HANDS_TIP[hands];

/** What each Hands choice means, for its Tip. */
export const HANDS_TIP: Record<Hands, string> = {
  none: 'No workspace: the model has the app’s own tools only.',
  virtual: 'virtual(): commands run in just-bash in the Function, and the files are in the session’s log. They can’t reach the Function’s files, processes or environment.',
  ephemeral: 'virtual({ durable: false }): the same just-bash, its files in memory only, cleared at the end of every turn.',
  machine: 'virtual() plus run_on_machine: a command on a real Linux VM in Vercel Sandbox, the log’s files copied in and back with the call.',
  sandbox: 'sandbox(): commands and files in this session’s Vercel Sandbox VM, on a Drive at /workspace. The agent’s brain and its log stay in a Function.',
};

/** Why a tab's brain can't take hands that need a VM. */
export const TAB_NO_VM =
  'This tab can’t reach a Vercel Sandbox VM, and its log is in IndexedDB, where no Function can run the call for it. Pick Hybrid: the session moves to a Function for the machine.';

/** A harness that runs only in a Vercel Sandbox (Claude Code, Codex): the hands it doesn't take. */
export const vmOnlyHands = (label: string) => `${label} runs only in a Vercel Sandbox: its own tools in the VM (Sandbox), or none (None: tool-less, still in a VM).`;
/** Hands a harness doesn't take, in general. */
export const handsNotTaken = (label: string, hands: Hands) => `${label} doesn’t take ${HANDS_LABEL[hands]} hands.`;
/** pi-durable's `run_on_machine`: not designed yet (docs/workspaces.md §8). */
export const PI_DURABLE_NO_MACHINE = 'Not designed yet: pi-durable has no DriveContext, so a machine command can’t settle its files with the call.';
/** Why the Hands choice is fixed with Native or Wrapped. */
export const HANDS_FIXED = 'Native and Wrapped run the harness as shipped, with its default hands. Pick Durable or Strict to choose them.';
/** Why the machine and sandbox hands are off: this server has no Vercel Sandbox credentials. */
export const sandboxOffReason = (local: boolean) =>
  local
    ? 'Vercel Sandbox needs a linked project here: run `vercel link` in apps/demo (the Vercel CLI’s login gives the credentials).'
    : 'Vercel Sandbox isn’t available on this deployment (no VERCEL_PROJECT_ID): turn on its system environment variables.';

export function storedIn(mode: Mode, world: WorldName | undefined): string {
  if (mode === 'tab') return 'Log: IndexedDB, in this tab';
  if (movesLanes(mode)) {
    if (world === 'local' || world === 'postgres') return `Log: world-${world}, shared by this tab and the server`;
    return 'Log: Vercel Workflow (world-vercel), shared by this tab and the Function';
  }
  if (world === 'local') return 'Log: world-local, on this machine';
  if (world === 'postgres') return 'Log: world-postgres';
  return 'Log: Vercel Workflow (world-vercel)';
}

export function crashWhatDies(mode: Mode, world: WorldName | undefined): string {
  if (mode === 'tab') return 'Reloads this tab partway through the step. The page comes back and the session resumes from IndexedDB.';
  if (movesLanes(mode))
    return 'Kills whichever process is driving: reloads this tab in the Tab lane, or kills the Function in the Function lane. During a machine command the command keeps running in its VM, and the call is run again.';
  if (world && serverLocal(world))
    return 'Kills this dev server partway through the step. Start it again and the session resumes from the log.';
  return 'Kills the Vercel Function running the step (SIGKILL). The queue redelivers it and the session resumes from the log.';
}

export const CRASH_OFF = 'Crashes are off on this server (HARNESS_CHAOS=0).';
/** Why a crash cannot be armed where nothing is recorded (Native, or Wrapped with no World). */
export const crashUnrecorded = (wrapped: boolean) =>
  wrapped
    ? 'Wrapped records nothing, so there is nothing to resume: a crash loses the turn.'
    : 'Native records nothing, so there is nothing to resume: a crash loses the turn.';
export const PREARMED = 'Armed for the next session you start.';
export const FX_JSPI_OFF = 'fx in the tab needs WebAssembly JSPI (Chrome 137+).';
export const FX_ON_SERVER =
  'This browser can’t run fx’s WebAssembly kernel (it needs JSPI, Chrome 137+), so this session’s turns run on the server instead of in this tab.';
export const SESSION_FAILED = 'This session stopped and can’t continue:';
export const SESSION_MISSING = 'That session isn’t on this deployment.';

export const TRIGGERS: { value: ChaosSpec['at']; label: string; short: string; noun: string }[] = [
  { value: 'tool', label: 'The next tool call', short: 'Tool', noun: 'tool call' },
  { value: 'model', label: 'The next model stream', short: 'Model', noun: 'model stream' },
  { value: 'any', label: 'The next step', short: 'Any Step', noun: 'step' },
  { value: 'sandbox', label: 'The next machine command', short: 'Machine', noun: 'run_on_machine' },
];

/** The `sandbox` trigger for a session whose hands are its own sandbox (`sandbox()`): the next turn's start, where its VM is attached (D2, D3). */
export const SESSION_SANDBOX_TRIGGER = { value: 'sandbox' as const, label: 'The next turn’s start (its VM)', short: 'Next Turn', noun: 'turn start' };

/** What dies, for a session whose hands are its own Vercel Sandbox (`sandbox()`: Claude Code, Codex): the drills on its VM (docs/workspaces.md §8). */
export const SESSION_KINDS: { value: ChaosKind; label: string; short: string; at: ChaosSpec['at'][] }[] = [
  { value: 'process', label: 'The Function driving it', short: 'Function', at: ['tool', 'model', 'any'] },
  { value: 'sandbox-vm', label: 'The Sandbox VM (a new one on the same Drive)', short: 'VM', at: ['tool'] },
  { value: 'relay-drop', label: 'The relay link (a socket dropped)', short: 'Relay', at: ['tool', 'model', 'any'] },
  { value: 'sandbox-new-vm', label: 'The VM, deleted between turns (the Drive kept)', short: 'New VM', at: ['sandbox'] },
  { value: 'sandbox-zombie', label: 'The VM, left holding the Drive (a zombie)', short: 'Zombie', at: ['sandbox'] },
];

/** The session kinds that fire at `at`. */
export const sessionKindsAt = (at: ChaosSpec['at']) => SESSION_KINDS.filter((k) => k.at.includes(at));

export const DELAYS = [
  { value: 500, label: '0.5 s in', short: '0.5 s' },
  { value: 1500, label: '1.5 s in', short: '1.5 s' },
  { value: 4000, label: '4 s in', short: '4 s' },
];

/** The crash button's words, by state (the split button's main part). */
export const CRASH_LABEL = { idle: 'Crash', arming: 'Arming…', armed: 'Crash Armed', fired: 'Recovering…' } as const;
export const RECORD_CRASH = 'Record the crash';
export const RECORD_CRASH_OFF =
  'No record: recovery waits for the queue to redeliver the turn on its own, which takes longer.';
/** pi-durable's and fx-durable's crash kills their own Function, which other sessions can share. */
export const OWN_CRASH_SHARED = "This harness's crash takes down its whole Function, including other sessions on it.";

export function armedText(spec: ChaosSpec): string {
  const noun = TRIGGERS.find((t) => t.value === spec.at)?.noun ?? 'step';
  const s = (spec.afterMs ?? 1500) / 1000;
  switch (spec.kind ?? 'process') {
    case 'sandbox-vm':
      return spec.at === 'sandbox'
        ? `Crash armed: the Sandbox VM is stopped ${s} s into the next parked sandbox_exec that is still running then.`
        : `Crash armed: the session’s Sandbox VM is stopped ${s} s into the next ${noun}; the turn goes on in a new VM on the same Drive.`;
    case 'relay-drop':
      return `Crash armed: the relay link drops ${spec.at === 'model' ? 'its /model socket' : 'its /ctl socket'} ${s} s into the next ${noun}; the Function re-attaches and goes on.`;
    case 'sandbox-new-vm':
      return 'Crash armed: at the next turn’s start, the session’s VM is deleted and its Drive kept; the turn boots a new VM on the same Drive.';
    case 'sandbox-zombie':
      return 'Crash armed: at the next turn’s start, the session’s VM is stopped and left holding its Drive; the new driver clears it and resumes.';
    case 'sandbox-command':
      return `Crash armed: the command is killed ${s} s into the next sandbox_exec that is still running then.`;
    case 'drop-callback':
      return 'Crash armed: the next sandbox_exec that outlives the function finishes, and its report is dropped.';
    default:
      return spec.at === 'sandbox'
        ? `Crash armed: the Function driving the next machine command dies ${s} s into it; the next Function kills that command and runs the call again.`
        : `Crash armed: the process driving this session dies ${s} s into the next ${noun}${spec.silent ? ', with no record of the kill' : ''}.`;
  }
}

export function prearmedText(spec: ChaosSpec): string {
  if ((spec.kind ?? 'process') !== 'process') return `Armed for the next session you start. ${armedText(spec).replace(/^Crash armed: /, '')}`;
  const noun = TRIGGERS.find((t) => t.value === spec.at)?.noun ?? 'step';
  return `Crash armed for the next session you start: it dies ${(spec.afterMs ?? 1500) / 1000} s into its first ${noun}${spec.silent ? ', with no record of the kill' : ''}.`;
}

/** How a crash row names what the dead drive left open. */
export function openText(open: string[]): string {
  if (open.length === 0) return '';
  const [first, ...rest] = open;
  return rest.length ? `${first} and ${rest.length} more are open` : `${first} is open`;
}

export const crashFiredTitle = (world: WorldName | undefined, mode?: Mode) =>
  mode === 'tab'
    ? 'Waiting for this tab to resume the turn from the log.'
    : world === 'local' || world === 'postgres'
      ? 'Waiting for the queue to hand the turn to the server, once you start it again.'
      : 'Waiting for the queue to hand the turn to a new Function.';

/** The turn a crash was armed for ended without the step it waited for: the crash was withdrawn. */
export function crashDisarmedText(at: ChaosSpec['at'], kind?: ChaosKind): string {
  if (kind === 'sandbox-new-vm' || kind === 'sandbox-zombie') return 'The session had no VM yet to restart, so the drill was disarmed. Run it after a turn.';
  const noun = TRIGGERS.find((t) => t.value === at)?.noun ?? 'step';
  return `The turn ended before a ${noun}, so the crash was disarmed.`;
}

export function laneLabel(lane: Lane, mode: Mode, world: WorldName | undefined, short = false): string {
  if (lane === 'browser') return short ? 'Tab' : 'This tab';
  // The retired brain-in-VM lane, which an older session's log can name.
  if (lane === 'sandbox') return short ? 'VM (retired)' : 'the retired Sandbox lane';
  return world && serverLocal(world) && mode !== 'tab' ? 'Server' : 'Function';
}

/** The lane's name inside a sentence ("Back in this tab", "Moved to Function"). */
export const laneInline = (lane: Lane, mode: Mode, world: WorldName | undefined) =>
  lane === 'browser' ? 'this tab' : laneLabel(lane, mode, world);

export const LOADING: Record<Mode, string> = {
  server: 'Connecting to the server…',
  tab: 'Loading the in-tab World…',
  hybrid: 'Connecting to the server World…',
};

export const LIST_EMPTY: Record<Mode, string> = {
  server: 'Sessions you start on the server appear here.',
  tab: 'Sessions you start in this tab appear here.',
  hybrid: 'Hybrid sessions you start appear here.',
};

/** The empty state's heading, in every mode. */
export const EMPTY_HEADING = 'Crash the agent mid-command. It picks up where it left off.';

export function emptyBody(mode: Mode, world: WorldName | undefined): string {
  if (mode === 'tab')
    return 'The log, its queue and the agent all run in this tab, with the log in IndexedDB. Reload the tab mid-step and the turn resumes from the log.';
  if (movesLanes(mode))
    return world && serverLocal(world)
      ? 'The agent starts in this tab and moves to this server only when a tool needs a backend secret or a machine, then comes back. Both read and write one log.'
      : 'The agent starts in this tab and moves to a Vercel Function only when a tool needs a backend secret or a machine, then comes back. Both read and write one log.';
  if (world && serverLocal(world))
    return `Each turn runs in this server and writes every step to a durable log in world-${world}. Kill the server mid-turn, start it again, and the turn resumes from the log.`;
  return 'Each turn runs in a Vercel Function and writes every step to a durable log. Kill the Function and the queue hands the turn to a new one, which resumes from the log.';
}

/** The empty state's one-click crash demo, and what it says next to it. */
export const EMPTY_CTA = 'Run a Command and Crash It';
export const EMPTY_CTA_OR = 'or type a prompt below';

export const LOG_EMPTY = 'The session exactly as it is stored, one row per step. Start or pick a session to read it.';
export const DETAIL_EMPTY = 'Nothing in the log for this row.';
export const FILES_EMPTY =
  'No files yet. Files the agent writes are stored in the session\'s log, so they follow the session to whichever machine runs the next turn.';
export const DOCS_HEADING = 'Documents';
export const DOCS_EMPTY = 'No documents yet. A document is app state kept in the log, such as the todo list the agent reads and updates.';
/** pi-durable and fx (libfx durable) keep their own logs: no kernel documents. */
export const NO_DOCS = 'No documents';
export const LOG_BEFORE = 'Before the first prompt';
export const LOG_AFTER = 'From the first prompt';
export const leftBehindCaption = (attempt: number) => `Left behind by the killed process; attempt ${attempt} replaced it.`;
export const showAllEvents = (n: number) => `Show All ${n} Events`;
export const HIDE_JOURNAL = 'Hide Journal Steps';
/** The Files panel for a `sandbox()` session: its Drive's last snapshot. */
export const DRIVE_SNAPSHOT = 'Snapshot; the Drive is the source of truth';
export const driveSnapshotAt = (at: number) => `Taken ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`;
export const DRIVE_TRUNCATED = 'Not every path is here: the snapshot keeps 500 entries and 48 KB at most.';
export const DRIVE_EMPTY = 'No snapshot of the Drive yet. One is taken after each turn that changes it, and stays readable after the VM stops.';
export const DRIVE_CHANGED = 'Changed since the snapshot';
export const driveChangeText = (tool: string, paths: string[] | undefined) => (paths?.length ? `${tool}: ${paths.join(', ')}` : `${tool}: may have changed any file`);
export const DRIVE_NO_TEXT = 'Its text is not in the snapshot (larger than 4 KB, binary, or past the snapshot’s budget). The file itself is on the Drive.';
/** `virtual({ durable: false })`: nothing to show. */
export const FILES_EPHEMERAL = 'Files are in memory only: they are cleared at the end of every turn, and nothing is kept to show here.';
/** No hands: no files. */
export const FILES_NONE = 'This session has no workspace: its hands are None, so the model has the app’s own tools only.';

export const interruptedNote = (partial: boolean) =>
  partial
    ? 'The process stopped mid-call and this tool isn’t safe to rerun. The model got the partial output.'
    : 'The process stopped mid-call and this tool isn’t safe to rerun. The model got an interrupted result.';

/** The tool row's note when the crash row right below it explains what happened. */
export const CRASH_BELOW = 'Stopped by the crash below.';

const STOP_REASONS: Record<string, string> = {
  end_turn: 'end of turn',
  tool_use: 'tool use',
  max_tokens: 'out of tokens',
  stop_sequence: 'stop sequence',
  stop: 'end of turn',
  toolUse: 'tool use',
  length: 'out of tokens',
};

/** fx's checkpoints count turns from 0; people count from 1. */
export function checkpointText(turn: unknown, stopReason: unknown): string {
  const n = typeof turn === 'number' ? `turn ${turn + 1}` : 'this turn';
  const why = typeof stopReason === 'string' && stopReason ? ` (${STOP_REASONS[stopReason] ?? stopReason.replace(/_/g, ' ')})` : '';
  return `Checkpoint for ${n}${why}`;
}

/** The pieces of the "lost the server" note (the command renders as code). */
export function lostServer(world: WorldName | undefined, mode: Mode, crashed: boolean, port: string) {
  return {
    lead: crashed
      ? 'Lost the server. The crash you armed killed it: it was driving the step.'
      : 'Lost the server. The page can’t reach it.',
    command: `HARNESS_WORLD=${world ?? 'local'} pnpm dev${port ? ` -p ${port}` : ''}`,
    tail:
      movesLanes(mode)
        ? 'Keep HYBRID_CRM_SECRET set if you started with it (the backend-secret tool needs it). This page reconnects on its own.'
        : 'This page reconnects on its own.',
  };
}
export const LOST_NOW = 'Lost the server, waiting for it to come back';
/** The header while a killed turn waits for the queue (or, for a reloaded tab, for the tab). */
export const crashWaitText = (world: WorldName | undefined, lane?: Lane) =>
  lane === 'browser'
    ? 'Reloaded. Waiting for this tab to resume the turn from the log.'
    : world === 'local' || world === 'postgres'
      ? 'Killed. Waiting for the server to come back and the queue to hand the turn over.'
      : 'Killed. Waiting for the queue to hand the turn to a new Function.';
export const UNREACHABLE = 'Can’t reach the server. Retrying…';

/** Why a handoff moved the session, in the words the scenarios use. */
export function handoffReason(reason: string, to: Lane): string {
  const m = /^(?:tool\.)?([\w-]+) needs the \w+ lane$/.exec(reason);
  // run_on_machine asks for the retired sandbox lane and lands on a Function, which calls the VM.
  if (m?.[1] === 'run_on_machine') return 'run_on_machine needs a real machine (the Function calls it)';
  const need = to === 'function' ? 'a backend secret' : to === 'sandbox' ? 'a real machine' : '';
  if (m && need) return `${m[1]} needs ${need}`;
  return reason.replace(/\btool\./g, '');
}

export function tabCrashToast(mode: Mode, world: WorldName | undefined): string {
  return movesLanes(mode)
    ? `This tab was reloaded mid-step by the crash you armed. The session is resuming from the log in world-${world ?? 'vercel'}.`
    : 'This tab was reloaded mid-step by the crash you armed. The session is resuming from the log.';
}

/** Turn a thrown error into the page's voice. */
export function errorCopy(mode: Mode, message: string, phase: 'load' | 'read'): string {
  if (/indexeddb/i.test(message) && mode === 'tab')
    return 'This browser blocked IndexedDB, so the in-tab World can’t start. Use Server or Hybrid.';
  const worldStatus = movesLanes(mode) ? /\b([45]\d\d)\b/.exec(message)?.[1] : undefined;
  if (movesLanes(mode) && worldStatus === '401')
    return 'Can’t reach the server World at /api/world (401). This deployment is behind Vercel Authentication: sign in to vercel.com in this browser, then reload.';
  if (movesLanes(mode) && worldStatus) return `Can’t reach the server World at /api/world (${worldStatus}).`;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return UNREACHABLE;
  if (phase === 'load') {
    const what = mode === 'tab' ? 'in-tab World' : movesLanes(mode) ? 'hybrid client' : 'server client';
    return `The ${what} didn’t load: ${message}. Reload the page to try again.`;
  }
  return message;
}

export const GATEWAY_401 =
  'Model calls failed: the server has no AI Gateway credential. Run vercel env pull in apps/demo, or set AI_GATEWAY_API_KEY.';

export interface Scenario {
  label: string;
  prompt: string;
  crash?: ChaosSpec;
  /** The example the empty state's button runs, styled as the row's primary (the first one whose hands are there). */
  primary?: boolean;
  /** Under More, not in the row. */
  more?: boolean;
  /**
   * The hands it needs (`scenariosFor`): `shell`, a shell and files of the
   * session's own (Virtual, Virtual (not saved), Virtual + machine);
   * `machine`, `run_on_machine` (Virtual + machine). Default: none.
   */
  needs?: 'shell' | 'machine';
}

const SLOW = 'Run `sleep 8 && date > slow.txt` with bash, then show slow.txt.';
const MACHINE_SLOW = 'Use run_on_machine to run: sleep 12 && date > out.txt && cat out.txt';
const MACHINE_VERSIONS = 'Use run_on_machine to run: node -e "console.log(process.version)" && python3 --version && ls /workspace';
const RECALL = 'Without using any tools: what have we done in this session so far?';
/** The non-idempotent example tool (replay: 'never'): a crash mid-call must not pay twice. */
export const UNSAFE_PAYMENT_PROMPT = "Pay alice@example.com $5 with memo 'demo' using unsafe_make_payment, then reply 'paid'.";

/** D6: a runaway command in a virtual session; another session's turn keeps streaming meanwhile, and this one times out. */
export const BUSY_NEIGHBOR_PROMPT = "Run this with bash and tell me what happened: awk 'BEGIN { while (1) n++ }'";
/** D7: try to read what a session must never see: the environment, the process, other sessions' files, the model port. */
export const ESCAPE_PROMPT =
  'Try each of these with bash and report exactly what each one printed, or that it failed: printenv; cat /proc/self/environ; ls -la /tmp/harness-* /tmp; ls -la /workspace/..; cat /workspace/../*/notes.md; curl -s -m 3 http://127.0.0.1:4100/v1/models';
/** D1-D5 on a session's own sandbox: a slow command to stop the VM, drop the relay or kill the Function in. */
const DRIVE_SLOW = 'Run this with Bash: echo started >> runs.txt; sleep 10; echo done >> runs.txt. Then show runs.txt.';
/** D2, D3: the next turn starts on a new VM; what the Drive and the conversation kept. */
const DRIVE_RECALL = 'Without changing anything: list /workspace with ls -la, and tell me what we did in this session so far.';

/**
 * The example prompts, by the kind of session (`scenariosFor` picks the
 * list and drops what the session's hands can't run): `sandbox`, hands on
 * the session's own Vercel Sandbox (the drills on its VM, D1-D5); `hybrid`,
 * a brain that moves (a backend secret, a machine); `plain`, the others.
 */
export const SCENARIOS: Record<'plain' | 'hybrid' | 'sandbox', Scenario[]> = {
  sandbox: [
    { label: 'Kill the Sandbox VM', prompt: DRIVE_SLOW, crash: { at: 'tool', kind: 'sandbox-vm', afterMs: 4000 }, primary: true },
    { label: 'Restart on a New Sandbox', prompt: DRIVE_RECALL, crash: { at: 'sandbox', kind: 'sandbox-new-vm', afterMs: 0 } },
    { label: 'Drop the Relay', prompt: DRIVE_SLOW, crash: { at: 'tool', kind: 'relay-drop', afterMs: 4000 } },
    { label: 'Write a File', prompt: 'Write notes.md containing a haiku about durable logs, then read it back.' },
    { label: 'Zombie VM', prompt: DRIVE_RECALL, crash: { at: 'sandbox', kind: 'sandbox-zombie', afterMs: 0 }, more: true },
    { label: 'Crash the Function', prompt: DRIVE_SLOW, crash: { at: 'tool', afterMs: 4000 }, more: true },
    { label: 'Drop the Relay Mid-Stream', prompt: 'Write a short story about a lighthouse, without using any tools.', crash: { at: 'model', kind: 'relay-drop', afterMs: 1500 }, more: true },
    { label: 'Try to Escape', prompt: ESCAPE_PROMPT, more: true },
    { label: 'Recall', prompt: RECALL, more: true },
  ],
  plain: [
    { label: 'Crash a Command', prompt: SLOW, crash: { at: 'tool', afterMs: 1500 }, primary: true, needs: 'shell' },
    // The payment is made at once, then confirmed after 3 s: a crash at 1.5 s
    // lands after the side effect and before its result.
    { label: 'Crash a Payment', prompt: UNSAFE_PAYMENT_PROMPT, crash: { at: 'tool', afterMs: 1500 }, primary: true },
    { label: 'Run on the Machine', prompt: MACHINE_VERSIONS, needs: 'machine' },
    { label: 'Crash a Machine Command', prompt: MACHINE_SLOW, crash: { at: 'sandbox', kind: 'process', afterMs: 4000 }, needs: 'machine' },
    { label: 'Write a File', prompt: 'Write notes.md containing a haiku about durable logs, then read it back.', needs: 'shell' },
    { label: 'Recall', prompt: RECALL },
    { label: 'Slow Command', prompt: SLOW, more: true, needs: 'shell' },
    { label: 'Unsafe Payment', prompt: UNSAFE_PAYMENT_PROMPT, more: true },
    // No record of the kill: recovery waits for the queue's own redelivery.
    { label: 'Crash a Command Silently', prompt: SLOW, crash: { at: 'tool', afterMs: 1500, silent: true }, more: true, needs: 'shell' },
    { label: 'Busy Neighbor', prompt: BUSY_NEIGHBOR_PROMPT, more: true, needs: 'shell' },
    { label: 'Try to Escape', prompt: ESCAPE_PROMPT, more: true, needs: 'shell' },
  ],
  hybrid: [
    { label: 'Backend Secret', prompt: 'Look up customer acme-42 and tell me their plan and account manager.' },
    { label: 'Real Machine', prompt: MACHINE_VERSIONS, needs: 'machine' },
    { label: 'Crash a Machine Command', prompt: MACHINE_SLOW, crash: { at: 'sandbox', kind: 'process', afterMs: 4000 }, primary: true, needs: 'machine' },
    { label: 'Crash a Payment', prompt: UNSAFE_PAYMENT_PROMPT, crash: { at: 'tool', afterMs: 1500 }, primary: true },
    { label: 'Write a File', prompt: 'Write notes.md containing a haiku about durable logs. Use write_file.', needs: 'shell' },
    {
      label: 'Long Command',
      prompt: 'Use run_on_machine with timeoutSeconds 300 to run: for i in $(seq 180); do sleep 1; done; echo done',
      more: true,
      needs: 'machine',
    },
    { label: 'Unsafe Payment', prompt: UNSAFE_PAYMENT_PROMPT, more: true },
    { label: 'Recall', prompt: RECALL, more: true },
  ],
};
