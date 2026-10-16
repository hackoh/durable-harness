import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chevron } from './bits.tsx';
import { useTip } from './Tip.tsx';

/**
 * A select whose options can say why they are disabled, and what each one
 * means, in words on the menu itself: a button, and a listbox in a portal
 * under it. Arrow keys, Home / End, Enter and Escape; a click outside closes.
 */

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  /** A second line: what it is, or why it is disabled. */
  detail?: string;
  disabled?: boolean;
  group?: string;
}

interface Place {
  left: number;
  top: number;
  minWidth: number;
  /** Open upward: not enough room below. */
  up?: number;
}

function usePlace(open: boolean, button: React.RefObject<HTMLElement | null>, list: React.RefObject<HTMLElement | null>) {
  const [place, setPlace] = useState<Place>();
  useLayoutEffect(() => {
    if (!open) return setPlace(undefined);
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.max(b.width, 240);
    const left = Math.min(b.left, Math.max(8, window.innerWidth - 8 - width));
    setPlace({ left, top: b.bottom + 4, minWidth: b.width });
  }, [open, button]);
  useLayoutEffect(() => {
    const el = list.current;
    const b = button.current?.getBoundingClientRect();
    if (!el || !b || !place || place.up !== undefined) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && b.top - 4 - r.height > 8) setPlace({ ...place, top: b.top - 4 - r.height, up: 1 });
    else if (r.right > window.innerWidth - 8) setPlace({ ...place, left: Math.max(8, window.innerWidth - 8 - r.width), up: 0 });
  }, [place, list, button]);
  return place;
}

export function Picker<T extends string>(props: {
  label: string;
  value: T;
  options: PickerOption<T>[];
  onChange(v: T): void;
  /** What the button says (default: the chosen option's label). */
  shown?: ReactNode;
  disabled?: boolean;
  /** Why the whole picker is disabled. */
  disabledReason?: string;
  className?: string;
  onOpen?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const place = usePlace(open, button, list);
  const tip = useTip(props.disabled ? props.disabledReason : undefined);
  const current = props.options.find((o) => o.value === props.value);
  const enabled = props.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => {
      if (list.current?.contains(ev.target as Node) || button.current?.contains(ev.target as Node)) return;
      setOpen(false);
    };
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', shut);
    };
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openAt = () => {
    const i = props.options.findIndex((o) => o.value === props.value);
    setActive(i >= 0 && !props.options[i]!.disabled ? i : (enabled[0] ?? 0));
    setOpen(true);
    props.onOpen?.();
  };
  const choose = (i: number) => {
    const o = props.options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (o.value !== props.value) props.onChange(o.value);
  };
  const move = (dir: 1 | -1 | 'first' | 'last') => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    const next = dir === 'first' ? enabled[0]! : dir === 'last' ? enabled.at(-1)! : enabled[(Math.max(0, at) + (dir === 1 ? 1 : enabled.length - 1)) % enabled.length]!;
    setActive(next);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (!open) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openAt();
      }
      return;
    }
    if (ev.key === 'Escape' || ev.key === 'Tab') {
      if (ev.key === 'Escape') ev.preventDefault();
      setOpen(false);
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      move(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      move('first');
    } else if (ev.key === 'End') {
      ev.preventDefault();
      move('last');
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      choose(active);
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`picker ${props.className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${props.label}: ${current?.label ?? props.value}`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-disabled={props.disabled || undefined}
        onClick={() => (props.disabled ? undefined : open ? setOpen(false) : openAt())}
        onKeyDown={props.disabled ? undefined : onKey}
        {...tip.props}
      >
        <span className="picker-shown">{props.shown ?? current?.label ?? props.value}</span>
        <Chevron />
      </button>
      {tip.pop}
      {open &&
        place &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="listbox"
            aria-label={props.label}
            className="picker-list"
            style={{ left: place.left, top: place.top, minWidth: Math.max(place.minWidth, 240) }}
          >
            {props.options.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : undefined;
              lastGroup = o.group;
              return (
                <div key={o.value} role="presentation">
                  {head && (
                    <div className="picker-group" role="presentation">
                      {head}
                    </div>
                  )}
                  <div
                    id={`${id}-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={o.value === props.value}
                    aria-disabled={o.disabled || undefined}
                    className="picker-option"
                    data-active={i === active || undefined}
                    onMouseEnter={() => !o.disabled && setActive(i)}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => choose(i)}
                  >
                    <span className="picker-label">{o.label}</span>
                    {o.detail && <span className="picker-detail">{o.detail}</span>}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

/** A menu of actions (the More menu): the same popover, items that run something. */
export function ActionMenu(props: { label: string; items: { key: string; label: string; detail?: string; disabled?: boolean; run(): void }[]; disabled?: boolean; className?: string }) {
  type Key = string;
  return (
    <Picker<Key>
      label={props.label}
      value={'' as Key}
      shown={props.label}
      className={props.className}
      {...(props.disabled ? { disabled: true } : {})}
      options={props.items.map((i) => ({ value: i.key, label: i.label, ...(i.detail ? { detail: i.detail } : {}), ...(i.disabled ? { disabled: true } : {}) }))}
      onChange={(key) => props.items.find((i) => i.key === key)?.run()}
    />
  );
}
