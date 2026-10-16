import {
  HANDS_LABEL,
  handsNotTaken,
  PI_DURABLE_NO_MACHINE,
  SCENARIOS,
  type Scenario,
  SESSION_KINDS,
  SESSION_SANDBOX_TRIGGER,
  TAB_NO_VM,
  TRIGGERS,
} from './copy.ts';
import type { Brain, ChaosKind, ChaosSpec, FilesSource, Hands, HarnessOption } from './view.ts';

// What the server says about hands, in the page's words.
export { HANDS_LABEL, sandboxOffReason, vmOnlyHands } from './copy.ts';
export { BUILTIN_HARNESSES } from './view.ts';

/**
 * The demo's two axes (docs/workspaces.md §8): where the agent's brain runs
 * (`Brain`, the page's `?mode=`) and where the model's commands and files go
 * (`Hands`, `?hands=`), and which combinations each harness takes. Pure: the
 * page reads it to draw its pickers and drills, the server to check what a
 * page asks for (`harness-world-demo-ui/axes`).
 */

export const BRAINS: readonly Brain[] = ['server', 'tab', 'hybrid'];
export const HANDS: readonly Hands[] = ['none', 'virtual', 'ephemeral', 'machine', 'sandbox'];

export const isBrain = (value: unknown): value is Brain => typeof value === 'string' && (BRAINS as readonly string[]).includes(value);
export const isHands = (value: unknown): value is Hands => typeof value === 'string' && (HANDS as readonly string[]).includes(value);

/**
 * `?mode=`: the brain. `sandbox`, the retired brain-in-VM mode, is Server
 * with Sandbox hands now: the brain and its log in a Function, the commands
 * and files in the session's VM.
 */
export function parseMode(value: string | null | undefined): { brain?: Brain; hands?: Hands } {
  if (value === 'sandbox') return { brain: 'server', hands: 'sandbox' };
  return isBrain(value) ? { brain: value } : {};
}

/** `?hands=`. */
export const parseHands = (value: string | null | undefined): Hands | undefined => (isHands(value) ? value : undefined);

/** Both axes from a query string: `?hands=` wins over the hands `?mode=sandbox` implies. */
export function readAxes(search: string | URLSearchParams): { brain?: Brain; hands?: Hands } {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const mode = parseMode(q.get('mode'));
  const hands = parseHands(q.get('hands')) ?? mode.hands;
  return { ...(mode.brain ? { brain: mode.brain } : {}), ...(hands ? { hands } : {}) };
}

/** The hands a harness takes (`HarnessOption.hands`, default Virtual only). */
export const handsOf = (option: Pick<HarnessOption, 'hands'>): readonly Hands[] => option.hands ?? ['virtual'];

/**
 * pi-durable's hands (docs/workspaces.md §8): every one but Virtual +
 * machine, which isn't designed yet (no DriveContext to settle its files
 * through), and Sandbox, which comes with its `sandboxEnv()`.
 */
export const PI_DURABLE_HANDS: Pick<HarnessOption, 'hands' | 'handsDisabled'> = {
  hands: [...HANDS],
  handsDisabled: {
    machine: PI_DURABLE_NO_MACHINE,
    sandbox: "Coming with sandboxEnv(): pi-durable's tools on this session's Vercel Sandbox VM aren't wired up yet. Its brain would stay in the Function.",
  },
};

/** What this deployment can do, for `handsReason`. */
export interface HandsContext {
  /** Why it can't make Vercel Sandbox VMs (the `machine` and `sandbox` hands), when it can't. */
  sandboxOff?: string;
}

/** Hands that need a Vercel Sandbox VM of the session's. */
export const needsVm = (hands: Hands) => hands === 'machine' || hands === 'sandbox';

/**
 * Why `option` can't take `hands` with its brain in `brain`, or undefined
 * when it can: hands it doesn't take (with its own reason, when it gives
 * one), hands it takes but can't here yet (`handsDisabled`: not built,
 * not designed), a tab's brain asking for a VM, or a deployment that can't
 * make one. The brain itself is `harnessDisabledReason`'s to check.
 */
export function handsReason(option: Pick<HarnessOption, 'label' | 'hands' | 'handsDisabled'>, brain: Brain, hands: Hands, ctx: HandsContext = {}): string | undefined {
  const own = option.handsDisabled?.[hands];
  if (!handsOf(option).includes(hands)) return own ?? handsNotTaken(option.label, hands);
  if (own) return own;
  if (brain === 'tab' && needsVm(hands)) return TAB_NO_VM;
  if (needsVm(hands) && ctx.sandboxOff) return ctx.sandboxOff;
  return undefined;
}

/**
 * The hands a new session of `option` gets when the page names none:
 * `defaultHands`, else Virtual; a Hybrid brain's default is Virtual + machine
 * where the harness takes it (a backend secret and a machine are what
 * Hybrid moves for).
 */
export function defaultHandsFor(option: Pick<HarnessOption, 'hands' | 'defaultHands'>, brain: Brain): Hands {
  const taken = handsOf(option);
  if (brain === 'hybrid' && taken.includes('machine')) return 'machine';
  return option.defaultHands ?? (taken.includes('virtual') ? 'virtual' : taken[0]!);
}

/**
 * The hands a new session gets: `wanted` if it can take them here, else
 * its default for this brain, else its default anywhere (Virtual), else the
 * first it can take; with none it can take, its default (the picker says why).
 */
export function pickHands(option: Pick<HarnessOption, 'label' | 'hands' | 'defaultHands' | 'handsDisabled'>, brain: Brain, wanted: Hands | undefined, ctx: HandsContext = {}): Hands {
  const fallback = defaultHandsFor(option, brain);
  for (const h of [wanted, fallback, option.defaultHands ?? 'virtual', ...HANDS]) if (h && !handsReason(option, brain, h, ctx)) return h;
  return fallback;
}

/** Every Hands choice for `option` in `brain`, each with why it is off here, if it is. */
export function handsChoices(option: Pick<HarnessOption, 'label' | 'hands' | 'handsDisabled'>, brain: Brain, ctx: HandsContext = {}): { hands: Hands; label: string; reason?: string }[] {
  return HANDS.map((hands) => {
    const reason = handsReason(option, brain, hands, ctx);
    return { hands, label: HANDS_LABEL[hands], ...(reason ? { reason } : {}) };
  });
}

/**
 * The hands of a session started before the hands axis (its `run_created`
 * has no `config.hands`): what its harness ran with then. Claude Code and
 * Codex were tool-less unless a local flag turned their built-ins on;
 * hybrid sessions had `run_on_machine`; the rest a virtual workspace.
 */
export function legacyHands(harness: string | undefined): Hands {
  if (harness === 'claude-code' || harness === 'codex') return 'none';
  if (harness === 'hybrid' || harness === 'hybrid-fx') return 'machine';
  return 'virtual';
}

/** A session's hands: what its log recorded (`config.hands`), else `legacyHands`. */
export const sessionHands = (view: { harness?: string; hands?: Hands }): Hands => view.hands ?? legacyHands(view.harness);

/** Where the Files panel reads a session's files, from its hands. */
export function filesOf(hands: Hands | undefined): FilesSource {
  if (hands === 'none') return 'none';
  if (hands === 'ephemeral') return 'ephemeral';
  if (hands === 'sandbox') return 'drive';
  return 'log';
}

// ---------- drills ----------

/**
 * Which drills a session's hands fire:
 *
 * - `sandbox`: its own Vercel Sandbox VM (`sandbox()`): D1-D4 on the VM and
 *   its relay, and the Kill Function (D5);
 * - `machine`: `run_on_machine`: the Kill Function, at a tool, the model,
 *   or a machine command. A command waits inside its call, never parked, so
 *   `sandbox-vm`, `sandbox-command` and `drop-callback` don't fire on it
 *   (docs/workspaces.md §8, As built (A8));
 * - `plain`: the Kill Function at a tool, the model or any step.
 */
export type DrillScope = 'sandbox' | 'machine' | 'plain';

export const drillScope = (hands: Hands | undefined): DrillScope => (hands === 'sandbox' ? 'sandbox' : hands === 'machine' ? 'machine' : 'plain');

export type Trigger = (typeof TRIGGERS)[number];

/**
 * The "Crash during" choices for a harness that fires `targets` (default:
 * every one) in a session of `scope`: the next machine command only with
 * a machine, the next turn's start (the VM's attach) only on a session's
 * own sandbox.
 */
export function triggersFor(targets: ChaosSpec['at'][] | undefined, scope: DrillScope): Trigger[] {
  return TRIGGERS.flatMap((t): Trigger[] => {
    if (t.value === 'sandbox') return scope === 'machine' ? [t] : scope === 'sandbox' ? [SESSION_SANDBOX_TRIGGER] : [];
    return targets && !targets.includes(t.value) ? [] : [t];
  });
}

/** The "What dies" choices at `at` in a session of `scope`: empty when only the Function does. */
export function kindsAt(scope: DrillScope, at: ChaosSpec['at']): { value: ChaosKind; label: string; short: string }[] {
  return scope === 'sandbox' ? SESSION_KINDS.filter((k) => k.at.includes(at)) : [];
}

/** Every kind a session of `scope` fires, anywhere. */
export function kindsFor(scope: DrillScope): ChaosKind[] {
  return scope === 'sandbox' ? SESSION_KINDS.map((k) => k.value) : ['process'];
}

/**
 * `spec`, fitted to a session of `scope` whose harness fires `targets`: a
 * target it doesn't fire becomes the next tool call, and a kind that
 * doesn't fire there the first one that does (the Kill Function, outside a
 * session's own sandbox). An armed crash always can fire.
 */
export function fitCrash<T extends ChaosSpec>(spec: T, targets: ChaosSpec['at'][] | undefined, scope: DrillScope): T {
  const triggers = triggersFor(targets, scope).map((t) => t.value);
  const at = triggers.includes(spec.at) ? spec.at : 'tool';
  const kinds = kindsAt(scope, at).map((k) => k.value);
  const kind = spec.kind ?? 'process';
  const fitted: ChaosKind = kinds.length ? (kinds.includes(kind) ? kind : kinds[0]!) : 'process';
  return at === spec.at && fitted === kind ? spec : { ...spec, at, kind: fitted };
}

/**
 * The example prompts for a session with its brain in `brain` and these
 * hands: the drills on its VM with Sandbox hands, Hybrid's moves for a
 * Hybrid brain, the plain ones otherwise; without what one needs (a shell
 * and files, or a machine), it is left out. The first primary that is left
 * is the empty state's button.
 */
export function scenariosFor(brain: Brain, hands: Hands | undefined): Scenario[] {
  if (hands === 'sandbox') return SCENARIOS.sandbox;
  const list = (brain === 'hybrid' ? SCENARIOS.hybrid : SCENARIOS.plain).filter((s) => {
    if (s.needs === 'machine') return hands === 'machine';
    if (s.needs === 'shell') return hands !== 'none';
    return true;
  });
  let primary = false;
  return list.map((s) => {
    if (!s.primary) return s;
    if (primary) {
      const { primary: _, ...rest } = s;
      return rest;
    }
    primary = true;
    return s;
  });
}
