import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type EntryRecord, type LiveState, MemoryStorage, ROOT_CONVERSATION_ID, type Seq, type StorageWrite } from '@earendil-works/pi-durable';
import type { Event, World } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import { decodeJournalPayload, journalToken } from './storage.ts';

export { decodeJournalPayload } from './storage.ts';

const ctx = BACKGROUND_CONTEXT;

/** One root-conversation entry, with the time its commit landed in the log. */
export interface PiEntry {
  id: string;
  kind: string;
  model?: readonly unknown[];
  data?: unknown;
  byTaskId?: string;
  /** ISO time of the commit that wrote it. */
  at: string;
  /** Slot of the commit that wrote it. */
  slot: number;
}

/** A task as the log tells it: how many times an invocation reserved it, and when. */
export interface PiTask {
  id: string;
  kind: string;
  status: string;
  /**
   * One per process that ran it: the first commit each writer made with the
   * task `running`. A rerun after a crash (another process) makes two.
   */
  starts: { slot: number; at: string; by?: string }[];
  /** ISO time of the commit that made it terminal. */
  endedAt?: string;
  input?: unknown;
}

/** One journal commit (one World event), for an event log view. */
export interface PiCommit {
  eventId: string;
  slot: number;
  at: string;
  /** Whether it counted (a fenced writer's entry is in the log but ignored by every reader). */
  valid: boolean;
  /** The writing process. */
  by?: string;
  seq?: number;
  /** What the commit wrote, short: `entry pi.user`, `task tool running`, `doc pi.live`. */
  summary: string[];
  entryIds: string[];
  taskIds: string[];
}

/** Everything a UI needs to draw a Pi session, read from the log without opening it. */
export interface PiSnapshot {
  sessionId: string;
  /** Highest slot in the run's log. */
  eventCount: number;
  /** Journal commits that counted. */
  commits: number;
  /** Some task has not reached `terminal`. */
  unfinished: boolean;
  /** The root conversation's active entries, oldest first. */
  entries: PiEntry[];
  /** `pi.live`: the streamed partial, the current tool round, run control. */
  live?: LiveState;
  tasks: PiTask[];
  log: PiCommit[];
}

const LIVE = new Set(['pending', 'running', 'waiting', 'completing']);

/**
 * A read-only follower of a Pi session's journal: it replays the run's log
 * into Pi's `MemoryStorage` once, then reads only the events past the last
 * one it saw on every `refresh()`. It never writes, so a viewer never fences
 * or delays the owner.
 */
export class JournalReader {
  private readonly memory = new MemoryStorage();
  private hookId?: string;
  private eventCount = 0;
  private lastValid = 0;
  private commits = 0;
  private cursor?: string;
  private readonly entryAt = new Map<string, { at: string; slot: number }>();
  private readonly tasks = new Map<string, PiTask>();
  private readonly log: PiCommit[] = [];

  constructor(
    private readonly world: World,
    readonly sessionId: string
  ) {}

  /** Read what landed since the last call. Resolves true when anything did. */
  async refresh(): Promise<boolean> {
    let grew = false;
    for (;;) {
      const page = await this.world.events.list({
        runId: this.sessionId,
        pagination: { sortOrder: 'asc', limit: 1000, ...(this.cursor ? { cursor: this.cursor } : {}) },
      } as never);
      for (const event of page.data as Event[]) {
        this.apply(event);
        grew = true;
      }
      if (page.cursor) this.cursor = page.cursor;
      if (!page.hasMore) break;
    }
    return grew;
  }

  private apply(event: Event): void {
    const slot = eventIdToSlot(event.eventId) ?? this.eventCount + 1;
    this.eventCount = Math.max(this.eventCount, slot);
    const at = new Date(event.createdAt).toISOString();
    if (event.eventType === 'hook_created' && (event.eventData as { token?: string }).token === journalToken(this.sessionId)) {
      this.hookId = event.correlationId;
      this.lastValid = slot;
      return;
    }
    if (!this.hookId || event.eventType !== 'hook_received' || event.correlationId !== this.hookId) return;
    const entry = decodeJournalPayload((event.eventData as { payload: unknown }).payload) as { after: number; seq: number; writes: StorageWrite[]; by?: string; close?: true; sandbox?: unknown };
    if (entry.close) {
      // A storage that closed with work live (storage.ts `CloseEntry`): never a commit.
      this.log.push({ eventId: event.eventId, slot, at, valid: false, ...(entry.by ? { by: entry.by } : {}), summary: ['closed: its writer let go'], entryIds: [], taskIds: [] });
      return;
    }
    if (entry.sandbox !== undefined) {
      // The session's sandbox record (storage.ts `SandboxEntry`): never a commit.
      this.log.push({ eventId: event.eventId, slot, at, valid: false, ...(entry.by ? { by: entry.by } : {}), summary: ['sandbox record'], entryIds: [], taskIds: [] });
      return;
    }
    const commit: PiCommit = {
      eventId: event.eventId,
      slot,
      at,
      valid: entry.after === this.lastValid,
      ...(entry.by ? { by: entry.by } : {}),
      seq: entry.seq,
      summary: [],
      entryIds: [],
      taskIds: [],
    };
    this.log.push(commit);
    if (!commit.valid) {
      commit.summary.push('ignored: written by a process that lost the session');
      return;
    }
    this.memory.prepareCommit(entry.writes, entry.seq as Seq).apply();
    this.lastValid = slot;
    this.commits++;
    for (const w of entry.writes) {
      if (w.type === 'entry') {
        this.entryAt.set(String(w.value.id), { at, slot });
        commit.entryIds.push(String(w.value.id));
        commit.summary.push(`entry ${w.value.kind}`);
      } else if (w.type === 'task') {
        const r = w.value;
        const id = String(r.id);
        const prev = this.tasks.get(id);
        const status = r.state.status;
        const task: PiTask = prev ?? { id, kind: r.kind, status, starts: [], input: r.input };
        if (status === 'running' && !task.starts.some((s) => s.by === entry.by)) task.starts.push({ slot, at, ...(entry.by ? { by: entry.by } : {}) });
        if (status === 'terminal') task.endedAt ??= at;
        task.status = status;
        this.tasks.set(id, task);
        commit.taskIds.push(id);
        commit.summary.push(`task ${r.kind} ${status}`);
      } else if (w.type === 'submission') {
        commit.summary.push(`submission ${w.value.status}`);
      } else if (w.type === 'document.create' || w.type === 'document.copy') {
        commit.summary.push(`doc ${w.record.kind} created`);
      } else if (w.type === 'document.change') {
        commit.summary.push('doc change');
      } else if (w.type === 'conversation') {
        commit.summary.push('conversation');
      }
    }
  }

  async snapshot(): Promise<PiSnapshot> {
    const entries: PiEntry[] = [];
    let cursor: Parameters<MemoryStorage['scanEntries']>[2];
    const newestFirst: EntryRecord[] = [];
    if (this.hookId && (await this.memory.conversation(ROOT_CONVERSATION_ID, ctx))) {
      for (;;) {
        const page = await this.memory.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 500, cursor, ctx);
        newestFirst.push(...page.items);
        if (!page.next) break;
        cursor = page.next;
      }
    }
    for (const e of newestFirst.reverse()) {
      entries.push({
        id: String(e.id),
        kind: e.kind,
        ...(e.model ? { model: e.model } : {}),
        ...(e.data !== undefined ? { data: e.data } : {}),
        ...(e.byTaskId ? { byTaskId: String(e.byTaskId) } : {}),
        at: this.entryAt.get(String(e.id))?.at ?? new Date(0).toISOString(),
        slot: this.entryAt.get(String(e.id))?.slot ?? 0,
      });
    }
    let live: LiveState | undefined;
    const doc = await this.memory.findDocument({ kind: 'pi.live', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', ctx).catch(() => undefined);
    if (doc) live = (await this.memory.document(doc.id, 'current', ctx))?.value as LiveState | undefined;
    const tasks = [...this.tasks.values()];
    return {
      sessionId: this.sessionId,
      eventCount: this.eventCount,
      commits: this.commits,
      unfinished: tasks.some((t) => LIVE.has(t.status)),
      entries,
      ...(live ? { live } : {}),
      tasks: tasks.map((t) => ({ ...t, starts: [...t.starts] })),
      log: this.log.map((c) => ({ ...c })),
    };
  }
}
