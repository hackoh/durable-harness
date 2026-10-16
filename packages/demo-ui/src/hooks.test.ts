import { describe, expect, it } from 'vitest';
import { PUSHED_POLL_MS, refreshDelay } from './hooks.ts';

describe('useSession refresh cadence', () => {
  it('polls fast while busy only when nothing pushes updates', () => {
    expect(refreshDelay({ fails: 0, pushed: false, pollMs: 500 })).toBe(500);
  });
  it('with hints or live pushes the busy poll is a 5 s fallback', () => {
    expect(refreshDelay({ fails: 0, pushed: true, pollMs: 500 })).toBe(PUSHED_POLL_MS);
    expect(PUSHED_POLL_MS).toBe(5000);
    expect(refreshDelay({ fails: 0, pushed: true, pollMs: 8000 })).toBe(8000);
  });
  it('backs off after failures either way', () => {
    expect(refreshDelay({ fails: 3, pushed: false, pollMs: 500 })).toBe(2000);
    expect(refreshDelay({ fails: 9, pushed: true, pollMs: 500 })).toBe(5000);
  });
});
