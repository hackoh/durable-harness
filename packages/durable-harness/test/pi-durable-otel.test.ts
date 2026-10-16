import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, type Storage, type ToolRegistration } from '@earendil-works/pi-durable';
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { INSTRUMENTATION } from 'harness-world/instrumentation';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, filteringProcessor } from '../src/instrumentation/otel.ts';
import { CodingTools, chatRoute, openWorldReader, openWorldStorage, resumeWith, virtualEnv } from '../src/pi-durable.ts';
import { getWorld } from '../src/world.ts';

/**
 * Agent Runs for pi-durable, the additive way: a Pi app's own code on
 * `openWorldStorage` (and `resumeWith`, and the optional `chatRoute`) traces
 * its turns through durable-harness's OpenTelemetry integration with no
 * wrapper around Pi's API. Spans go to an in-memory span processor.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(50);
  }
}

/** A Pi app's own setup: a scripted faux model, a registry with `tools`, and its opener. */
function piApp(answers: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0], tools: ToolRegistration[] = []) {
  const faux = fauxProvider();
  faux.setResponses(answers);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  if (tools.length) registry.install(defineExtension({ name: 'app', tools }));
  const open = (storage: Storage) => Harness.open(storage, { models, registry }, ctx);
  return { open, model: `${model.provider}/${model.id}`, agent: { model: { provider: model.provider, modelId: model.id } } };
}

const MARKER = 'zebra-7f3a';
const shout = defineTool({
  name: 'shout',
  description: 'Uppercase some text.',
  parameters: Type.Object({ text: Type.String() }),
  replay: 'safe',
  execute: async (args: { text: string }) => ({ content: [{ type: 'text', text: args.text.toUpperCase() }] }),
}) as ToolRegistration;
const shoutTurn = () => [fauxAssistantMessage([fauxToolCall('shout', { text: MARKER })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Shouted.')])];

/** A tool that waits until `release()` (or its call is aborted). */
function gate(name: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started = 0;
  const tool = defineTool({
    name,
    description: `${name}.`,
    parameters: Type.Object({ text: Type.String() }),
    replay: 'safe',
    execute: async (_args, _api, context) => {
      started++;
      await Promise.race([released, new Promise((r) => context.abortSignal?.addEventListener('abort', r, { once: true }))]);
      return { content: [{ type: 'text', text: `${name} done` }] };
    },
  }) as ToolRegistration;
  return { tool, started: () => started, release: () => release() };
}

const exporter = new InMemorySpanExporter();
const integration = agentRuns({ audience: 'public', exportPolicy: { span: () => ({ emit: true }) }, spanProcessors: [new SimpleSpanProcessor(exporter)] });
const spansOf = (sessionId: string) => exporter.getFinishedSpans().filter((s) => s.attributes['agent.run.id'] === sessionId);
const roots = (spans: ReadableSpan[]) => spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent');

describe('Agent Runs for pi-durable, additive (openWorldStorage, resumeWith, chatRoute)', () => {
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'dh-pi-durable-otel-'));
    integration.register();
  });
  afterAll(async () => {
    await integration.forceFlush();
    delete (globalThis as Record<symbol, unknown>)[INSTRUMENTATION];
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });
  beforeEach(() => exporter.reset());

  it("traces a turn of a Pi app's own code on openWorldStorage: the root, steps, model and tool spans, with its audience", async () => {
    const app = piApp(shoutTurn(), [shout]);
    const open = resumeWith(app.open, { name: 'otel-own-code' });
    const storage = await openWorldStorage(undefined, { name: 'otel-own-code', traceAudience: 'private' });
    const harness = await open(storage);
    const root = await harness.root(ctx, { agent: app.agent });
    expect((await (await root.submit({ type: 'input', content: `shout ${MARKER}` }, ctx)).wait(ctx)).status).toBe('done');
    await harness.close(ctx);
    await integration.forceFlush();

    const spans = spansOf(storage.sessionId);
    const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
    const parentOf = (s: ReadableSpan) => (s.parentSpanContext ? byId.get(s.parentSpanContext.spanId) : undefined);
    const [turn, ...more] = roots(spans);
    expect(more).toEqual([]);
    expect(turn!.name).toBe('invoke_agent otel-own-code');
    expect(turn!.attributes).toMatchObject({
      'agent.framework.name': 'durable-harness',
      'agent.run.id': storage.sessionId,
      'agent.channel.audience': 'private',
      'agent.turn.outcome': 'completed',
    });
    expect(String(turn!.attributes['agent.session.title'])).toContain(MARKER);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const models = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'chat');
    expect(models.map((s) => s.name)).toEqual([`chat ${app.model}`, `chat ${app.model}`]);
    expect(String(models[0]!.attributes['gen_ai.input.messages'])).toContain(MARKER);
    const tool = spans.find((s) => s.name === 'execute_tool shout')!;
    expect(String(tool.attributes['gen_ai.tool.call.arguments'])).toContain(MARKER);
    expect(String(tool.attributes['gen_ai.tool.call.result'])).toContain(MARKER.toUpperCase());
    for (const s of [...models, tool]) {
      expect(parentOf(s)!.name).toBe('agent.step');
      expect(parentOf(parentOf(s)!)).toBe(turn);
    }
    expect(models.every((m) => typeof parentOf(m)!.attributes['agent.usage.input_tokens'] === 'number')).toBe(true);

    // The default export policy: a private session's spans carry no content.
    const out: ReadableSpan[] = [];
    const policy = filteringProcessor({ onStart() {}, onEnd: (s) => void out.push(s), forceFlush: async () => {}, shutdown: async () => {} });
    for (const s of spans) policy.onEnd(s);
    expect(out).toHaveLength(spans.length);
    for (const s of out) expect(JSON.stringify({ attributes: s.attributes, status: s.status, events: s.events })).not.toMatch(new RegExp(MARKER, 'i'));

    // Reading the session back replays its journal: no new spans.
    const count = exporter.getFinishedSpans().length;
    const again = await open(await openWorldStorage(storage.sessionId, { name: 'otel-own-code' }));
    await again.close(ctx);
    await integration.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(count);
  });

  it('a turn a wake finishes traces with the audience the session recorded, in the same trace', async () => {
    const work = gate('work');
    const app = piApp([fauxAssistantMessage([fauxToolCall('work', { text: MARKER })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Worked.')])], [work.tool]);
    // resumeWith's audience is only for sessions that recorded none: this one recorded private.
    const open = resumeWith(app.open, { name: 'otel-wake', traceAudience: 'public' });
    const storage = await openWorldStorage(undefined, { name: 'otel-wake', traceAudience: 'private' });
    const harness = await open(storage);
    await (await harness.root(ctx, { agent: app.agent })).submit({ type: 'input', content: `work on ${MARKER}` }, ctx);
    await until(() => work.started() === 1);
    // Closing mid-turn hands the session to a wake, which reruns the safe tool and finishes the turn.
    await harness.close(ctx);
    work.release();
    const reader = openWorldReader(storage.sessionId);
    await until(async () => {
      await reader.refresh();
      const s = await reader.snapshot();
      return !s.unfinished && JSON.stringify(s.entries).includes('Worked.');
    });
    const turns = await until(async () => {
      await integration.forceFlush();
      const r = roots(spansOf(storage.sessionId));
      return r.some((s) => s.attributes['agent.turn.outcome'] === 'completed') ? r : undefined;
    });
    // The request's root ends running (it closed with work left); the wake's completes the turn.
    expect(turns.map((s) => s.attributes['agent.turn.outcome'])).toEqual(['running', 'completed']);
    expect(turns.every((s) => s.attributes['agent.channel.audience'] === 'private')).toBe(true);
    const spans = spansOf(storage.sessionId);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(spans.filter((s) => s.name === 'execute_tool work').length).toBeGreaterThanOrEqual(1);
  });

  it("a wake of a session that recorded no audience uses resumeWith's", async () => {
    const work = gate('slow');
    const app = piApp([fauxAssistantMessage([fauxToolCall('slow', { text: MARKER })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Slow done.')])], [work.tool]);
    const open = resumeWith(app.open, { name: 'otel-wake-default', traceAudience: 'unknown' });
    const storage = await openWorldStorage(undefined, { name: 'otel-wake-default' });
    const harness = await open(storage);
    await (await harness.root(ctx, { agent: app.agent })).submit({ type: 'input', content: 'go' }, ctx);
    await until(() => work.started() === 1);
    await harness.close(ctx);
    work.release();
    const turns = await until(async () => {
      await integration.forceFlush();
      const r = roots(spansOf(storage.sessionId));
      return r.some((s) => s.attributes['agent.turn.outcome'] === 'completed') ? r : undefined;
    });
    // The request's storage had no audience: the integration's (public). The wake's: resumeWith's.
    expect(turns.map((s) => [s.attributes['agent.turn.outcome'], s.attributes['agent.channel.audience']])).toEqual([
      ['running', 'public'],
      ['completed', 'unknown'],
    ]);
  });

  it("chatRoute's sessions are public on a public route, unknown on an authorized one, and an explicit audience wins", async () => {
    const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const cases = [
      { name: 'otel-chat-public', options: { authorize: 'public' as const }, audience: 'public' },
      { name: 'otel-chat-auth', options: { authorize: async () => true }, audience: 'unknown' },
      { name: 'otel-chat-private', options: { authorize: 'public' as const, traceAudience: 'private' as const }, audience: 'private' },
    ];
    for (const c of cases) {
      const app = piApp(shoutTurn(), [shout]);
      const open = resumeWith(app.open, { name: c.name });
      const route = chatRoute({ open, agent: app.agent, name: c.name, ...c.options });
      const res = await route.POST(post({ text: `shout ${MARKER}` }));
      expect(res.status).toBe(200);
      const sessionId = res.headers.get('x-session-id')!;
      await res.text();
      const [turn] = await until(async () => {
        await integration.forceFlush();
        const r = roots(spansOf(sessionId));
        return r.length ? r : undefined;
      });
      expect([c.name, turn!.attributes['agent.channel.audience']]).toEqual([c.name, c.audience]);
      expect(spansOf(sessionId).some((s) => s.name === 'execute_tool shout')).toBe(true);
    }
  }, 60_000);

  it('Pi\'s coding tools on a virtual workspace (CodingTools, virtualEnv) trace as tool spans, with what the model saw', async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: MARKER })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat note.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Read it.')]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(CodingTools);
    const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry, env: virtualEnv() }, ctx), { name: 'otel-coding-tools' });
    const storage = await openWorldStorage(undefined, { name: 'otel-coding-tools', traceAudience: 'public' });
    const harness = await open(storage);
    const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    expect((await (await root.submit({ type: 'input', content: 'write and read' }, ctx)).wait(ctx)).status).toBe('done');
    await harness.close(ctx);
    await integration.forceFlush();
    const spans = spansOf(storage.sessionId);
    const write = spans.find((s) => s.name === 'execute_tool write')!;
    const bash = spans.find((s) => s.name === 'execute_tool bash')!;
    expect(String(write.attributes['gen_ai.tool.call.arguments'])).toContain(MARKER);
    expect(String(bash.attributes['gen_ai.tool.call.result'])).toContain(MARKER);
    expect(roots(spans)).toHaveLength(1);
  });
});
