import type { SessionState } from 'harness-world';
import { journalRecords, type TranscriptEntry } from 'harness-world-process/records';
import type { InstructionBlob, OpenCodeEvent } from './protocol.ts';

/**
 * OpenCode v2's records in the run's log, and the pure readers for them. No
 * Node imports: UIs read sessions with this module.
 *
 * OpenCode v2 is event-sourced: every change to a session is a durable event
 * with a per-session `seq`, committed in its SQLite before it is published.
 * The harness mirrors the session's committed events into the run's journal
 * (`harness-world-process`'s `NativeJournal`), one record per event on the
 * `opencode.events` stream (record id `seq:<n>`), and the instruction blobs
 * they reference on `opencode.blobs` (record id `blob:<hash>`). OpenCode's
 * SQLite is a cache of these records: every drive rebuilds it from them.
 */

export type { InstructionBlob, OpenCodeEvent } from './protocol.ts';

/** The journal stream of OpenCode's committed events. */
export const EVENTS = 'opencode.events';
/** The journal stream of instruction blobs. */
export const BLOBS = 'opencode.blobs';

/** The journal record id of the event at `seq` (dedupe: an event is journaled once, whichever drive ships it). */
export const eventRecordId = (seq: number) => `seq:${seq}`;
/** The journal record id of an instruction blob. */
export const blobRecordId = (hash: string) => `blob:${hash}`;

/** OpenCode's session id for a run. */
export const opencodeSessionId = (runId: string) => `ses_${runId}`;
/** OpenCode's message id for a submission: the inbox dedupes by it, so a resend is a no-op. */
export const opencodeMessageId = (submissionId: string) => `msg_${submissionId}`;

/** An event's type without its version: `session.tool.called.1` → `session.tool.called`. */
export const eventName = (e: Pick<OpenCodeEvent, 'type'>) => e.type.replace(/\.\d+$/, '');

/** The session's journaled events, in order. Offloaded (large) events are skipped here; the drive reads them with `NativeJournal.read`. */
export function eventsOf(state: SessionState): OpenCodeEvent[] {
  return journalRecords<OpenCodeEvent>(state, EVENTS)
    .map((r) => r.data)
    .filter((e): e is OpenCodeEvent => !!e);
}

/** The journaled instruction blobs. */
export function blobsOf(state: SessionState): InstructionBlob[] {
  return journalRecords<InstructionBlob>(state, BLOBS)
    .map((r) => r.data)
    .filter((b): b is InstructionBlob => !!b);
}

const TERMINAL = new Set(['session.execution.succeeded', 'session.execution.failed']);

/** Whether an event ends an execution (a turn). An interruption for shutdown does not: OpenCode keeps the claim to resume it. */
export function isTerminal(e: OpenCodeEvent): boolean {
  const name = eventName(e);
  if (TERMINAL.has(name)) return true;
  return name === 'session.execution.interrupted' && e.data?.reason !== 'shutdown';
}

/** What a sequence of a session's events says about the session, for recovery. */
export interface OpenCodeStatus {
  /** The last event's seq (-1 when there are none). */
  lastSeq: number;
  /**
   * OpenCode's execution claim (`session_v2.time_suspended`) would be held:
   * the last `session.execution.*` is `started`, or an interruption for
   * shutdown. The claim is written by a commit hook, so replay does not
   * restore it; the host sets it from this.
   */
  claimHeld: boolean;
  /**
   * Restart notices since the last terminal execution event: how many times
   * this turn was already resumed. OpenCode keeps the count in a plain
   * column (`resume_attempts`) that replay does not restore either.
   */
  restarts: number;
  /** An execution is running (started, not ended). */
  executing: boolean;
  /** Inbox ids OpenCode admitted (`session.inbox.enqueued`). */
  enqueued: Set<string>;
  /** Admitted inbox ids not yet delivered or cancelled. */
  undelivered: Set<string>;
}

/** Fold a session's events into its `OpenCodeStatus`. */
export function statusOf(events: OpenCodeEvent[]): OpenCodeStatus {
  const status: OpenCodeStatus = { lastSeq: -1, claimHeld: false, restarts: 0, executing: false, enqueued: new Set(), undelivered: new Set() };
  for (const e of events) applyStatus(status, e);
  return status;
}

/** Apply one event to a status (in place). */
export function applyStatus(status: OpenCodeStatus, e: OpenCodeEvent): void {
  status.lastSeq = Math.max(status.lastSeq, e.seq);
  const name = eventName(e);
  if (name === 'session.execution.started') {
    status.claimHeld = true;
    status.executing = true;
  } else if (name === 'session.execution.interrupted' && e.data?.reason === 'shutdown') {
    status.executing = false;
  } else if (isTerminal(e)) {
    status.claimHeld = false;
    status.executing = false;
    status.restarts = 0;
  } else if (name === 'session.synthetic' && e.data?.metadata?.notice === 'restart') {
    status.restarts++;
  } else if (name === 'session.inbox.enqueued') {
    status.enqueued.add(String(e.data.inboxID));
    status.undelivered.add(String(e.data.inboxID));
  } else if (name === 'session.inbox.delivered' || name === 'session.inbox.cancelled') {
    status.undelivered.delete(String(e.data.inboxID));
  }
}

/** The hashes of the instruction blobs an event references. */
export function blobHashes(e: OpenCodeEvent): string[] {
  if (eventName(e) !== 'session.instructions.updated') return [];
  const delta = e.data?.delta;
  if (!delta || typeof delta !== 'object') return [];
  return Object.values(delta as Record<string, unknown>).filter((h): h is string => typeof h === 'string');
}

/**
 * Turns a session's committed events into the normalized transcript
 * (`harness-world-process`'s `TranscriptEntry`): the model's text and the
 * tool calls it made, and a `turn` entry at the end of every execution.
 *
 * Text is held until the step that said it calls a tool or ends, so a
 * message and its calls are one entry (UIs place it before the tool rows
 * it references). Prime it with the events already journaled: text a crash
 * cut off before its step ended is then written once the resumed turn
 * settles that step.
 *
 * It also names each tool call for the log (`callId`): OpenCode's call id is
 * the model's, and some providers reuse ids across steps (Kimi's
 * `functions.bash:0`), where a plain `tool:<id>` key would answer a new call
 * from an older call's record and never run it.
 */
export class TranscriptBuilder {
  private said = '';
  private readonly names = new Map<string, string>();
  /** The assistant message that first called each call id. */
  private readonly first = new Map<string, string>();
  /** Each call id's latest call, as the log names it. */
  private readonly latest = new Map<string, string>();

  constructor(primed: Iterable<OpenCodeEvent> = []) {
    for (const e of primed) this.push(e);
  }

  /**
   * The id the log keys the latest call with OpenCode call id `id` by
   * (`tool:<callId>`): `id` itself, or `<id>@<assistant message id>` when an
   * earlier assistant message already called `id`. Derived from the events
   * alone, so a drive that rebuilds the session derives the same one; a call
   * OpenCode re-issues within its own message keeps its key (and its
   * recorded outcome).
   */
  callId(id: string): string {
    return this.latest.get(id) ?? id;
  }

  private called(id: string, message: unknown): string {
    const m = typeof message === 'string' ? message : '';
    const owner = this.first.get(id);
    if (owner === undefined) this.first.set(id, m);
    const named = owner === undefined || owner === m ? id : `${id}@${m}`;
    this.latest.set(id, named);
    return named;
  }

  /** The transcript entries this event completes. */
  push(e: OpenCodeEvent): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    const d = e.data ?? {};
    const flush = () => {
      if (this.said) out.push({ type: 'message', role: 'assistant', text: this.said });
      this.said = '';
    };
    switch (eventName(e)) {
      case 'session.text.ended':
        if (typeof d.text === 'string' && d.text) this.said = this.said ? `${this.said}\n\n${d.text}` : d.text;
        break;
      case 'session.tool.input.started':
        this.names.set(String(d.id), String(d.name));
        break;
      case 'session.tool.called': {
        const id = String(d.id);
        out.push({ type: 'message', role: 'assistant', text: this.said, toolCalls: [{ id: this.called(id, d.assistantMessageID), name: this.names.get(id) ?? 'tool' }] });
        this.said = '';
        break;
      }
      case 'session.step.ended':
      case 'session.step.failed':
        flush();
        break;
      case 'session.execution.succeeded':
        flush();
        out.push({ type: 'turn', status: 'completed' });
        break;
      case 'session.execution.failed':
        flush();
        out.push({ type: 'turn', status: 'failed', error: errorText(d.error) });
        break;
      case 'session.execution.interrupted':
        if (d.reason === 'shutdown') break;
        flush();
        out.push({ type: 'turn', status: 'interrupted', error: String(d.reason) });
        break;
    }
    return out;
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return error === undefined ? 'the turn failed' : JSON.stringify(error);
}
