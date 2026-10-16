import { type EffectRecord, emptyState, type SessionState } from 'harness-world';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from './records.ts';
import { openTurn, recoveryNote } from './recovery.ts';

/** A fold built by hand: the records a drive would have left. */
function state(records: Partial<EffectRecord>[], submissions: { id: string; text: string }[] = []): SessionState {
  const s = emptyState('wrun_r');
  s.status = 'running';
  for (const sub of submissions) s.submissions.push({ id: sub.id, kind: 'prompt', text: sub.text, receivedAt: new Date() });
  records.forEach((r, i) => {
    const record = { stepId: `step_${i}`, replay: 'safe', status: 'completed', attempt: 1, placed: [], input: null, ...r } as EffectRecord;
    s.effectOrder.push(record);
    s.effects.set(record.key, record);
    for (const id of record.placed) s.placed.add(id);
  });
  return s;
}

let batches = 0;
const batch = (entries: TranscriptEntry[]): Partial<EffectRecord> => {
  const n = batches++;
  return { key: `journal:${n}`, name: 'journal', input: { v: 1, n, streams: { transcript: { from: 0, entries: entries.map((data) => ({ data })) } } } };
};
const place = (id: string): Partial<EffectRecord> => ({ key: `place:${id}`, name: 'place', placed: [id] });
const tool = (id: string, name: string, r: Partial<EffectRecord>): Partial<EffectRecord> => ({ key: `tool:${id}`, name: `tool.${name}`, input: { id }, ...r });

describe('recovery notes', () => {
  it('lists every call since the turn began, with what the log knows', () => {
    batches = 0;
    const s = state(
      [
        place('s1'),
        tool('c0', 'read_file', {}), // the previous turn's: not listed
        batch([{ type: 'message', role: 'assistant', text: 'done' }, { type: 'turn', status: 'completed' }]),
        place('s2'),
        batch([{ type: 'message', role: 'assistant', text: 'paying', toolCalls: [{ id: 'c1', name: 'pay' }] }]),
        tool('c1', 'pay', { replay: 'never', status: 'failed', error: { message: 'interrupted', interrupted: true } }),
        tool('c2', 'bash', { status: 'pending' }),
        tool('c3', 'read_file', { output: 'line 1\nline 2' }),
        tool('c4', 'edit_file', { status: 'failed', error: { message: 'oldText not found' } }),
      ],
      [
        { id: 's1', text: 'first' },
        { id: 's2', text: 'pay acme' },
        { id: 's3', text: 'also check the logs' },
      ]
    );
    const turn = openTurn(s)!;
    expect(turn.placed).toEqual(['s2']);
    expect(turn.entries.map((e) => e.data.type)).toEqual(['message']);
    const note = recoveryNote(s, { prompts: true })!;
    expect(note.calls.map((c) => [c.callId, c.status])).toEqual([
      ['c1', 'interrupted'],
      ['c2', 'retryable'],
      ['c3', 'completed'],
      ['c4', 'failed'],
    ]);
    expect(note.pending.map((p) => p.id)).toEqual(['s3']);
    expect(note.text).toContain('[Recovery]');
    expect(note.text).toContain('> pay acme');
    expect(note.text).toMatch(/pay\(\{"id":"c1"\}\), call c1: interrupted .* may have taken effect/);
    expect(note.text).toMatch(/bash\(\{"id":"c2"\}\), call c2: .*safe to repeat/);
    expect(note.text).toContain('    line 2');
    expect(note.text).toContain('failed: oldText not found');
    expect(note.text).toContain('New messages since then:\n> also check the logs');
  });

  it('is undefined when the last turn ended and nothing happened since', () => {
    batches = 0;
    const s = state([place('s1'), batch([{ type: 'turn', status: 'completed' }])], [{ id: 's1', text: 'hi' }]);
    expect(openTurn(s)).toBeUndefined();
    expect(recoveryNote(s)).toBeUndefined();
  });

  it('a crash that fired after the turn ended opens no turn: its step places only its own submission', () => {
    batches = 0;
    const s = state(
      [place('s1'), batch([{ type: 'turn', status: 'completed' }]), { key: 'model:late', name: 'model', status: 'pending' }, { key: 'chaos:c1', name: 'chaos', placed: ['c1'] }],
      [{ id: 's1', text: 'hi' }]
    );
    expect(openTurn(s)).toBeUndefined();
    expect(recoveryNote(s)).toBeUndefined();
  });

  it('a turn cut off before any tool: the note says so', () => {
    batches = 0;
    const s = state([place('s1')], [{ id: 's1', text: 'hi' }]);
    const note = recoveryNote(s, { pending: [] })!;
    expect(note.calls).toEqual([]);
    expect(note.text).toContain('No tool call had started in that turn.');
    expect(note.text).not.toContain('New messages');
  });
});
