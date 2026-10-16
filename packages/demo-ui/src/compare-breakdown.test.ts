import { describe, expect, it } from 'vitest';
import { breakdown, markOffset, markOffsets, medianDiff, modelCalls, pairDisagreement, pairedDiff, percentile, visibleModelMs } from './compare-breakdown.ts';
import { type Arrival, turnView } from './compare-model.ts';

// Server clock = page clock − 5000, with 40 ms of delivery at best.
const S = (t: number) => t - 5000;
const mark = (at: number, name: string, t: number, extra: Record<string, unknown> = {}): Arrival => ({ at, e: { type: 'mark', name, t: S(t), pid: 'p1', ...extra } });
const ev = (at: number, e: Arrival['e']): Arrival => ({ at, e });

describe('breakdown', () => {
  it('takes the model out of first output and of each tool gap', () => {
    const arrivals: Arrival[] = [
      mark(1140, 'drive.start', 1100, { drv: 'd1' }),
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2340, 'model.first_token', 2300, { key: 'model:0' }),
      mark(2540, 'model.done', 2500, { key: 'model:0' }),
      ev(2560, { type: 'tool_start', name: 'bash' }),
      mark(2560, 'tool.start', 2520),
      mark(2580, 'tool.end', 2530),
      ev(2600, { type: 'tool_end', name: 'bash' }),
      mark(2575, 'model.request', 2535, { key: 'model:1' }),
      mark(3575, 'model.first_token', 3535, { key: 'model:1' }),
      ev(3600, { type: 'text', delta: 'done' }),
      mark(3640, 'model.done', 3600, { key: 'model:1' }),
      ev(3700, { type: 'idle' }),
    ];
    const v = turnView(1000, arrivals, 3700, 4000);
    const b = breakdown(v, arrivals);
    expect(markOffset(arrivals)).toBe(5040);
    expect(b.calls).toHaveLength(2);
    // The tool call only showed after the response ended: model time is request → done.
    expect(b.modelMs).toBe(1200);
    expect(b.overheadMs).toBe(1560 - 1200);
    expect(b.pre).toBe(340);
    expect(b.model).toBe(1200);
    expect(b.delivery).toBe(20);
    // The whole hop: next text (page 3600) − model done (server 2500 → page 2540)
    // − the tool (10) − next model (1000). The 20 ms between the model's end
    // and the tool's start (the tool's intent write) counts, as does the 5 ms
    // after the tool.
    expect(b.tools[0]).toEqual({ execMs: 10, nextModelMs: 1000, oursMs: 2535 - 2500 - 10, overheadMs: 3600 - 2540 - 10 - 1000, from: 'model.done' });
    expect(b.flags).toEqual({});
    expect(b.flagged).toBe(false);
    // Turn (2700 = idle at 3700 − send at 1000) − models (1200 + 1065) − tool (10).
    expect(b.turnModelMs).toBe(2265);
    expect(b.turnToolMs).toBe(10);
    expect(b.turnOverheadMs).toBe(2700 - 2265 - 10);
  });

  it('flags a new instance, a resumed stream, a delivery stall, a slow write and a model tail', () => {
    const arrivals: Arrival[] = [
      mark(1040, 'submit', 1000, { fresh: true }),
      mark(1100, 'model.request', 1060),
      ev(1200, { type: 'stream', name: 'resumed' }),
      mark(5100, 'model.first_token', 4000),
      mark(5150, 'stream.put_slow', 5000, { ms: 1800 }),
      ev(5200, { type: 'text', delta: 'x' }),
    ];
    const b = breakdown(turnView(1000, arrivals, 5300, 6000), arrivals);
    expect(b.flags).toMatchObject({ newInstance: true, reconnect: 1, slowPutMs: 1800, modelTailMs: 2940 });
    expect(b.flags.deliveryStallMs).toBe(1060);
    expect(b.flagged).toBe(true);
  });

  it('measures tool overhead from the work before the tool, so a late tool_start cannot make it negative', () => {
    // Run-ahead: the tool ran at server 2520-2530, but everything the stream
    // carried from then on reached the page about 300 ms late (marks too:
    // they share the stream), until the next text caught up.
    const arrivals: Arrival[] = [
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2540, 'model.done', 2500, { key: 'model:0' }),
      ev(2860, { type: 'tool_start', name: 'write_file' }),
      mark(2860, 'tool.start', 2520),
      mark(2870, 'tool.end', 2530),
      ev(2880, { type: 'tool_end', name: 'write_file' }),
      mark(2885, 'model.request', 2535, { key: 'model:1' }),
      mark(3580, 'model.first_token', 3535, { key: 'model:1' }),
      ev(3600, { type: 'text', delta: 'done' }),
      ev(3700, { type: 'idle' }),
    ];
    const b = breakdown(turnView(1000, arrivals, 3700, 4000), arrivals);
    // From tool_start's arrival it would read 740 − 1000 − 10 = −270.
    expect(b.tools[0]!.overheadMs).toBe(3600 - 2540 - 10 - 1000);
    expect(b.tools[0]!.from).toBe('model.done');
  });

  it('starts the second of two tools in one response at the first tool\'s end', () => {
    const arrivals: Arrival[] = [
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2540, 'model.done', 2500, { key: 'model:0' }),
      ev(2560, { type: 'tool_start', name: 'bash' }),
      mark(2560, 'tool.start', 2520),
      mark(2580, 'tool.end', 2530),
      ev(2600, { type: 'tool_end', name: 'bash' }),
      ev(2700, { type: 'tool_start', name: 'write_file' }),
      mark(2700, 'tool.start', 2600),
      mark(2720, 'tool.end', 2620),
      ev(2740, { type: 'tool_end', name: 'write_file' }),
      mark(2760, 'model.request', 2700, { key: 'model:1' }),
      mark(3760, 'model.first_token', 3700, { key: 'model:1' }),
      ev(3800, { type: 'text', delta: 'done' }),
      ev(3900, { type: 'idle' }),
    ];
    const b = breakdown(turnView(1000, arrivals, 3900, 4000), arrivals);
    // The first tool's gap ends at the second tool: no model call to take out.
    expect(b.tools[0]!.overheadMs).toBeUndefined();
    // From the first tool's end (server 2530 → page 2570) − the tool (20) − next model (1000).
    expect(b.tools[1]).toMatchObject({ execMs: 20, oursMs: 2700 - 2530 - 20, overheadMs: 3800 - 2570 - 20 - 1000, from: 'tool.end' });
  });

  it('does not read a back-dated end mark behind a slow commit as a delivery stall', () => {
    // model.done carries when the model ended (server 2500); it was written
    // after a 1.5 s commit and arrived with it.
    const arrivals: Arrival[] = [
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2340, 'model.first_token', 2300, { key: 'model:0' }),
      ev(2360, { type: 'text', delta: 'hi' }),
      mark(4040, 'model.done', 2500, { key: 'model:0', commitMs: 1500 }),
      ev(4100, { type: 'idle' }),
    ];
    const b = breakdown(turnView(1000, arrivals, 4100, 5000), arrivals);
    expect(b.flags.deliveryStallMs).toBeUndefined();
    expect(b.flagged).toBe(false);
    // The commit is still the harness's: the model is request → done, 1200.
    expect(b.turnModelMs).toBe(1200);
  });

  it('maps each process onto the page clock with its own offset', () => {
    // The drive (p1) is 5000 ms behind the page; a mark this page made itself
    // (pid page, its own clock) arrives at once. One shared offset would read
    // every p1 mark as 5 s late.
    const arrivals: Arrival[] = [
      { at: 1000, e: { type: 'mark', name: 'submit', t: 1000, pid: 'page' } },
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2340, 'model.first_token', 2300, { key: 'model:0' }),
      ev(2360, { type: 'text', delta: 'hi' }),
      ev(2400, { type: 'idle' }),
    ];
    expect(markOffsets(arrivals)).toEqual(new Map([['page', 0], ['p1', 5040]]));
    const b = breakdown(turnView(1000, arrivals, 2400, 3000), arrivals);
    expect(b.flags.deliveryStallMs).toBeUndefined();
    expect(b.pre).toBe(340);
  });

  it('falls back to the tool_start gap without a tool.end mark', () => {
    const arrivals: Arrival[] = [
      mark(1340, 'model.request', 1300, { key: 'model:0' }),
      mark(2540, 'model.done', 2500, { key: 'model:0' }),
      ev(2560, { type: 'tool_start', name: 'bash' }),
      ev(2600, { type: 'tool_end', name: 'bash' }),
      mark(2615, 'model.request', 2575, { key: 'model:1' }),
      mark(3575, 'model.first_token', 3535, { key: 'model:1' }),
      ev(3600, { type: 'text', delta: 'done' }),
      ev(3700, { type: 'idle' }),
    ];
    const t = breakdown(turnView(1000, arrivals, 3700, 4000), arrivals).tools[0]!;
    expect(t.from).toBe('tool_start');
    expect(t.overheadMs).toBe(1040 - 960 - 40);
  });

  it('marks a second drive placing the same turn', () => {
    const b = breakdown(turnView(0, [], 10, 10), [], { drvs: ['a', 'b'] });
    expect(b.flags.doubleDrive).toBe(true);
  });

  it('matches model marks by process and key', () => {
    const arrivals: Arrival[] = [
      { at: 10, e: { type: 'mark', name: 'model.request', t: 0, pid: 'a', key: 'k1' } },
      { at: 11, e: { type: 'mark', name: 'model.request', t: 0, pid: 'b', key: 'k1' } },
      { at: 20, e: { type: 'mark', name: 'model.first_token', t: 300, pid: 'b', key: 'k1' } },
      { at: 30, e: { type: 'mark', name: 'model.first_token', t: 900, pid: 'a', key: 'k1' } },
    ];
    const calls = modelCalls(arrivals, 0, 100);
    expect(calls.map((c) => [c.pid, c.firstT])).toEqual([
      ['a', 900],
      ['b', 300],
    ]);
    expect(visibleModelMs(calls[0], 40)).toBe(900);
  });
});

describe('a lane whose text does not stream', () => {
  const at = (t: number, e: Arrival['e']): Arrival => ({ at: t, e });
  it('flags a first output that trails the first token, and takes the model call that reported back, not a step opened around it', () => {
    const arrivals = [
      at(10, { type: 'mark', name: 'model.request', key: 'request:0', t: 10, pid: 'p' }),
      // A drill's model step around the same call: marked, never reports a first token.
      at(12, { type: 'mark', name: 'model.request', key: 'model:x', t: 12, pid: 'p' }),
      at(900, { type: 'mark', name: 'model.first_token', key: 'request:0', t: 900, pid: 'p' }),
      at(1200, { type: 'mark', name: 'model.done', key: 'request:0', t: 1200, pid: 'p' }),
      // The text shows only once journaled, 2.6 s after its first token.
      at(3500, { type: 'text', delta: 'hi' }),
    ];
    const v = turnView(0, arrivals, 3600, 4000);
    const b = breakdown(v, arrivals);
    expect(b.modelMs).toBe(1190); // to the call's end: its output only came after it
    expect(b.flags.firstOutputTrailsMs).toBe(2600);
  });
});

describe('statistics', () => {
  it('percentiles interpolated, as /bench reports them: an even count’s median is the mean of the middle two', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5.5);
    expect(percentile(xs, 90)).toBeCloseTo(9.1);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([], 50)).toBeUndefined();
  });

  it('pairs by round: a steady per-round difference is clear even when the rounds swing far more', () => {
    // The model swings by seconds round to round; the lane adds 40-60 ms to every round.
    const swing = [800, 3200, 1200, 2600, 900, 4100, 1500, 2200, 1000, 3000];
    const extra = [40, 55, 45, 60, 50, 42, 58, 47, 53, 49];
    const d = pairedDiff(swing.map((_, i) => extra[i]!));
    expect(d.n).toBe(10);
    expect(d.ms).toBe(50);
    expect(d.withinNoise).toBe(false);
    expect(d.lo).toBeGreaterThan(40);
    // Unpaired, the same samples cannot tell the two apart.
    expect(medianDiff(swing.map((x, i) => x + extra[i]!), swing)!.withinNoise).toBe(true);
    expect(pairedDiff([-30, 20, -10, 40, 0, -25, 15, 5, -5, 10]).withinNoise).toBe(true);
  });

  it('a median difference far outside the noise is not within noise; overlapping samples are', () => {
    const a = [400, 420, 410, 430, 405, 415, 425, 435, 400, 410];
    const b = [100, 110, 120, 105, 115, 100, 125, 130, 110, 120];
    const d = medianDiff(a, b)!;
    expect(d.ms).toBe(300);
    expect(d.withinNoise).toBe(false);
    expect(d.lo).toBeGreaterThan(250);
    const noisy = medianDiff([100, 3000, 200, 900, 1500], [150, 2500, 300, 800, 1200])!;
    expect(noisy.withinNoise).toBe(true);
  });

  it('pair disagreement: how often two single draws differ by over a second', () => {
    expect(pairDisagreement([0, 0, 2000])).toBeCloseTo(2 / 3);
    expect(pairDisagreement([1])).toBeUndefined();
  });
});
