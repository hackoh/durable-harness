import { memo } from 'react';
import { Ticker } from './bits.tsx';

/**
 * One line over the session: the Sessions drawer, the first prompt, what
 * runs it, what it is doing; then what durability costs it right now (write
 * acks, from the marks every durable write reports), a link that measures it
 * properly, and the Event Log drawer.
 */
export const SessionHeader = memo(function SessionHeader(props: {
  /** The open session's first prompt (its title), or undefined for a new session. */
  title?: string;
  /** No session open. */
  fresh: boolean;
  harness: string;
  durability: string;
  now: string;
  tone?: 'crash';
  since?: number;
  /** Freeze the timer here (the server went away). */
  until?: number;
  /** Durable lanes: the writes readout, as [lead, ...figures]. */
  writes?: { lead: string; figures: string[] };
  compareHref?: string;
  sessionCount?: number;
  sessionsOpen: boolean;
  onSessions(): void;
  eventCount?: number;
  /** The status in a word (Running, Idle, Killed): what a phone shows. */
  short?: string;
  logOpen: boolean;
  onLog(): void;
}) {
  const { writes } = props;
  return (
    <div className="s-head">
      <button type="button" className="btn drawer-btn s-sessions" aria-expanded={props.sessionsOpen} onClick={props.onSessions} aria-label="Sessions">
        <ListIcon />
        <span className="drawer-btn-label">Sessions</span>
        <span className="num muted">{props.sessionCount ?? ''}</span>
      </button>
      <div className="s-what">
        <span className="s-title one-line" data-fresh={props.fresh || undefined}>
          {props.fresh ? 'New session' : (props.title ?? '')}
        </span>
        <span className="s-meta">
          <span>{props.harness}</span>
          <span aria-hidden="true">·</span>
          <span>{props.durability}</span>
          {!props.fresh && (
            <>
              <span aria-hidden="true">·</span>
              <span className="now" data-tone={props.tone} {...(props.short ? { 'data-short': props.short } : {})}>
                <span className="now-long">{props.now}</span>
              </span>
              <span className="dur num">
                <Ticker since={props.since} until={props.until} every={100} />
              </span>
            </>
          )}
        </span>
      </div>
      <div className="s-side">
        {writes && (
          <span className="writes num">
            <span className="writes-lead">{writes.lead}</span>
            {writes.figures.map((f, i) => (
              <span key={f} className={i === 0 ? 'writes-first' : 'writes-more'}>
                {f}
              </span>
            ))}
          </span>
        )}
        {props.compareHref && (
          <a className="link-quiet measure" href={props.compareHref}>
            Measure on Compare
          </a>
        )}
        <button type="button" className="btn drawer-btn s-log" aria-expanded={props.logOpen} onClick={props.onLog} aria-label="Event Log">
          <span className="drawer-btn-label">Event Log</span>
          <span className="drawer-btn-short" aria-hidden="true">
            Log
          </span>
          <span className="num muted">{props.eventCount ?? ''}</span>
        </button>
      </div>
    </div>
  );
});

/** Three lines: the Sessions button on a phone, where its word does not fit. */
function ListIcon() {
  return (
    <svg className="list-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
