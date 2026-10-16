import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { crashes, laneOf, logIndex, nowState, stepTimes } from './lanes.ts';
import { Row, type RowCtx } from './Rows.tsx';
import { buildItems } from './Transcript.tsx';
import type { EffectView, EventView, SessionView } from './view.ts';

/** A view and its log, built by hand: each effect gets a started (and maybe ended) event. */
function session(effects: (EffectView & { t0: number; t1?: number })[], status = 'running'): { view: SessionView; events: EventView[] } {
  const events: EventView[] = [];
  const at = (s: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, s)).toISOString();
  for (const e of effects) {
    events.push({ eventId: `e${events.length}`, eventType: 'step_started', correlationId: e.stepId, createdAt: at(e.t0), index: events.length + 1 });
    if (e.t1 !== undefined)
      events.push({ eventId: `e${events.length}`, eventType: 'step_completed', correlationId: e.stepId, createdAt: at(e.t1), index: events.length + 1 });
  }
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  events.forEach((e, i) => (e.index = i + 1));
  const view: SessionView = {
    id: 'wrun_x',
    harness: 'hybrid-fx',
    status,
    eventCount: events.length,
    lane: 'browser',
    submissions: [],
    effects: effects.map(({ t0: _a, t1: _b, ...e }) => e),
    files: {},
    supersededStepIds: [],
  };
  return { view, events };
}

const eff = (key: string, name: string, status: string, extra: Partial<EffectView> = {}): EffectView => ({
  key,
  stepId: `step_${key}`,
  name,
  status,
  attempt: 1,
  input: null,
  output: undefined,
  placed: [],
  ...extra,
});

function render(view: SessionView, events: EventView[]) {
  const mode = 'hybrid' as const;
  const lanes = laneOf(view.effects, mode);
  const times = stepTimes(events);
  const list = crashes(view, lanes, times, mode);
  const items = buildItems(view, lanes, list);
  const ctx: RowCtx = {
    mode,
    world: 'vercel',
    harnessName: 'fx',
    times,
    index: logIndex(events),
    live: { text: '', done: true } as never,
    onSelect() {},
    onHover() {},
    onCite() {},
    onOpenFile() {},
  };
  const crash = items.find((i) => i.t === 'crash')!;
  const html = renderToStaticMarkup(createElement(Row, { item: crash, ctx, sig: '', cites: '', selected: false, tab: false }));
  return { list, html: html.replace(/<[^>]+>/g, ''), now: nowState(view, mode, 'vercel', lanes, times, list) };
}

const chaosOut = (target: EffectView, extra: Record<string, unknown> = {}) => ({
  v: 2,
  kind: 'process',
  crashedDuring: target.key,
  stepId: target.stepId,
  effect: target.name,
  afterMs: 1500,
  driver: 'drv_dead',
  lane: 'function',
  ...extra,
});

describe('crash rows', () => {
  it('names what the killed drive left open (the production race: a checkpoint), and ticks only while it is open', () => {
    const model = eff('model:8', 'model', 'completed', { driver: 'drv_dead' });
    const checkpoint = eff('checkpoint:8', 'checkpoint', 'running', { driver: 'drv_dead' });
    const chaos = eff('chaos:s1', 'chaos', 'completed', { output: chaosOut(model) });
    const { view, events } = session([
      { ...model, t0: 0, t1: 2 },
      { ...chaos, t0: 1, t1: 2 },
      { ...checkpoint, t0: 3 },
    ]);
    const { list, html, now } = render(view, events);
    expect(list[0]).toMatchObject({ state: 'waiting', open: ['Checkpoint for turn 9'] });
    expect(html).toContain('Function killed 1.5\u00a0s into the model call in the Function lane (attempt 1).');
    expect(html).toContain('Checkpoint for turn 9 is open. Waiting for the queue to hand the turn to a new Function');
    expect(now.text).toBe('Killed. Waiting for the queue to hand the turn to a new Function.');
  });

  it('says nothing was left open instead of counting forever', () => {
    const model = eff('model:8', 'model', 'completed', { driver: 'drv_dead' });
    const chaos = eff('chaos:s1', 'chaos', 'completed', { output: chaosOut(model) });
    const { view, events } = session([
      { ...model, t0: 0, t1: 1 },
      { ...chaos, t0: 2, t1: 2 },
    ]);
    const { list, html, now } = render(view, events);
    expect(list[0]).toMatchObject({ state: 'clear', open: [] });
    expect(html).toContain('Nothing was left open: the session carried on.');
    expect(now.text).not.toContain('Waiting for the queue');
  });

  it('tells each sandbox crash apart, and who collected the result', () => {
    const cases: [string, Record<string, unknown>, Partial<EffectView>, RegExp][] = [
      [
        'sandbox-vm',
        {},
        { status: 'failed', error: { interrupted: true, message: 'VM stopped' }, settlement: { by: 'check', ok: false, files: [] } },
        /Sandbox VM stopped 4\u00a0s into sandbox_exec.*A result check found the VM gone .* later and gave the model an interrupted result; the next command restores \/workspace from the log/,
      ],
      [
        'sandbox-command',
        {},
        { status: 'completed', output: 'exit code: 137', settlement: { by: 'push', ok: true, exitCode: 137, files: [] } },
        /Command killed 4\u00a0s into sandbox_exec.*The command exited 137 and the sandbox reported it, .* later/,
      ],
      [
        'drop-callback',
        {},
        { status: 'completed', output: 'exit code: 0', settlement: { by: 'check', ok: true, exitCode: 0, files: [] } },
        /report for sandbox_exec was dropped.*The result check collected it from the Sandbox API .* later/,
      ],
      [
        'process',
        {},
        { status: 'completed', output: 'exit code: 0', settlement: { by: 'check', ok: true, exitCode: 0, files: [] } },
        /Function killed 4\u00a0s into sandbox_exec.*The command kept running in the sandbox and reported .* later \(the result check collected it/,
      ],
      [
        // Driven from the Sandbox lane, the process that dies is the VM's host daemon.
        'process',
        { lane: 'sandbox' },
        { status: 'completed', output: 'exit code: 0', settlement: { by: 'check', ok: true, exitCode: 0, files: [] } },
        /Sandbox host killed 4\u00a0s into sandbox_exec \(attempt 1\).*The command kept running in the sandbox/,
      ],
    ];
    for (const [kind, out, tool, want] of cases) {
      const exec = eff('tool:1', 'tool.sandbox_exec', 'running', { park: { kind: 'sandbox', cmdId: 'cmd_1' }, ...tool });
      const chaos = eff('chaos:s1', 'chaos', 'completed', { output: chaosOut(exec, { kind, afterMs: 4000, ...out }) });
      const settle = eff('settle:1', 'settle', 'completed', { input: { forStepId: exec.stepId, paths: [] } });
      const { view, events } = session([
        { ...exec, t0: 0, t1: 9 },
        { ...chaos, t0: 4, t1: 4 },
        { ...settle, t0: 8, t1: 8 },
      ]);
      const { list, html } = render(view, events);
      expect(list[0]!.state).not.toBe('waiting');
      expect(html).toMatch(want);
    }
  });

  it('a process harness: its model step (a drill) has no row of its own; the crash it took is replayed by the recovered turn', () => {
    const model = eff('model:a', 'model', 'completed', { driver: 'drv_dead', attempt: 2, input: { method: 'POST', path: '/v1/messages' } });
    const chaos = eff('chaos:s1', 'chaos', 'completed', { output: chaosOut(model) });
    const journal = eff('journal:3', 'journal', 'completed', { input: { v: 1, n: 3, streams: { transcript: { from: 0, entries: [{ data: { type: 'message', role: 'assistant', text: 'A poem.' } }] } } } });
    const { view, events } = session([
      { ...chaos, t0: 2, t1: 2 },
      // The retry's intent: started after the crash.
      { ...model, t0: 5, t1: 8 },
      { ...journal, t0: 9, t1: 9 },
    ]);
    const processView: SessionView = { ...view, harness: 'claude-code', turnOpen: false, lane: undefined };
    const mode = 'server' as const;
    const lanes = laneOf(processView.effects, mode);
    const times = stepTimes(events);
    const list = crashes(processView, lanes, times, mode);
    expect(list[0]).toMatchObject({ state: 'replayed', attempt: 2, effectName: 'model' });
    const items = buildItems(processView, lanes, list);
    expect(items.map((i) => i.t)).toEqual(['crash', 'message']);
    const ctx: RowCtx = {
      mode,
      world: 'local',
      harnessName: 'Claude Code',
      times,
      index: logIndex(events),
      live: { text: '', done: true } as never,
      onSelect() {},
      onHover() {},
      onCite() {},
      onOpenFile() {},
    };
    const html = renderToStaticMarkup(createElement(Row, { item: items[0]!, ctx, sig: '', cites: '', selected: false, tab: false })).replace(/<[^>]+>/g, '');
    expect(html).toContain('killed 1.5\u00a0s into the model call');
    expect(html).toContain('resumed from the log on attempt 2');
  });
});

describe('drills on a session\'s own sandbox', () => {
  function rendered(effects: (EffectView & { t0: number; t1?: number })[]) {
    const { view, events } = session(effects);
    const processView: SessionView = { ...view, harness: 'claude-code', turnOpen: false, lane: undefined };
    const mode = 'server' as const;
    const lanes = laneOf(processView.effects, mode);
    const times = stepTimes(events);
    const list = crashes(processView, lanes, times, mode);
    const items = buildItems(processView, lanes, list);
    const ctx: RowCtx = {
      mode,
      world: 'vercel',
      harnessName: 'Claude Code',
      times,
      index: logIndex(events),
      live: { text: '', done: true } as never,
      onSelect() {},
      onHover() {},
      onCite() {},
      onOpenFile() {},
    };
    const crash = items.find((i) => i.t === 'crash')!;
    return { list, html: renderToStaticMarkup(createElement(Row, { item: crash, ctx, sig: '', cites: '', selected: false, tab: false })).replace(/<[^>]+>/g, '') };
  }
  // A drill names no driver: the drive lived.
  const drill = (target: EffectView, kind: string, afterMs = 4000) => eff('chaos:s1', 'chaos', 'completed', { output: { v: 2, kind, crashedDuring: target.key, stepId: target.stepId, effect: target.name, afterMs } });

  it('D1 and D4: the Function re-attached in the same invocation, and the call came back interrupted, not rerun', () => {
    for (const [kind, words] of [
      ['sandbox-vm', /Sandbox VM stopped 4\u00a0s into Bash\. The Function re-attached on a new VM over the same Drive .* later\. Bash isn’t safe to rerun, so Claude Code was told it was interrupted\./],
      ['relay-drop', /The relay link dropped its \/ctl socket 4\u00a0s into Bash\. The Function re-attached to the VM .* later\./],
    ] as const) {
      const bash = eff('tool:1', 'tool.Bash', 'failed', { error: { message: 'interrupted', interrupted: true } });
      const { list, html } = rendered([
        { ...bash, t0: 0, t1: 6 },
        { ...drill(bash, kind), t0: 4, t1: 4 },
        { ...eff('tool:2', 'tool.Read', 'completed'), t0: 7, t1: 8 },
      ]);
      expect(list[0]).toMatchObject({ kind, state: 'interrupted' });
      expect(list[0]!.parked).toBeUndefined();
      expect(html).toMatch(words);
      expect(html).not.toContain('queue');
    }
  });

  it('D2 and D3: fired at the turn\'s attach; the turn carried on on a new VM', () => {
    for (const [kind, words] of [
      ['sandbox-new-vm', /VM was deleted before this turn; its Drive was kept\. The turn started on a new VM over the same Drive/],
      ['sandbox-zombie', /VM was stopped before this turn and left holding its Drive\. The new driver deleted the old VM once it stopped, waited for the Drive to let go of it/],
    ] as const) {
      const attach = eff('sandbox.attach:1', 'sandbox.attach', 'completed');
      const { list, html } = rendered([
        { ...attach, t0: 0, t1: 3 },
        { ...drill(attach, kind, 0), t0: 1, t1: 1 },
      ]);
      expect(list[0]).toMatchObject({ kind, state: 'clear' });
      expect(html).toMatch(words);
    }
  });
});
