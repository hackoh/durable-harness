import { afterEach, describe, expect, it } from 'vitest';
import { breakdown } from './compare-breakdown.ts';
import {
  type Arrival,
  columnsFor,
  columnTitle,
  DEFAULT_COLUMNS,
  deltaOf,
  describeColumn,
  durabilitiesFor,
  gapTotal,
  hasNative,
  laneKind,
  medianDelta,
  normalizeSpec,
  parseColumns,
  registerProcessHarnesses,
  runtimesFor,
  runtimeUnavailable,
  serializeColumns,
  setupOf,
  turnEnd,
  turnView,
} from './compare-model.ts';
import { LatencyTracker } from './latency.ts';

const at = (t: number, e: Arrival['e']): Arrival => ({ at: t, e });

describe('compare columns', () => {
  it('defaults to what durability costs Pi: Native, Durable and Strict, in a Function', () => {
    expect(parseColumns(null)).toEqual([
      { harness: 'pi', durability: 'none', runtime: 'function' },
      { harness: 'pi', durability: 'async', runtime: 'function' },
      { harness: 'pi', durability: 'strict', runtime: 'function' },
    ]);
    expect(serializeColumns(DEFAULT_COLUMNS)).toBe('pi:none:function,pi:async:function,pi:strict:function');
    expect(setupOf(DEFAULT_COLUMNS)).toEqual({ harness: 'pi', levels: ['none', 'async', 'strict'], runtime: 'function' });
  });

  it('the setup row makes the columns, and reads them back; anything else is a custom comparison', () => {
    expect(serializeColumns(columnsFor({ harness: 'fx', levels: ['strict', 'none'], runtime: 'tab' }))).toBe('fx:none:tab,fx:strict:tab');
    // Durable runs on the server only: in This Tab its column stays on the server.
    expect(serializeColumns(columnsFor({ harness: 'pi', levels: ['none', 'async', 'strict'], runtime: 'tab' }))).toBe('pi:none:tab,pi:async:function,pi:strict:tab');
    expect(setupOf(parseColumns('pi:none:tab,pi:async:function,pi:strict:tab'))).toEqual({ harness: 'pi', levels: ['none', 'async', 'strict'], runtime: 'tab' });
    expect(setupOf(parseColumns('fx:strict:function,pi:strict:function,eve'))).toBeUndefined();
    expect(setupOf(parseColumns('pi:strict:function,pi:none:function'))).toBeUndefined(); // not in ladder order
    expect(hasNative('pi')).toBe(true);
  });

  it('round-trips any mix of harness, durability and runtime', () => {
    const cols = parseColumns('fx:none:tab,pi:wrapped:function,pi:strict:hybrid,fx:async:function');
    expect(cols.map(columnTitle)).toEqual(['fx · Native · This Tab', 'Pi · Wrapped (no World) · Server', 'Pi · Strict · Hybrid', 'fx · Durable · Server']);
    expect(parseColumns(serializeColumns(cols))).toEqual(cols);
  });

  it('repairs choices a harness or durability does not offer', () => {
    expect(parseColumns('fx:async:tab,pi:none:hybrid,eve:none:tab')).toEqual([
      { harness: 'fx', durability: 'async', runtime: 'function' }, // Async: Function only
      { harness: 'pi', durability: 'none', runtime: 'function' }, // Hybrid needs the durable log
      { harness: 'eve', durability: 'strict', runtime: 'function' }, // eve: Strict, Function, nothing else
    ]);
    expect(normalizeSpec({ harness: 'eve', durability: 'none', runtime: 'tab' })).toEqual({ harness: 'eve', durability: 'strict', runtime: 'function' });
    expect(runtimesFor('pi', 'strict')).toEqual(['function', 'tab', 'hybrid']);
    expect(runtimeUnavailable({ harness: 'fx', durability: 'async', runtime: 'function' }, 'tab')).toMatch(/server only/);
    expect(runtimeUnavailable({ harness: 'fx', durability: 'strict', runtime: 'function' }, 'tab')).toBeUndefined();
    expect(parseColumns('fx')).toEqual(DEFAULT_COLUMNS); // fewer than two
    expect(parseColumns('bogus,also')).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns('fx,pi,eve,fx:none,pi:none')).toHaveLength(4);
  });

  it('opens old links: page-wide harness, kind:lane columns', () => {
    expect(parseColumns('native,run-ahead:function,on:tab,off:tab', 'fx')).toEqual([
      { harness: 'fx', durability: 'none', runtime: 'function' },
      { harness: 'fx', durability: 'async', runtime: 'function' },
      { harness: 'fx', durability: 'strict', runtime: 'tab' },
      { harness: 'fx', durability: 'wrapped', runtime: 'tab' },
    ]);
    expect(parseColumns('native,eve', null).map(laneKind)).toEqual(['native', 'eve']);
  });

  it('describes what runs', () => {
    expect(describeColumn({ harness: 'eve', durability: 'strict', runtime: 'function' })).toMatch(/Vercel Workflow/);
    expect(describeColumn({ harness: 'pi', durability: 'strict', runtime: 'tab' })).toBe('Pi in this tab. Every write awaited.');
    expect(laneKind({ harness: 'fx', durability: 'async', runtime: 'function' })).toBe('run-ahead');
  });
});

describe('Pi (pi-durable) columns', () => {
  it('is Strict (Pi awaits every commit) on the server, titled by name, and opens from the main page link', () => {
    const cols = parseColumns('pi:none:function,pi-durable');
    expect(cols).toEqual([
      { harness: 'pi', durability: 'none', runtime: 'function' },
      { harness: 'pi-durable', durability: 'strict', runtime: 'function' },
    ]);
    expect(serializeColumns(cols)).toBe('pi:none:function,pi-durable');
    expect(columnTitle(cols[1]!)).toBe('Pi (pi-durable)');
    expect(laneKind(cols[1]!)).toBe('pi-durable');
    expect(setupOf(cols)).toBeUndefined();
  });
});

describe('fx (libfx durable) columns', () => {
  it('is Async (libfx awaits only the prompt and unsafe tools) in a Function only, titled by name, and round-trips as one word', () => {
    const cols = parseColumns('fx-durable,pi:strict:function,eve');
    expect(cols[0]).toEqual({ harness: 'fx-durable', durability: 'async', runtime: 'function' });
    expect(durabilitiesFor('fx-durable')).toEqual(['async']);
    expect(normalizeSpec({ harness: 'fx-durable', durability: 'strict', runtime: 'tab' })).toEqual({ harness: 'fx-durable', durability: 'async', runtime: 'function' });
    expect(serializeColumns(cols)).toBe('fx-durable,pi:strict:function,eve');
    expect(laneKind(cols[0]!)).toBe('fx-durable');
    expect(columnTitle(cols[0]!)).toBe('fx (libfx durable)');
    expect(describeColumn(cols[0]!)).toMatch(/libfx's own durable sessions/);
    expect(describeColumn(cols[0]!)).toMatch(/unsafe tool/);
  });
});

describe('process harness columns', () => {
  const register = () =>
    registerProcessHarnesses([
      { value: 'claude-code', label: 'Claude Code', title: 'Claude Code in a process', modes: ['server'], process: true },
      { value: 'codex', label: 'Codex', title: 'Codex', modes: ['server'], durabilities: ['on'], process: true },
      { value: 'keyed', label: 'Keyed', title: 'Keyed', modes: ['server'], disabledReason: 'No API key.', process: true },
      // Nothing a column can run: no brain at all.
      { value: 'boxed', label: 'Boxed', title: 'Boxed', modes: [], process: true },
    ]);
  afterEach(() => registerProcessHarnesses([]));

  it('offers what the server registered: Async and Strict by default, in a Function only', () => {
    register();
    expect(durabilitiesFor('claude-code')).toEqual(['async', 'strict']);
    expect(durabilitiesFor('codex')).toEqual(['strict']);
    expect(runtimesFor('claude-code', 'strict')).toEqual(['function']);
    expect(runtimeUnavailable({ harness: 'claude-code', durability: 'strict', runtime: 'function' }, 'tab')).toMatch(/server only/);
    expect(normalizeSpec({ harness: 'codex', durability: 'none', runtime: 'tab' })).toEqual({ harness: 'codex', durability: 'strict', runtime: 'function' });
  });

  it('round-trips through the link, and drops ones the server does not have', () => {
    register();
    const cols = parseColumns('claude-code:async:function,codex:async:tab,boxed:strict:function,keyed,pi:strict:function');
    expect(cols).toEqual([
      { harness: 'claude-code', durability: 'async', runtime: 'function' },
      { harness: 'codex', durability: 'strict', runtime: 'function' },
      { harness: 'keyed', durability: 'strict', runtime: 'function' },
      { harness: 'pi', durability: 'strict', runtime: 'function' },
    ]);
    expect(parseColumns(serializeColumns(cols))).toEqual(cols);
    expect(cols.map(laneKind)).toEqual(['run-ahead', 'on', 'on', 'on']);
    expect(columnTitle(cols[0]!)).toBe('Claude Code · Durable · Server');
    expect(describeColumn(cols[1]!)).toBe('Codex. Every write awaited.');
  });

  it('opens a link to one before the server has listed it as the default columns', () => {
    expect(parseColumns('codex:strict:function,claude-code:strict:function')).toEqual(DEFAULT_COLUMNS);
    register();
    expect(parseColumns('codex:strict:function,claude-code:strict:function').map((c) => c.harness)).toEqual(['codex', 'claude-code']);
  });
});

describe('an eve column', () => {
  // What harness-world-bench/eve makes of an eve stream: server marks (pid `eve`, eve's meta.at),
  // the page events, and an idle event then an idle mark with no drive id.
  const S = 1_000_000; // server clock
  const OFF = 50; // page clock = server + 50
  const m = (name: string, t: number, extra: Record<string, unknown> = {}) => at(t + OFF, { type: 'mark', name, t, pid: 'eve', runId: 'eve', ...extra });
  const arrivals: Arrival[] = [
    m('model.request', S + 100, { key: 'turn_0:0' }),
    m('model.first_token', S + 900, { key: 'turn_0:0' }),
    m('model.done', S + 1000, { key: 'turn_0:0' }),
    m('tool.start', S + 1000, { key: 'c1' }),
    at(S + 1000 + OFF, { type: 'tool_start', name: 'write_file' }),
    m('tool.end', S + 1010, { key: 'c1' }),
    at(S + 1010 + OFF, { type: 'tool_end', name: 'write_file' }),
    m('model.request', S + 1400, { key: 'turn_0:1' }),
    m('model.first_token', S + 2000, { key: 'turn_0:1' }),
    at(S + 2000 + OFF, { type: 'text', delta: 'done' }),
    m('model.done', S + 2010, { key: 'turn_0:1' }),
    at(S + 2020 + OFF, { type: 'idle' }),
    m('idle', S + 2020),
  ];

  it('ends its turn on the idle mark and splits it into model, tool and overhead', () => {
    const tracker = new LatencyTracker();
    const sentAt = S;
    tracker.sent('prompt', sentAt);
    for (const a of arrivals) tracker.event(a.e, a.at);
    const t = tracker.turns[0]!;
    expect(t.idleAt).toBe(S + 2020 + OFF);
    expect(t.turn).toBe(2070);
    const v = { ...turnView(sentAt, arrivals, t.idleAt, t.idleAt!), turn: t.turn };
    const b = breakdown(v, arrivals);
    // The first output is the tool call: the model's own time is request → done.
    expect(b.modelMs).toBe(900);
    // eve's model.done and tool.start are both actions.requested: its hop
    // already started at the model's end, so its numbers are what they were.
    expect(b.tools[0]).toMatchObject({ execMs: 10, oursMs: 390, overheadMs: 1000 - 10 - 600, from: 'model.done' });
    // 2070 − (900 + 610 model) − 10 tool.
    expect(b.turnOverheadMs).toBe(550);
    expect(b.flagged).toBe(false);
  });
});

describe('turnEnd', () => {
  it('ends a durable turn at the kernel idle mark, keeping the harness idle', () => {
    // Pi said idle 1500 ms in; its last writes landed 300 ms later.
    expect(turnEnd({ sentAt: 1000, idleAt: 2500, durableAt: 1800 })).toEqual({ endAt: 2800, harnessIdle: 1500 });
  });
  it('has no separate harness idle when both are the same point (eve)', () => {
    expect(turnEnd({ sentAt: 1000, idleAt: 2800, durableAt: 1800 })).toEqual({ endAt: 2800 });
  });
  it('ends a lane without a kernel mark (None) at its idle, and an open turn nowhere', () => {
    expect(turnEnd({ sentAt: 1000, idleAt: 2500 })).toEqual({ endAt: 2500 });
    expect(turnEnd({ sentAt: 1000 })).toEqual({});
  });
});

describe('turnView', () => {
  it('splits a tool turn into wait, model, tool, gap, model and tail', () => {
    const v = turnView(
      1000,
      [
        at(1900, { type: 'text', delta: 'ok' }),
        at(2100, { type: 'tool_start', name: 'write_file' }),
        at(2110, { type: 'tool_end', name: 'write_file' }),
        at(3200, { type: 'text', delta: 'done' }),
        at(3300, { type: 'text', delta: '.' }),
        at(3350, { type: 'idle' }),
      ],
      3350,
      9999
    );
    expect(v.ttft).toBe(900);
    expect(v.turn).toBe(2350);
    expect(v.segments.map((s) => [s.kind, s.end - s.start])).toEqual([
      ['wait', 900],
      ['model', 200],
      ['tool', 10],
      ['gap', 1090],
      ['model', 100],
      ['tail', 50],
    ]);
    expect(v.tools).toEqual([{ name: 'write_file', toolMs: 10, gapMs: 1100 }]);
    expect(gapTotal(v)).toBe(1100);
  });

  it('measures each of several tools, straight after each other', () => {
    const v = turnView(
      0,
      [
        at(800, { type: 'tool_start', name: 'bash' }),
        at(820, { type: 'tool_end', name: 'bash' }),
        at(1600, { type: 'tool_start', name: 'write_file' }),
        at(1605, { type: 'tool_end', name: 'write_file' }),
        at(2400, { type: 'text', delta: 'done' }),
      ],
      2450,
      9999
    );
    expect(v.ttft).toBe(800);
    expect(v.tools).toEqual([
      { name: 'bash', toolMs: 20, gapMs: 800 },
      { name: 'write_file', toolMs: 5, gapMs: 800 },
    ]);
    expect(v.segments.map((s) => s.kind)).toEqual(['wait', 'tool', 'gap', 'tool', 'gap', 'tail']);
  });

  it('measures the gap when the tool end arrives after the next output', () => {
    const v = turnView(
      0,
      [at(500, { type: 'tool_start', name: 'bash' }), at(1400, { type: 'text', delta: 'done' }), at(1450, { type: 'tool_end', name: 'bash' })],
      1500,
      9999
    );
    expect(v.tools).toEqual([{ name: 'bash', toolMs: 950, gapMs: 900 }]);
  });

  it('keeps an open turn open up to now, and ignores events outside the turn', () => {
    const v = turnView(1000, [at(500, { type: 'text', delta: 'old' }), at(1500, { type: 'text', delta: 'a' })], undefined, 2000);
    expect(v.turn).toBeUndefined();
    expect(v.ttft).toBe(500);
    expect(v.segments.map((s) => [s.kind, s.end - s.start])).toEqual([
      ['wait', 500],
      ['model', 500],
    ]);
  });
});

describe('deltas', () => {
  it('against the baseline, and as the median over turns', () => {
    expect(deltaOf(1500, 1000)).toEqual({ ms: 500, pct: 50 });
    expect(deltaOf(900, 1000)).toEqual({ ms: -100, pct: -10 });
    expect(deltaOf(undefined, 1000)).toBeUndefined();
    expect(medianDelta([1100, 1300, 1200, undefined], [1000, 1000, 1000, 1000])).toEqual({ ms: 200, pct: 20 });
    expect(medianDelta([1100, 1300], [1000, 1000])).toEqual({ ms: 200, pct: 20 });
    expect(medianDelta([], [])).toBeUndefined();
    // A near-zero base carries no percentage (69 ms -> -91 ms is not "-232%").
    expect(deltaOf(-91, 69)).toEqual({ ms: -160 });
    expect(deltaOf(-91, -10)).toEqual({ ms: -81 });
    expect(medianDelta([-91, -50, -60], [69, 40, 20])).toEqual({ ms: -90 });
  });
});

describe('a turn whose reply arrives in one chunk', () => {
  // The Wrapped column's chat turn: the whole reply arrives in one NDJSON
  // chunk, so its text, model.done and the idle mark are read within a
  // fraction of a millisecond of each other. The turn must end on the idle
  // mark itself, not on a rounded copy of it, or the text falls outside.
  it('keeps its first output and its overhead, every time', () => {
    let lost = 0;
    let noOverhead = 0;
    const N = 1000;
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < N; i++) {
      const tr = new LatencyTracker();
      const arrivals: Arrival[] = [];
      const sent = 1_000_000 + rand();
      tr.sent('prompt', sent);
      const feed = (e: Arrival['e'], at: number) => {
        arrivals.push({ at, e });
        tr.event(e, at);
      };
      const base = sent + 700 + rand();
      feed({ type: 'mark', name: 'submit', id: 's1', kind: 'prompt', t: 10, pid: 'p' }, base);
      feed({ type: 'mark', name: 'drive.start', drv: 'd1', t: 11, pid: 'p' }, base + 0.01);
      feed({ type: 'mark', name: 'intent', drv: 'd1', t: 12, pid: 'p' }, base + 0.02);
      feed({ type: 'mark', name: 'model.request', drv: 'd1', key: 'm', t: 13, pid: 'p' }, base + 0.03);
      feed({ type: 'mark', name: 'model.first_token', drv: 'd1', key: 'm', t: 600, pid: 'p' }, base + 0.04);
      feed({ type: 'text', delta: '4.' }, base + 0.05);
      feed({ type: 'mark', name: 'model.done', drv: 'd1', key: 'm', t: 610, pid: 'p' }, base + 0.06);
      feed({ type: 'idle' }, base + 0.07);
      feed({ type: 'mark', name: 'idle', drv: 'd1', t: 611, pid: 'p' }, base + 0.08);
      const t = tr.turns[0]!;
      const { endAt } = turnEnd(t);
      const v = turnView(t.sentAt, arrivals, endAt, base + 10_000);
      const b = breakdown(v, arrivals);
      if (v.ttft === undefined) lost++;
      if (b.overheadMs === undefined) noOverhead++;
    }
    expect({ lost, noOverhead }).toEqual({ lost: 0, noOverhead: 0 });
  });
});
