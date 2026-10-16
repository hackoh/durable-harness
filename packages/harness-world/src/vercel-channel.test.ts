import { afterEach, describe, expect, it, vi } from 'vitest';
import { setVercelChannelOpenerForTest, vercelChannel } from './vercel-channel.ts';

afterEach(() => {
  vi.useRealTimers();
  setVercelChannelOpenerForTest(null);
});

describe('vercelChannel', () => {
  it('shares one socket between holders and keeps it for the linger period', () => {
    vi.useFakeTimers();
    const released = vi.fn();
    const open = vi.fn(() => released);
    setVercelChannelOpenerForTest(open);
    const channel = vercelChannel({ lingerMs: 1000 });

    const a = channel('wrun_1')!;
    const b = channel('wrun_1')!;
    expect(open).toHaveBeenCalledTimes(1);
    a();
    a(); // idempotent
    b();
    vi.advanceTimersByTime(999);
    expect(released).not.toHaveBeenCalled();

    // Reused within the linger: no new handshake.
    const c = channel('wrun_1')!;
    vi.advanceTimersByTime(5000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
    c();
    vi.advanceTimersByTime(1000);
    expect(released).toHaveBeenCalledTimes(1);

    // After it closed, the next holder opens a fresh one.
    channel('wrun_1');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('returns undefined, so writes stay on HTTP, with no opener or when the World cannot hold a socket', () => {
    setVercelChannelOpenerForTest(null);
    expect(vercelChannel()('wrun_1')).toBeUndefined();
    setVercelChannelOpenerForTest(() => undefined);
    expect(vercelChannel()('wrun_1')).toBeUndefined();
  });
});
