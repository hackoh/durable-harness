import { describe, expect, it } from 'vitest';
import { PULL_BEFORE_MS, pullToken, startTokenPull, tokenExpired, tokenNeedsPush } from './token.ts';

describe('daemon token freshness', () => {
  it('push when less than 30 min remain; expired at exp', () => {
    const now = 1_000_000_000_000;
    const s = now / 1000;
    expect(tokenNeedsPush(s + 3600, now)).toBe(false);
    expect(tokenNeedsPush(s + 29 * 60, now)).toBe(true);
    expect(tokenNeedsPush(undefined, now)).toBe(false);
    expect(tokenExpired(s - 1, now)).toBe(true);
    expect(tokenExpired(s + 1, now)).toBe(false);
  });

  it('pullToken sends the boot secret and returns the token', async () => {
    const token = await pullToken({
      appOrigin: 'https://app.test',
      vm: 'vm1',
      bootId: 'b1',
      secret: 's3cret',
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://app.test/api/token?vm=vm1&bootId=b1');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
        return Response.json({ token: 'tok2' });
      }) as typeof fetch,
    });
    expect(token).toBe('tok2');
    await expect(
      pullToken({ appOrigin: 'https://app.test', vm: 'v', bootId: 'b', secret: 'x', fetch: (async () => new Response(null, { status: 401 })) as typeof fetch })
    ).rejects.toThrow(/401/);
  });

  it('the pull fires at exp - 10 min, replaces the token, and reschedules from the new exp; a failure retries', async () => {
    let now = 0;
    let exp = 7200; // unix s
    const timers: { fn: () => void; ms: number }[] = [];
    const tokens: string[] = [];
    let fail = false;
    const pull = startTokenPull({
      now: () => now,
      tokenExp: () => exp,
      setToken: (t) => {
        tokens.push(t);
        exp = now / 1000 + 7200;
      },
      pull: async () => {
        if (fail) throw new Error('down');
        return `tok@${now}`;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      retryMs: 60_000,
    });
    await Promise.resolve();
    expect(timers.at(-1)!.ms).toBe(7200_000 - PULL_BEFORE_MS);
    now = 7200_000 - PULL_BEFORE_MS;
    timers.at(-1)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(tokens).toEqual([`tok@${now}`]);
    expect(timers.at(-1)!.ms).toBe(7200_000 - PULL_BEFORE_MS);
    fail = true;
    now += 7200_000 - PULL_BEFORE_MS;
    timers.at(-1)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(tokens).toHaveLength(1);
    expect(timers.at(-1)!.ms).toBe(60_000);
    pull.stop();
  });

  it('a push that moved exp later makes the pull wait instead of fetching', async () => {
    let now = 0;
    let exp = 7200;
    const timers: { fn: () => void; ms: number }[] = [];
    let pulls = 0;
    startTokenPull({
      now: () => now,
      tokenExp: () => exp,
      setToken: () => {},
      pull: async () => {
        pulls++;
        return 't';
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    });
    await Promise.resolve();
    now = 7200_000 - PULL_BEFORE_MS;
    exp = 7200 * 2; // a push landed
    timers.at(-1)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(pulls).toBe(0);
    expect(timers.at(-1)!.ms).toBe(exp * 1000 - PULL_BEFORE_MS - now);
  });
});
