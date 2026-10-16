import { describe, expect, it } from 'vitest';
import { buildItems } from './Transcript.tsx';
import { type FxLine, fxBusy, fxLiveEvents, fxPartial, fxProjection } from './fx-view.ts';
import { LatencyTracker } from './latency.ts';

const T0 = 1_800_000_000_000;
let cursor = 0;
const line = (type: string, fields: Partial<FxLine> = {}): FxLine => ({ type, cursor: ++cursor, at: T0 + cursor * 100, epoch: 1, messageId: 'm1', ...fields });

/** A prompt, a model call asking for bash, the call, then a second model call that answers. */
function turn(): FxLine[] {
  cursor = 0;
  return [
    line('turn_start', { sessionId: 'wrun_1', input: 'make a file' }),
    line('text_delta', { delta: 'Writing it.' }),
    line('tool_start', { id: 'toolu_1', name: 'bash', input: { command: 'echo hi > a.txt' } }),
    line('tool_end', { id: 'toolu_1', name: 'bash', content: 'exit 0' }),
    line('text_delta', { delta: 'Done' }),
    line('text_delta', { delta: '.' }),
    line('turn_end', { stopReason: 'end_turn' }),
  ];
}

describe('fxProjection', () => {
  it('puts a steer sent during a tool before the step that took it, not at the end', () => {
    cursor = 0;
    const lines = [
      line('turn_start', { sessionId: 'wrun_1', input: 'run two commands' }),
      line('tool_start', { id: 'toolu_1', name: 'bash', input: { command: 'sleep 6 && echo first' } }),
      line('user_message', { text: 'also echo steered' }),
      line('tool_end', { id: 'toolu_1', name: 'bash', content: 'first' }),
      line('tool_start', { id: 'toolu_2', name: 'bash', input: { command: 'echo steered' } }),
      line('tool_end', { id: 'toolu_2', name: 'bash', content: 'steered' }),
      line('text_delta', { delta: 'Both ran.' }),
      line('turn_end', { stopReason: 'end_turn' }),
    ];
    const { view } = fxProjection('wrun_1', lines);
    const order = buildItems(view, new Map(), []).map((i) => (i.t === 'user' ? `${i.steer ? 'steer' : 'you'}:${i.text}` : i.t === 'tool' ? `tool:${i.effect.input.command}` : i.t));
    expect(order).toEqual(['you:run two commands', 'tool:sleep 6 && echo first', 'steer:also echo steered', 'tool:echo steered', 'model']);
  });

  it('folds a turn into the prompt, each model call and the tool', () => {
    const { view, events } = fxProjection('wrun_1', turn());
    expect(view.harness).toBe('fx-durable');
    expect(view.submissions).toEqual([{ id: 'm1', kind: 'prompt', text: 'make a file', placed: true, withdrawn: false }]);
    expect(view.effects.map((e) => [e.name, e.status, e.attempt])).toEqual([
      ['model', 'completed', 1],
      ['tool.bash', 'completed', 1],
      ['model', 'completed', 1],
    ]);
    expect(view.effects[0]!.placed).toEqual(['m1']);
    expect(view.effects[0]!.output).toEqual({ content: [{ type: 'text', text: 'Writing it.' }] });
    expect(view.effects[1]!.input).toEqual({ command: 'echo hi > a.txt' });
    expect(view.effects[2]!.output).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
    // Text deltas are not rows: a model call is one start and one end.
    expect(events.map((e) => [e.eventType, e.stepName])).toEqual([
      ['hook_received', 'turn_start'],
      ['step_started', 'model'],
      ['step_completed', 'model'],
      ['step_started', 'bash'],
      ['step_completed', 'bash'],
      ['step_started', 'model'],
      ['step_completed', 'model'],
      ['hook_received', 'turn_end (end_turn)'],
    ]);
    // The transcript draws it like any other session.
    expect(buildItems(view, new Map(), []).map((i) => i.t)).toEqual(['user', 'model', 'tool', 'model']);
    expect(fxBusy(turn())).toBe(false);
  });

  it('shows an idempotent call that ran again after a takeover', () => {
    const lines = turn().slice(0, 3);
    lines.push(
      line('turn_resume', { epoch: 2 }),
      line('tool_start', { id: 'toolu_1', name: 'bash', epoch: 2 }),
      line('tool_end', { id: 'toolu_1', name: 'bash', content: 'exit 0', epoch: 2 }),
      line('turn_end', { stopReason: 'end_turn', epoch: 2 })
    );
    const { view } = fxProjection('wrun_1', lines, [
      { t: 'armed', at: T0, spec: { at: 'tool', afterMs: 1500 } },
      { t: 'fired', at: T0 + 2000, spec: { at: 'tool', afterMs: 1500 }, effectKey: 'tool:toolu_1', effectName: 'tool.bash' },
    ]);
    expect(view.effects.map((e) => [e.name, e.status, e.attempt])).toEqual([
      ['model', 'completed', 1],
      ['tool.bash', 'completed', 2],
      ['chaos', 'completed', 1],
    ]);
    expect(view.effects[2]!.output).toMatchObject({ crashedDuring: 'tool:toolu_1', effect: 'tool.bash' });
    expect(view.armedChaos).toBeUndefined();
  });

  it('leaves a call that is not run again interrupted, and restarts a model call cut off mid-stream', () => {
    cursor = 0;
    const lines = [
      line('turn_start', { input: 'pay' }),
      line('tool_start', { id: 'toolu_9', name: 'unsafe_make_payment' }),
      line('turn_resume', { epoch: 2 }),
      line('text_delta', { delta: 'The pay', epoch: 2 }),
      line('turn_resume', { epoch: 3 }),
      line('text_delta', { delta: 'The payment may have gone through.', epoch: 3 }),
      line('turn_end', { stopReason: 'end_turn', epoch: 3 }),
    ];
    const { view } = fxProjection('wrun_1', lines);
    const [model, tool, answer] = view.effects;
    expect([model!.name, model!.status]).toEqual(['model', 'completed']);
    expect([tool!.name, tool!.status, tool!.error]).toEqual(['tool.unsafe_make_payment', 'failed', { interrupted: true, message: 'the process running this call stopped' }]);
    // The answer's first attempt died after "The pay"; the second starts over.
    expect([answer!.status, answer!.attempt, answer!.output]).toEqual(['completed', 2, { content: [{ type: 'text', text: 'The payment may have gone through.' }] }]);
  });

  it('places a model-step crash after the model call the takeover restarted', () => {
    cursor = 0;
    const lines = [
      line('turn_start', { input: 'hi' }),
      line('text_delta', { delta: 'Hel' }),
      line('turn_resume', { epoch: 2 }),
      line('text_delta', { delta: 'Hello.', epoch: 2 }),
      line('turn_end', { stopReason: 'end_turn', epoch: 2 }),
    ];
    const { view } = fxProjection('wrun_1', lines, [
      { t: 'armed', at: T0, spec: { at: 'model', afterMs: 500 } },
      // The app's own key for the request; the stream has no model call ids.
      { t: 'fired', at: T0 + 700, spec: { at: 'model', afterMs: 500 }, effectKey: 'model:3f2a', effectName: 'model' },
    ]);
    expect(view.effects.map((e) => [e.name, e.attempt])).toEqual([
      ['model', 2],
      ['chaos', 1],
    ]);
    expect(view.effects[1]!.output).toMatchObject({ crashedDuring: view.effects[0]!.key, effect: 'model' });
  });

  it('does not count a deadline yield as a crash', () => {
    const lines = turn().slice(0, 4);
    lines.push(line('turn_yield'), line('turn_resume', { epoch: 2 }), line('text_delta', { delta: 'ok', epoch: 2 }), line('turn_end', { stopReason: 'end_turn', epoch: 2 }));
    const { view } = fxProjection('wrun_1', lines);
    expect(view.effects.map((e) => [e.name, e.status, e.attempt])).toEqual([
      ['model', 'completed', 1],
      ['tool.bash', 'completed', 1],
      ['model', 'completed', 1],
    ]);
  });

  it('shows how a failed turn ended, and what is armed and in the workspace', () => {
    cursor = 0;
    const lines = [line('turn_start', { input: 'hi' }), line('turn_end', { stopReason: 'error', error: { message: 'the engine stopped each of the 3 times it started this turn' } })];
    // The side route sends the newest workspace record and how many there are.
    const { view } = fxProjection('wrun_1', lines, [{ t: 'armed', at: T0, spec: { at: 'tool', afterMs: 0 } }], {
      latest: { executionId: 'toolu_2', tool: 'edit_file', output: 'edited', files: { '/workspace/a.txt': 'v2' }, at: T0 + 1 },
      count: 2,
    });
    expect(view.effects.map((e) => [e.name, e.status, e.error])).toEqual([['model', 'failed', { message: 'the engine stopped each of the 3 times it started this turn' }]]);
    expect(view.armedChaos).toEqual({ at: 'tool', afterMs: 0 });
    expect(view.files).toEqual({ '/workspace/a.txt': 'v2' });
    expect(view.eventCount).toBe(2 + 1 + 2);
  });
});

describe('live', () => {
  it('replays the running call and maps lines to the page events', () => {
    const lines = turn().slice(0, 5);
    expect(fxBusy(lines)).toBe(true);
    expect(fxPartial(lines)).toBe('Done');
    expect(fxLiveEvents(lines[4]!, true)).toEqual([{ type: 'text', delta: 'Done', t: lines[4]!.at }]);
    expect(fxLiveEvents(lines[2]!, true)).toEqual([{ type: 'tool_start', name: 'bash', t: lines[2]!.at }]);
    expect(fxLiveEvents(lines[3]!, true)).toEqual([{ type: 'tool_end', name: 'bash', isError: false, t: lines[3]!.at }]);
    const end = line('turn_end', { stopReason: 'end_turn' });
    expect(fxLiveEvents(end, false).map((e: any) => e.type)).toEqual(['idle']);
    // Another prompt is queued: the session is not idle yet.
    expect(fxLiveEvents(end, true).map((e: any) => e.type)).toEqual(['line']);
  });

  it('ends a turn in the pages\' turn timing, which marks would hold open', () => {
    // What Shell and /compare do with live events: a mark would make the
    // tracker wait for the durable kernel's idle mark, which never comes.
    const tracker = new LatencyTracker();
    tracker.sent('prompt', T0);
    let busy = false;
    for (const l of turn()) {
      if (l.type === 'turn_start' || l.type === 'turn_resume') busy = true;
      else if (l.type === 'turn_end') busy = false;
      for (const e of fxLiveEvents(l, busy)) tracker.event(e, l.at);
    }
    const [timing] = tracker.turns;
    expect(timing!.ttft).toBe(200);
    expect(timing!.turn).toBe(700);
  });
});
