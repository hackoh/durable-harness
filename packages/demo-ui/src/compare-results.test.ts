import { describe, expect, it } from 'vitest';
import { breakdown } from './compare-breakdown.ts';
import { type Arrival, turnView } from './compare-model.ts';
import {
  cellText,
  countedOf,
  noiseFloor,
  promptsOf,
  type RoundRecord,
  recordOf,
  reliabilityPer100,
  resultsMarkdown,
  slope,
  summarize,
  tierOf,
  withDifferentWork,
} from './compare-results.ts';

const P = "Create a file named notes.txt containing exactly 'hi', then reply 'done'.";
const rec = (seq: number, o: Partial<RoundRecord> = {}): RoundRecord => ({ seq, prompt: P, warmup: false, toolCalls: 1, turn: 2000, flags: {}, ...o });

/** `n` rounds of a column: overheads from `f(i)`. */
const column = (n: number, f: (i: number) => Partial<RoundRecord>, from = 1) => Array.from({ length: n }, (_, i) => rec(from + i, f(i)));

describe('round records', () => {
  const at = (t: number, e: Arrival['e']): Arrival => ({ at: t, e });

  it('a finished turn becomes a record with its flags; a running one does not', () => {
    const arrivals = [
      at(10, { type: 'mark', name: 'drive.start', drv: 'd1', t: 5, pid: 'p' }),
      at(20, { type: 'mark', name: 'model.request', t: 15, pid: 'p' }),
      at(400, { type: 'mark', name: 'model.first_token', t: 395, pid: 'p' }),
      at(410, { type: 'text', delta: 'done' }),
      at(450, { type: 'mark', name: 'model.done', t: 445, pid: 'p' }),
      at(470, { type: 'mark', name: 'ack', lagMs: 8, t: 465, pid: 'p' }),
      at(6200, { type: 'mark', name: 'drive.start', drv: 'd2', t: 6195, pid: 'q' }),
      at(6300, { type: 'mark', name: 'idle', drv: 'd2', t: 6295, pid: 'q' }),
    ];
    const v = turnView(0, arrivals, 6300, 7000);
    const r = recordOf({ ...v, breakdown: breakdown(v, arrivals) }, { seq: 3, prompt: P, reply: 'done' })!;
    expect(r).toMatchObject({ seq: 3, prompt: P, warmup: false, firstOutput: 410, turn: 6300, model: 380, overhead: 30, modelCalls: 1, toolCalls: 0, writes: 1, ackP50: 8, reply: 'done' });
    // A drive that started 6 s after the send, and a different drive finishing it: recovered.
    expect(r.flags.recovered).toBe(1);
    expect(recordOf(turnView(0, arrivals, undefined, 7000), { seq: 4, prompt: P })).toBeUndefined();
  });

  it('flags different work against the baseline in the same round', () => {
    const base = [rec(1, { toolCalls: 1 }), rec(2, { toolCalls: 1, modelCalls: 2 })];
    const other = [rec(1, { toolCalls: 2 }), rec(2, { toolCalls: 1, modelCalls: 3 })];
    const same = [rec(1, { toolCalls: 1 }), rec(2, { toolCalls: 1 })];
    const [b, o, s] = withDifferentWork([base, other, same], 0);
    expect(b!.every((r) => !r.flags.differentWork)).toBe(true);
    expect(o!.map((r) => r.flags.differentWork)).toEqual([1, 1]);
    expect(s!.every((r) => !r.flags.differentWork)).toBe(true);
  });
});

describe('the results table', () => {
  it('says as much as its rounds allow: value only under 5, a Δ from 5, an interval and a verdict from 10', () => {
    expect([3, 5, 9, 10].map(tierOf)).toEqual(['few', 'delta', 'delta', 'interval']);
    const base = column(3, () => ({ overhead: 100 }));
    const b = column(3, () => ({ overhead: 150 }));
    const [sb, s] = summarize([base, b], 0, P, true);
    expect(cellText(sb!.cells.overhead)).toEqual({ main: '100 ms', note: 'n = 3, run more' });
    expect(cellText(s!.cells.overhead)).toEqual({ main: '+50 ms', note: 'n = 3, run more' });
    // An overhead under its baseline reads with the same minus sign as a Δ.
    const [under] = summarize([column(3, () => ({ overhead: -9 }))], 0, P, true);
    expect(cellText(under!.cells.overhead).main).toBe('−9 ms');
  });

  it('pairs rounds: a steady difference under a model that swings is clear; noise is within noise', () => {
    const swing = (i: number) => [800, 3200, 1200, 2600, 900, 4100, 1500, 2200, 1000, 3000, 1800, 2500][i]!;
    const base = column(12, (i) => ({ overhead: 100, turnOverhead: swing(i) }));
    const durable = column(12, (i) => ({ overhead: 100 + ((i % 3) - 1) * 20, turnOverhead: swing(i) + 40 + (i % 4) * 5 }));
    const [, s] = summarize([base, durable], 0, P, true);
    const turn = s!.cells.turnOverhead;
    expect(turn.kind).toBe('delta');
    expect(cellText(turn).note).toBe('clear');
    expect(cellText(turn).main).toMatch(/^\+\d+ ms \(\+\d+ ms to \+\d+ ms\)$/);
    expect(cellText(s!.cells.overhead)).toEqual({ main: '+0 ms', note: 'within noise' });
  });

  it('counts per prompt, leaves warm-ups out, and excludes flagged rounds unless asked not to', () => {
    const rs = [rec(1, { warmup: true }), rec(2), rec(3, { flags: { newInstance: 1 } }), rec(4, { flags: { modelTail: 2600 } }), rec(5, { prompt: 'other' })];
    expect(countedOf(rs, P, true).map((r) => r.seq)).toEqual([2, 4]);
    expect(countedOf(rs, P, false).map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(promptsOf([rs])).toEqual([P, 'other']);
  });

  it('a column that finished rounds but reports no model timing reads Not measured, in words', () => {
    const base = column(6, () => ({ overhead: 100, turnOverhead: 50 }));
    const claude = column(6, () => ({}));
    const [, s] = summarize([base, claude], 0, P, true);
    expect(cellText(s!.cells.overhead, 'Claude Code').main).toBe('Not measured: Claude Code reports no model timings yet');
  });

  it('names the columns the model time is pooled over, and the drift per round', () => {
    const a = column(5, () => ({ model: 900 }));
    const b = column(5, () => ({}));
    const c = column(5, () => ({ model: 1100 }));
    expect(noiseFloor([a, b, c], P, true)).toEqual({ p50: 1000, columns: [0, 2] });
    expect(slope(column(6, (i) => ({ turnOverhead: 100 + i * 10 })))).toBeCloseTo(10);
    expect(reliabilityPer100([rec(1, { flags: { recovered: 1 } }), rec(2), rec(3), rec(4)])).toBe(25);
  });

  it('copies as a Markdown table, then a line per column against the baseline', () => {
    const base = column(10, () => ({ overhead: 100, turnOverhead: 50, toolOverhead: 0 }));
    const strict = column(10, (i) => ({ overhead: 140 + (i % 2) * 10, turnOverhead: 120 + (i % 3) * 5, toolOverhead: 20 }));
    const summary = summarize([base, strict], 0, P, true);
    const md = resultsMarkdown({
      heading: 'Pi · One File Write · Server',
      prompt: 'One File Write',
      columns: [
        { letter: 'A', title: 'Pi · Native · Server', short: 'Native', harness: 'Pi' },
        { letter: 'B', title: 'Pi · Strict · Server', short: 'Strict', harness: 'Pi' },
      ],
      summary,
      baseIndex: 0,
      meta: 'anthropic/claude-opus-5.5-fast, this server, chaos off',
    });
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Pi · One File Write · Server | A Native (baseline) | B Strict |');
    expect(lines[1]).toBe('| --- | ---: | ---: |');
    expect(lines[2]).toMatch(/^\| Overhead to first output \| 100 ms \| \+\d+ ms \(\+\d+ ms to \+\d+ ms\) clear \|$/);
    expect(lines[5]).toBe('| Rounds counted | 10 of 10 | 10 of 10 |');
    expect(md).toMatch(/- B Pi · Strict · Server vs A Pi · Native · Server · One File Write · n = 10 of 10: per turn \+\d+ ms \(90% interval/);
    expect(lines.at(-1)).toBe('anthropic/claude-opus-5.5-fast, this server, chaos off');
  });
});
