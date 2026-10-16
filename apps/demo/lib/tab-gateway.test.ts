import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, type Harness, readJsonLines } from 'harness-world';
import { mintRunToken, RUN_TOKEN_HEADER } from 'harness-world-remote/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitTabCall, issueRunToken, spendStreamName, tokenRun } from './run-tokens';
import { tabGateway } from './tab-gateway';

/**
 * `/api/gateway` (lib/tab-gateway.ts): each model call is a session's, by
 * its run token; its body is checked against §5.5's schema before the
 * credential is added, and a session past its budget is refused, the
 * spend kept in the session's log.
 */

const SECRET = 'tab-gateway-test-secret';
const MODEL = 'anthropic/claude-opus-5.5-fast';

let world: LocalWorld | undefined;
beforeEach(() => {
  vi.stubEnv('HARNESS_TAB_SECRET', SECRET);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await world?.close?.();
  world = undefined;
});

const quiet = (name: string): Harness => ({ name, async drive() {} });

async function setup(sessionUsd = 2) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'tab-gateway-')), recoverActiveRuns: false });
  const sessions = durableSessions({ world, harness: [quiet('hybrid'), quiet('reference')] });
  const { sessionId } = await sessions.start({ harness: 'hybrid' });
  const upstream: { url: string; body: string; headers: Headers }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    upstream.push({ url: String(url), body: String(init?.body), headers: new Headers(init?.headers) });
    return new Response(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","provider_metadata":{"gateway":{"gatewayCost":"1.25"}}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }) as typeof globalThis.fetch;
  const make = () =>
    tabGateway({ world: world!, runOf: tokenRun, models: { model: MODEL }, sessionUsd, credential: async () => 'project-oidc', fetch, log: () => {} });
  const { token } = await mintRunToken(SECRET, sessionId);
  const call = (gw: ReturnType<typeof make>, body: unknown, headers: Record<string, string> = { [RUN_TOKEN_HEADER]: token }) =>
    gw(
      new Request('https://app.test/api/gateway/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      '/v1/messages?beta=true'
    );
  return { sessions, sessionId, token, upstream, make, call };
}

/** Pi's Messages call, as pi-ai sends it. */
const messages = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
  max_tokens: 128000,
  stream: true,
  system: [{ type: 'text', text: 'You are Pi.' }],
  thinking: { type: 'disabled' },
  ...extra,
});

describe('/api/gateway', () => {
  it('forwards a session\'s call with the credential added, the token never upstream', async () => {
    const { make, call, upstream } = await setup();
    const res = await call(make(), messages());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('text_delta');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://ai-gateway.vercel.sh/v1/messages?beta=true');
    expect(upstream[0]!.headers.get('authorization')).toBe('Bearer project-oidc');
    expect(upstream[0]!.headers.get(RUN_TOKEN_HEADER)).toBeNull();
  });

  it('refuses a call without a session token, or with a forged one', async () => {
    const { make, call, upstream } = await setup();
    expect((await call(make(), messages(), {})).status).toBe(401);
    expect((await call(make(), messages(), { [RUN_TOKEN_HEADER]: 'hwr1.x.y' })).status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('refuses a body outside §5.5\'s schema, a model that is not the app\'s, and a path off the table', async () => {
    const { make, call, upstream, token } = await setup();
    const gw = make();
    for (const body of [
      messages({ mcp_servers: [{ type: 'url', url: 'https://attacker.example', name: 'x' }] }),
      messages({ fallbacks: [{ model: 'openai/gpt-expensive' }] }),
      messages({ tools: [{ type: 'code_execution_20250522', name: 'code_execution' }] }),
      messages({ container: 'c' }),
      messages({ model: 'anthropic/claude-other' }),
    ]) {
      const res = await call(gw, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(403);
      expect(await res.json()).toEqual({ type: 'error', error: { type: 'forbidden' } });
    }
    // Duplicate keys: one value checked, the other read upstream.
    expect((await call(gw, '{"model":"anthropic/claude-opus-5.5-fast","model":"openai/gpt-expensive","max_tokens":1,"messages":[]}')).status).toBe(400);
    const offTable = await gw(
      new Request('https://app.test/api/gateway/v1/models', { method: 'POST', headers: { [RUN_TOKEN_HEADER]: token }, body: '{}' }),
      '/v1/models'
    );
    expect(offTable.status).toBe(403);
    expect(upstream).toHaveLength(0);
  });

  it('refuses a call past the session\'s budget, the spend kept in the session\'s log across instances', async () => {
    const { make, call, upstream, sessionId } = await setup(2);
    const first = make();
    const one = await call(first, messages());
    expect(one.status).toBe(200);
    // Charged as the response ends (the Gateway's figure is in its last event).
    await one.text();
    // $1.25 spent of $2: one more goes out.
    await (await call(first, messages())).text();
    // $2.50: refused, on this instance and on a fresh one (the spend is in the log).
    const refused = await call(first, messages());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ type: 'error', error: { type: 'budget' } });
    expect((await call(make(), messages())).status).toBe(403);
    expect(upstream).toHaveLength(2);
    const spend = await readJsonLines(world!, sessionId, spendStreamName(sessionId));
    expect(spend.map((l) => (l as { usd: number }).usd)).toEqual([1.25, 1.25]);
  });
});

describe('session tokens', () => {
  it('are issued for a hybrid session or a run id the World does not have, and for no other run', async () => {
    const { sessions } = await setup();
    const { sessionId: hybrid } = await sessions.start({ harness: 'hybrid' });
    const { sessionId: other } = await sessions.start({ harness: 'reference' });
    expect(await issueRunToken(world!, hybrid)).toMatchObject({ ok: true });
    expect(await issueRunToken(world!, 'wrun_01KRZZZZZZZZZZZZZZZZZZZZZZ')).toMatchObject({ ok: true });
    expect(await issueRunToken(world!, other)).toMatchObject({ ok: false, status: 403 });
    expect(await issueRunToken(world!, 'not-a-run')).toMatchObject({ ok: false, status: 400 });
  });

  it("keep the server's streams and other harnesses' runs out of the tab's writes", () => {
    const runId = 'wrun_01KRZZZZZZZZZZZZZZZZZZZZZZ';
    expect(admitTabCall({ op: 'streams.write', args: [runId, `${runId}_live`, 'x'] }, runId)).toBe(true);
    expect(admitTabCall({ op: 'streams.write', args: [runId, spendStreamName(runId), 'x'] }, runId)).toBe(false);
    expect(admitTabCall({ op: 'streams.write', args: [runId, `${runId}_ledger`, 'x'] }, runId)).toBe(false);
    const created = (harness: string) => ({ op: 'events.create', args: [runId, { eventType: 'run_created', eventData: { workflowName: `workflow//durable-harness@0.0.1//${harness}` } }] });
    expect(admitTabCall(created('hybrid-fx'), runId)).toBe(true);
    expect(admitTabCall(created('claude-code'), runId)).toBe(false);
    const hook = (token: string) => ({ op: 'events.create', args: [runId, { eventType: 'hook_created', eventData: { token } }] });
    expect(admitTabCall(hook(`harness:${runId}:inbox`), runId)).toBe(true);
    expect(admitTabCall(hook('harness:wrun_OTHER:inbox'), runId)).toBe(false);
  });
});
