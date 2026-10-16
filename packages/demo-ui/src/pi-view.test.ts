import { describe, expect, it } from 'vitest';
import { buildItems } from './Transcript.tsx';
import { type PiSnapshot, piProjection, runningEffect } from './pi-view.ts';

const at = (s: number) => new Date(1_800_000_000_000 + s * 1000).toISOString();
const commit = (slot: number, summary: string[], entryIds: string[] = [], by = 'pi_A') => ({
  eventId: `evnt_${slot}`,
  slot,
  at: at(slot),
  valid: true,
  by,
  summary,
  entryIds,
  taskIds: [],
});

/** A turn: a prompt, a model call asking for write_file, the tool, then a second model call streaming. */
function turn(): PiSnapshot {
  return {
    sessionId: 'wrun_1',
    eventCount: 12,
    commits: 9,
    unfinished: true,
    entries: [
      { id: '3', kind: 'pi.system', at: at(4), slot: 4 },
      { id: '5', kind: 'pi.user', model: [{ role: 'user', content: 'write a.txt' }], at: at(5), slot: 5 },
      {
        id: '9',
        kind: 'pi.assistant',
        byTaskId: '6',
        model: [{ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Writing.' }, { type: 'toolCall', id: 'call_1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } }] }],
        at: at(7),
        slot: 7,
      },
      {
        id: '11',
        kind: 'pi.tool-result',
        byTaskId: '10',
        model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'write_file', isError: false, content: [{ type: 'text', text: 'wrote 2 bytes' }], details: { files: { '/workspace/a.txt': 'hi' } } }],
        at: at(9),
        slot: 9,
      },
    ],
    live: { run: { taskId: '4', inputs: [] }, generation: { attempt: 1, message: { content: [{ type: 'text', text: 'Done, I wro' }] } } },
    tasks: [
      { id: '4', kind: 'pi.run', status: 'running', starts: [{ slot: 5, at: at(5), by: 'pi_A' }] },
      { id: '6', kind: 'pi.generation', status: 'terminal', starts: [{ slot: 6, at: at(6), by: 'pi_A' }], endedAt: at(7) },
      { id: '10', kind: 'pi.tool', status: 'terminal', input: { callId: 'call_1' }, starts: [{ slot: 8, at: at(8), by: 'pi_A' }], endedAt: at(9) },
      { id: '12', kind: 'pi.generation', status: 'running', starts: [{ slot: 10, at: at(10), by: 'pi_A' }] },
    ],
    log: [commit(5, ['entry pi.user'], ['5']), commit(6, ['task pi.generation running']), commit(7, ['entry pi.assistant'], ['9']), commit(8, ['task pi.tool running']), commit(9, ['entry pi.tool-result'], ['11']), commit(10, ['task pi.generation running']), commit(11, ['doc change'])],
  };
}

describe('piProjection', () => {
  it('maps a Pi session onto the page: prompt, model calls, tool, streamed partial, files, log rows', () => {
    const { view, events } = piProjection(turn());
    expect(view.harness).toBe('pi-durable');
    expect(view.eventCount).toBe(12);
    expect(piProjection(turn(), [{ t: 'armed', at: 1, spec: { at: 'tool' } }]).view.eventCount).toBe(13);
    expect(view.submissions).toEqual([{ id: 'evnt_5', kind: 'prompt', text: 'write a.txt', placed: true, withdrawn: false }]);
    expect(view.effects.map((e) => [e.key, e.name, e.status])).toEqual([
      ['gen:6', 'model', 'completed'],
      ['tool:10', 'tool.write_file', 'completed'],
      ['gen:12', 'model', 'running'],
    ]);
    expect(view.effects[0]!.placed).toEqual(['evnt_5']);
    expect(view.effects[1]!.input).toEqual({ path: 'a.txt', content: 'hi' });
    expect(view.effects[2]!.output).toEqual({ content: [{ type: 'text', text: 'Done, I wro' }] });
    expect(view.files).toEqual({ '/workspace/a.txt': 'hi' });
    expect(events.map((e) => [e.eventType, e.correlationId])).toEqual([
      ['hook_received', undefined],
      ['step_started', 'gen:6'],
      ['step_completed', 'gen:6'],
      ['step_started', 'tool:10'],
      ['step_completed', 'tool:10'],
      ['step_started', 'gen:12'],
      ['hook_received', undefined],
    ]);
    // The transcript draws it like any other session: the prompt, then each step.
    const items = buildItems(view, new Map(), []);
    expect(items.map((i) => i.t)).toEqual(['user', 'model', 'tool', 'model']);
    expect(runningEffect(turn())).toEqual({ key: 'gen:12', name: 'model' });
  });

  it('shows a crash, a safe tool rerun by another process, and an unsafe tool interrupted', () => {
    const snap = turn();
    // The write_file tool reran in process B (before its result landed, now at slot 23).
    snap.tasks[2]!.starts.push({ slot: 20, at: at(40), by: 'pi_B' });
    snap.entries[3]!.slot = 23;
    // B also resumed the first generation's tools phase: not a rerun of the model call.
    snap.tasks[1]!.starts.push({ slot: 19, at: at(39), by: 'pi_B' });
    snap.tasks.push({ id: '30', kind: 'pi.tool', status: 'terminal', input: { callId: 'call_2' }, starts: [{ slot: 21, at: at(41), by: 'pi_B' }] });
    snap.entries.push({
      id: '31',
      kind: 'pi.tool-result',
      byTaskId: '30',
      model: [{ role: 'toolResult', toolCallId: 'call_2', toolName: 'unsafe_make_payment', isError: true, content: [{ type: 'text', text: 'Tool unsafe_make_payment was interrupted and may have partially run' }] }],
      at: at(41),
      slot: 22,
    });
    snap.entries[2]!.model![0].content.push({ type: 'toolCall', id: 'call_2', name: 'unsafe_make_payment', arguments: { amount_usd: 5 } });
    const { view } = piProjection(snap, [
      { t: 'armed', at: Date.parse(at(1)), spec: { at: 'tool', afterMs: 1500 } },
      { t: 'fired', at: Date.parse(at(8.5)), spec: { at: 'tool', afterMs: 1500 }, effectKey: 'tool:10', effectName: 'tool.write_file', by: 'pi_A' },
    ]);
    const tool = view.effects.find((e) => e.key === 'tool:10')!;
    expect(tool.attempt).toBe(2);
    expect(tool.startedAt).toBe(at(40));
    expect(view.effects.find((e) => e.key === 'gen:6')!.attempt).toBe(1);
    const pay = view.effects.find((e) => e.key === 'tool:30')!;
    expect(pay).toMatchObject({ status: 'failed', attempt: 1, error: { interrupted: true } });
    const chaos = view.effects.find((e) => e.name === 'chaos')!;
    expect(chaos.output).toMatchObject({ crashedDuring: 'tool:10', effect: 'tool.write_file', kind: 'process' });
    expect(view.armedChaos).toBeUndefined();
    // Its row sits in the log in time order, so the page reads the crash at once.
    const rows = piProjection(snap, [{ t: 'fired', at: Date.parse(at(8.5)), spec: { at: 'tool' }, effectKey: 'tool:10' }]).events;
    expect(rows.findIndex((e) => e.correlationId === 'chaos:0')).toBe(rows.findIndex((e) => e.eventId === 'evnt_9') - 1);
    const armedOnly = piProjection(snap, [{ t: 'armed', at: 1, spec: { at: 'any', afterMs: 500 } }]).view;
    expect(armedOnly.armedChaos).toEqual({ at: 'any', afterMs: 500 });
  });

  it("folds each call's file changes (durable-harness/pi-durable's virtualEnv(): details['hw.workspace'])", () => {
    const snap = turn();
    const result = (id: string, slot: number, files: Record<string, unknown>) => ({
      id,
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolCallId: `call_${id}`, toolName: 'bash', isError: false, content: [{ type: 'text', text: '' }], details: { 'hw.workspace': { files } } }],
      at: at(slot),
      slot,
    });
    snap.entries.push(
      result('20', 20, { '/workspace/b.txt': 'bee', '/workspace/run.sh': { t: 'echo hi', m: 0o755 }, '/workspace/big.txt': { n: 9000, h: 'f'.repeat(64) }, '/workspace/bin.dat': { d: 'AP8=' } }),
      result('21', 21, { '/workspace/a.txt': null, '/workspace/b.txt': 'bee 2' })
    );
    expect(piProjection(snap).view.files).toEqual({
      '/workspace/b.txt': 'bee 2',
      '/workspace/run.sh': 'echo hi',
      '/workspace/big.txt': "(9000 bytes, in the session's blob stream)",
      '/workspace/bin.dat': '(binary)',
    });
  });
});
