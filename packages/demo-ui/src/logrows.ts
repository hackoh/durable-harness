import type { EffectView, EventView, Lane, SessionView, SubmissionView } from './view.ts';

/**
 * The event log as the drawer lists it: one row per step (its `step_*`
 * events together), one per message the session received, one per run-level
 * event. Every row keeps its events, so it expands to them; the log's count
 * is still the events', and the rows are built from that same array.
 */

export type RowStatus = 'queued' | 'running' | 'completed' | 'failed' | 'retrying';

export interface LogRow {
  /** The step's correlation id, or the event id of a row that is one event. */
  key: string;
  kind: 'step' | 'message' | 'run';
  name: string;
  /** What a message said (a prompt's text), or what a run-level event was. */
  detail?: string;
  lane?: Lane;
  status?: RowStatus;
  /** First event (ms). */
  start: number;
  /** Start of the latest attempt and its end (ms): the row's duration. */
  attemptStart?: number;
  end?: number;
  /** `step_started` count (1 for a step that ran once). */
  attempts: number;
  events: EventView[];
  /** A process harness's journal write: hidden unless the log shows everything. */
  journal: boolean;
  /**
   * Replaced: a killed process's step that a recovery retried (or the loser
   * of a race between two drivers). Every reader ignores it.
   */
  superseded: boolean;
  /** For a superseded step: the attempt of the step that replaced it. */
  replacedAttempt?: number;
  /** Events of attempts a killed process left behind (the step ran again). */
  leftBehind: Set<string>;
  tone?: 'crash' | 'run';
}

const RUN_NAMES: Record<string, string> = {
  run_created: 'Run created',
  run_started: 'Run started',
  run_completed: 'Run completed',
  run_failed: 'Run failed',
  run_cancelled: 'Run cancelled',
  hook_created: 'Inbox opened',
  hook_disposed: 'Inbox closed',
};

const MESSAGE_NAMES: Record<string, string> = {
  prompt: 'Prompt',
  steer: 'Steer',
  chaos: 'Crash armed',
  withdraw: 'Withdrawn',
};

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Which submission each `hook_received` delivered. A crash's submission is
 * named by its event id; a message sent with a client-minted id (`sub_…`)
 * is matched in order, on the session's inbox (the hook most messages
 * arrived on; a document edit arrives on a hook of its own).
 */
export function messagesOf(events: EventView[], view: SessionView | undefined): Map<string, SubmissionView> {
  const out = new Map<string, SubmissionView>();
  const subs = view?.submissions ?? [];
  if (!subs.length) return out;
  const received = events.filter((e) => e.eventType === 'hook_received');
  const ids = new Set(received.map((e) => e.eventId));
  const hooks = new Map<string, number>();
  for (const e of received) if (e.correlationId) hooks.set(e.correlationId, (hooks.get(e.correlationId) ?? 0) + 1);
  const inbox = [...hooks].sort((a, b) => b[1] - a[1])[0]?.[0];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const queue = subs.filter((s) => !ids.has(s.id));
  for (const e of received) {
    const own = byId.get(e.eventId);
    if (own) out.set(e.eventId, own);
    else if (!inbox || !e.correlationId || e.correlationId === inbox) {
      const next = queue.shift();
      if (next) out.set(e.eventId, next);
    }
  }
  return out;
}

export function logRows(events: EventView[], view: SessionView | undefined, lanes: Map<string, Lane>): LogRow[] {
  const byStep = new Map<string, EffectView>((view?.effects ?? []).map((e) => [e.stepId, e]));
  const subs = messagesOf(events, view);
  const superseded = new Set(view?.supersededStepIds ?? []);
  const rows: LogRow[] = [];
  const open = new Map<string, LogRow>();

  for (const e of events) {
    const t = Date.parse(e.createdAt);
    const isStep = e.eventType.startsWith('step_') || e.eventType.startsWith('wait_');
    if (isStep && e.correlationId) {
      let row = open.get(e.correlationId);
      if (!row) {
        const effect = byStep.get(e.correlationId);
        const name = effect?.name ?? (e.stepName ? String(e.stepName).split('//').pop()! : e.eventType.startsWith('wait_') ? 'wait' : e.correlationId);
        row = {
          key: e.correlationId,
          kind: 'step',
          name,
          ...(effect && lanes.get(effect.key) ? { lane: lanes.get(effect.key)! } : {}),
          start: t,
          attempts: 0,
          events: [],
          journal: name === 'journal',
          superseded: superseded.has(e.correlationId),
          leftBehind: new Set(),
        };
        open.set(e.correlationId, row);
        rows.push(row);
      }
      row.events.push(e);
      switch (e.eventType) {
        case 'step_created':
        case 'wait_created':
          row.status ??= 'queued';
          row.attemptStart ??= t;
          break;
        case 'step_started':
          row.attempts += 1;
          row.attemptStart = t;
          row.end = undefined;
          row.status = 'running';
          break;
        case 'step_retrying':
          row.status = 'retrying';
          row.tone = 'crash';
          break;
        case 'step_completed':
        case 'wait_completed':
          row.status = 'completed';
          row.end = t;
          if (row.name === 'chaos') row.tone = 'crash';
          break;
        case 'step_failed':
          row.status = 'failed';
          row.end = t;
          row.tone = 'crash';
          break;
      }
      continue;
    }
    if (e.eventType === 'hook_received') {
      const sub = subs.get(e.eventId);
      rows.push({
        key: e.eventId,
        kind: 'message',
        name: sub ? (MESSAGE_NAMES[sub.kind] ?? sub.kind) : (e.stepName ? String(e.stepName) : 'Message'),
        ...(sub?.text ? { detail: oneLine(sub.text) } : {}),
        start: t,
        attempts: 1,
        events: [e],
        journal: false,
        superseded: false,
        leftBehind: new Set(),
      });
      continue;
    }
    rows.push({
      key: e.eventId,
      kind: 'run',
      name: RUN_NAMES[e.eventType] ?? e.eventType,
      start: t,
      attempts: 1,
      events: [e],
      journal: false,
      superseded: false,
      leftBehind: new Set(),
      tone: 'run',
      ...(e.eventType === 'run_failed' ? { tone: 'crash' as const } : {}),
    });
  }

  // A superseded step: the next step of the same name that stands is the attempt that replaced it.
  rows.forEach((row, i) => {
    if (!row.superseded) return;
    const by = rows.slice(i + 1).find((r) => r.kind === 'step' && r.name === row.name && !r.superseded);
    const attempt = by ? byStep.get(by.key)?.attempt : undefined;
    if (attempt) row.replacedAttempt = attempt;
  });

  // A step that ran again: its earlier attempts' events are what the killed process left behind.
  for (const row of rows) {
    if (row.attempts < 2) continue;
    let seen = 0;
    const lastStart = row.events.findLastIndex((e) => e.eventType === 'step_started');
    row.events.forEach((e, i) => {
      if (e.eventType === 'step_started') seen += 1;
      if (i < lastStart && seen < row.attempts) row.leftBehind.add(e.eventId);
    });
  }
  return rows;
}

/**
 * Where the log's clock starts: the first prompt's `hook_received` (the
 * moment the session was asked something), else the first event.
 */
export function logOrigin(events: EventView[], view: SessionView | undefined): number {
  const subs = messagesOf(events, view);
  const first = events.find((e) => e.eventType === 'hook_received' && (subs.size === 0 || subs.get(e.eventId)?.kind === 'prompt'));
  const at = first ?? events[0];
  return at ? Date.parse(at.createdAt) : 0;
}

/** A log time: `+1.2 s` under a minute, then `+12:05`, then `+1:02:05`. Fixed width in tabular figures. */
export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `+${h}:${String(m).padStart(2, '0')}:${ss}` : `+${m}:${ss}`;
}

/** How many events the rows hide while journal steps are folded away. */
export const hiddenCount = (rows: LogRow[]) => rows.reduce((n, r) => n + (r.journal ? r.events.length : 0), 0);

/** A document's name for the Files tab: `demo.todos` → "Todos". */
export function docTitle(kind: string): string {
  const last = kind.split('.').pop() ?? kind;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/[-_]/g, ' ');
}

/**
 * A todo item is plain text: a model marks one done by writing it as
 * "[x] buy milk" (or "[done] …", "✓ …"), and one open as "[ ] …". The
 * checklist ticks the box instead of showing the marker.
 */
export function todoItem(item: string): { done: boolean; text: string } {
  const m = /^\s*(?:\[(x|done|✓|✔| )\]|✓|✔)\s*/i.exec(item);
  return m ? { done: m[1] !== ' ', text: item.slice(m[0].length) } : { done: false, text: item };
}
