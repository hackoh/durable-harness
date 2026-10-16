import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness as PiHarness, type Storage } from '@earendil-works/pi-durable';
import type { Harness, SessionState } from 'harness-world';
import type { AcquireMachine, AcquireMachineRequest } from 'harness-world-process';
import { transcriptOf } from 'harness-world-process';
import type { SandboxSessionOptions } from 'harness-world-sandbox';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { scriptedGateway, type ScriptedGateway, text, toolCall, toolResults } from '../../harness-opencode/test/scripted-gateway.ts';
import { durableAgent, isSettled, type Agent } from '../src/index.ts';
import { opencode, opencodeHarness } from '../src/opencode.ts';
import { CodingTools, chatRoute as piDurableChatRoute, openWorldReader, sandboxEnv } from '../src/pi-durable.ts';
import { createCodingTools, pi, piHarness } from '../src/pi.ts';
import { publicSandboxConfig } from '../src/sandbox-harness.ts';
import { resolveEnvironment } from '../src/environments.ts';
import { sandbox } from '../src/workspace.ts';
import { getWorld } from '../src/world.ts';
import { atWorkspace, FakeSandboxApi, nameOf, relayBundle, SPEC } from './sandbox-stand-in.ts';

/**
 * The public-route guard (docs/workspaces.md §5.7 "Abuse",
 * sandbox-harness.ts) on the Function-tier harnesses that boot a Vercel
 * Sandbox VM per session on `sandbox()`: OpenCode, Pi and pi-durable,
 * through their public `durable-harness/<harness>` lines, real turns with
 * scripted models.
 *
 * `sandbox()`'s session factory (harness-world-sandbox's `sandboxSession`,
 * which the acquire imports on first use) is replaced here by the stand-in
 * (`sandbox-stand-in.ts`: the real factory over harness-sandbox's fake
 * Sandbox API, each "VM" a local relay over temp dirs), behind a counter of
 * every acquire that reaches it. A session a public route started without
 * `allowPublicSandbox: true`, or with an infinite `budget.sessionUsd`, must
 * fail before any VM is acquired: the counter stays 0, whatever the
 * harness's mark says (the rows start such sessions on marked agents, and
 * behind a public route built from a harness rebuilt without its mark).
 * With the opt-in and a finite `sessionUsd` the command runs on the
 * stand-in.
 */

/** Every acquire that reached the session factory, and every factory made. */
const tier = vi.hoisted(() => ({
  acquires: 0,
  factories: 0,
  make: undefined as undefined | ((options: unknown, real: (options: never) => unknown) => unknown),
}));

vi.mock('harness-world-sandbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('harness-world-sandbox')>();
  return {
    ...real,
    // sandbox()'s factory, on the stand-in, counted.
    sandboxSession: (options: SandboxSessionOptions) => {
      tier.factories++;
      const acquire = tier.make!(options, real.sandboxSession as never) as AcquireMachine;
      return (request: AcquireMachineRequest) => {
        tier.acquires++;
        return acquire(request);
      };
    },
  };
});

const MODEL = 'anthropic/claude-haiku-4.5';
const PROOF = 'ran-on-the-stand-in';
const COMMAND = `echo ${PROOF} > proof.txt && cat proof.txt`;
const NO_OPT_IN = /without allowPublicSandbox: true/;
const UNCAPPED = /no finite budget\.sessionUsd/;

const apis: FakeSandboxApi[] = [];
const env0: Record<string, string | undefined> = {};
let root: string;

beforeAll(async () => {
  for (const k of ['WORKFLOW_TARGET_WORLD', 'WORKFLOW_LOCAL_DATA_DIR', 'DH_TEST_LOCAL_SANDBOX', 'VERCEL']) env0[k] = process.env[k];
  process.env.WORKFLOW_TARGET_WORLD = 'local';
  process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'dh-public-sandbox-'));
  // The stand-in's guard (§5.8): the test flag, a test runner, not on Vercel.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
  root = mkdtempSync(join(tmpdir(), 'dh-public-sandbox-root-'));
  await relayBundle();
  tier.make = (_options, real) => {
    const api = new FakeSandboxApi();
    apis.push(api);
    return atWorkspace((real as (o: SandboxSessionOptions) => AcquireMachine)({ spec: SPEC, test: { api, allowDegraded: true } }));
  };
}, 120_000);

afterEach(() => {
  tier.acquires = 0;
  tier.factories = 0;
});

afterAll(async () => {
  for (const api of apis.splice(0)) await api.dispose();
  await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  for (const [k, v] of Object.entries(env0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let named = 0;
/** Each agent needs a name of its own (a session's run records it). */
const agentName = (h: string) => `public-sandbox-${h}-${++named}`;

const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A response's server-sent events. */
async function sse(response: Response): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (const block of (await response.text()).split('\n\n')) {
    for (const line of block.split('\n')) if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6)));
  }
  return out;
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 90_000, what = 'the condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const unavailableOf = (s: SessionState) => s.effectOrder.filter((e) => e.name === 'unavailable');
const attachesOf = (s: SessionState) => s.effectOrder.filter((e) => e.name === 'sandbox.attach');

/** A kernel session's turn that the refusal failed: its `unavailable` fact, once the session is settled. */
async function refusedTurn(agent: Agent, sessionId: string): Promise<SessionState> {
  return until(async () => {
    const s = await agent.sessions.inspect(sessionId);
    if (s.status === 'failed') throw new Error(`session failed: ${s.failure?.message}`);
    return unavailableOf(s).length > 0 && isSettled(s) ? s : undefined;
  }, 90_000, 'the refused turn');
}

/**
 * What every refused kernel turn shows: one `unavailable` fact with the
 * refusal and its hint, on the first delivery (no redelivery repeated it),
 * at most two attaches (the route's drive hands an `Unavailable` to the
 * queue at once, which fails the turn), none admitted, and no acquire.
 */
function expectRefused(state: SessionState, refusal: RegExp) {
  const [failed, ...more] = unavailableOf(state);
  expect(more).toEqual([]);
  expect(failed!.output).toMatchObject({ code: 'unavailable', message: expect.stringMatching(refusal), hint: expect.stringContaining('sandbox({ budget: { sessionUsd } })') });
  expect((failed!.output as { attempt?: number }).attempt ?? 1).toBe(1);
  // What the route's caller sees: the developer's fix, nothing of the deployment.
  expect(JSON.stringify(failed!.output)).not.toMatch(/prj_|team_|\$\d|\d+(\.\d+)? ?USD/);
  const attaches = attachesOf(state);
  expect(attaches.length).toBeGreaterThanOrEqual(1);
  expect(attaches.length).toBeLessThanOrEqual(2);
  for (const a of attaches) expect(a.output).toMatchObject({ attached: false, error: expect.stringMatching(refusal) });
  expect(tier.acquires).toBe(0);
  expect(tier.factories).toBe(0);
}

// ---------- the acquire itself ----------

describe("sandbox()'s acquire admits a request before the session factory", () => {
  it('a request without the config key is refused (a runtime that forgot it fails closed), and the factory is never asked', async () => {
    const { acquire } = resolveEnvironment(sandbox({ budget: { sessionUsd: 2 } }));
    const request = { sessionId: 'wrun_x', fence: () => ({ count: 1, fenced: true }), signal: new AbortController().signal };
    await expect(acquire(request)).rejects.toThrow(TypeError);
    await expect(acquire(request)).rejects.toThrow(/without config/);
    expect(tier.acquires).toBe(0);
    expect(tier.factories).toBe(0);
  });

  it('config: undefined (a session that recorded none) passes to the factory', async () => {
    const { acquire } = resolveEnvironment(sandbox({ budget: { sessionUsd: 2 } }));
    // The factory goes on to refuse a request with no fencing token: what this row checks is that it was asked.
    await acquire({ sessionId: 'wrun_y', config: undefined, fence: () => undefined, signal: new AbortController().signal }).catch(() => {});
    expect(tier.factories).toBe(1);
    expect(tier.acquires).toBe(1);
  });

  it("a public route's session without the opt-in, or with no finite sessionUsd, is refused before the factory is asked", async () => {
    const request = { sessionId: 'wrun_z', fence: () => ({ count: 1, fenced: true }), signal: new AbortController().signal };
    await expect(resolveEnvironment(sandbox({ budget: { sessionUsd: 2 } })).acquire({ ...request, config: publicSandboxConfig(undefined) })).rejects.toThrow(NO_OPT_IN);
    await expect(resolveEnvironment(sandbox()).acquire({ ...request, config: publicSandboxConfig(true) })).rejects.toThrow(UNCAPPED);
    expect(tier.acquires).toBe(0);
    expect(tier.factories).toBe(0);
  });
});

// ---------- OpenCode ----------

describe('OpenCode on sandbox() behind a public route', () => {
  let gateway: ScriptedGateway;
  /** What the model says next, for requests that offer tools (one without is OpenCode's own: a title). */
  const steps: ((body: any) => ReturnType<typeof text>)[] = [];
  beforeAll(async () => {
    gateway = await scriptedGateway();
    gateway.script.push(...Array.from({ length: 400 }, () => (body: any) => (body?.tools?.length ? (steps.shift()?.(body) ?? text('done')) : text('A title'))));
  });
  afterAll(async () => {
    await gateway?.close();
  });
  afterEach(() => {
    steps.splice(0);
  });

  const options = (workspace: ReturnType<typeof sandbox>) => ({ model: MODEL, name: agentName('opencode'), root, gatewayUrl: gateway.url, credential: async () => 'fake-gateway-credential', workspace });

  it("the route refuses to be made, as Claude Code's does: no opt-in, an infinite sessionUsd; a spread of the harness keeps its mark", () => {
    const capped = sandbox({ budget: { sessionUsd: 2 } });
    const agent = opencode(options(capped));
    expect(() => agent.chatRoute({ authorize: 'public' })).toThrow(/Vercel Sandbox VM.*allowPublicSandbox: true/);
    expect(() => agent.chatRoute({ authorize: 'public', allowPublicSandbox: false })).toThrow(TypeError);
    expect(() => agent.chatRoute({ authorize: 'public', allowPublicSandbox: true })).not.toThrow();
    expect(() => agent.chatRoute({ authorize: async () => {} })).not.toThrow();
    expect(() => agent.chatRoute()).not.toThrow();
    const uncapped = opencode(options(sandbox()));
    expect(() => uncapped.chatRoute({ authorize: 'public', allowPublicSandbox: true })).toThrow(/needs a finite sandbox\(\{ budget: \{ sessionUsd \} \}\)/);
    expect(() => uncapped.chatRoute({ authorize: async () => {} })).not.toThrow();
    const copied = durableAgent({ harness: { ...opencodeHarness(options(capped)) } });
    expect(() => copied.chatRoute({ authorize: 'public' })).toThrow(/Vercel Sandbox VM.*allowPublicSandbox: true/);
    expect(() => copied.chatRoute({ authorize: 'public', allowPublicSandbox: true })).not.toThrow();
    // A virtual workspace, or none, boots no VM: no opt-in.
    const { workspace: _, ...noWorkspace } = options(capped);
    expect(() => opencode(noWorkspace).chatRoute({ authorize: 'public' })).not.toThrow();
  });

  it("a session a public route started without the opt-in fails its turn at once, before any VM is acquired, whatever the agent's mark; the session stays", { timeout: 180_000 }, async () => {
    const agent = opencode(options(sandbox({ budget: { sessionUsd: 2 } })));
    steps.push(() => toolCall('n1', 'shell', { command: COMMAND }));
    // What chatRoute({ authorize: 'public' }) records, on a session of the marked agent: the acquire's check alone.
    const { sessionId } = await agent.sessions.start({ prompt: 'Run it.', config: { traceAudience: 'public', ...publicSandboxConfig(undefined) } });
    expectRefused(await refusedTurn(agent, sessionId), NO_OPT_IN);
    // The session stays: its next turn runs (a reply with no tool call).
    steps.push(() => text('still here'));
    await agent.sessions.send(sessionId, 'Are you there?');
    const after = await until(async () => {
      const s = await agent.sessions.inspect(sessionId);
      return transcriptOf(s).some((r) => r.data.type === 'turn' && r.data.status === 'completed') && isSettled(s) ? s : undefined;
    }, 90_000, 'the next turn');
    expect(after.status).not.toBe('failed');
    expect(tier.acquires).toBe(0);
  });

  it('the opt-in with the default, infinite sessionUsd: the same', { timeout: 120_000 }, async () => {
    const agent = opencode(options(sandbox()));
    steps.push(() => toolCall('u1', 'shell', { command: COMMAND }));
    const { sessionId } = await agent.sessions.start({ prompt: 'Run it.', config: { traceAudience: 'public', ...publicSandboxConfig(true) } });
    expectRefused(await refusedTurn(agent, sessionId), UNCAPPED);
  });

  it("a harness rebuilt without its mark builds a public route, and each of its sessions is refused at attach; the next turn on it still runs", { timeout: 180_000 }, async () => {
    const raw = opencodeHarness(options(sandbox({ budget: { sessionUsd: 2 } })));
    const rebuilt: Harness = { name: raw.name, drive: (c) => raw.drive(c) };
    const agent = durableAgent({ harness: rebuilt });
    const route = agent.chatRoute({ authorize: 'public' });
    steps.push(() => toolCall('r1', 'shell', { command: COMMAND }));
    const res = await route.POST(post({ text: 'Run it.' }));
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('x-session-id')!;
    const events = await sse(res);
    // The route's caller is told why, in the turn's error event.
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'unavailable', message: expect.stringMatching(NO_OPT_IN) }));
    expectRefused(await refusedTurn(agent, sessionId), NO_OPT_IN);
    steps.push(() => text('still here'));
    const next = await sse(await route.POST(post({ sessionId, text: 'Are you there?' })));
    expect(next).toContainEqual(expect.objectContaining({ type: 'text', delta: 'still here' }));
    expect(next.some((e) => e.type === 'error')).toBe(false);
    expect(tier.acquires).toBe(0);
  });

  it('with the opt-in and a finite sessionUsd, the command runs on the stand-in', { timeout: 180_000 }, async () => {
    const agent = opencode(options(sandbox({ budget: { sessionUsd: 2 } })));
    steps.push(() => toolCall('p1', 'shell', { command: COMMAND }), () => text('done'));
    const before = gateway.requests.length;
    const res = await agent.chatRoute({ authorize: 'public', allowPublicSandbox: true }).POST(post({ text: 'Run it.' }));
    const sessionId = res.headers.get('x-session-id')!;
    const events = await sse(res);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const asked = gateway.requests.slice(before).filter((b) => b?.tools?.length);
    expect(toolResults(asked.at(-1)).get('p1')).toContain(PROOF);
    expect(tier.acquires).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(apis.at(-1)!.driveDir(nameOf(sessionId)), 'proof.txt'), 'utf8')).toBe(`${PROOF}\n`);
  });
});

// ---------- Pi ----------

describe('Pi with createCodingTools(sandbox()) behind a public route', () => {
  /** A faux pi-ai model that answers `responses` in order. */
  function faux(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
    const provider = fauxProvider();
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses(responses);
    return { model: provider.getModel(), streamFn: models.streamSimple.bind(models), getApiKey: () => 'fake-key' };
  }
  const runIt = () => fauxAssistantMessage(fauxToolCall('bash', { command: COMMAND }), { stopReason: 'toolUse' });
  const say = (t: string) => fauxAssistantMessage(fauxText(t));

  it('the route refuses to be made: no opt-in, an infinite sessionUsd; a spread of the harness, or of its tools, keeps the mark', () => {
    const capped = createCodingTools(sandbox({ budget: { sessionUsd: 2 } }));
    const agent = pi({ ...faux([]), name: agentName('pi'), tools: capped });
    expect(() => agent.chatRoute({ authorize: 'public' })).toThrow(/Vercel Sandbox VM.*allowPublicSandbox: true/);
    expect(() => agent.chatRoute({ authorize: 'public', allowPublicSandbox: false })).toThrow(TypeError);
    expect(() => agent.chatRoute({ authorize: 'public', allowPublicSandbox: true })).not.toThrow();
    expect(() => agent.chatRoute({ authorize: async () => {} })).not.toThrow();
    expect(() => pi({ ...faux([]), name: agentName('pi'), tools: createCodingTools(sandbox()) }).chatRoute({ authorize: 'public', allowPublicSandbox: true })).toThrow(/needs a finite sandbox/);
    expect(() => pi({ ...faux([]), name: agentName('pi'), tools: capped.map((t) => ({ ...t })) }).chatRoute({ authorize: 'public' })).toThrow(/allowPublicSandbox: true/);
    expect(() => durableAgent({ harness: { ...piHarness({ ...faux([]), tools: capped }) } }).chatRoute({ authorize: 'public' })).toThrow(/allowPublicSandbox: true/);
    // Tools on a virtual workspace, or none: no VM, no opt-in.
    expect(() => pi({ ...faux([]), name: agentName('pi') }).chatRoute({ authorize: 'public' })).not.toThrow();
  });

  it("a session a public route started without the opt-in fails its turn at once, before any VM is acquired, whatever the agent's mark; the session stays", { timeout: 120_000 }, async () => {
    const agent = pi({ ...faux([runIt(), say('still here')]), name: agentName('pi'), tools: createCodingTools(sandbox({ budget: { sessionUsd: 2 } })) });
    const { sessionId } = await agent.sessions.start({ prompt: 'Run it.', config: { traceAudience: 'public', ...publicSandboxConfig(undefined) } });
    const refused = await refusedTurn(agent, sessionId);
    expectRefused(refused, NO_OPT_IN);
    expect(refused.effectOrder.some((e) => e.name === 'tool.bash')).toBe(false);
    await agent.sessions.send(sessionId, 'Are you there?');
    const after = await until(async () => {
      const s = await agent.sessions.inspect(sessionId);
      return s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length === 2 && isSettled(s) ? s : undefined;
    }, 60_000, 'the next turn');
    expect(after.status).not.toBe('failed');
    expect(tier.acquires).toBe(0);
  });

  it('the opt-in with the default, infinite sessionUsd: the same', { timeout: 120_000 }, async () => {
    const agent = pi({ ...faux([runIt(), say('done')]), name: agentName('pi'), tools: createCodingTools(sandbox()) });
    const { sessionId } = await agent.sessions.start({ prompt: 'Run it.', config: { traceAudience: 'public', ...publicSandboxConfig(true) } });
    expectRefused(await refusedTurn(agent, sessionId), UNCAPPED);
  });

  it('a harness rebuilt without its mark builds a public route, and each of its sessions is refused at attach; the next turn on it still runs', { timeout: 120_000 }, async () => {
    const raw = piHarness({ ...faux([runIt(), say('still here')]), tools: createCodingTools(sandbox({ budget: { sessionUsd: 2 } })) });
    const agent = durableAgent({ harness: { name: agentName('pi'), drive: (c) => raw.drive(c) } });
    const route = agent.chatRoute({ authorize: 'public' });
    const res = await route.POST(post({ text: 'Run it.' }));
    const sessionId = res.headers.get('x-session-id')!;
    expect(await sse(res)).toContainEqual(expect.objectContaining({ type: 'error', code: 'unavailable', message: expect.stringMatching(NO_OPT_IN) }));
    expectRefused(await refusedTurn(agent, sessionId), NO_OPT_IN);
    const next = await sse(await route.POST(post({ sessionId, text: 'Are you there?' })));
    expect(next).toContainEqual(expect.objectContaining({ type: 'text', delta: 'still here' }));
    expect(next.some((e) => e.type === 'error')).toBe(false);
    expect(tier.acquires).toBe(0);
  });

  it('with the opt-in and a finite sessionUsd, the command runs on the stand-in', { timeout: 120_000 }, async () => {
    const agent = pi({ ...faux([runIt(), say('done')]), name: agentName('pi'), tools: createCodingTools(sandbox({ budget: { sessionUsd: 2 } })) });
    const res = await agent.chatRoute({ authorize: 'public', allowPublicSandbox: true }).POST(post({ text: 'Run it.' }));
    const sessionId = res.headers.get('x-session-id')!;
    expect((await sse(res)).some((e) => e.type === 'error')).toBe(false);
    const state = await until(async () => {
      const s = await agent.sessions.inspect(sessionId);
      return s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length === 2 && isSettled(s) ? s : undefined;
    }, 60_000, 'the turn');
    const bash = state.effectOrder.find((e) => e.name === 'tool.bash');
    expect(bash?.status).toBe('completed');
    expect(JSON.stringify(bash?.output)).toContain(PROOF);
    expect(tier.acquires).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(apis.at(-1)!.driveDir(nameOf(sessionId)), 'proof.txt'), 'utf8')).toBe(`${PROOF}\n`);
  });
});

// ---------- pi-durable ----------

describe("pi-durable's chatRoute with sandboxEnv(): no harness to mark, so the attach is the check", () => {
  /** An app's own Pi setup: a faux model answering `responses`, CodingTools, and an opener on `sandboxEnv(workspace)`. */
  function app(workspace: ReturnType<typeof sandbox>, responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
    const faux = fauxProvider();
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const registry = createRegistry();
    registry.install(CodingTools);
    const env = sandboxEnv(workspace);
    return {
      open: (storage: Storage) => PiHarness.open(storage, { models, registry, env }, ctx),
      agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Use the tools.' },
    };
  }
  const runIt = () => fauxAssistantMessage(fauxToolCall('bash', { command: COMMAND }, { id: 'c1' }), { stopReason: 'toolUse' });
  const say = (t: string) => fauxAssistantMessage(fauxText(t));

  /** The session's tool results, as its log has them. */
  async function results(sessionId: string) {
    const reader = openWorldReader(sessionId);
    await reader.refresh();
    return (await reader.snapshot()).entries
      .filter((e) => e.kind === 'pi.tool-result')
      .map((e) => {
        const m = e.model?.[0] as { toolName: string; content: { type: string; text?: string }[]; isError: boolean };
        return { name: m.toolName, text: m.content.map((c) => c.text ?? '').join(''), isError: m.isError };
      });
  }

  /** One message through the route; resolves once its stream says the session is idle. */
  async function message(route: ReturnType<typeof piDurableChatRoute>, body: Record<string, unknown>) {
    const res = await route.POST(post(body));
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('x-session-id')!;
    const events = await sse(res);
    expect(events.at(-1)).toEqual({});
    return { sessionId, events };
  }

  /** A refused session: the call failed with the refusal (nothing ran), no VM acquired; its next message still gets an answer. */
  async function expectRefusedSession(route: ReturnType<typeof piDurableChatRoute>, sessionId: string, refusal: RegExp) {
    const [bash, ...more] = await results(sessionId);
    expect(more).toEqual([]);
    expect(bash).toMatchObject({ name: 'bash', isError: true, text: expect.stringMatching(refusal) });
    expect(bash!.text).not.toContain(PROOF);
    expect(bash!.text).not.toMatch(/prj_|team_/);
    expect(tier.acquires).toBe(0);
    expect(tier.factories).toBe(0);
    const { events } = await message(route, { sessionId, text: 'Are you there?' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', delta: 'still here' }));
    expect(tier.acquires).toBe(0);
  }

  it('a public route without the opt-in: the call fails with the refusal before any VM is acquired; the session stays', { timeout: 120_000 }, async () => {
    const a = app(sandbox({ budget: { sessionUsd: 2 } }), [runIt(), say('done'), say('still here')]);
    const route = piDurableChatRoute({ open: a.open, agent: a.agent, authorize: 'public', name: agentName('pi-durable') });
    const { sessionId } = await message(route, { text: 'Run it.' });
    await expectRefusedSession(route, sessionId, NO_OPT_IN);
  });

  it('the opt-in with the default, infinite sessionUsd: the same', { timeout: 120_000 }, async () => {
    const a = app(sandbox(), [runIt(), say('done'), say('still here')]);
    const route = piDurableChatRoute({ open: a.open, agent: a.agent, authorize: 'public', allowPublicSandbox: true, name: agentName('pi-durable') });
    const { sessionId } = await message(route, { text: 'Run it.' });
    await expectRefusedSession(route, sessionId, UNCAPPED);
  });

  it('a session id the World has never seen, which the route creates as it opens it: the same', { timeout: 120_000 }, async () => {
    const a = app(sandbox({ budget: { sessionUsd: 2 } }), [runIt(), say('done'), say('still here')]);
    const route = piDurableChatRoute({ open: a.open, agent: a.agent, authorize: 'public', name: agentName('pi-durable') });
    const fresh = `wrun_${ulid()}`;
    const { sessionId } = await message(route, { sessionId: fresh, text: 'Run it.' });
    expect(sessionId).toBe(fresh);
    await expectRefusedSession(route, sessionId, NO_OPT_IN);
  });

  it('a route with your own authorize records nothing, and boots the VM', { timeout: 120_000 }, async () => {
    const a = app(sandbox(), [runIt(), say('done')]);
    const route = piDurableChatRoute({ open: a.open, agent: a.agent, authorize: async () => {}, name: agentName('pi-durable') });
    const { sessionId } = await message(route, { text: 'Run it.' });
    expect(await results(sessionId)).toEqual([{ name: 'bash', isError: false, text: expect.stringContaining(PROOF) }]);
    expect(tier.acquires).toBeGreaterThanOrEqual(1);
  });

  it('with the opt-in and a finite sessionUsd, the command runs on the stand-in', { timeout: 120_000 }, async () => {
    const a = app(sandbox({ budget: { sessionUsd: 2 } }), [runIt(), say('done')]);
    const route = piDurableChatRoute({ open: a.open, agent: a.agent, authorize: 'public', allowPublicSandbox: true, name: agentName('pi-durable') });
    const { sessionId } = await message(route, { text: 'Run it.' });
    expect(await results(sessionId)).toEqual([{ name: 'bash', isError: false, text: expect.stringContaining(PROOF) }]);
    expect(tier.acquires).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(apis.at(-1)!.driveDir(nameOf(sessionId)), 'proof.txt'), 'utf8')).toBe(`${PROOF}\n`);
  });
});
