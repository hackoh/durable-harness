import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blobHashes, eventName, isTerminal, type OpenCodeEvent, statusOf, TranscriptBuilder } from './records.ts';

/**
 * The pure readers, on events recorded from real OpenCode 2.0.22 turns
 * through this harness (`test/fixtures/`): `turn.json` is one turn with two
 * tool calls; `crash.json` is a turn whose process was SIGKILLed during
 * `unsafe_make_payment` (seq 0-9) and the recovery that finished it on
 * another session root (seq 10-21).
 */

interface Fixture {
  runId: string;
  events: OpenCodeEvent[];
  blobs: { hash: string; value: unknown }[];
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const turn = fixture('turn');
const crash = fixture('crash');
const upTo = (f: Fixture, seq: number) => f.events.filter((e) => e.seq <= seq);
const msgId = (f: Fixture) => String(f.events.find((e) => eventName(e) === 'session.inbox.enqueued')!.data.inboxID);

describe('statusOf', () => {
  it('a finished turn: no claim, nothing undelivered', () => {
    const s = statusOf(turn.events);
    expect(s).toMatchObject({ lastSeq: 28, claimHeld: false, executing: false, restarts: 0 });
    expect([...s.enqueued]).toEqual([msgId(turn)]);
    expect(s.undelivered.size).toBe(0);
  });

  it('a turn cut off mid tool: the claim is held, the prompt admitted', () => {
    const s = statusOf(upTo(crash, 9));
    expect(s).toMatchObject({ lastSeq: 9, claimHeld: true, executing: true, restarts: 0 });
    expect(s.enqueued.has(msgId(crash))).toBe(true);
    expect(s.undelivered.size).toBe(0);
  });

  it('counts restart notices until a terminal event resets them', () => {
    // seq 10: our recovery note (inbox), 11: OpenCode's restart notice, 12: the resumed execution.
    expect(statusOf(upTo(crash, 12))).toMatchObject({ claimHeld: true, restarts: 1 });
    expect(statusOf(upTo(crash, 10)).undelivered.size).toBe(1);
    expect(statusOf(crash.events)).toMatchObject({ claimHeld: false, executing: false, restarts: 0 });
  });

  it('an interruption for shutdown keeps the claim; any other ends the turn', () => {
    const base = upTo(crash, 9);
    const at = (data: object) => ({ id: 'evt_x', seq: 10, created: 0, type: 'session.execution.interrupted.1', data: { sessionID: 's', ...data } });
    expect(isTerminal(at({ reason: 'shutdown' }))).toBe(false);
    expect(statusOf([...base, at({ reason: 'shutdown' })])).toMatchObject({ claimHeld: true, executing: false });
    expect(isTerminal(at({ reason: 'user' }))).toBe(true);
    expect(statusOf([...base, at({ reason: 'user' })])).toMatchObject({ claimHeld: false });
  });
});

describe('TranscriptBuilder', () => {
  it('a message and the call it made are one entry; a turn ends at the execution’s end', () => {
    const b = new TranscriptBuilder();
    const entries = turn.events.flatMap((e) => b.push(e));
    expect(entries.map((e) => (e.type === 'turn' ? `turn:${e.status}` : `${e.role}:${e.type === 'message' && 'toolCalls' in e ? e.toolCalls?.map((c) => c.name).join(',') : ''}`))).toEqual([
      'assistant:write_file',
      'assistant:read_file',
      'assistant:',
      'turn:completed',
    ]);
    const [first, , last] = entries as { text: string; toolCalls?: { id: string }[] }[];
    expect(first!.text).toContain('haiku');
    // The call id is OpenCode's own: the tool's effect key is `tool:<id>`.
    expect(first!.toolCalls![0]!.id).toBe(turn.events.find((e) => eventName(e) === 'session.tool.called')!.data.id);
    expect(last!.text.length).toBeGreaterThan(0);
  });

  it('primed with the journal, it writes only what new events complete', () => {
    const b = new TranscriptBuilder(upTo(crash, 9));
    const entries = crash.events.filter((e) => e.seq > 9).flatMap((e) => b.push(e));
    expect(entries.map((e) => e.type)).toEqual(['message', 'turn']);
    expect(entries[0]).toMatchObject({ role: 'assistant', text: expect.stringContaining('payment') });
    expect(entries[1]).toEqual({ type: 'turn', status: 'completed' });
  });

  it('names a call id an earlier assistant message used by its own message; the first use, or a re-issue in the same message, keeps the plain id', () => {
    const ev = (seq: number, type: string, data: object) => ({ id: `evt_${seq}`, seq, created: 0, type: `${type}.1`, data: { sessionID: 's', ...data } });
    const id = 'functions.bash:0';
    const b = new TranscriptBuilder([ev(0, 'session.tool.called', { id, assistantMessageID: 'msg_1' })]);
    expect(b.callId(id)).toBe(id);
    b.push(ev(1, 'session.tool.called', { id, assistantMessageID: 'msg_1' }));
    expect(b.callId(id)).toBe(id);
    const [entry] = b.push(ev(2, 'session.tool.called', { id, assistantMessageID: 'msg_2' }));
    expect(b.callId(id)).toBe(`${id}@msg_2`);
    expect(entry).toMatchObject({ toolCalls: [{ id: `${id}@msg_2` }] });
    // A builder primed with the same events (the next drive) derives the same names.
    expect(new TranscriptBuilder([ev(0, 'session.tool.called', { id, assistantMessageID: 'msg_1' }), ev(2, 'session.tool.called', { id, assistantMessageID: 'msg_2' })]).callId(id)).toBe(`${id}@msg_2`);
    expect(b.callId('never-called')).toBe('never-called');
  });

  it('text a crash cut off before its step ended is written when the step settles', () => {
    const textEnded = { id: 'evt_t', seq: 6, created: 0, type: 'session.text.ended.1', data: { sessionID: 's', text: 'half a thought' } };
    const b = new TranscriptBuilder([textEnded]);
    expect(b.push({ id: 'evt_f', seq: 7, created: 0, type: 'session.step.failed.1', data: { sessionID: 's' } })).toEqual([
      { type: 'message', role: 'assistant', text: 'half a thought' },
    ]);
  });
});

describe('blobHashes', () => {
  it('names the instruction blobs an instructions update references, and they were journaled', () => {
    const update = turn.events.find((e) => eventName(e) === 'session.instructions.updated')!;
    const hashes = blobHashes(update);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every((h) => turn.blobs.some((b) => b.hash === h))).toBe(true);
    expect(blobHashes(turn.events[0]!)).toEqual([]);
  });

  it('a recovery on another machine re-observes its environment: a new blob, journaled too', () => {
    const updates = crash.events.filter((e) => eventName(e) === 'session.instructions.updated');
    expect(updates).toHaveLength(2);
    const second = blobHashes(updates[1]!);
    expect(second.every((h) => crash.blobs.some((b) => b.hash === h))).toBe(true);
  });
});
