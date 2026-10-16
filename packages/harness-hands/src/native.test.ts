import { readFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { FxEngineOptions } from 'libfx';
import { describe, expect, it } from 'vitest';
import { defineDoc } from 'harness-world';
import { readDocSpec, updateDocSpec } from './doc-tool-specs.ts';
import { docTools } from './doc-tools.ts';
import { workspaceTools } from './index.ts';
import { type NativeEvent, type NativeFxAgent, NativeWorkspace, nativeTools, nativeTurn, steerNative } from './native.ts';

function pi() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, config: { pi: { model: faux.getModel(), streamFn: models.streamSimple.bind(models), systemPrompt: 'Be brief.' } } };
}

describe('native baseline', () => {
  it('sends the model the same tool definitions as the durable tools', async () => {
    const durable = workspaceTools().map(({ name, label, description, inputSchema }) => ({ name, label, description, inputSchema }));
    const native = nativeTools(await NativeWorkspace.from()).map(({ name, label, description, inputSchema }) => ({ name, label, description, inputSchema }));
    expect(JSON.stringify(native)).toBe(JSON.stringify(durable));
  });

  it('offers a document as docTools does, on the state it carries between turns', async () => {
    const spec = {
      name: 'todos',
      kind: 'demo.todos',
      initial: () => ({ items: [] as string[] }),
      schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'], additionalProperties: false },
    };
    const Todos = defineDoc<{ items: string[] }>({ kind: spec.kind, version: 1, initial: spec.initial, schema: spec.schema });
    const durable = docTools([Todos]).map(({ name, label, description, inputSchema }) => ({ name, label, description, inputSchema }));
    const { faux, config } = pi();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('update_todos', { value: { items: ['ship it'] }, expectRevision: 0 }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('added')),
      fauxAssistantMessage(fauxToolCall('read_todos', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('read')),
    ]);
    const events: NativeEvent[] = [];
    await nativeTurn({ harness: 'pi', text: 'add it' }, (e) => events.push(e), { ...config, docs: [spec] });
    const state = (events.at(-1) as Extract<NativeEvent, { type: 'state' }>).state;
    expect(state.docs).toEqual({ 'demo.todos': { revision: 1, value: { items: ['ship it'] } } });
    const more: NativeEvent[] = [];
    await nativeTurn({ harness: 'pi', text: 'read it', state }, (e) => more.push(e), { ...config, docs: [spec] });
    expect(more.find((e) => e.type === 'tool_end')).toMatchObject({ name: 'read_todos', output: '{"revision":1,"value":{"items":["ship it"]}}' });
    // The model is offered exactly what the durable lanes offer.
    expect(JSON.stringify([readDocSpec('todos', spec.kind), updateDocSpec('todos', spec.kind, spec.schema)])).toBe(JSON.stringify(durable));
  });

  it('imports nothing of the durable machinery (only the mark clock, which has no dependencies)', async () => {
    const src = await readFile(new URL('./native.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => /harness-world|@workflow|\.\/index/.test(i!))).toEqual(['harness-world/marks']);
    const marks = await readFile(new URL('../../harness-world/src/marks.ts', import.meta.url), 'utf8');
    expect([...marks.matchAll(/^import .* from '([^']+)'/gm)]).toEqual([]);
  });

  it('runs a Pi tool turn, streams events, and carries messages and files to the follow-up', async () => {
    const { faux, config } = pi();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write_file', { path: 'notes.txt', content: 'hi' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('done')),
      fauxAssistantMessage(fauxText('still here')),
    ]);
    const events: NativeEvent[] = [];
    await nativeTurn({ harness: 'pi', text: 'write it' }, (e) => events.push(e), config);
    expect(events.filter((e) => e.type !== 'mark').map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'idle', 'state']);
    // The model timing marks every lane writes: two calls, each requested, first output, done.
    const marks = events.filter((e): e is Extract<NativeEvent, { type: 'mark' }> => e.type === 'mark');
    expect(marks.map((m) => `${m.name}:${m.key}`)).toEqual([
      'model.request:model:0',
      'model.first_token:model:0',
      'model.done:model:0',
      'model.request:model:1',
      'model.first_token:model:1',
      'model.done:model:1',
    ]);
    expect(marks[1]!.t).toBeGreaterThanOrEqual(marks[0]!.t);
    const state = (events.at(-1) as Extract<NativeEvent, { type: 'state' }>).state;
    expect(state.files).toEqual({ '/workspace/notes.txt': 'hi' });
    const n = state.messages!.length;
    expect((state.messages as { role: string }[]).map((m) => m.role).slice(-4)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);

    const more: NativeEvent[] = [];
    await nativeTurn({ harness: 'pi', text: 'again', state }, (e) => more.push(e), config);
    const next = (more.at(-1) as Extract<NativeEvent, { type: 'state' }>).state;
    expect(next.messages?.length).toBe(n + 2);
    expect(next.files).toEqual(state.files);
    expect(more.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('still here');
  });

  it('reports a failed model call as an error and still ends idle', async () => {
    const { faux, config } = pi();
    faux.setResponses([fauxAssistantMessage(fauxText(''), { stopReason: 'error', errorMessage: 'boom' })]);
    const events: NativeEvent[] = [];
    await nativeTurn({ harness: 'pi', text: 'x' }, (e) => events.push(e), config);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'boom' });
    expect(events.at(-2)?.type).toBe('idle');
  });

  it('runs an fx turn with its checkpoint, and steers it while it runs', async () => {
    const steered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let restoredFrom: Uint8Array | undefined;
    const fake: NativeFxAgent & { tools?: any[] } = {
      prompt(input) {
        const tools = fake.tools!;
        const events = (async function* () {
          yield { type: 'tool_start', id: '1', name: 'bash', input: { command: 'echo hi' } };
          const out = await tools.find((t) => t.name === 'bash').execute({ command: 'echo hi' }, { signal: new AbortController().signal });
          yield { type: 'tool_end', id: '1', name: 'bash', output: out };
          await gate;
          yield { type: 'text_delta', delta: `${input} ${steered.join(',')}` };
        })();
        return Object.assign(events, { result: Promise.resolve({ stopReason: 'stop' }), steer: async (t: string) => void steered.push(t) });
      },
      checkpoint: async () => new Uint8Array([1, 2, 3]),
      close: async () => {},
    };
    const config = {
      fx: {
        createFxEngine: async (o: FxEngineOptions) => {
          fake.tools = o.tools as any[];
          restoredFrom = o.checkpoint as Uint8Array | undefined;
          return fake;
        },
        apiKey: () => 'k',
        model: 'm',
        instructions: 'i',
      },
    };
    const events: NativeEvent[] = [];
    const done = nativeTurn({ harness: 'fx', text: 'go', turnId: 't1' }, (e) => events.push(e), config);
    while (!events.some((e) => e.type === 'tool_end')) await new Promise((r) => setTimeout(r, 1));
    expect(await steerNative('t1', 'faster')).toBe(true);
    release();
    await done;
    expect(await steerNative('t1', 'late')).toBe(false);
    expect(events.find((e) => e.type === 'text')).toMatchObject({ delta: 'go faster' });
    const state = (events.at(-1) as Extract<NativeEvent, { type: 'state' }>).state;
    expect(state.checkpoint).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    await nativeTurn({ harness: 'fx', text: 'x', state }, () => {}, config).catch(() => {});
    expect([...(restoredFrom ?? [])]).toEqual([1, 2, 3]);
  });

  it("refuses libfx's durable agent (createFxAgent since vercel-labs/fx#1180) as the fx engine", async () => {
    // Its shape: returned synchronously, with session() and wakeHandler().
    const durable = () => ({ session() {}, sessionId: undefined, prompt() {}, checkpoint() {}, wakeHandler() {}, close() {} });
    const fx = { apiKey: () => 'k', model: 'm', instructions: 'i' };
    for (const config of [{ fx: { ...fx, createFxEngine: durable as never } }, { fx: { ...fx, createFxAgent: durable as never } }]) {
      const events: NativeEvent[] = [];
      await nativeTurn({ harness: 'fx', text: 'go' }, (e) => events.push(e), config);
      expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/durable agent.*pass libfx's createFxEngine/) });
      expect(events.some((e) => e.type === 'text')).toBe(false);
    }
  });
});
