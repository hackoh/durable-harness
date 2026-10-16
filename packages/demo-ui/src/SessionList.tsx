import { memo, useEffect, useState } from 'react';
import { DURABILITY_LABEL, MODE_LABEL } from './copy.ts';
import { fmtRelative, midId } from './lanes.ts';
import type { MineEntry } from './registry.ts';
import { useTip } from './Tip.tsx';
import { harnessLabel, type SessionRow } from './view.ts';

/** A run's status in the list, for sessions the page has not opened (the open one says what it is doing). */
const STATUS: Record<string, string> = { running: '', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', pending: '' };

/** Re-render relative times every 30s, nothing more. */
function useNow(every = 30_000): number {
  const [n, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), every);
    return () => clearInterval(id);
  }, [every]);
  return n;
}

const MineRow = memo(function MineRow({
  entry,
  current,
  status,
  onOpen,
}: {
  tick: number;
  entry: MineEntry;
  current: boolean;
  /** What it is doing: the open session's from its fold, another's from the World's list. */
  status?: string;
  onOpen(e: MineEntry): void;
}) {
  return (
    <button type="button" className="s-row" aria-current={current} onClick={() => onOpen(entry)}>
      <span className="s-title one-line">{entry.prompt}</span>
      <span className="s-meta">
        <span>
          {harnessLabel(entry.harness)} · {DURABILITY_LABEL[entry.durability]}
          {entry.mode !== 'server' ? ` · ${MODE_LABEL[entry.mode]}` : ''}
        </span>
        <span className={status === 'Failed' ? 'failed' : undefined}>{status ?? ''}</span>
        <span className="num">{fmtRelative(entry.sentAt)}</span>
      </span>
    </button>
  );
});

const AllRow = memo(function AllRow({ row, current, onOpen }: { tick: number; row: SessionRow; current: boolean; onOpen(r: SessionRow): void }) {
  return (
    <button type="button" className="s-row" aria-current={current} onClick={() => onOpen(row)}>
      <span className="s-id">{midId(row.id)}</span>
      <span className="s-meta">
        <span>{harnessLabel(row.harness)}</span>
        <span className={row.status === 'failed' ? 'failed' : undefined}>{STATUS[row.status] ?? row.status}</span>
        <span className="num">{fmtRelative(new Date(row.createdAt).getTime())}</span>
      </span>
    </button>
  );
});

/**
 * The Sessions drawer: this browser's sessions (every mode and harness,
 * titled by their first prompt, the open one first), or, with the toggle,
 * every session on this deployment (the World's latest runs, everyone's).
 */
export function SessionList(props: {
  mine: MineEntry[];
  /** The World's list (the current mode's client), when it has answered. */
  all?: SessionRow[];
  showAll: boolean;
  onShowAll(all: boolean): void;
  /** The list can't reach its World right now. */
  offline?: boolean;
  current?: string;
  /** What the open session is doing (its fold): the same word the header uses. */
  currentStatus?: string;
  open: boolean;
  onOpen(entry: MineEntry): void;
  onOpenRow(row: SessionRow): void;
  onNew(): void;
  onClose(): void;
}) {
  const tick = useNow();
  const statusOf = new Map((props.all ?? []).map((r) => [r.id, STATUS[r.status] ?? r.status]));
  // The open session first, then newest first.
  const mine = [...props.mine].sort((a, b) => (a.id === props.current ? -1 : b.id === props.current ? 1 : b.sentAt - a.sentAt));
  return (
    <aside className="drawer drawer-left" aria-label="Sessions" {...(props.open ? { 'data-open': '' } : {})} inert={!props.open || undefined}>
      <div className="drawer-head">
        <span>Sessions</span>
        <NewSession onNew={props.onNew} />
        <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </div>
      <label className="check drawer-toggle">
        <input type="checkbox" checked={props.showAll} onChange={(e) => props.onShowAll(e.target.checked)} />
        <span>All sessions on this deployment</span>
      </label>
      <div className="scroll">
        {props.showAll ? (
          <>
            <p className="drawer-note">Everyone’s sessions, the World’s latest runs.{props.offline ? ' Can’t reach the server right now.' : ''}</p>
            {!props.all &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="s-row skeleton" aria-hidden="true">
                  <span className="skel" style={{ width: 140 }} />
                  <span className="skel" style={{ width: 96 }} />
                </div>
              ))}
            {props.all?.map((r) => (
              <AllRow key={r.id} tick={tick} row={r} current={r.id === props.current} onOpen={props.onOpenRow} />
            ))}
          </>
        ) : mine.length === 0 ? (
          <div className="list-empty">
            <strong>No sessions yet</strong>
            <span>Sessions you start in this browser appear here.</span>
          </div>
        ) : (
          mine.map((e) => (
            <MineRow
              key={e.id}
              tick={tick}
              entry={e}
              current={e.id === props.current}
              status={e.id === props.current ? props.currentStatus : statusOf.get(e.id)}
              onOpen={props.onOpen}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/** New Session, with its key on a tip. */
function NewSession({ onNew }: { onNew(): void }) {
  const tip = useTip('New session: N');
  return (
    <button type="button" className="btn" onClick={onNew} {...tip.props}>
      New Session
      {tip.pop}
    </button>
  );
}
