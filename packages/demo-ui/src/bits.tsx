import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import { fmtDuration } from './lanes.ts';

/** The one crash glyph: rail, transcript and log share it. Armed (not fired yet): an outline. */
export function CrashGlyph({ size = 12, armed = false }: { size?: number; armed?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      {armed ? (
        <>
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="var(--crash)" strokeWidth="1.5" strokeDasharray="2.5 2" />
          <path d="M4.25 4.25l3.5 3.5M7.75 4.25l-3.5 3.5" stroke="var(--crash)" strokeWidth="1.25" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="6" cy="6" r="6" fill="var(--crash)" />
          <path d="M4 4l4 4M8 4l-4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M5 2H2.5A.5.5 0 0 0 2 2.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V7M7 2h3v3M10 2 5.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M9.5 4.5V3a.5.5 0 0 0-.5-.5H3A.5.5 0 0 0 2.5 3v6a.5.5 0 0 0 .5.5h1.5" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2.5 3.75 5 6.25l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A label slot that holds every label it can show, so switching between them
 * never changes the element's width.
 */
export function Stack({ labels, show }: { labels: string[]; show: string }) {
  return (
    <span className="stack">
      {labels.map((l) => (
        <span key={l} {...(l === show ? {} : { 'data-off': '', 'aria-hidden': true })}>
          {l}
        </span>
      ))}
    </span>
  );
}

/**
 * Elapsed time since `since`, written straight into the DOM so ticking
 * seconds never re-render anything.
 */
export const Ticker = memo(function Ticker({ since, until, every = 100 }: { since?: number; until?: number; every?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (since === undefined) {
      el.textContent = '';
      return;
    }
    const paint = () => {
      el.textContent = fmtDuration((until ?? Date.now()) - since);
    };
    paint();
    if (until !== undefined) return;
    const id = setInterval(paint, every);
    return () => clearInterval(id);
  }, [since, until, every]);
  return <span ref={ref} />;
});

/**
 * Live tokens for the one running model effect. Deltas are buffered and
 * flushed once per animation frame, and only the streaming row subscribes.
 */
export class LiveText {
  private text = '';
  private shown = '';
  private frame = 0;
  private listeners = new Set<() => void>();
  append(delta: string) {
    this.text += delta;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }
  reset() {
    this.text = '';
    this.flush();
  }
  get hasText() {
    return this.text.length > 0;
  }
  private flush() {
    this.frame = 0;
    if (this.shown === this.text) return;
    this.shown = this.text;
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.shown;
}

export function useLiveText(store: LiveText | undefined): string {
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptySnapshot);
}
const noopSubscribe = () => () => {};
const emptySnapshot = () => '';

/**
 * A module that loads with the page (never on first use) and is read
 * synchronously once here, so no render ever suspends on it.
 */
export function preloaded<T>(load: () => Promise<T>) {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  if (typeof window !== 'undefined')
    void load().then((v) => {
      value = v;
      for (const l of listeners) l();
    });
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const get = () => value;
  return { get, use: () => useSyncExternalStore(subscribe, get, () => undefined) };
}
