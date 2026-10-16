import { describe, expect, it } from 'vitest';
import { countedTurns, foldItems, type Item } from './Compare.tsx';
import type { TurnView } from './compare-model.ts';

describe('compare foldItems', () => {
  it('joins text deltas, tracks tools, ignores marks', () => {
    let items: Item[] = [{ kind: 'user', text: 'hi' }];
    for (const e of [
      { type: 'text', delta: 'He' },
      { type: 'text', delta: 'llo' },
      { type: 'mark', name: 'ack', lagMs: 3 },
      { type: 'tool_start', name: 'bash' },
      { type: 'tool_end', name: 'bash', isError: true },
      { type: 'text', delta: 'done' },
    ])
      items = foldItems(items, e);
    expect(items).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'text', text: 'Hello' },
      { kind: 'tool', name: 'bash', done: true, error: true },
      { kind: 'text', text: 'done' },
    ]);
  });
  it('returns the same array for events that show nothing', () => {
    const items: Item[] = [];
    expect(foldItems(items, { type: 'mark', name: 'idle' })).toBe(items);
    expect(foldItems(items, null)).toBe(items);
  });
});

describe('compare summary turns', () => {
  const turn = (extra: Partial<TurnView> & { flagged?: boolean }): TurnView => {
    const { flagged, ...rest } = extra;
    return { sentAt: 0, segments: [], tools: [], turn: 1000, ...(flagged !== undefined ? { breakdown: { calls: [], tools: [], flags: {}, flagged } } : {}), ...rest };
  };
  const vs = [turn({ warmup: true }), turn({ flagged: true }), turn({ flagged: false }), turn({ turn: undefined })];
  it('counts every finished turn but the warm-up, flagged ones included', () => {
    expect(countedTurns(vs, false)).toEqual([vs[1], vs[2]]);
  });
  it('leaves flagged turns out only when asked', () => {
    expect(countedTurns(vs, true)).toEqual([vs[2]]);
  });
});
