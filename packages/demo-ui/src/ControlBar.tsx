import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BRAINS, type DrillScope, kindsAt, triggersFor } from './axes.ts';
import { Chevron } from './bits.tsx';
import {
  CRASH_LABEL,
  CRASH_OFF,
  crashFiredTitle,
  crashWhatDies,
  DELAYS,
  DURABILITY_LABEL,
  DURABILITY_TIP,
  handsTip,
  HARNESS_GROUP,
  harnessGroup,
  MODE_LABEL,
  modeDescriptionLong,
  PREARMED,
  RECORD_CRASH,
  RECORD_CRASH_OFF,
} from './copy.ts';
import { Picker, type PickerOption } from './Menu.tsx';
import { useTip } from './Tip.tsx';
import type { ChaosSpec, CrashSettings, Durability, Hands, HarnessOption, Mode, WorldName } from './view.ts';

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Its explanation, or why it is disabled: a tip on hover and focus. */
  tip?: string;
}

function Segment<T extends string>({ o, checked, onChoose, onPrefetch }: { o: SegOption<T>; checked: boolean; onChoose(v: T): void; onPrefetch?(v: T): void }) {
  const tip = useTip(o.tip);
  return (
    <>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-disabled={o.disabled || undefined}
        tabIndex={checked ? 0 : -1}
        {...tip.props}
        onClick={() => !o.disabled && onChoose(o.value)}
        onMouseEnter={(ev) => {
          onPrefetch?.(o.value);
          (tip.props as { onMouseEnter?: (e: typeof ev) => void }).onMouseEnter?.(ev);
        }}
      >
        {o.label}
      </button>
      {tip.pop}
    </>
  );
}

/** A radiogroup of buttons: arrow keys move within it, disabled options stay visible and focusable for their reason. */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: SegOption<T>[];
  onChange(v: T): void;
  onPrefetch?(v: T): void;
  className?: string;
}) {
  const { value, options, onChange } = props;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    ev.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + (ev.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (next) {
      onChange(next.value);
      requestAnimationFrame(() => (ev.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    }
  };
  return (
    <div className={`seg ${props.className ?? ''}`} role="radiogroup" aria-label={props.label} onKeyDown={onKey}>
      {options.map((o) => (
        <Segment key={o.value} o={o} checked={o.value === value} onChoose={onChange} {...(props.onPrefetch ? { onPrefetch: props.onPrefetch } : {})} />
      ))}
    </div>
  );
}

export type CrashButtonState = 'idle' | 'arming' | 'armed' | 'fired';

export interface CrashControlProps {
  mode: Mode;
  world?: WorldName;
  enabled: boolean;
  /** Why it is not enabled, when that is not the server's HARNESS_CHAOS=0. */
  disabledReason?: string;
  spec: CrashSettings;
  onSpec(spec: CrashSettings): void;
  /** The targets the harness fires (`HarnessOption.crashes`). Default: every one. */
  targets?: ChaosSpec['at'][];
  state: CrashButtonState;
  /** No session open: the button toggles a pre-arm. */
  prearm: boolean;
  /** Arm with the current settings, or (armed) disarm. */
  onArm(): void;
  /** A note for the settings popover (a harness whose crash kills more than its session). */
  note?: string;
  /** Which drills the session's hands fire (`drillScope`): the ones on its own VM, a machine command's, or the Kill Function's. */
  scope: DrillScope;
}

/** A radio list inside the crash popover. */
function Choices<T extends string | number>(props: { legend: string; name: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void; disabled?: boolean }) {
  return (
    <fieldset className="choices" disabled={props.disabled}>
      <legend>{props.legend}</legend>
      {props.options.map((o) => (
        <label key={String(o.value)}>
          <input type="radio" name={props.name} checked={o.value === props.value} onChange={() => props.onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The crash control: one click arms the current crash (or disarms it), the
 * chevron opens what it does: when, how long into the step, what dies (in a
 * hybrid session), and whether the kill is recorded.
 */
export function CrashControl(props: CrashControlProps) {
  const { enabled, spec, onSpec, state, prearm } = props;
  const [open, setOpen] = useState<{ top: number; right: number }>();
  const pop = useRef<HTMLDivElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent | globalThis.KeyboardEvent) => {
      if (ev instanceof MouseEvent && (pop.current?.contains(ev.target as Node) || chevron.current?.contains(ev.target as Node))) return;
      if (ev instanceof globalThis.KeyboardEvent && ev.key !== 'Escape') return;
      setOpen(undefined);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const label = CRASH_LABEL[state];
  const reason = !enabled
    ? (props.disabledReason ?? CRASH_OFF)
    : state === 'fired'
      ? crashFiredTitle(props.world, props.mode)
      : state === 'armed' && prearm
        ? PREARMED
        : `${crashWhatDies(props.mode, props.world)} (X)`;
  const tip = useTip(reason);
  const busy = state === 'arming' || state === 'fired';
  // Only the drills that fire for the session's harness and hands (`drillScope`).
  const triggers = triggersFor(props.targets, props.scope);
  const kindFor = (at: ChaosSpec['at']) => {
    const kinds = kindsAt(props.scope, at);
    return kinds.some((k) => k.value === spec.kind) ? spec.kind : (kinds[0]?.value ?? 'process');
  };
  const kinds = kindsAt(props.scope, spec.at);
  /** The attach drills fire at a point of their own (the next turn's start), not some time into a step. */
  const timed = !(spec.at === 'sandbox' && (spec.kind === 'sandbox-new-vm' || spec.kind === 'sandbox-zombie'));
  return (
    <div className="crash-split" data-state={state} aria-disabled={!enabled || undefined}>
      <button
        type="button"
        className="btn btn-crash crash-main"
        data-state={state}
        aria-disabled={!enabled || busy || undefined}
        aria-pressed={state === 'armed'}
        {...tip.props}
        onClick={() => enabled && !busy && props.onArm()}
      >
        {label}
      </button>
      {tip.pop}
      <button
        ref={chevron}
        type="button"
        className="btn btn-crash crash-chevron"
        aria-label="Crash settings"
        aria-expanded={!!open}
        aria-disabled={!enabled || undefined}
        onClick={(ev) => {
          if (!enabled) return;
          const r = ev.currentTarget.getBoundingClientRect();
          setOpen((o) => (o ? undefined : { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }));
        }}
      >
        <Chevron />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="popover crash-pop" style={{ position: 'fixed', right: open.right, top: open.top }} role="dialog" aria-label="Crash settings">
            <Choices
              legend="Crash during"
              name="crash-at"
              value={spec.at}
              options={triggers.map((t) => ({ value: t.value, label: t.label }))}
              onChange={(at) => onSpec({ ...spec, at, kind: kindFor(at) })}
            />
            {kinds.length > 1 && <Choices legend="What dies" name="crash-kind" value={spec.kind} options={kinds} onChange={(kind) => onSpec({ ...spec, kind })} />}
            {timed && (
              <Choices legend="How far in" name="crash-after" value={spec.afterMs} options={DELAYS} onChange={(afterMs) => onSpec({ ...spec, afterMs })} />
            )}
            {spec.kind === 'process' && (
              <label className="check">
                <input type="checkbox" checked={!spec.silent} onChange={(ev) => onSpec({ ...spec, silent: ev.target.checked ? undefined : true })} />
                <span>
                  {RECORD_CRASH}
                  {spec.silent && <span className="help">{RECORD_CRASH_OFF}</span>}
                </span>
              </label>
            )}
            <p className="help">{crashWhatDies(props.mode, props.world)}</p>
            {props.note && <p className="help">{props.note}</p>}
          </div>,
          document.body
        )}
    </div>
  );
}

/** A harness name (see `HarnessOption.value`). */
export type HarnessChoice = string;

/** Why a harness cannot be picked with its brain in `mode`, if it cannot. */
export function harnessDisabledReason(h: HarnessOption, mode: Mode, now?: string): string | undefined {
  if (h.disabledReason) return h.disabledReason;
  if (now) return now;
  if (h.modes.includes(mode)) return undefined;
  const where = h.modes.map((m) => MODE_LABEL[m]);
  return `${h.label} runs in ${where.length > 1 ? `${where.slice(0, -1).join(', ')} or ${where.at(-1)}` : where[0]} only.`;
}

/** The picker's order: durable-harness's own harnesses first, then the demo's. */
const HARNESS_ORDER = ['claude-code', 'codex', 'opencode', 'pi', 'pi-durable', 'fx-durable', 'fx', 'ai-sdk'];
const rank = (v: string) => {
  const i = HARNESS_ORDER.indexOf(v);
  return i < 0 ? HARNESS_ORDER.length : i;
};

export interface ControlBarProps {
  mode: Mode;
  durability: Durability;
  onDurability(d: Durability): void;
  /** Why Durable (run-ahead) is unavailable here, if it is. */
  runAheadDisabledReason?: string;
  /** Why Strict is unavailable here (a harness whose own durability is Durable only), if it is. */
  strictDisabledReason?: string;
  /** Why Native is unavailable here, if it is. */
  nativeDisabledReason?: string;
  world?: WorldName;
  onMode(m: Mode): void;
  onPrefetch(m: Mode): void;
  harness: HarnessChoice;
  onHarness(h: HarnessChoice): void;
  /** What the picker offers: label, title, the modes each runs in, why one cannot run here. */
  harnesses: HarnessOption[];
  /** Why a harness is unavailable right now, by value (fx in a tab without JSPI). Wins over its modes. */
  harnessDisabled?: Record<string, string | undefined>;
  /** The hands a new session gets. */
  hands: Hands;
  onHands(h: Hands): void;
  /** Every Hands choice for the harness and brain, each with why it is off here (`handsChoices`). */
  handsChoices: { hands: Hands; label: string; reason?: string }[];
  /** Why the Hands choice is fixed here (a durability that runs the harness as shipped), if it is. */
  handsFixedReason?: string;
  crash: CrashControlProps;
  /** Under 640 px: Durability is a menu too. */
  compact: boolean;
}

export function ControlBar(props: ControlBarProps) {
  const { mode, world } = props;
  const harnessOptions: PickerOption<HarnessChoice>[] = [...props.harnesses]
    .sort((a, b) => rank(a.value) - rank(b.value))
    .map((h) => {
      const reason = harnessDisabledReason(h, mode, props.harnessDisabled?.[h.value]);
      return { value: h.value, label: h.label, group: HARNESS_GROUP[harnessGroup(h.value)], ...(reason ? { detail: reason, disabled: true } : {}) };
    });
  // Grouped in order (the sort keeps each group together).
  harnessOptions.sort((a, b) => Object.values(HARNESS_GROUP).indexOf(a.group as never) - Object.values(HARNESS_GROUP).indexOf(b.group as never));
  // Native, Durable, Strict: one control, the API's words (Wrapped, `off`, is reachable from the URL only).
  const durabilityOptions: SegOption<Durability>[] = [
    { value: 'native', label: DURABILITY_LABEL.native, tip: props.nativeDisabledReason ?? DURABILITY_TIP.native, disabled: !!props.nativeDisabledReason },
    {
      value: 'run-ahead',
      label: DURABILITY_LABEL['run-ahead'],
      tip: props.runAheadDisabledReason ?? DURABILITY_TIP['run-ahead'],
      disabled: !!props.runAheadDisabledReason,
    },
    { value: 'on', label: DURABILITY_LABEL.on, tip: props.strictDisabledReason ?? DURABILITY_TIP.on, disabled: !!props.strictDisabledReason },
  ];
  const modeOptions: PickerOption<Mode>[] = BRAINS.map((m, i) => ({
    value: m,
    label: MODE_LABEL[m],
    detail: `${modeDescriptionLong(m, m === 'tab' ? 'browser' : world)} (${i + 1})`,
  }));
  const handsOptions: PickerOption<Hands>[] = props.handsChoices.map((c) => {
    const reason = props.handsFixedReason ?? c.reason;
    return { value: c.hands, label: c.label, ...(reason && c.hands !== props.hands ? { detail: reason, disabled: true } : { detail: handsTip(c.hands, mode) }) };
  });
  return (
    <nav className="bar" aria-label="Session options">
      <div className="group">
        <span className="group-label">Harness</span>
        <Picker className="sel-harness" label="Harness" value={props.harness} options={harnessOptions} onChange={props.onHarness} />
      </div>
      <div className="group">
        <span className="group-label">Durability</span>
        {props.compact ? (
          <Picker
            className="sel-durability"
            label="Durability"
            value={props.durability}
            options={durabilityOptions.map((o) => ({ value: o.value, label: String(o.label), detail: o.tip, ...(o.disabled ? { disabled: true } : {}) }))}
            onChange={props.onDurability}
          />
        ) : (
          <Segmented label="Durability" className="seg-durability" value={props.durability} options={durabilityOptions} onChange={props.onDurability} />
        )}
      </div>
      <div className="group">
        <span className="group-label">Brain</span>
        <Picker className="sel-mode" label="Brain" value={mode} options={modeOptions} onChange={props.onMode} onOpen={() => BRAINS.forEach((m) => props.onPrefetch(m))} />
      </div>
      <div className="group">
        <span className="group-label">Hands</span>
        <Picker className="sel-hands" label="Hands" value={props.hands} options={handsOptions} onChange={props.onHands} />
      </div>
      <span className="spacer" />
      <CrashControl {...props.crash} />
    </nav>
  );
}
