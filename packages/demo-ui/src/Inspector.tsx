import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CopyIcon, ExternalIcon } from './bits.tsx';
import {
  AGENT_RUNS_LABEL,
  DETAIL_EMPTY,
  DOCS_EMPTY,
  DOCS_HEADING,
  DRIVE_CHANGED,
  DRIVE_EMPTY,
  DRIVE_NO_TEXT,
  DRIVE_SNAPSHOT,
  DRIVE_TRUNCATED,
  driveChangeText,
  driveSnapshotAt,
  FILES_EMPTY,
  FILES_EPHEMERAL,
  FILES_NONE,
  HIDE_JOURNAL,
  LOG_AFTER,
  LOG_BEFORE,
  LOG_EMPTY,
  leftBehindCaption,
  NO_DOCS,
  showAllEvents,
  storedIn,
} from './copy.ts';
import { cite, fmtBytes, fmtDone, type LogIndex, midId } from './lanes.ts';
import { docTitle, fmtClock, hiddenCount, type LogRow, logOrigin, logRows, todoItem } from './logrows.ts';
import { SideEffects } from './SideEffects.tsx';
import { useTip } from './Tip.tsx';
import { exitCode } from './tools.ts';
import { type DriveChange, type DriveView, type EffectView, type EventView, type FilesSource, type Lane, type Mode, movesLanes, type SessionView, type WorldName } from './view.ts';

export type Selection =
  | { kind: 'event'; eventId: string }
  | { kind: 'row'; key: string; stepIds: string[]; eventIds: string[] }
  | { kind: 'file'; path: string };

export interface Highlight {
  steps: Set<string>;
  events: Set<string>;
}

export interface InspectorProps {
  mode: Mode;
  world?: WorldName;
  /** Overrides where the log is stored (durability off: nowhere). */
  stored?: string;
  hasSession: boolean;
  view?: SessionView;
  events: EventView[];
  lanes: Map<string, Lane>;
  index: LogIndex;
  selection?: Selection;
  highlight: Highlight;
  tab: 'log' | 'files';
  onTab(t: 'log' | 'files'): void;
  onSelectEvent(id: string | undefined): void;
  onSelectFile(path: string): void;
  onShowInTranscript(stepOrEventId: string): void;
  loadPayload(eventId: string): Promise<unknown>;
  laneName(lane: Lane | undefined, hookReceived: boolean): string;
  sessionKey: string;
  /** The open session's run id, for the header (it left the session header). */
  runId?: string;
  /** The model the server runs. */
  model?: string;
  /** On Vercel: the session's trace in Agent Runs (Observability), its model and tool calls. */
  agentRunsUrl?: string;
  open: boolean;
  onClose(): void;
  /**
   * Where the Files tab reads the session's files (`HarnessOption.files`):
   * the log (default), the Drive's last snapshot (`view.drive`, with the
   * changes the live stream reported since), or nowhere.
   */
  files?: FilesSource;
  /** `drive`: the mutating calls the live stream reported (`SessionData.driveChanges`). */
  driveChanges?: DriveChange[];
  /** pi-durable and fx (libfx durable): their own logs hold no kernel documents. */
  noDocs?: boolean;
}

const STATUS_WORD: Record<string, string> = { queued: 'Queued', running: 'Running', failed: 'Failed', retrying: 'Retrying' };

/** A step's name as the log row shows it (the crash step is the one a reader looks for). */
const rowName = (r: LogRow) => (r.kind === 'step' && r.name === 'chaos' ? 'crash' : r.name);

/** "Interrupted" or "exit 1" for a failed step the transcript does not call a failure. */
function failureWord(effect: EffectView): string | undefined {
  if (effect.error?.interrupted) return 'Interrupted';
  const code = exitCode(String(effect.error?.message ?? ''));
  return code !== undefined && code !== 0 ? `exit ${code}` : undefined;
}

const StepRow = memo(function StepRow({
  row,
  origin,
  expanded,
  hl,
  lanes,
  effect,
  selectedId,
  onToggle,
  onSelect,
}: {
  row: LogRow;
  origin: number;
  expanded: boolean;
  hl: boolean;
  /** Color each row's dot by its lane: only where a session moves between lanes (one lane is plain). */
  lanes: boolean;
  /** The row's step as the session view folds it: says whether a failed step was interrupted, or a command that exited non-zero. */
  effect?: EffectView;
  selectedId?: string;
  onToggle(key: string): void;
  onSelect(id: string): void;
}) {
  const before = row.start < origin;
  const status = row.status === 'completed' || (row.kind !== 'step' && !row.status) ? '' : STATUS_WORD[row.status ?? ''] ?? '';
  const duration = row.kind === 'step' && row.status === 'completed' && row.attemptStart !== undefined && row.end !== undefined ? fmtDone(row.end - row.attemptStart) : '';
  const lastLeft = row.leftBehind.size ? row.events.findLastIndex((e) => row.leftBehind.has(e.eventId)) : -1;
  // The transcript's words for a failed step that is not a failure: a tool the crash cut off, a command that exited non-zero.
  const plainFailure = row.status === 'failed' && effect?.status === 'failed' ? failureWord(effect) : undefined;
  const tone = plainFailure ? undefined : row.tone;
  return (
    <div className="l-group" data-key={row.key} {...(hl ? { 'data-hl': '' } : {})} {...(row.lane && lanes ? { 'data-lane': row.lane } : {})}>
      <button type="button" className="l-row" aria-expanded={expanded} onClick={() => onToggle(row.key)} tabIndex={-1}>
        <span className="chev" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="off num">{before ? '' : fmtClock(row.start - origin)}</span>
        <span className="lane-dot" {...(row.kind === 'message' ? { 'data-hollow': '' } : row.lane ? {} : { 'data-none': '' })} />
        <span className="l-name" data-kind={row.kind} data-tone={tone} {...(row.superseded ? { 'data-struck': '' } : {})}>
          <span className="n">{rowName(row)}</span>
          {row.detail && <span className="d">{row.detail}</span>}
          {row.attempts >= 2 && <span className="d">attempt {row.attempts}</span>}
        </span>
        <span className="l-status num" data-tone={(row.status === 'failed' && !plainFailure) || row.status === 'retrying' ? 'crash' : undefined}>
          {duration || plainFailure || status}
        </span>
      </button>
      {row.superseded && <p className="l-caption">{leftBehindCaption(row.replacedAttempt ?? 2)}</p>}
      {expanded && (
        <div className="l-events">
          {row.events.map((e, i) => (
            <span key={e.eventId} style={{ display: 'contents' }}>
              <button
                type="button"
                className="l-event"
                data-id={e.eventId}
                aria-selected={selectedId === e.eventId}
                {...(row.leftBehind.has(e.eventId) ? { 'data-struck': '' } : {})}
                onClick={() => onSelect(e.eventId)}
                tabIndex={-1}
              >
                <span />
                <span className="off num">{Date.parse(e.createdAt) < origin ? '' : fmtClock(Date.parse(e.createdAt) - origin)}</span>
                <span />
                <span className="type">{e.eventType}</span>
                <span className="idx num">#{e.index}</span>
              </button>
              {i === lastLeft && <p className="l-caption">{leftBehindCaption(row.attempts)}</p>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const tip = useTip(<span className="mono">{id}</span>);
  return (
    <span className="i-id">
      <span className="mono" tabIndex={0} {...tip.props}>
        {midId(id)}
        {tip.pop}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={copied ? 'Copied' : 'Copy the run id'}
        onClick={() => {
          void navigator.clipboard?.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        <CopyIcon />
      </button>
    </span>
  );
}

export function Inspector(props: InspectorProps) {
  const { view, events, lanes, selection, highlight, tab } = props;
  const byStep = useMemo(() => new Map((view?.effects ?? []).map((e) => [e.stepId, e])), [view]);
  const rows = useMemo(() => logRows(events, view, lanes), [events, view, lanes]);
  const origin = useMemo(() => logOrigin(events, view), [events, view]);
  const [showAll, setShowAll] = useState(false);
  const hidden = hiddenCount(rows);
  const visible = useMemo(() => (showAll ? rows : rows.filter((r) => !r.journal)), [rows, showAll]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const docs = view?.docs ?? [];
  const source = props.files ?? 'log';
  const files = useMemo(() => (source === 'log' ? fileRows(view, lanes, props.index) : []), [source, view, lanes, props.index]);
  const driveFiles = useMemo(() => (source === 'drive' ? driveRows(view?.drive) : []), [source, view?.drive]);
  const fileCount = files.length + driveFiles.length + docs.length;
  const selectedEvent = selection?.kind === 'event' ? events.find((e) => e.eventId === selection.eventId) : undefined;
  const rowOf = useMemo(() => {
    const m = new Map<string, LogRow>();
    for (const r of rows) for (const e of r.events) m.set(e.eventId, r);
    return m;
  }, [rows]);

  // Log scroll: follow the bottom only when already there.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastLen = useRef(0);
  useLayoutEffect(() => {
    atBottom.current = true;
    lastLen.current = 0;
    setUnseen(0);
    setExpanded(new Set());
    setShowAll(false);
  }, [props.sessionKey]);
  useLayoutEffect(() => {
    const added = events.length - lastLen.current;
    lastLen.current = events.length;
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen((n) => n + added);
  }, [events.length, tab]);
  // A selected event opens its row (a journal row shows the whole log) and scrolls to it.
  useEffect(() => {
    if (!selectedEvent) return;
    const row = rowOf.get(selectedEvent.eventId);
    if (row) {
      if (row.journal) setShowAll(true);
      setExpanded((s) => (s.has(row.key) ? s : new Set(s).add(row.key)));
    }
    if (props.open)
      requestAnimationFrame(() =>
        scroller.current?.querySelector(`[data-id="${CSS.escape(selectedEvent.eventId)}"]`)?.scrollIntoView({ block: 'nearest' })
      );
  }, [selectedEvent, rowOf, props.open]);
  // A transcript row selected: scroll its first step into view.
  useEffect(() => {
    if (selection?.kind !== 'row') return;
    const key = selection.stepIds[0] ?? selection.eventIds.map((id) => rowOf.get(id)?.key).find(Boolean);
    if (key && props.open) scroller.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selection, rowOf, props.open]);

  const toggle = useCallback((key: string) => setExpanded((s) => {
    const next = new Set(s);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);

  // j / k step through the events of the rows on screen, opening each row they reach.
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== 'j' && ev.key !== 'k' && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const flat = visible.flatMap((r) => r.events);
    const i = selectedEvent ? flat.findIndex((e) => e.eventId === selectedEvent.eventId) : -1;
    const next = flat[Math.max(0, Math.min(flat.length - 1, i + (ev.key === 'j' || ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) props.onSelectEvent(next.eventId);
  };

  const firstAfter = visible.findIndex((r) => r.start >= origin);
  const beforeCount = firstAfter < 0 ? visible.length : firstAfter;

  return (
    <aside className="drawer drawer-right" aria-label="Event log" {...(props.open ? { 'data-open': '' } : {})} inert={!props.open || undefined}>
      <div className="drawer-head">
        <div className="i-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'log'} onClick={() => props.onTab('log')}>
            Event Log <span className="count num">{props.hasSession ? events.length : ''}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => props.onTab('files')}>
            Files <span className="count num">{props.hasSession ? fileCount : ''}</span>
          </button>
        </div>
        <button type="button" className="icon-btn" aria-label="Close the event log" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="i-meta">
        {props.runId && <CopyId id={props.runId} />}
        <span className="stored">{props.stored ?? storedIn(props.mode, props.world)}</span>
        {props.model && <span className="mono model">{props.model}</span>}
        {props.agentRunsUrl && (
          <a className="link-quiet i-runs" href={props.agentRunsUrl} target="_blank" rel="noreferrer">
            {AGENT_RUNS_LABEL} <ExternalIcon />
          </a>
        )}
      </div>
      {tab === 'log' ? (
        <div className="log-body">
          <div className="log-wrap">
            <div
              className="scroll"
              ref={scroller}
              tabIndex={0}
              aria-label="Event log"
              onKeyDown={onKey}
              onScroll={() => {
                const el = scroller.current!;
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                if (atBottom.current && unseen) setUnseen(0);
              }}
            >
              {!props.hasSession && <div className="log-empty">{LOG_EMPTY}</div>}
              {props.hasSession && hidden > 0 && (
                <div className="l-more">
                  <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? HIDE_JOURNAL : showAllEvents(events.length)}
                  </button>
                </div>
              )}
              {props.hasSession &&
                events.length === 0 &&
                [0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="l-row" aria-hidden="true">
                    <span />
                    <span className="skel" />
                    <span />
                    <span className="skel" style={{ width: 120 }} />
                    <span className="skel" style={{ width: 40 }} />
                  </div>
                ))}
              {beforeCount > 0 && visible.length > 0 && <p className="l-section">{LOG_BEFORE}</p>}
              {visible.map((row, i) => (
                <span key={row.key} style={{ display: 'contents' }}>
                  {i === beforeCount && beforeCount > 0 && <p className="l-section">{LOG_AFTER}</p>}
                  <StepRow
                    row={row}
                    origin={origin}
                    expanded={expanded.has(row.key)}
                    hl={highlight.steps.has(row.key) || row.events.some((e) => highlight.events.has(e.eventId))}
                    lanes={movesLanes(props.mode)}
                    {...(row.kind === 'step' && byStep.get(row.key) ? { effect: byStep.get(row.key)! } : {})}
                    {...(selectedEvent && rowOf.get(selectedEvent.eventId) === row ? { selectedId: selectedEvent.eventId } : {})}
                    onToggle={toggle}
                    onSelect={props.onSelectEvent}
                  />
                </span>
              ))}
            </div>
            {unseen > 0 && (
              <button
                type="button"
                className="btn float jump"
                onClick={() => {
                  atBottom.current = true;
                  setUnseen(0);
                  const el = scroller.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                Jump to Latest ({unseen})
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="scroll" aria-label="Files">
          {source === 'ephemeral' && <p className="files-note">{FILES_EPHEMERAL}</p>}
          {source === 'none' && <p className="files-note">{FILES_NONE}</p>}
          {source === 'drive' && (
            <DriveList
              drive={view?.drive}
              rows={driveFiles}
              changes={props.driveChanges ?? []}
              hasSession={props.hasSession}
              {...(selection?.kind === 'file' ? { selected: selection.path } : {})}
              onSelect={props.onSelectFile}
            />
          )}
          {source === 'log' && props.hasSession && files.length === 0 && <div className="log-empty">{FILES_EMPTY}</div>}
          {source !== 'drive' && source !== 'none' && !props.hasSession && <div className="log-empty">{FILES_EMPTY}</div>}
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className="f-row"
              aria-selected={selection?.kind === 'file' && selection.path === f.path}
              {...(f.lane ? { 'data-lane': f.lane } : {})}
              onClick={() => props.onSelectFile(f.path)}
            >
              <span className="lane-dot dot" style={{ margin: 0 }} />
              <span className="one-line mono">{f.path}</span>
              <span className="size num">{fmtBytes(f.size)}</span>
              <span className="cite num">{f.cite}</span>
            </button>
          ))}
          {props.hasSession && (
            <section className="docs" aria-label={DOCS_HEADING}>
              <h3>{DOCS_HEADING}</h3>
              {props.noDocs ? (
                <p className="muted">{NO_DOCS}</p>
              ) : docs.length === 0 ? (
                <p className="muted">{DOCS_EMPTY}</p>
              ) : (
                docs.map((d) => <DocCard key={d.kind} kind={d.kind} revision={d.revision} value={d.value} />)
              )}
            </section>
          )}
        </div>
      )}
      <SideEffects ledger={view?.ledger} />
      {selection && <Detail {...props} selectedEvent={selectedEvent} byStep={byStep} t0={origin} />}
    </aside>
  );
}

/** A document: a todo list as a checklist, anything else as its JSON. */
function DocCard({ kind, revision, value }: { kind: string; revision: number; value: unknown }) {
  const items = (value as { items?: unknown } | null)?.items;
  const list = Array.isArray(items) && items.every((i) => typeof i === 'string') ? (items as string[]) : undefined;
  return (
    <div className="doc">
      <div className="doc-head">
        <span className="doc-title">{docTitle(kind)}</span>
        <span className="mono muted">{kind}</span>
        <span className="muted num">revision {revision}</span>
      </div>
      {list ? (
        list.length ? (
          <ul className="todo">
            {list.map((item, i) => {
              const { done, text } = todoItem(item);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a list item's place is its identity
                <li key={i} data-done={done || undefined}>
                  <span className="box" aria-hidden="true" />
                  {done && <span className="sr-only">Done: </span>}
                  {text}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">Empty.</p>
        )
      ) : (
        <pre className="json">{stringify(value)}</pre>
      )}
    </div>
  );
}

interface FileRow {
  path: string;
  size: number;
  lane?: Lane;
  cite: string;
}

/** The Drive snapshot's rows: its files, and the directories it listed by name only (a `node_modules`), by path. */
export function driveRows(drive: DriveView | undefined) {
  return (drive?.files ?? []).filter((f) => !f.directory || f.skipped);
}

/**
 * A `sandbox()` session's Files tab: the Drive's last snapshot, labelled as
 * one (the Drive is the source of truth), and the mutating calls the live
 * stream reported since it was taken.
 */
export function DriveList(props: { drive?: DriveView; rows: DriveView['files']; changes: DriveChange[]; hasSession: boolean; selected?: string; onSelect(path: string): void }) {
  const { drive, rows } = props;
  const since = props.changes.filter((c) => !drive || c.t > drive.at);
  return (
    <>
      <p className="files-note">
        {DRIVE_SNAPSHOT}.{drive ? ` ${driveSnapshotAt(drive.at)}` : ''}
      </p>
      {since.length > 0 && (
        <section className="drive-changes" aria-label={DRIVE_CHANGED}>
          <h3>{DRIVE_CHANGED}</h3>
          <ul>
            {since.map((c) => (
              <li key={c.callId} className="mono">
                {driveChangeText(c.tool, c.paths)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(!props.hasSession || !drive) && <div className="log-empty">{DRIVE_EMPTY}</div>}
      {rows.map((f) => (
        <button key={f.path} type="button" className="f-row" aria-selected={props.selected === f.path} onClick={() => props.onSelect(f.path)}>
          <span className="lane-dot dot" style={{ margin: 0 }} />
          <span className="one-line mono">{f.directory ? `${f.path}/` : f.path}</span>
          <span className="size num">{f.directory ? 'not listed' : fmtBytes(f.bytes)}</span>
          <span className="cite num" />
        </button>
      ))}
      {drive?.truncated && <p className="muted">{DRIVE_TRUNCATED}</p>}
    </>
  );
}

function fileRows(view: SessionView | undefined, lanes: Map<string, Lane>, index: LogIndex): FileRow[] {
  if (!view) return [];
  const last = new Map<string, EffectView>();
  for (const e of view.effects) {
    if (e.name !== 'fs' || e.status !== 'completed') continue;
    for (const p of Object.keys(e.output?.files ?? {})) last.set(p, e);
  }
  return Object.entries(view.files)
    .map(([path, content]) => {
      const e = last.get(path);
      return {
        path,
        size: new TextEncoder().encode(content).length,
        lane: e ? lanes.get(e.key) : undefined,
        cite: e ? cite(index.byStep.get(e.stepId)) : '',
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function Detail(props: InspectorProps & { selectedEvent?: EventView; byStep: Map<string, EffectView>; t0: number }) {
  const { selection, selectedEvent, events } = props;
  const [payload, setPayload] = useState<{ id: string; value?: unknown; loading: boolean; error?: string }>();
  useEffect(() => {
    if (!selectedEvent) return;
    let cancelled = false;
    setPayload({ id: selectedEvent.eventId, loading: true });
    props
      .loadPayload(selectedEvent.eventId)
      .then((value) => !cancelled && setPayload({ id: selectedEvent.eventId, value, loading: false }))
      .catch((e) => !cancelled && setPayload({ id: selectedEvent.eventId, loading: false, error: String(e?.message ?? e) }));
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once per selected event
  }, [selectedEvent?.eventId]);

  let body: React.ReactNode = <div className="detail-empty">{DETAIL_EMPTY}</div>;
  let actions: React.ReactNode = null;

  if (selectedEvent) {
    const effect = selectedEvent.correlationId ? props.byStep.get(selectedEvent.correlationId) : undefined;
    const lane = effect ? props.lanes.get(effect.key) : undefined;
    const json = payload?.id === selectedEvent.eventId && !payload.loading ? stringify(payload.value) : '';
    body = (
      <>
        <h3>
          {selectedEvent.eventType}
          {effect ? `  ${effect.name}` : ''}
          <span className="muted"> #{selectedEvent.index}</span>
        </h3>
        <dl>
          <dt>Event</dt>
          <dd>{selectedEvent.eventId}</dd>
          {selectedEvent.correlationId && (
            <>
              <dt>Correlation</dt>
              <dd>{selectedEvent.correlationId}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{new Date(selectedEvent.createdAt).toISOString()}</dd>
          <dt>Written by</dt>
          <dd style={{ fontFamily: 'var(--sans)' }}>{props.laneName(lane, selectedEvent.eventType === 'hook_received')}</dd>
        </dl>
        {payload?.loading ? (
          <div className="detail-empty">Loading payload…</div>
        ) : payload?.error ? (
          <div className="detail-empty">{payload.error}</div>
        ) : json ? (
          <pre className="json">{json}</pre>
        ) : (
          <div className="detail-empty">No payload.</div>
        )}
      </>
    );
    actions = (
      <div className="detail-actions">
        <button type="button" className="btn" disabled={!json} onClick={() => void navigator.clipboard?.writeText(json)}>
          Copy JSON
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => props.onShowInTranscript(selectedEvent.correlationId && effect ? selectedEvent.correlationId : selectedEvent.eventId)}
        >
          Show in Transcript
        </button>
      </div>
    );
  } else if (selection?.kind === 'row') {
    const rows = events.filter((e) => (e.correlationId && selection.stepIds.includes(e.correlationId)) || selection.eventIds.includes(e.eventId));
    body = (
      <div className="detail-steps">
        {rows.map((e) => (
          <button key={e.eventId} type="button" className="e-row" onClick={() => props.onSelectEvent(e.eventId)}>
            <span className="type mono">{e.eventType}</span>
            <span className="off num">{Date.parse(e.createdAt) < props.t0 ? '' : fmtClock(Date.parse(e.createdAt) - props.t0)}</span>
            <span className="muted">#{e.index}</span>
          </button>
        ))}
        {rows.length === 0 && <div className="detail-empty">{DETAIL_EMPTY}</div>}
      </div>
    );
  } else if (selection?.kind === 'file' && props.view && props.files === 'drive') {
    const f = props.view.drive?.files.find((x) => x.path === selection.path);
    body = (
      <>
        <h3>{selection.path}</h3>
        {f?.text !== undefined ? (
          <pre className="json" style={{ marginTop: 8 }}>
            {f.text}
          </pre>
        ) : (
          <div className="detail-empty">{DRIVE_NO_TEXT}</div>
        )}
      </>
    );
  } else if (selection?.kind === 'file' && props.view) {
    const content = props.view.files[selection.path];
    body = (
      <>
        <h3>{selection.path}</h3>
        <pre className="json" style={{ marginTop: 8 }}>
          {content ?? ''}
        </pre>
      </>
    );
  }
  return (
    <div className="detail">
      <div className="detail-body">{body}</div>
      {actions}
    </div>
  );
}

function stringify(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
