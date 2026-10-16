import { createHash, randomBytes } from 'node:crypto';
import { ROOT_CONTEXT, createContextKey, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { BasicTracerProvider, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { INSTRUMENTATION, type InstrumentationRuntime, type TraceOperation, type TraceScope } from 'harness-world/instrumentation';
// Fatal from its own module: from the kernel's index it would load the driver.
import { Fatal } from 'harness-world/errors';
import type { DriveContext, Harness } from 'harness-world';
import type { World } from '@workflow/world';

export type Audience = 'public' | 'private' | 'unknown';
export interface SpanExportContext {
  readonly audience: Audience;
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: Readonly<Attributes>;
}
export type SpanExportDecision = { readonly emit: boolean } | { readonly redact: true; readonly inputs?: boolean; readonly outputs?: boolean };
export interface SpanExportPolicy {
  readonly span?: (span: SpanExportContext) => SpanExportDecision;
  readonly attribute?: (input: { key: string; value: unknown; span: SpanExportContext }) =>
    { readonly emit: boolean } | { readonly replace: true; readonly value: NonNullable<Attributes[string]> };
}
export interface AgentRunsOptions {
  readonly exportPolicy?: SpanExportPolicy;
  /** Default for sessions without an explicit audience. Defaults to unknown (content hidden). */
  readonly audience?: Audience;
  readonly serviceName?: string;
  /** Additional destinations, with the same content policy applied. */
  readonly spanProcessors?: readonly SpanProcessor[];
}
export interface AgentRunsIntegration {
  /** Call from the host's instrumentation register hook, once per process. */
  register(): void;
  forceFlush(): Promise<void>;
}

/**
 * OpenTelemetry's SDK, which records and serializes the spans, at the versions
 * this module is tested with. Optional peer dependencies, which nothing but
 * `agentRuns()` loads: the harnesses emit through `@opentelemetry/api` alone
 * (a dependency), whose spans are no-ops until a provider is registered. A
 * test keeps these equal to package.json's.
 */
const OTEL_SDK_PINS = {
  '@opentelemetry/sdk-trace-base': '2.2.0',
  '@opentelemetry/resources': '2.2.0',
  '@opentelemetry/otlp-transformer': '0.208.0',
} as const;
/** The install line for OpenTelemetry's SDK. */
const OTEL_SDK_INSTALL = `pnpm add ${Object.entries(OTEL_SDK_PINS).map(([name, version]) => `${name}@${version}`).join(' ')}`;

/**
 * The SDK, loaded when this module is, or why it isn't there. Any other
 * failure to load it fails the import, as a static import would.
 */
const sdk = await Promise.all([
  import('@opentelemetry/sdk-trace-base'),
  import('@opentelemetry/resources'),
  import('@opentelemetry/otlp-transformer'),
]).then(
  ([traceBase, resources, transformer]) => ({
    BasicTracerProvider: traceBase.BasicTracerProvider,
    resourceFromAttributes: resources.resourceFromAttributes,
    JsonTraceSerializer: transformer.JsonTraceSerializer,
  }),
  (error: unknown) => {
    const missing = missingPackage(error);
    if (!missing) throw error;
    return { missing: new Error(`durable-harness/instrumentation/otel: agentRuns() exports spans with OpenTelemetry's SDK, optional peer dependencies of durable-harness, and ${missing} is not installed. Install them: ${OTEL_SDK_INSTALL}`, { cause: error }) };
  }
);
/** Which of the SDK's packages `error` says could not be found, if it says so (on it or its causes). */
function missingPackage(error: unknown): string | undefined {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND' && !/Cannot find (?:package|module)/.test(String(message))) continue;
    const name = Object.keys(OTEL_SDK_PINS).find((n) => String(message).includes(n));
    if (name) return name;
  }
  return undefined;
}
function requireSdk() {
  if ('missing' in sdk) throw sdk.missing;
  return sdk;
}

const REPORTER = createContextKey('durable-harness.report-spans');
type Reporter = (payload: unknown) => void;
interface ReportedSpan { __durableReporter?: Reporter; __durableMetadata?: (span: ReadableSpan) => void }
function requestReporter(): Reporter | undefined {
  const reader = (globalThis as Record<symbol, { get?: () => { telemetry?: { reportSpans?: Reporter } } } | undefined>)[Symbol.for('@vercel/request-context')];
  try {
    const telemetry = reader?.get?.()?.telemetry;
    return telemetry?.reportSpans?.bind(telemetry);
  } catch { return undefined; }
}
const INPUTS = new Set(['agent.session.title', 'agent.channel.delivery.input', 'gen_ai.input.messages', 'gen_ai.system_instructions', 'gen_ai.tool.definitions', 'gen_ai.tool.call.arguments', 'ai.prompt', 'ai.prompt.tools', 'ai.prompt.toolChoice']);
const OUTPUTS = new Set(['gen_ai.output.messages', 'gen_ai.tool.call.result', 'ai.response.text', 'ai.response.reasoning', 'ai.response.toolCalls', 'ai.response.tool_calls', 'ai.toolCall.args', 'ai.toolCall.result']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): string | undefined => {
  try { const s = JSON.stringify(value); return s && s.length <= 64_000 ? s : undefined; } catch { return undefined; }
};
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const audienceOf = (v: unknown): Audience => v === 'public' || v === 'private' ? v : 'unknown';

/**
 * Vercel's Agent Runs destination. Importing or declaring it performs no I/O.
 * Without OpenTelemetry's SDK installed (optional peer dependencies) it
 * throws, naming the install line.
 */
export function agentRuns(options: AgentRunsOptions = {}): AgentRunsIntegration {
  const { BasicTracerProvider: TracerProvider, resourceFromAttributes, JsonTraceSerializer } = requireSdk();
  let provider: BasicTracerProvider | undefined;
  let seed = '';
  const metadataWrites = new Set<Promise<void>>();
  return {
    register() {
      if (provider) return;
      const downstream = [vercelProcessor(JsonTraceSerializer), ...(options.spanProcessors ?? [])];
      provider = new TracerProvider({
        resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'durable-harness', 'agent.framework.name': 'durable-harness' }),
        idGenerator: {
          generateTraceId: () => seed || randomBytes(16).toString('hex'),
          generateSpanId: () => randomBytes(8).toString('hex'),
        },
        spanLimits: { attributeValueLengthLimit: 64_000, attributeCountLimit: 128 },
        spanProcessors: downstream.map(p => filteringProcessor(p, options.exportPolicy)),
      });
      // The deployed warehouse currently selects this scope explicitly. The
      // framework identity stays durable-harness; this is the v4 wire contract.
      const tracer = provider.getTracer('eve.agent', '4');
      const session = (sessionId: string, harness: string, turnId: string, input?: unknown, audience = audienceOf(options.audience), world?: World): TraceScope => {
        seed = hash(`durable-harness:${sessionId}`).slice(0, 32);
        const common: Attributes = {
          'agent.framework.name': 'durable-harness', 'agent.name': harness,
          'gen_ai.agent.name': harness, 'agent.run.id': sessionId, 'agent.run.type': 'session',
          'gen_ai.conversation.id': sessionId, 'vercel.session_id': sessionId,
          'agent.trace.schema.version': 4, 'agent.turn.id': turnId,
          'agent.channel.audience': audience, 'agent.channel.kind': 'http',
          'agent.session.origin': 'channel', 'agent.trace.content.input': true, 'agent.trace.content.output': true,
        };
        const report = requestReporter();
        const rootContext = report ? ROOT_CONTEXT.setValue(REPORTER, report) : ROOT_CONTEXT;
        const root = tracer.startSpan(`invoke_agent ${harness}`, { root: true, attributes: { ...common, 'gen_ai.operation.name': 'invoke_agent' } }, rootContext);
        (root as Span & ReportedSpan).__durableReporter = report;
        let metadataWrite: Promise<void> | undefined;
        if (world?.runs.experimentalSetAttributes) {
          (root as Span & ReportedSpan).__durableMetadata = (filtered) => {
            // Front still reads Eve's Workflow metadata for schema-4 content
            // visibility and discovery. These are compatibility tags, not
            // content storage or a claim that the harness framework is Eve.
            const visible = filtered.attributes['agent.trace.content.input'] === true
              && filtered.attributes['agent.trace.content.output'] === true;
            const title = filtered.attributes['agent.session.title'];
            const attributes: Record<string, string | null> = {
              '$eve.type': 'session', '$eve.is_otel_trace_enabled': 'true',
              '$eve.is_trace_content_visible': String(visible),
              '$eve.trace_id': filtered.spanContext().traceId, '$eve.trigger': 'http',
              '$eve.title': typeof title === 'string' ? title : null,
              'agent.framework.name': 'durable-harness', 'agent.name': harness,
            };
            metadataWrite = Promise.resolve().then(() => world.runs.experimentalSetAttributes!(sessionId,
              Object.entries(attributes).map(([key, value]) => ({ key, value })), { allowReservedAttributes: true }
            )).then(() => {}, () => { console.warn('durable-harness: Agent Runs Workflow metadata export failed'); });
            metadataWrites.add(metadataWrite);
            void metadataWrite.then(() => metadataWrites.delete(metadataWrite!));
          };
        }
        seed = '';
        root.addEvent('turn.started');
        const inputText = json(input);
        if (inputText) root.setAttribute('agent.channel.delivery.input', inputText);
        const title = typeof input === 'string' ? input : record(input).content;
        if (typeof title === 'string') root.setAttribute('agent.session.title', title.slice(0, 160));
        const parent = trace.setSpan(rootContext, root);
        const open = new Set<TraceOperation>();
        let closed = false;
        let stepIndex = 0;
        // The tool calls this turn's model responses asked for, not yet run.
        // A tool span takes its call's id, so Agent Runs shows the model's
        // call and its execution as one tool call.
        const asked: { id: string; name: string; args: string }[] = [];
        return {
          async flush() { await metadataWrite; },
          start(name, input, key) {
            const model = name === 'model';
            const tool = name.startsWith('tool.');
            const data = record(input);
            const requestData = record(data.requestBody ?? data.request);
            const requestModel = data.model ?? requestData.model;
            const modelId = typeof requestModel === 'string' ? gatewayModelId(requestModel) : 'unknown';
            const operation = model ? 'chat' : tool ? 'execute_tool' : 'step';
            const stepId = key ?? randomBytes(16).toString('hex');
            const step = tracer.startSpan('agent.step', { attributes: { ...common, 'agent.step.id': stepId, 'agent.step.index': stepIndex++, 'agent.step.attempt': 1, ...(model ? { 'agent.model.id': modelId } : {}) } }, parent);
            const span = tracer.startSpan(model ? `chat ${modelId}` : tool ? `execute_tool ${name.slice(5)}` : name, {
              kind: model ? SpanKind.CLIENT : SpanKind.INTERNAL,
              attributes: { ...common, 'gen_ai.operation.name': operation, ...(model ? { 'gen_ai.request.model': modelId } : {}), ...(tool ? { 'gen_ai.tool.name': name.slice(5), 'gen_ai.tool.call.id': toolCallId(asked, name.slice(5), input, stepId) } : {}) },
            }, trace.setSpan(parent, step));
            (step as Span & ReportedSpan).__durableReporter = report;
            (span as ReportedSpan).__durableReporter = report;
            if (model) {
              setJson(span, 'gen_ai.input.messages', messages(data.messages ?? data.appended ?? requestMessages(requestData)));
              if (requestData.system ?? requestData.instructions) setJson(span, 'gen_ai.system_instructions', requestData.system ?? requestData.instructions);
              if (requestData.tools) setJson(span, 'gen_ai.tool.definitions', requestData.tools);
            }
            else if (tool) setJson(span, 'gen_ai.tool.call.arguments', input);
            let ended = false;
            const handle: TraceOperation = { end(output, error) {
              if (ended) return;
              ended = true; open.delete(handle);
              if (model) {
                const result = modelResponse(output);
                const request = record(record(output).requestBody ?? data.requestBody ?? data.request);
                if (request.model) { const id = gatewayModelId(String(request.model)); span.setAttribute('gen_ai.request.model', id); step.setAttribute('agent.model.id', id); span.updateName(`chat ${id}`); }
                const prompt = requestMessages(request);
                if (prompt !== undefined) setJson(span, 'gen_ai.input.messages', messages(prompt));
                if (request.system ?? request.instructions) setJson(span, 'gen_ai.system_instructions', request.system ?? request.instructions);
                if (result.model) span.setAttribute('gen_ai.response.model', String(result.model));
                const reply = messages([result.message ?? result], 'assistant');
                setJson(span, 'gen_ai.output.messages', reply);
                for (const part of reply.flatMap(m => record(m).parts as unknown[] ?? [])) {
                  const call = record(part);
                  if (call.type === 'tool_call' && typeof call.id === 'string' && typeof call.name === 'string') asked.push({ id: call.id, name: call.name, args: canonical(call.arguments) });
                }
                usage(span, step, result.usage ?? record(result.message).usage);
                const gatewayCost = record(record(result.providerMetadata).gateway).gatewayCost;
                if (gatewayCost !== undefined && Number.isFinite(Number(gatewayCost))) {
                  step.setAttribute('gen_ai.usage.gateway_cost', Number(gatewayCost));
                  span.setAttribute('gen_ai.usage.gateway_cost', Number(gatewayCost));
                }
              } else if (tool) setJson(span, 'gen_ai.tool.call.result', output);
              if (error !== undefined) { fail(span, error); fail(step, error); }
              span.end(); step.end();
            } };
            open.add(handle);
            return handle;
          },
          end(error, requestedOutcome) {
            if (closed) return; closed = true;
            const outcome = requestedOutcome ?? (error === undefined ? 'completed' : 'failed');
            for (const operation of open) operation.end(undefined, outcome === 'failed' ? error : undefined);
            root.setAttribute('agent.turn.outcome', outcome);
            root.addEvent(`turn.${outcome}`);
            if (error !== undefined && outcome === 'failed') fail(root, error);
            root.end();
          },
        };
      };
      const runtime: InstrumentationRuntime = {
        session,
        async drive(harness: Harness, ctx: DriveContext) {
          let submission = ctx.pending().find(s => s.text !== undefined)
            ?? ctx.state().submissions.filter(s => s.text !== undefined).at(-1);
          let scope: TraceScope | undefined;
          const priorScopes: TraceScope[] = [];
          let currentTurn: string | undefined;
          const audience = audienceOf(record(ctx.config).traceAudience ?? options.audience);
          const finish = (error?: unknown) => {
            const state = ctx.state();
            const reason = error instanceof Fatal ? error : ctx.signal.aborted ? ctx.signal.reason : error;
            const name = record(reason).name;
            const outcome = state.status === 'cancelled' ? 'cancelled'
              : reason instanceof Fatal || state.status === 'failed' ? 'failed'
              : name === 'Yield' || name === 'Restart' || ctx.signal.aborted ? 'running'
              : reason !== undefined ? 'failed' : 'completed';
            scope?.end(reason, outcome);
          };
          const bridge: TraceScope = {
            start(name, input, key) {
              if (!submission) return { end() {} };
              if (scope && currentTurn !== submission.id) { scope.end(); priorScopes.push(scope); }
              if (!scope || currentTurn !== submission.id) {
                currentTurn = submission.id;
                scope = session(ctx.runId, harness.name, submission.id, submission.text, audience, ctx.world);
              }
              return scope.start(name, input, key);
            },
            end: (error, outcome) => scope?.end(error, outcome),
          };
          const wrapped: DriveContext = {
            ...ctx, instrumentation: bridge,
            effect(key, effect, fn) {
              // Placement follows durable turn identity, including memoized placement.
              // Steers belong to the open turn; a fresh prompt starts another one.
              const placed = ctx.state().submissions.find(s => effect.placed?.includes(s.id) && s.kind !== 'steer' && s.text !== undefined);
              if (placed) submission = placed;
              return ctx.effect(key, effect, async io => {
                // Process model proxy callbacks own their model spans. The
                // synthetic chaos effect only records crash/recovery facts.
                const proxyModel = effect.name === 'model' && (typeof record(effect.input).method === 'string' || record(effect.input).instrumentation === 'adapter');
                if (proxyModel || (effect.name !== 'model' && !effect.name.startsWith('tool.'))) return fn(io);
                const op = bridge.start(effect.name, effect.input, key);
                try { const result = await fn(io); op.end(result); return result; }
                catch (error) { op.end(undefined, ctx.signal.aborted ? undefined : error); throw error; }
              });
            },
          };
          try { await harness.drive(wrapped); finish(); }
          catch (error) { finish(error); throw error; }
          finally { await Promise.all([...priorScopes, ...(scope ? [scope] : [])].map(s => s.flush?.())); }
        },
      };
      (globalThis as { [INSTRUMENTATION]?: InstrumentationRuntime })[INSTRUMENTATION] = runtime;
    },
    async forceFlush() { await provider?.forceFlush(); await Promise.all([...metadataWrites]); },
  };
}

/** Arguments as comparable text: a model may send them as a JSON string or an object. */
function canonical(args: unknown): string {
  let value = args;
  if (typeof args === 'string') { try { value = JSON.parse(args); } catch { return args; } }
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value)) ?? '';
}
/**
 * A tool span's `gen_ai.tool.call.id`: the id the model gave the call, so
 * Agent Runs joins the call in the model's reply with its execution. Most
 * harnesses key a tool effect `tool:<call id>`; the fx kernel keys it by
 * position and input, and pi-durable by its task, so a call the model asked
 * for this turn is found by its id, else by name and arguments, else by name.
 * Without one, the key (less a `tool:` prefix).
 */
function toolCallId(asked: { id: string; name: string; args: string }[], name: string, input: unknown, key: string): string {
  const fromKey = key.startsWith('tool:') ? key.slice(5).split('@')[0]! : key;
  const args = canonical(input);
  const index = [
    (c: typeof asked[number]) => c.id === fromKey,
    (c: typeof asked[number]) => c.name === name && c.args === args,
    (c: typeof asked[number]) => c.name === name,
  ].reduce((found, test) => found >= 0 ? found : asked.findIndex(test), -1);
  if (index < 0) return fromKey;
  return asked.splice(index, 1)[0]!.id;
}
/** pi-ai names a Gateway model `vercel-ai-gateway/<id>`; every other harness, and the Gateway, name it `<id>`. */
function gatewayModelId(id: string): string { return id.startsWith('vercel-ai-gateway/') ? id.slice('vercel-ai-gateway/'.length) : id; }
function setJson(span: Span, key: string, value: unknown) { const s = json(value); if (s !== undefined) span.setAttribute(key, s); }
function fail(span: Span, error: unknown) { span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) }); }
function requestMessages(request: Record<string, unknown>): unknown { return request.messages ?? request.input ?? request.prompt; }
function messages(input: unknown, fallbackRole = 'user'): unknown[] {
  if (typeof input === 'string') input = [{ role: fallbackRole, content: input }];
  if (!Array.isArray(input)) return [];
  return input.map(m => {
    const v = record(m);
    if (v.type === 'function_call') return { role: 'assistant', parts: [{ type: 'tool_call', id: v.call_id, name: v.name, arguments: v.arguments }] };
    if (v.type === 'function_call_output') return { role: 'tool', parts: [{ type: 'tool_call_response', id: v.call_id, response: v.output }] };
    const content = v.content ?? v.text;
    const parts = typeof content === 'string' ? [{ type: 'text', content }] : Array.isArray(content) ? content.map(p => {
      const part = record(p);
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return { type: 'text', content: part.text ?? part.content };
      if (part.type === 'toolCall' || part.type === 'tool-call' || part.type === 'tool_use') return { type: 'tool_call', id: part.id ?? part.toolCallId, name: part.name ?? part.toolName, arguments: part.arguments ?? part.input ?? part.args };
      if (part.type === 'tool-result' || part.type === 'tool_result') {
        const output = part.output ?? part.result ?? part.content;
        return { type: 'tool_call_response', id: part.toolCallId ?? part.tool_use_id, response: record(output).value ?? output };
      }
      return part;
    }) : [];
    return { role: v.role === 'toolResult' ? 'tool' : v.role ?? fallbackRole, parts };
  });
}
function usage(span: Span, step: Span, input: unknown) {
  const u = record(input);
  const cacheRead = u.cacheRead ?? u.cacheReadTokens ?? u.cache_read_input_tokens ?? record(u.inputTokens).cacheRead ?? record(u.input_tokens_details).cached_tokens ?? record(u.prompt_tokens_details).cached_tokens;
  const cacheWrite = u.cacheWrite ?? u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? record(u.inputTokens).cacheWrite;
  // Pi/Anthropic report uncached input separately; Agent Runs subtracts
  // cache tokens from the canonical inclusive input count.
  const inputTokens = u.input ?? record(u.inputTokens).total ?? u.inputTokens ?? u.input_tokens ?? u.prompt_tokens;
  const inclusiveInput = typeof inputTokens === 'number' && (typeof u.input === 'number' || typeof u.cache_read_input_tokens === 'number' || typeof u.cache_creation_input_tokens === 'number')
    ? inputTokens + (typeof cacheRead === 'number' ? cacheRead : 0) + (typeof cacheWrite === 'number' ? cacheWrite : 0) : inputTokens;
  const fields: [string, unknown][] = [
    ['input_tokens', inclusiveInput],
    ['output_tokens', u.output ?? record(u.outputTokens).total ?? u.outputTokens ?? u.output_tokens ?? u.completion_tokens],
    ['cache_read_tokens', cacheRead],
    ['cache_write_tokens', cacheWrite],
    ['reasoning_tokens', u.reasoningTokens ?? record(u.outputTokens).reasoning ?? record(u.output_tokens_details).reasoning_tokens ?? record(u.completion_tokens_details).reasoning_tokens],
  ];
  // The model span carries the same usage in gen_ai's names (the inclusive
  // input and its cached parts), so Agent Runs reads one usage from either.
  const genAi: Record<string, string> = { input_tokens: 'input_tokens', output_tokens: 'output_tokens', cache_read_tokens: 'cache_read.input_tokens', cache_write_tokens: 'cache_write.input_tokens' };
  for (const [key, value] of fields) if (typeof value === 'number' && Number.isFinite(value)) {
    step.setAttribute(`agent.usage.${key}`, value);
    if (genAi[key]) span.setAttribute(`gen_ai.usage.${genAi[key]}`, value);
  }
  const cost = record(u.cost).total;
  if (typeof cost === 'number') { step.setAttribute('gen_ai.usage.cost', cost); span.setAttribute('gen_ai.usage.cost', cost); }
}

/** Filter a destination's copy, including status and events; never mutate a shared span. */
export function filteringProcessor(downstream: SpanProcessor, policy?: SpanExportPolicy): SpanProcessor {
  return {
    onStart(span, ctx) { try { downstream.onStart(span, ctx); } catch { /* Observability cannot reject agent work. */ } }, forceFlush: () => downstream.forceFlush(), shutdown: () => downstream.shutdown(),
    onEnd(span) {
      const sc = span.spanContext();
      const context: SpanExportContext = { ...sc, name: span.name, attributes: { ...span.attributes }, audience: audienceOf(span.attributes['agent.channel.audience']) };
      let decision: SpanExportDecision;
      try { decision = policy?.span?.(context) ?? (context.audience === 'public' ? { emit: true } : { redact: true, inputs: true, outputs: true }); }
      catch { return; }
      if (!decision || typeof decision !== 'object' || ('emit' in decision && 'redact' in decision)) return;
      if ('emit' in decision ? decision.emit !== true : decision.redact !== true || (!decision.inputs && !decision.outputs)) return;
      const inputs = 'redact' in decision && decision.inputs === true;
      const outputs = 'redact' in decision && decision.outputs === true;
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(span.attributes)) {
        if ((inputs && INPUTS.has(key)) || (outputs && OUTPUTS.has(key))) continue;
        try {
          const d = policy?.attribute?.({ key, value, span: context }) ?? { emit: true };
          if ('replace' in d && d.replace === true) attributes[key] = d.value;
          else if ('emit' in d && d.emit === true) attributes[key] = value;
        } catch { /* Attribute policies fail closed. */ }
      }
      if (inputs) attributes['agent.trace.content.input'] = false;
      if (outputs) attributes['agent.trace.content.output'] = false;
      try { downstream.onEnd({ ...span, spanContext: () => sc, attributes,
        status: outputs ? { code: span.status.code } : { ...span.status },
        events: outputs ? span.events.filter(e => e.name !== 'exception').map(e => ({ ...e, attributes: undefined })) : span.events,
      } as ReadableSpan); } catch { /* Observability cannot reject agent work. */ }
    },
  };
}
function vercelProcessor(JsonTraceSerializer: typeof import('@opentelemetry/otlp-transformer').JsonTraceSerializer): SpanProcessor {
  return {
    onStart(span, ctx) { (span as Span & ReportedSpan).__durableReporter = ctx.getValue(REPORTER) as Reporter | undefined; }, forceFlush: async () => {}, shutdown: async () => {},
    onEnd(span) {
      (span as ReadableSpan & ReportedSpan).__durableMetadata?.(span);
      const report = (span as ReadableSpan & ReportedSpan).__durableReporter ?? requestReporter();
      if (!report) return;
      try {
        const bytes = JsonTraceSerializer.serializeRequest([span]);
        if (bytes) report(JSON.parse(new TextDecoder().decode(bytes)));
      } catch { console.warn('durable-harness: Agent Runs span export failed'); }
    },
  };
}

function modelResponse(output: unknown): Record<string, unknown> {
  const result = record(output);
  const body = result.responseBody ?? result.body;
  if (typeof body !== 'string') return result;
  let text = '';
  let model: string | undefined;
  const parts: unknown[] = [];
  const anthropicTools = new Map<number, { part: Record<string, unknown>; json: string }>();
  let providerMetadata: unknown;
  const usage: Record<string, unknown> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {}
  const events = parsed ? [parsed] : body.split('\n').filter((line: string) => line.startsWith('data:')).flatMap((line: string) => {
    try { return [JSON.parse(line.slice(5))]; } catch { return []; }
  });
  for (const event of events) {
    const e = record(event);
    const candidateModel = e.model ?? e.modelId ?? record(e.message).model ?? record(e.response).model;
    if (typeof candidateModel === 'string') model ??= candidateModel;
    providerMetadata = e.providerMetadata ?? providerMetadata;
    if (e.type === 'tool-call') parts.push({ type: 'toolCall', id: e.toolCallId, name: e.toolName, arguments: e.input });
    // OpenAI Responses (Codex): each finished function call is one output item.
    if (e.type === 'response.output_item.done' && record(e.item).type === 'function_call') {
      const item = record(e.item);
      parts.push({ type: 'toolCall', id: item.call_id, name: item.name, arguments: item.arguments });
    }
    if (e.type === 'content_block_start' && record(e.content_block).type === 'tool_use') {
      const part = { ...record(e.content_block) };
      parts.push(part);
      if (typeof e.index === 'number') anthropicTools.set(e.index, { part, json: '' });
    }
    if (e.type === 'content_block_delta' && record(e.delta).type === 'input_json_delta' && typeof e.index === 'number') {
      const tool = anthropicTools.get(e.index);
      const fragment = record(e.delta).partial_json;
      if (tool && typeof fragment === 'string') tool.json += fragment;
    }
    Object.assign(usage, record(e.usage ?? record(e.message).usage ?? record(e.response).usage));
    const delta = record(e.delta).text ?? (e.type === 'response.output_text.delta' || e.type === 'text-delta' ? e.delta ?? e.textDelta : undefined);
    if (typeof delta === 'string') text += delta;
    if (e.type === 'finish') Object.assign(usage, e.totalUsage ?? e.usage ?? {});
    for (const choice of Array.isArray(e.choices) ? e.choices : []) {
      const c = record(choice);
      const content = record(c.delta).content ?? record(c.message).content;
      if (typeof content === 'string') text += content;
    }
    for (const part of Array.isArray(e.content) ? e.content : []) {
      const c = record(part);
      if (c.type === 'text' && typeof c.text === 'string') text += c.text;
    }
  }
  for (const { part, json } of anthropicTools.values()) {
    if (!json) continue;
    try { part.input = JSON.parse(json); } catch { part.input = json; }
  }
  if (text) parts.unshift({ type: 'text', text });
  return { model, usage, providerMetadata, role: 'assistant', content: parts };
}
