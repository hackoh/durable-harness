import { describe, expect, it } from 'vitest';
import aiSdk from './fixtures/ai-sdk-crashes.json' with { type: 'json' };
import opencode from './fixtures/opencode-crashes.json' with { type: 'json' };
import { laneOf } from './lanes.ts';
import { docTitle, fmtClock, hiddenCount, logOrigin, logRows, messagesOf, todoItem } from './logrows.ts';
import type { EventView, SessionView } from './view.ts';

function load(fixture: { view: unknown; events: unknown[] }) {
  const view = fixture.view as SessionView;
  const events = (fixture.events as Omit<EventView, 'index'>[]).map((e, i) => ({ ...e, index: i + 1 }));
  return { view, events, rows: logRows(events, view, laneOf(view.effects, 'server')) };
}

describe('the event log, one row per step (the AI SDK, three crashes)', () => {
  const { view, events, rows } = load(aiSdk);

  it('builds its rows from every event, each event in one row', () => {
    expect(rows.reduce((n, r) => n + r.events.length, 0)).toBe(events.length);
    expect(new Set(rows.flatMap((r) => r.events.map((e) => e.eventId))).size).toBe(events.length);
  });

  it('names each message by what it was, in order', () => {
    const messages = rows.filter((r) => r.kind === 'message');
    expect(messages.map((r) => r.name)).toEqual(view.submissions.map((s) => ({ prompt: 'Prompt', steer: 'Steer', chaos: 'Crash armed' })[s.kind]));
    expect(messages[0]?.detail).toBe('Reply with one short sentence: what is a durable log?');
    expect(messagesOf(events, view).size).toBe(view.submissions.length);
  });

  it('counts time from the first prompt: it is at +0.0 s, the run before it is not', () => {
    const origin = logOrigin(events, view);
    const first = rows.find((r) => r.kind === 'message')!;
    expect(fmtClock(first.start - origin)).toBe('+0.0 s');
    expect(rows.filter((r) => r.start < origin).map((r) => r.name)).toEqual(['Run created', 'Run started', 'Inbox opened']);
  });

  it('strikes the steps a killed process left behind, naming the attempt that replaced them', () => {
    const struck = rows.filter((r) => r.superseded);
    expect(struck.map((r) => r.key).sort()).toEqual([...view.supersededStepIds].sort());
    expect(struck.every((r) => r.replacedAttempt === 2)).toBe(true);
  });

  it('marks the crash steps and the failed unsafe payment', () => {
    expect(rows.filter((r) => r.name === 'chaos').every((r) => r.tone === 'crash')).toBe(true);
    expect(rows.some((r) => r.name === 'tool.unsafe_make_payment' && r.status === 'failed')).toBe(true);
  });
});

describe('the event log for a process harness (OpenCode)', () => {
  const { events, rows } = load(opencode);

  it('folds its journal writes away, and says how many events showing them all adds', () => {
    const journal = rows.filter((r) => r.journal);
    expect(journal.length).toBeGreaterThan(50);
    expect(hiddenCount(rows)).toBe(journal.reduce((n, r) => n + r.events.length, 0));
    expect(rows.filter((r) => !r.journal).reduce((n, r) => n + r.events.length, 0) + hiddenCount(rows)).toBe(events.length);
  });
});

describe('log formatting', () => {
  it('keeps the time column one width past ten minutes', () => {
    expect(fmtClock(1234)).toBe('+1.2 s');
    expect(fmtClock(65_000)).toBe('+1:05');
    expect(fmtClock(12 * 60_000 + 5000)).toBe('+12:05');
    expect(fmtClock(3_725_000)).toBe('+1:02:05');
  });

  it('names a document by the last part of its kind', () => {
    expect(docTitle('demo.todos')).toBe('Todos');
  });

  it('reads a todo a model marked done as ticked, without the marker', () => {
    expect(todoItem('[x] buy milk')).toEqual({ done: true, text: 'buy milk' });
    expect(todoItem('[done] buy milk')).toEqual({ done: true, text: 'buy milk' });
    expect(todoItem('✓ call mom')).toEqual({ done: true, text: 'call mom' });
    expect(todoItem('call mom')).toEqual({ done: false, text: 'call mom' });
    expect(todoItem('[ ] call mom')).toEqual({ done: false, text: 'call mom' });
  });
});
