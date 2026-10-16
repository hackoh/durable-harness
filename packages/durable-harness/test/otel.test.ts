import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { INSTRUMENTATION, instrumentation } from 'harness-world/instrumentation';
import type { DriveContext } from 'harness-world';
import type { World } from '@workflow/world';
import { Fatal, Yield } from 'harness-world';
import { agentRuns } from '../src/instrumentation/otel.ts';

const requestContext = Symbol.for('@vercel/request-context');
afterEach(() => { delete (globalThis as any)[INSTRUMENTATION]; delete (globalThis as any)[requestContext]; });
function setup(options: Parameters<typeof agentRuns>[0] = {}) {
  const exporter = new InMemorySpanExporter();
  const integration = agentRuns({ audience: 'public', ...options, spanProcessors: [new SimpleSpanProcessor(exporter)] });
  integration.register();
  return { exporter, integration };
}
function ctx(sessionId = 'wrun_test', memo = false): DriveContext {
  const submission = { id: 'submission_1', text: 'private prompt', kind: 'prompt', receivedAt: new Date() };
  return {
    runId: sessionId, signal: new AbortController().signal, config: {}, attempt: 0,
    pending: () => [submission], state: () => ({ submissions: [submission] }),
    effect: async (key: string, _options: unknown, fn: any) => memo ? 'memoized' : fn({ stepId: key }),
  } as unknown as DriveContext;
}
describe('Agent Runs', () => {
  it('writes Eve-compatible Workflow visibility metadata after applying the export policy', async () => {
    const writes: { runId: string; attributes: Record<string, string | null>; reserved?: boolean }[] = [];
    const world = { runs: { async experimentalSetAttributes(runId: string, changes: { key: string; value: string | null }[], options: { allowReservedAttributes?: boolean }) {
      writes.push({ runId, attributes: Object.fromEntries(changes.map(c => [c.key, c.value])), reserved: options.allowReservedAttributes });
      return { attributes: {} };
    } } } as unknown as World;
    const { integration } = setup({ exportPolicy: { span: ({ audience }) => audience === 'public' ? { emit: true } : { redact: true, inputs: true, outputs: true } } });
    const publicScope = instrumentation()!.session('public', 'pi', 'turn', 'Public title', 'public', world);
    publicScope.start('model', { model: 'test' }).end({ role: 'assistant', content: 'public output' });
    publicScope.end();
    await publicScope.flush?.();
    const privateScope = instrumentation()!.session('private', 'pi', 'turn', 'Private title', 'private', world);
    privateScope.start('model', { model: 'test' }).end({ role: 'assistant', content: 'private output' });
    privateScope.end();
    await integration.forceFlush();
    expect(writes[0]).toMatchObject({ runId: 'public', reserved: true, attributes: {
      '$eve.type': 'session', '$eve.is_otel_trace_enabled': 'true', '$eve.is_trace_content_visible': 'true', '$eve.title': 'Public title',
      'agent.framework.name': 'durable-harness',
    } });
    expect(writes[0].attributes['$eve.trace_id']).toMatch(/^[a-f0-9]{32}$/);
    expect(writes[1].attributes).toMatchObject({ '$eve.is_trace_content_visible': 'false', '$eve.title': null });
    expect(JSON.stringify(writes)).not.toContain('Private title');
    expect(JSON.stringify(writes)).not.toContain('private output');
    expect(JSON.stringify(writes)).not.toContain('public output');
  });
  it('awaits Workflow metadata for every turn in a drive and tolerates a metadata destination failure', async () => {
    const written: string[] = [];
    const world = { runs: { async experimentalSetAttributes(runId: string) {
      await Promise.resolve(); written.push(runId); throw new Error('metadata unavailable');
    } } } as unknown as World;
    setup();
    const c = ctx('metadata');
    const second = { ...c.pending()[0], id: 'submission_2', text: 'next' };
    await expect(instrumentation()!.drive({ name: 'fx', async drive(c) {
      await c.effect('first', { name: 'model', replay: 'safe', input: {}, placed: ['submission_1'] }, async () => 'done');
      await c.effect('next', { name: 'model', replay: 'safe', input: {}, placed: ['submission_2'] }, async () => 'done');
    } }, { ...c, world, state: () => ({ ...c.state(), submissions: [...c.state().submissions, second] }) })).resolves.toBeUndefined();
    expect(written).toEqual(['metadata', 'metadata']);
  });
  it('emits the deployed warehouse v4 contract with canonical step usage and nested model/tool spans', async () => {
    const { exporter, integration } = setup();
    await instrumentation()!.drive({ name: 'pi', async drive(c) {
      await c.effect('model:1', { name: 'model', replay: 'safe', input: { model: 'anthropic/test', appended: [{ role: 'user', content: 'hello' }] } }, async () => ({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 12, output: 4 } }));
      await c.effect('tool:1', { name: 'tool.read', replay: 'safe', input: { path: 'a.txt' } }, async () => 'file contents');
    } }, ctx());
    await integration.forceFlush();
    const spans = exporter.getFinishedSpans();
    const root = spans.find(s => s.name === 'invoke_agent pi')!;
    expect(root.attributes).toMatchObject({ 'agent.framework.name': 'durable-harness', 'agent.run.id': 'wrun_test', 'vercel.session_id': 'wrun_test', 'agent.trace.schema.version': 4, 'agent.turn.id': 'submission_1', 'agent.turn.outcome': 'completed' });
    expect(spans.every(s => s.instrumentationScope.name === 'eve.agent')).toBe(true);
    expect(spans.every(s => s.spanContext().traceId === root.spanContext().traceId)).toBe(true);
    const model = spans.find(s => s.name === 'chat anthropic/test')!;
    expect(JSON.parse(model.attributes['gen_ai.output.messages'] as string)[0].parts[0]).toEqual({ type: 'text', content: 'hi' });
    expect(spans.find(s => s.spanContext().spanId === model.parentSpanContext?.spanId)?.attributes['agent.usage.input_tokens']).toBe(12);
    expect(spans.find(s => s.name === 'execute_tool read')!.attributes['gen_ai.tool.call.result']).toBe('"file contents"');
  });
  it('does not emit model/tool spans for memoized work and preserves session trace identity across invocations', async () => {
    const { exporter } = setup();
    const harness = { name: 'test', async drive(c: DriveContext) { await c.effect('done', { name: 'tool.read', replay: 'safe', input: {} }, async () => 'new'); } };
    await instrumentation()!.drive(harness, ctx('same', true));
    await instrumentation()!.drive(harness, ctx('same', true));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
    const a = instrumentation()!.session('same', 'test', 'turn'); a.end();
    const b = instrumentation()!.session('same', 'test', 'turn'); b.end();
    const roots = exporter.getFinishedSpans();
    expect(roots[0].spanContext().traceId).toBe(roots[1].spanContext().traceId);
    expect(roots[0].spanContext().spanId).not.toBe(roots[1].spanContext().spanId);
  });
  it('redacts inputs, outputs and status messages for unknown audiences', async () => {
    const { exporter } = setup({ audience: 'unknown' });
    const scope = instrumentation()!.session('private', 'codex', 'turn', 'private title');
    scope.start('tool.bash', { command: 'secret' }).end('secret result', new Error('secret error'));
    scope.end();
    for (const span of exporter.getFinishedSpans()) {
      expect(JSON.stringify({ attributes: span.attributes, status: span.status })).not.toContain('secret');
      expect(span.attributes['agent.trace.content.input']).toBe(false);
      expect(span.attributes['agent.trace.content.output']).toBe(false);
      expect(span.attributes['agent.session.title']).toBeUndefined();
    }
  });
  it('drops spans when a policy throws, and can replace attributes', () => {
    const a = setup({ exportPolicy: { span() { throw new Error('no'); } } });
    instrumentation()!.session('one', 'pi', 'turn').end();
    expect(a.exporter.getFinishedSpans()).toHaveLength(0);
    const b = setup({ exportPolicy: { attribute: ({ key }) => key === 'agent.name' ? { replace: true, value: 'custom' } : { emit: true } } });
    instrumentation()!.session('two', 'pi', 'turn').end();
    expect(b.exporter.getFinishedSpans()[0].attributes['agent.name']).toBe('custom');
  });
  it('keeps budget continuations running and creates no trace for idle drives', async () => {
    const { exporter } = setup();
    const c = ctx();
    const abort = new AbortController();
    const reason = Object.assign(new Error('budget'), { name: 'Yield' });
    const harness = { name: 'pi', async drive(c: DriveContext) {
      c.instrumentation!.start('model', { model: 'test' }).end({ usage: { input: 4, output: 2, cacheRead: 100 } });
      abort.abort(reason); throw reason;
    } };
    await expect(instrumentation()!.drive(harness, { ...c, signal: abort.signal })).rejects.toBe(reason);
    const root = exporter.getFinishedSpans().find(s => s.name.startsWith('invoke_agent'))!;
    expect(root.attributes['agent.turn.outcome']).toBe('running');
    expect(root.status.code).not.toBe(2);
    expect(exporter.getFinishedSpans().find(s => s.name === 'agent.step')!.attributes['agent.usage.input_tokens']).toBe(104);
    const count = exporter.getFinishedSpans().length;
    await instrumentation()!.drive({ name: 'pi', async drive() {} }, c);
    expect(exporter.getFinishedSpans()).toHaveLength(count);
  });
  it('splits fresh prompt turns but keeps one session trace identity', async () => {
    const { exporter } = setup();
    const c = ctx();
    const second = { ...c.pending()[0], id: 'submission_2', text: 'second prompt' };
    const state = { ...c.state(), submissions: [...c.state().submissions, second] };
    await instrumentation()!.drive({ name: 'fx', async drive(c) {
      await c.effect('one', { name: 'model', replay: 'safe', input: { model: 'test' }, placed: ['submission_1'] }, async () => ({}));
      await c.effect('two', { name: 'model', replay: 'safe', input: { model: 'test' }, placed: ['submission_2'] }, async () => ({}));
    } }, { ...c, state: () => state });
    const roots = exporter.getFinishedSpans().filter(s => s.name.startsWith('invoke_agent'));
    expect(roots.map(s => s.attributes['agent.turn.id'])).toEqual(['submission_1', 'submission_2']);
    expect(roots[0].spanContext().traceId).toBe(roots[1].spanContext().traceId);
  });
  it.each(['halt', 'throw'] as const)('marks a fatal %s as failed even when the drive is aborted', async (mode) => {
    const { exporter } = setup();
    const abort = new AbortController();
    const fatal = new Fatal('incompatible session log');
    const thrown = mode === 'halt' ? new Error('child aborted') : fatal;
    await expect(instrumentation()!.drive({ name: 'test', async drive(c) {
      c.instrumentation!.start('model', { model: 'test' });
      abort.abort(mode === 'halt' ? fatal : new Yield('budget'));
      throw thrown;
    } }, { ...ctx(), signal: abort.signal })).rejects.toBe(thrown);
    const spans = exporter.getFinishedSpans();
    const root = spans.find(s => s.name.startsWith('invoke_agent'))!;
    expect(root.attributes['agent.turn.outcome']).toBe('failed');
    expect(root.status).toMatchObject({ code: 2, message: fatal.message });
    expect(spans.find(s => s.name === 'chat test')!.status.code).toBe(2);
  });
  it('normalizes Gateway v4 and OpenAI Responses usage and content', () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('sse', 'fx', 'turn');
    scope.start('model', { model: 'test' }).end({ responseBody: [
      { type: 'tool-call', toolName: 'read', toolCallId: 'call_1', input: '{}' },
      { type: 'text-delta', delta: 'hello' },
      { type: 'finish', usage: { inputTokens: { total: 104, cacheRead: 100 }, outputTokens: { total: 2 } }, providerMetadata: { gateway: { gatewayCost: '0.01' } } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') });
    scope.start('model', { model: 'openai' }).end({ responseBody: 'data: {"type":"response.output_text.delta","delta":"response text"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n' });
    scope.end();
    const steps = exporter.getFinishedSpans().filter(s => s.name === 'agent.step');
    expect(new Set(steps.map(s => s.attributes['agent.step.id'])).size).toBe(2);
    expect(steps[0].attributes).toMatchObject({ 'agent.usage.input_tokens': 104, 'agent.usage.output_tokens': 2, 'gen_ai.usage.gateway_cost': 0.01 });
    // The model span: the same inclusive input with its cached part, as Agent Runs reads gen_ai usage.
    expect(exporter.getFinishedSpans().find(s => s.name === 'chat test')!.attributes)
      .toMatchObject({ 'gen_ai.usage.input_tokens': 104, 'gen_ai.usage.cache_read.input_tokens': 100, 'gen_ai.usage.output_tokens': 2 });
    expect(steps[1].attributes['agent.usage.input_tokens']).toBe(12);
    expect(JSON.stringify(exporter.getFinishedSpans().map(s => s.attributes))).toContain('response text');
  });
  it('captures Gateway prompt messages and Responses inputs supplied when a proxy call ends', () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('wire-inputs', 'test', 'turn');
    scope.start('model', {}).end({ requestBody: { model: 'gateway', prompt: [
      { role: 'user', content: [{ type: 'text', text: 'List 世界' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', output: { type: 'text', value: 'a.txt' } }] },
    ] } });
    scope.start('model', {}).end({ requestBody: { model: 'responses', instructions: 'System context', input: [
      { role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
      { type: 'function_call', call_id: 'call', name: 'shell', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call', output: 'a.txt' },
    ] } });
    scope.start('model', { requestBody: { model: 'responses', input: 'String input' } }).end();
    scope.end();
    const models = exporter.getFinishedSpans().filter(s => s.attributes['gen_ai.operation.name'] === 'chat');
    const inputs = models.map(s => JSON.parse(s.attributes['gen_ai.input.messages'] as string));
    expect(inputs[0]).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'List 世界' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call', response: 'a.txt' }] },
    ]);
    expect(inputs[1]).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'List files' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call', name: 'shell', arguments: '{"command":"ls"}' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call', response: 'a.txt' }] },
    ]);
    expect(models[1].attributes['gen_ai.system_instructions']).toBe('"System context"');
    expect(inputs[2]).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'String input' }] }]);
  });
  it('reassembles interleaved Anthropic streamed tool arguments by content block', () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('anthropic-tools', 'claude-code', 'turn');
    scope.start('model', { model: 'anthropic/test' }).end({ responseBody: [
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read_1', name: 'read', input: {} } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read_2', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"b.txt"}' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"世界.txt"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 2 },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') });
    scope.end();
    const model = exporter.getFinishedSpans().find(s => s.name.startsWith('chat '))!;
    expect(JSON.parse(model.attributes['gen_ai.output.messages'] as string)[0].parts).toEqual([
      { type: 'tool_call', id: 'read_1', name: 'read', arguments: { path: '世界.txt' } },
      { type: 'tool_call', id: 'read_2', name: 'read', arguments: { path: 'b.txt' } },
    ]);
  });
  it('preserves incomplete Anthropic arguments without failing the export', () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('partial-tools', 'claude-code', 'turn');
    scope.start('model', { model: 'anthropic/test' }).end({ responseBody: [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"partial' } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') });
    scope.end();
    const model = exporter.getFinishedSpans().find(s => s.name.startsWith('chat '))!;
    expect(JSON.parse(model.attributes['gen_ai.output.messages'] as string)[0].parts[0].arguments).toBe('{"path":"partial');
  });
  it("gives a tool span the id the model gave its call, so Agent Runs shows one tool call", () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('tool-ids', 'test', 'turn');
    const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    // Claude Code, Pi, OpenCode, the AI SDK: the effect is keyed `tool:<call id>`.
    scope.start('model', { model: 'anthropic/test' }).end({ responseBody: sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
    ]) });
    scope.start('tool.read', { path: 'a.txt' }, 'tool:toolu_1').end('a');
    // The fx kernel keys a call by position and input, pi-durable by its task: matched by name and arguments.
    scope.start('model', { model: 'test' }).end({ responseBody: sse([
      { type: 'tool-call', toolName: 'write_file', toolCallId: 'call_w', input: '{"path":"b.txt","content":"hi"}' },
    ]) });
    scope.start('tool.write_file', { content: 'hi', path: 'b.txt' }, 'tool:1:write_file:0123:0').end('ok');
    // Codex: an OpenAI Responses stream names its function calls in output items.
    scope.start('model', { model: 'openai/test' }).end({ responseBody: sse([
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_r', name: 'shell', arguments: '{"command":"ls"}' } },
    ]) });
    scope.start('tool.shell', { command: 'ls' }, 'tool:call_r').end('a.txt');
    // No model call asked for it: the key, less its prefix.
    scope.start('tool.read', { path: 'c.txt' }, 'tool:orphan').end('c');
    scope.end();
    const spans = exporter.getFinishedSpans();
    expect(spans.filter(s => s.attributes['gen_ai.operation.name'] === 'execute_tool').map(s => s.attributes['gen_ai.tool.call.id']))
      .toEqual(['toolu_1', 'call_w', 'call_r', 'orphan']);
    const codex = spans.filter(s => s.attributes['gen_ai.operation.name'] === 'chat')[2]!;
    expect(JSON.parse(codex.attributes['gen_ai.output.messages'] as string)[0].parts)
      .toEqual([{ type: 'tool_call', id: 'call_r', name: 'shell', arguments: '{"command":"ls"}' }]);
    // The durable step keeps the effect's key.
    expect(spans.filter(s => s.name === 'agent.step').map(s => s.attributes['agent.step.id'])).toContain('tool:1:write_file:0123:0');
  });
  it('exports using the initiating Vercel request context even when a loopback callback has no context', () => {
    const reported: any[] = [];
    (globalThis as any)[requestContext] = { get: () => ({ telemetry: { reportSpans: (data: unknown) => reported.push(data) } }) };
    setup();
    const scope = instrumentation()!.session('callback', 'opencode', 'turn');
    delete (globalThis as any)[requestContext];
    scope.start('model', {}).end({ requestBody: { model: 'test', messages: [{ role: 'user', content: 'hi' }] }, responseBody: 'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' });
    scope.end();
    expect(reported).toHaveLength(3);
    expect(JSON.stringify(reported)).toContain('hello');
    expect(JSON.stringify(reported)).toContain('agent.usage.input_tokens');
  });
  it('keeps the proxy model ID when Gateway request bodies contain only prompt options', () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('gateway-model', 'opencode', 'turn');
    scope.start('model', { method: 'POST', path: '/v3/ai/language-model', model: 'anthropic/claude-haiku-4.5' }).end({
      requestBody: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      responseBody: 'data: {"type":"response-metadata","modelId":"claude-haiku-4-5-20251001"}\n\ndata: {"type":"text-delta","delta":"hi"}\n\n',
    });
    scope.end();
    const spans = exporter.getFinishedSpans();
    const model = spans.find(s => s.attributes['gen_ai.operation.name'] === 'chat')!;
    expect(model.name).toBe('chat anthropic/claude-haiku-4.5');
    expect(model.attributes).toMatchObject({ 'gen_ai.request.model': 'anthropic/claude-haiku-4.5', 'gen_ai.response.model': 'claude-haiku-4-5-20251001' });
    expect(spans.find(s => s.name === 'agent.step')!.attributes['agent.model.id']).toBe('anthropic/claude-haiku-4.5');
    expect(JSON.parse(model.attributes['gen_ai.input.messages'] as string)).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]);
  });
  it("names a Gateway model by its Gateway id, without pi-ai's provider prefix", () => {
    const { exporter } = setup();
    const scope = instrumentation()!.session('pi-gateway', 'pi', 'turn');
    scope.start('model', { model: 'vercel-ai-gateway/anthropic/claude-haiku-4.5' }).end({ role: 'assistant', content: 'hi' });
    scope.start('model', {}).end({ requestBody: { model: 'vercel-ai-gateway/openai/gpt-5.4-mini' } });
    scope.end();
    const spans = exporter.getFinishedSpans();
    expect(spans.filter(s => s.name.startsWith('chat ')).map(s => s.name)).toEqual(['chat anthropic/claude-haiku-4.5', 'chat openai/gpt-5.4-mini']);
    expect(spans.filter(s => s.name === 'agent.step').map(s => s.attributes['agent.model.id'])).toEqual(['anthropic/claude-haiku-4.5', 'openai/gpt-5.4-mini']);
  });
  it('keeps agent work successful when an additional trace destination throws', async () => {
    const integration = agentRuns({ spanProcessors: [{
      onStart() { throw new Error('destination unavailable'); },
      onEnd() { throw new Error('destination unavailable'); },
      async forceFlush() {}, async shutdown() {},
    }] });
    integration.register();
    await expect(instrumentation()!.drive({ name: 'test', async drive(c) {
      expect(await c.effect('read', { name: 'tool.read', replay: 'safe', input: {} }, async () => 'file contents')).toBe('file contents');
    } }, ctx())).resolves.toBeUndefined();
  });
});
