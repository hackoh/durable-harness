import { afterEach, describe, expect, it } from 'vitest';
import { createLocalEcho } from './local-echo.ts';
import { JsonLinesWriter, liveStreamName, setLocalLiveTap } from './streams.ts';

const world = { streams: { write: async () => {} } } as never;

afterEach(() => setLocalLiveTap(undefined));

describe('local echo', () => {
  it('delivers a writer’s live lines at once and drops their stream copies', () => {
    let t = 0;
    const echo = createLocalEcho(() => t);
    const got: unknown[] = [];
    const off = echo.subscribe('r1', (e) => got.push(e));
    const w = new JsonLinesWriter(world, 'r1', liveStreamName('r1'));
    w.write({ type: 'text', delta: 'a' });
    w.write({ type: 'text', delta: 'a' });
    expect(got).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'a' },
    ]);
    expect(echo.fromStream('r1', { type: 'text', delta: 'a' })).toBe(false);
    expect(echo.fromStream('r1', { type: 'text', delta: 'a' })).toBe(false);
    // A third copy is someone else's line.
    expect(echo.fromStream('r1', { type: 'text', delta: 'a' })).toBe(true);
    expect(echo.fromStream('r1', { type: 'idle' })).toBe(true);
    off();
  });

  it('ignores other streams and lines produced while nobody listens', () => {
    const echo = createLocalEcho();
    const got: unknown[] = [];
    new JsonLinesWriter(world, 'r2', liveStreamName('r2')).write({ type: 'text', delta: 'early' });
    const off = echo.subscribe('r2', (e) => got.push(e));
    new JsonLinesWriter(world, 'r2', 'r2_other').write({ type: 'x' });
    expect(got).toEqual([]);
    expect(echo.fromStream('r2', { type: 'text', delta: 'early' })).toBe(true);
    off();
  });

  it('expires an echo the stream never returned', () => {
    let t = 0;
    const echo = createLocalEcho(() => t);
    const off = echo.subscribe('r3', () => {});
    new JsonLinesWriter(world, 'r3', liveStreamName('r3')).write({ type: 'text', delta: 'lost' });
    t = 60_000;
    expect(echo.fromStream('r3', { type: 'text', delta: 'lost' })).toBe(true);
    off();
  });
});
