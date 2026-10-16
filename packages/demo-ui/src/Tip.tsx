import { type FocusEvent, type MouseEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY, type GlossaryTerm } from './compare-glossary.ts';

/**
 * Explanations on hover and keyboard focus, never in a `title`: rendered in a
 * portal with fixed positioning, so a scrolling pane or a clipped bar cannot
 * cut them off, and flipped to stay on screen.
 */

interface At {
  left: number;
  top: number;
  /** The anchor's top edge, to flip above it. */
  above: number;
}

function TipPop({ id, at, wide, children }: { id: string; at: At; wide?: boolean; children: ReactNode }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.left, top: at.top });
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    let left = at.left;
    let top = at.top;
    if (left + b.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - b.width);
    if (top + b.height > window.innerHeight - 8) top = Math.max(8, at.above - 6 - b.height);
    setPos({ left, top });
  }, [at]);
  return createPortal(
    <div ref={pop} id={id} role="tooltip" className="tip-pop" data-wide={wide || undefined} style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>,
    document.body
  );
}

/**
 * A tip for any element: spread `props` on it and render `pop` next to it.
 * No content, no tip (and nothing to spread).
 */
export function useTip(content: ReactNode | undefined, options: { wide?: boolean } = {}) {
  const id = useId();
  const [at, setAt] = useState<At>();
  const show = (ev: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 6, above: r.top });
  };
  const hide = () => setAt(undefined);
  if (content === undefined || content === null || content === '') return { props: {}, pop: null };
  return {
    props: {
      'aria-describedby': at ? id : undefined,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
    },
    pop:
      at && typeof document !== 'undefined' ? (
        <TipPop id={id} at={at} wide={options.wide}>
          {content}
        </TipPop>
      ) : null,
  };
}

/** A focusable span with a tip: for text whose explanation used to live in a `title`. */
export function Hint({ text, children, className }: { text: ReactNode; children: ReactNode; className?: string }) {
  const tip = useTip(text);
  return (
    <span className={className ? `hint ${className}` : 'hint'} tabIndex={0} {...tip.props}>
      {children}
      {tip.pop}
    </span>
  );
}

/**
 * A metric's explanation on hover or keyboard focus: what it is, and
 * pseudocode of how /compare computes it (compare-glossary.ts).
 */
export function Tip({ term, children, className, kind }: { term: GlossaryTerm; children: ReactNode; className?: string; kind?: string }) {
  const entry = GLOSSARY[term];
  const tip = useTip(
    <>
      <b>{entry.title}</b>
      <p>{entry.what}</p>
      <pre>{entry.how}</pre>
    </>,
    { wide: true }
  );
  return (
    <span className={className ? `compare-tip ${className}` : 'compare-tip'} data-kind={kind} tabIndex={0} {...tip.props}>
      {children}
      {tip.pop}
    </span>
  );
}
