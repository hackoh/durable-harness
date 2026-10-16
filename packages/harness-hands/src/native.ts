import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';
import { markTime, PROCESS_ID } from 'harness-world/marks';
import type { FxEngineOptions } from 'libfx';
import { docUpdateValue, readDocSpec, readDocText, updatedDocText, updateDocSpec } from './doc-tool-specs.ts';
import { type NativeTool, NativeWorkspace, nativeTools } from './workspace.ts';

export { type NativeTool, NativeWorkspace, nativeTools } from './workspace.ts';

/**
 * The native baseline: Pi (pi-agent-core's `Agent`) and fx (libfx's
 * `createFxEngine`) run the way an app on a plain Vercel Function would run
 * them, with the same model, system prompt and tool definitions as the
 * durable lanes and none of the durability machinery: no harness-world, no
 * World, no queue, no live stream. Events go straight to the caller as they
 * happen. The only additions are the model timing marks every lane writes
 * (`model.request`, `model.first_token`, `model.done`, in this process's
 * clock), so a comparison can take the model's own time out of every column.
 *
 * A Function holds nothing between requests, so the caller carries the
 * conversation (Pi's messages or fx's checkpoint, plus the workspace files)
 * from one turn to the next, the way a stateless chat route does. A steer
 * reaches the running turn through an in-process registry, so it lands when
 * the steer request reaches the same instance; `steerNative` says whether it
 * did.
 */

export type NativeHarness = 'pi' | 'fx';

export interface NativeState {
  /** Pi: the agent's messages after the last turn. */
  messages?: unknown[];
  /** fx: the agent's checkpoint after the last turn, base64. */
  checkpoint?: string;
  /** The workspace, path → contents. */
  files: Record<string, string>;
  /** Documents the native document tools keep (`config.docs`), kind → its revision and value. */
  docs?: Record<string, { revision: number; value: unknown }>;
}

/**
 * A document the native baseline offers its model, as `docTools` does on
 * the kernel (`read_<name>`, `update_<name>`, the same descriptions and
 * schema), kept in the state the caller carries between turns. A plain
 * description, not a kernel `Doc`: the native route loads none of the kernel.
 */
export interface NativeDocSpec {
  /** The tools' name part: `todos` for read_todos / update_todos. */
  name: string;
  kind: string;
  /** The value's JSON schema (update's input type). */
  schema?: object;
  initial(): object;
  validate?(value: any): void;
}

/** The document tools on carried state: each update bumps the revision. */
function nativeDocTools(specs: readonly NativeDocSpec[], state: NonNullable<NativeState['docs']>): NativeTool[] {
  return specs.flatMap((d) => {
    const read = () => state[d.kind] ?? { revision: 0, value: d.initial() };
    return [
      { ...readDocSpec(d.name, d.kind), execute: async () => readDocText(read().revision, read().value) },
      {
        ...updateDocSpec(d.name, d.kind, d.schema),
        execute: async (input: { value: unknown; expectRevision?: unknown }) => {
          const current = read();
          const next = docUpdateValue(d.name, input, current.revision);
          d.validate?.(next);
          state[d.kind] = { revision: current.revision + 1, value: next };
          return updatedDocText(d.name);
        },
      },
    ];
  });
}

export type NativeEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args?: unknown }
  | { type: 'tool_end'; name: string; isError?: boolean; output?: string }
  | { type: 'error'; message: string }
  | { type: 'idle' }
  | { type: 'state'; state: NativeState }
  | NativeMark;

/** A timing mark, the same shape as harness-world's (`runId` is `native`). */
export interface NativeMark {
  type: 'mark';
  name: 'model.request' | 'model.first_token' | 'model.done';
  t: number;
  pid: string;
  runId: 'native';
  key: string;
  [extra: string]: unknown;
}

const nativeMark = (name: NativeMark['name'], key: string, extra: Record<string, unknown> = {}): NativeMark => ({
  type: 'mark',
  name,
  t: markTime(),
  pid: PROCESS_ID,
  runId: 'native',
  key,
  ...extra,
});

/** Pi's first-output event types (as harness-pi counts TTFT). */
const PI_FIRST_OUTPUT = new Set(['text_delta', 'thinking_delta', 'toolcall_start', 'toolcall_delta']);

/** A Pi `StreamFn` that marks each model call (request, first output, done) and passes every event through. */
export function markedStreamFn(inner: StreamFn, emit: (e: NativeEvent) => void): StreamFn {
  let ordinal = 0;
  return (async (model: any, context: any, opts: any) => {
    const key = `model:${ordinal++}`;
    emit(nativeMark('model.request', key));
    const stream: any = await inner(model, context, opts);
    let first = false;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        emit(nativeMark('model.done', key));
      }
    };
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = () => {
      const it = iterate();
      return {
        async next() {
          const r = await it.next();
          if (r.done) finish();
          else if (!first && PI_FIRST_OUTPUT.has(r.value?.type)) {
            first = true;
            emit(nativeMark('model.first_token', key, { kind: r.value.type }));
          }
          if (!r.done && (r.value?.type === 'done' || r.value?.type === 'error')) finish();
          return r;
        },
        return: it.return?.bind(it),
        throw: it.throw?.bind(it),
      };
    };
    return stream;
  }) as StreamFn;
}

/** A `fetch` for libfx that marks each model call: the POST, its first output event, the end of its body. */
export function markedFetch(inner: typeof fetch, emit: (e: NativeEvent) => void): typeof fetch {
  let ordinal = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return inner(url, init);
    const key = `model:${ordinal++}`;
    emit(nativeMark('model.request', key));
    const response = await inner(url, init);
    if (!response.body) {
      emit(nativeMark('model.done', key, { status: response.status }));
      return response;
    }
    const decoder = new TextDecoder();
    let first = false;
    let seen = '';
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!first) {
            seen += decoder.decode(chunk, { stream: true });
            if (/"type":\s*"(text-delta|reasoning-delta|tool-input-start|tool-input-delta|tool-call)"/.test(seen)) {
              first = true;
              seen = '';
              emit(nativeMark('model.first_token', key));
            }
          }
          controller.enqueue(chunk);
        },
        flush() {
          emit(nativeMark('model.done', key));
        },
      })
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

export interface NativeTurnRequest {
  harness: NativeHarness;
  state?: NativeState;
  text: string;
  /** Lets a steer find this turn (`steerNative`). */
  turnId?: string;
}

export interface NativePiConfig {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  systemPrompt: string;
}

export interface NativeFxConfig {
  /** libfx's `createFxEngine` (`libfx`, or `libfx/browser` in a tab). */
  createFxEngine?: (options: FxEngineOptions) => Promise<NativeFxAgent>;
  /**
   * @deprecated Pass `createFxEngine`. Since vercel-labs/fx#1180, libfx's own
   * `createFxAgent` is its durable agent, not an engine, and a native turn
   * refuses it.
   */
  createFxAgent?: (options: FxEngineOptions) => Promise<NativeFxAgent>;
  apiKey: () => Promise<string> | string;
  model: string;
  instructions: string;
  /** The network fetch model requests go to (default `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Extra `createFxEngine` options (the tab passes `{ backend: 'wasm' }`). */
  agentOptions?: Record<string, unknown>;
}

export interface NativeFxAgent {
  prompt(input: string): AsyncIterable<any> & { result: Promise<{ stopReason: string }>; steer(text: string): Promise<unknown> };
  checkpoint(): Promise<Uint8Array>;
  close(): Promise<void>;
}

type Steer = (text: string) => Promise<void> | void;
const registry = ((globalThis as { __nativeTurns?: Map<string, Steer> }).__nativeTurns ??= new Map());

/** Hand a steer to a running native turn in this process. False: not here (another instance, or it ended). */
export async function steerNative(turnId: string, text: string): Promise<boolean> {
  const steer = registry.get(turnId);
  if (!steer) return false;
  await steer(text);
  return true;
}

/** Run one turn natively, emitting events as they happen and the new state last. */
export async function nativeTurn(
  req: NativeTurnRequest,
  emit: (event: NativeEvent) => void,
  config: { pi?: NativePiConfig; fx?: NativeFxConfig; docs?: readonly NativeDocSpec[] }
): Promise<void> {
  const ws = await NativeWorkspace.from(req.state?.files);
  const docs = { ...(req.state?.docs ?? {}) };
  // Tools run one at a time: the last result is what the next tool_end reports.
  let lastOutput: string | undefined;
  const tools = [...nativeTools(ws), ...nativeDocTools(config.docs ?? [], docs)].map((t) => ({
    ...t,
    execute: async (input: any, signal?: AbortSignal) => {
      lastOutput = undefined;
      try {
        return (lastOutput = await t.execute(input, signal));
      } catch (err) {
        lastOutput = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },
  }));
  const inner = emit;
  emit = (e) => {
    if (e.type === 'tool_end' && lastOutput !== undefined) {
      inner({ ...e, output: lastOutput.length > 4000 ? `${lastOutput.slice(0, 4000)}…` : lastOutput });
      lastOutput = undefined;
    } else inner(e);
  };
  let next: Omit<NativeState, 'files'>;
  try {
    if (req.harness === 'fx') {
      if (!config.fx) throw new Error('fx is not configured');
      next = await fxTurn(req, tools, config.fx, emit);
    } else {
      if (!config.pi) throw new Error('Pi is not configured');
      next = await piTurn(req, tools, config.pi, emit);
    }
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    next = { ...(req.state?.messages ? { messages: req.state.messages } : {}), ...(req.state?.checkpoint ? { checkpoint: req.state.checkpoint } : {}) };
  } finally {
    if (req.turnId) registry.delete(req.turnId);
  }
  emit({ type: 'idle' });
  emit({ type: 'state', state: { ...next, files: await ws.files(), ...(Object.keys(docs).length ? { docs } : {}) } });
}

const userMessage = (text: string): Message => ({ role: 'user', content: text, timestamp: Date.now() });

async function piTurn(req: NativeTurnRequest, tools: NativeTool[], cfg: NativePiConfig, emit: (e: NativeEvent) => void) {
  const agent = new Agent({
    initialState: {
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      thinkingLevel: 'off',
      tools: tools.map(
        (t): AgentTool<any> => ({
          name: t.name,
          label: t.label,
          description: t.description,
          parameters: t.inputSchema as AgentTool<any>['parameters'],
          execute: async (_id, params, signal) => ({ content: [{ type: 'text', text: await t.execute(params, signal) }], details: undefined }),
        })
      ),
      messages: (req.state?.messages ?? []) as AgentMessage[],
    },
    streamFn: markedStreamFn(cfg.streamFn, emit),
    ...(cfg.getApiKey ? { getApiKey: cfg.getApiKey } : {}),
    toolExecution: 'sequential',
    followUpMode: 'all',
    steeringMode: 'all',
  });
  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      emit({ type: 'text', delta: event.assistantMessageEvent.delta });
    } else if (event.type === 'tool_execution_start') emit({ type: 'tool_start', name: event.toolName, args: event.args });
    else if (event.type === 'tool_execution_end') emit({ type: 'tool_end', name: event.toolName, isError: event.isError });
  });
  if (req.turnId) registry.set(req.turnId, (text: string) => agent.steer(userMessage(text)));
  await agent.prompt(userMessage(req.text));
  const messages = agent.state.messages;
  const last = messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  if (last?.role === 'assistant' && last.stopReason === 'error') emit({ type: 'error', message: last.errorMessage ?? 'model call failed' });
  return { messages };
}

/** libfx's durable agent (its `createFxAgent` since vercel-labs/fx#1180) has these; its engine has neither. */
const isDurableAgent = (value: unknown) => !!value && typeof value === 'object' && ('wakeHandler' in value || 'session' in value);

/**
 * One engine from `cfg`, refusing libfx's durable agent: driven as an
 * engine, it would run the turn in a session libfx keeps in a World of its
 * own, which is not the plain fx a native column measures.
 */
async function nativeEngine(cfg: NativeFxConfig, options: FxEngineOptions): Promise<NativeFxAgent> {
  const factory = cfg.createFxEngine ?? cfg.createFxAgent;
  if (typeof factory !== 'function') throw new TypeError("native fx needs createFxEngine: libfx's createFxEngine");
  const made: unknown = factory(options);
  const refuse = () =>
    new TypeError("native fx: the engine factory returned libfx's durable agent (libfx's createFxAgent since vercel-labs/fx#1180) instead of an engine: pass libfx's createFxEngine as createFxEngine");
  if (isDurableAgent(made)) throw refuse();
  if (!made || typeof (made as { then?: unknown }).then !== 'function') throw new TypeError("native fx: the engine factory must return a promise of an engine, as libfx's createFxEngine does");
  const engine = await (made as Promise<unknown>);
  if (isDurableAgent(engine)) throw refuse();
  return engine as NativeFxAgent;
}

async function fxTurn(req: NativeTurnRequest, tools: NativeTool[], cfg: NativeFxConfig, emit: (e: NativeEvent) => void) {
  const agent = await nativeEngine(cfg, {
    apiKey: await cfg.apiKey(),
    model: cfg.model,
    instructions: cfg.instructions,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      // One at a time, as nativeTurn's tool_end output assumes: libfx runs
      // the tools of one model response in parallel unless they write.
      writes: true,
      execute: (input: unknown, io?: { signal?: AbortSignal }) => t.execute(input, io?.signal),
    })),
    fetch: markedFetch(cfg.fetch ?? globalThis.fetch, emit),
    ...cfg.agentOptions,
    ...(req.state?.checkpoint ? { checkpoint: fromBase64(req.state.checkpoint) } : {}),
  });
  try {
    const turn = agent.prompt(req.text);
    if (req.turnId) registry.set(req.turnId, (text: string) => turn.steer(text));
    for await (const event of turn) {
      if (event.type === 'text_delta') emit({ type: 'text', delta: event.delta });
      else if (event.type === 'tool_start') emit({ type: 'tool_start', name: event.name, args: event.input });
      else if (event.type === 'tool_end') emit({ type: 'tool_end', name: event.name, isError: event.isError });
    }
    await turn.result;
    return { checkpoint: toBase64(await agent.checkpoint()) };
  } finally {
    await agent.close().catch(() => {});
  }
}

// Portable (Node and the browser): no Buffer.
const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
