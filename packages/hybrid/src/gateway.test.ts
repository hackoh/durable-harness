import { describe, expect, it, vi } from 'vitest';
import {
  createTokenSource,
  type DirectCredentials,
  directHeaders,
  GATEWAY_URL,
  gatewayFetch,
  jwtClaims,
  probeGateway,
  tokenTimes,
} from './gateway.ts';
import { createGatewayModel, withFetch } from './harness.ts';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

/** A token source over a fixed list of tokens (the next one on each fetch). */
function source(tokens: (string | undefined)[], now = () => Date.now()) {
  let i = 0;
  const fetch = vi.fn(async (): Promise<DirectCredentials | undefined> => {
    const t = tokens[Math.min(i++, tokens.length - 1)];
    return t === undefined ? undefined : { token: t };
  });
  return { tokens: createTokenSource({ fetch, now, background: false }), fetch };
}

const PROXY = 'https://app.test/api/gateway';

describe('jwt claims', () => {
  it('reads exp and iat without verifying', () => {
    const token = jwt({ exp: 1_790_000_000, iat: 1_789_996_400, owner_id: 'team_x', project_id: 'prj_y' });
    expect(tokenTimes(token)).toEqual({ exp: 1_790_000_000, iat: 1_789_996_400 });
    expect(jwtClaims(token)?.project_id).toBe('prj_y');
  });
  it('is undefined for something that is not a JWT', () => {
    expect(jwtClaims('proxy')).toBeUndefined();
    expect(jwtClaims('a.%%%.c')).toBeUndefined();
    expect(tokenTimes('a.b.c')).toEqual({});
  });
});

describe('directHeaders', () => {
  it('keeps only what the Gateway CORS allows and sets the credential', () => {
    const h = directHeaders(
      {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-stainless-os': 'MacOS',
        'x-stainless-retry-count': '0',
        'ai-language-model-id': 'anthropic/claude',
        'x-api-key': 'proxy',
        authorization: 'Bearer proxy',
        accept: 'application/json',
      },
      'tok'
    );
    expect(Object.fromEntries(h)).toEqual({
      accept: 'application/json',
      'ai-language-model-id': 'anthropic/claude',
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      'x-api-key': 'tok',
    });
  });
  it('keeps every header outside a browser when asked', () => {
    expect(directHeaders({ 'x-stainless-os': 'Linux' }, 't', false).get('x-stainless-os')).toBe('Linux');
  });
});

describe('createTokenSource', () => {
  it('fetches once, caches, and shares a fetch in flight', async () => {
    let clock = 1_000_000_000_000;
    const { tokens, fetch } = source([jwt({ exp: clock / 1000 + 3600 })], () => clock);
    const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
    expect(a?.token).toBe(b?.token);
    expect(a?.exp).toBe(clock / 1000 + 3600);
    await tokens.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    // Within a minute of exp: fetched again.
    clock += (3600 - 30) * 1000;
    await tokens.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('force refetches', async () => {
    const { tokens, fetch } = source([jwt({ exp: 9e9 }), jwt({ exp: 9e9 + 1 })]);
    const a = await tokens.get();
    const b = await tokens.get({ force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(a?.token).not.toBe(b?.token);
  });

  it('a 404 from the token route turns direct off for good', async () => {
    const { tokens, fetch } = source([undefined]);
    expect(await tokens.get()).toBeUndefined();
    expect(tokens.unavailable).toBe(true);
    expect(await tokens.get()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps serving a still-valid token when a refresh fails', async () => {
    let clock = 1_000_000_000_000;
    let fail = false;
    const onError = vi.fn();
    const tokens = createTokenSource({
      now: () => clock,
      background: false,
      onError,
      fetch: async () => {
        if (fail) throw new Error('down');
        return { token: jwt({ exp: clock / 1000 + 600 }) };
      },
    });
    const first = await tokens.get();
    fail = true;
    clock += 570_000; // 30 s left: not handed out without a refresh, but still valid
    expect((await tokens.get())?.token).toBe(first?.token);
    expect(onError).toHaveBeenCalledTimes(1);
    clock += 60_000; // expired
    expect(await tokens.get()).toBeUndefined();
  });

  it('refreshes in the background before exp', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      let n = 0;
      const tokens = createTokenSource({
        refreshBeforeMs: 10 * 60_000,
        fetch: async () => ({ token: jwt({ exp: Math.floor(start / 1000) + 3600, n: n++ }) }),
      });
      await tokens.get();
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(49 * 60_000);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(n).toBe(2);
      // The route handed back a token with the same exp (inside the window):
      // retried gently, not in a loop.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      tokens.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('gatewayFetch', () => {
  const recorder = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer);
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers)), ...(body !== undefined ? { body } : {}) });
      return respond(url, init ?? {});
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };
  const messages = `${GATEWAY_URL}/v1/messages`;
  const init = { method: 'POST', headers: { 'x-stainless-os': 'MacOS', 'x-api-key': 'proxy', 'content-type': 'application/json' }, body: '{"a":1}' };

  it('goes direct with the token and CORS-safe headers', async () => {
    const { calls, fetch } = recorder(() => new Response('ok'));
    const { tokens } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    await gw(messages, init);
    expect(calls).toEqual([{ url: messages, headers: { authorization: 'Bearer tok', 'x-api-key': 'tok', 'content-type': 'application/json' }, body: '{"a":1}' }]);
    expect(gw.status()).toEqual({ route: 'direct', last: 'direct' });
  });

  it('uses the proxy when the token route is off', async () => {
    const { calls, fetch } = recorder(() => new Response('ok'));
    const { tokens } = source([undefined]);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    await gw(`${GATEWAY_URL}/coding-agent/v1/models?x=1`, { method: 'GET' });
    expect(calls[0]!.url).toBe(`${PROXY}/coding-agent/v1/models?x=1`);
    expect(gw.status().route).toBe('proxy');
    expect(gw.status().reason).toMatch(/off/);
  });

  it('adds proxyHeaders to proxied requests (a session token), never to direct ones', async () => {
    const { calls, fetch } = recorder(() => new Response('ok'));
    let n = 0;
    const proxied = gatewayFetch({ proxyBase: PROXY, fetch, proxyHeaders: async () => ({ 'x-harness-run-token': `t${++n}` }) });
    await proxied(messages, init);
    await proxied(messages, init);
    expect(calls.map((c) => [c.url, c.headers['x-harness-run-token'], c.headers['x-stainless-os']])).toEqual([
      [`${PROXY}/v1/messages`, 't1', 'MacOS'],
      [`${PROXY}/v1/messages`, 't2', 'MacOS'],
    ]);
    const { tokens } = source(['tok']);
    const direct = gatewayFetch({ tokens, proxyBase: PROXY, fetch, proxyHeaders: () => ({ 'x-harness-run-token': 'never' }) });
    await direct(messages, init);
    expect(calls[2]!.headers['x-harness-run-token']).toBeUndefined();
  });

  /** A fetch whose direct requests never answer (until aborted); the proxy answers. */
  const stalling = (stallDirect: number) => {
    let direct = 0;
    const seen: string[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith(GATEWAY_URL) && direct++ < stallDirect) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  };

  it('sends a direct request that never answers through the proxy', async () => {
    const { fetch, seen } = stalling(1);
    const { tokens } = source(['tok']);
    const onRoute = vi.fn();
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch, headersTimeoutMs: 20, onRoute });
    expect(await (await gw(messages, init)).text()).toBe('ok');
    expect(seen).toEqual([messages, `${PROXY}/v1/messages`]);
    expect(onRoute).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'proxy', reason: expect.stringMatching(/no response headers/) }));
    // No cooldown: the next request goes direct again.
    await gw(messages, init);
    expect(seen.at(-1)).toBe(messages);
    expect(gw.status().route).toBe('direct');
  });

  it('forced direct: resends a stalled request once, then fails', async () => {
    const once = stalling(1);
    const gw1 = gatewayFetch({ tokens: source(['tok']).tokens, proxyBase: PROXY, fetch: once.fetch, headersTimeoutMs: 20, mode: 'direct' });
    expect(await (await gw1(messages, init)).text()).toBe('ok');
    expect(once.seen).toEqual([messages, messages]);
    const always = stalling(9);
    const gw2 = gatewayFetch({ tokens: source(['tok']).tokens, fetch: always.fetch, headersTimeoutMs: 20, mode: 'direct' });
    await expect(gw2(messages, init)).rejects.toThrow(/no response headers/);
    expect(always.seen).toHaveLength(2);
  });

  it("the caller's abort still aborts, and is not mistaken for a stall", async () => {
    const { fetch, seen } = stalling(9);
    const gw = gatewayFetch({ tokens: source(['tok']).tokens, proxyBase: PROXY, fetch, headersTimeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = gw(messages, { ...init, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(seen).toEqual([messages]);
  });

  it('a slow but answering request is not cut off', async () => {
    const fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response('late');
    }) as unknown as typeof globalThis.fetch;
    const gw = gatewayFetch({ tokens: source(['tok']).tokens, proxyBase: PROXY, fetch, headersTimeoutMs: 200 });
    expect(await (await gw(messages, init)).text()).toBe('late');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('can be forced to the proxy (A/B)', async () => {
    const { calls, fetch } = recorder(() => new Response('ok'));
    const { tokens, fetch: tokenFetch } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch, mode: 'proxy' });
    await gw(messages, init);
    expect(calls[0]!.url).toBe(`${PROXY}/v1/messages`);
    // Headers pass to the proxy untouched (it filters and adds the credential).
    expect(calls[0]!.headers['x-stainless-os']).toBe('MacOS');
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('retries once with a fresh token on 401, then falls back to the proxy', async () => {
    const { calls, fetch } = recorder((url) => new Response('', { status: url.startsWith(PROXY) ? 200 : 401 }));
    const { tokens, fetch: tokenFetch } = source(['old', 'new']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    const r = await gw(messages, init);
    expect(r.status).toBe(200);
    expect(calls.map((c) => [c.url, c.headers.authorization])).toEqual([
      [messages, 'Bearer old'],
      [messages, 'Bearer new'],
      [`${PROXY}/v1/messages`, undefined],
    ]);
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    expect(calls[2]!.body).toBe('{"a":1}');
    // In the cooldown the next request goes to the proxy straight away.
    await gw(messages, init);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.url).toBe(`${PROXY}/v1/messages`);
    expect(gw.status().reason).toMatch(/rejected the token/);
  });

  it('a fresh token after a 401 is enough', async () => {
    let n = 0;
    const { calls, fetch } = recorder(() => new Response('', { status: n++ === 0 ? 401 : 200 }));
    const { tokens } = source(['old', 'new']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    expect((await gw(messages, init)).status).toBe(200);
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('a blocked direct request (CORS, network) is sent to the proxy, and direct is retried after the cooldown', async () => {
    let clock = 0;
    let block = true;
    const { calls, fetch } = recorder((url) => {
      if (!url.startsWith(PROXY) && block) throw new TypeError('Failed to fetch');
      return new Response('ok');
    });
    const { tokens } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch, now: () => clock, cooldownMs: 1000 });
    expect(await (await gw(messages, init)).text()).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([messages, `${PROXY}/v1/messages`]);
    block = false;
    clock = 500;
    await gw(messages, init);
    expect(calls.at(-1)!.url).toBe(`${PROXY}/v1/messages`);
    clock = 1500;
    await gw(messages, init);
    expect(calls.at(-1)!.url).toBe(messages);
  });

  it('does not resend an aborted request', async () => {
    const { calls, fetch } = recorder(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { tokens } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    await expect(gw(messages, init)).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(1);
  });

  it('reads a stream body once so it can be resent', async () => {
    const { calls, fetch } = recorder((url) => {
      if (!url.startsWith(PROXY)) throw new TypeError('Failed to fetch');
      return new Response('ok');
    });
    const { tokens } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    await gw(messages, { method: 'POST', body: new Blob(['{"b":2}']).stream(), duplex: 'half' } as RequestInit);
    expect(calls.map((c) => c.body)).toEqual(['{"b":2}', '{"b":2}']);
  });

  it('passes other URLs through untouched', async () => {
    const { calls, fetch } = recorder(() => new Response('ok'));
    const gw = gatewayFetch({ proxyBase: PROXY, fetch });
    await gw('https://example.com/x', { headers: { 'x-stainless-os': 'a' } });
    expect(calls).toEqual([{ url: 'https://example.com/x', headers: { 'x-stainless-os': 'a' } }]);
  });

  it('without a proxy (a VM) a blocked request fails instead of looping', async () => {
    const { fetch } = recorder(() => {
      throw new TypeError('Failed to fetch');
    });
    const { tokens } = source(['tok']);
    await expect(gatewayFetch({ tokens, fetch })(messages, init)).rejects.toThrow(/Failed to fetch/);
  });

  it('warm() probes and sends requests to the proxy when the probe fails', async () => {
    const { calls, fetch } = recorder((url, i) =>
      i.method === 'OPTIONS' ? new Response(null, { status: 204 }) : new Response('', { status: url.includes('models') ? 403 : 200 })
    );
    const { tokens } = source(['tok']);
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch });
    const probe = await gw.warm();
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(/models 403/);
    await gw(messages, init);
    expect(calls.at(-1)!.url).toBe(`${PROXY}/v1/messages`);
  });
});

describe('probeGateway', () => {
  it('is ok when the preflight and the catalog read are', async () => {
    const seen: string[] = [];
    const probe = await probeGateway('tok', {
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(`${init.method ?? 'GET'} ${url} ${new Headers(init.headers).get('authorization')}`);
        return init.method === 'OPTIONS' ? new Response(null, { status: 204 }) : new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(probe.ok).toBe(true);
    expect(seen.sort()).toEqual([
      `GET ${GATEWAY_URL}/coding-agent/v1/models Bearer tok`,
      `OPTIONS ${GATEWAY_URL}/v1/messages Bearer tok`,
    ]);
  });
});

describe('Pi through gatewayFetch', () => {
  it('withFetch hands every stream call the fetch', () => {
    const inner = vi.fn(() => 'stream' as never);
    const f = (async () => new Response()) as unknown as typeof fetch;
    const wrapped = withFetch(inner as never, f);
    wrapped({} as never, {} as never, { apiKey: 'k' } as never);
    expect(inner).toHaveBeenCalledWith({}, {}, { apiKey: 'k', fetch: f });
  });

  it("pi-ai's Anthropic client sends its model requests through it, with CORS-safe headers", async () => {
    const { tokens } = source(['tok']);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
      return new Response('{"type":"error","error":{"type":"overloaded_error","message":"stop here"}}', {
        status: 529,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const gw = gatewayFetch({ tokens, proxyBase: PROXY, fetch: base });
    const { model, streamFn } = createGatewayModel(undefined, undefined, gw);
    const stream = await streamFn(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as never, { apiKey: 'placeholder', maxRetries: 0 } as never);
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain until the error event
    }
    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0]!;
    expect(first.url.split('?')[0]).toBe(`${GATEWAY_URL}/v1/messages`);
    expect(first.headers.authorization).toBe('Bearer tok');
    expect(first.headers['x-api-key']).toBe('tok');
    expect(Object.keys(first.headers).filter((k) => k.startsWith('x-stainless') || k === 'anthropic-dangerous-direct-browser-access')).toEqual([]);
  });
});
