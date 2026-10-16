import { defineDoc, durableSessions, QUEUE_PREFIX, readDoc, type SessionState } from 'harness-world';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { docTools } from './index.ts';
import { type Call, localStore, scripted, toolRecords, until } from './test-harness.ts';

const Todos = defineDoc<{ items: string[] }>({
  kind: 'app.todos',
  version: 1,
  initial: () => ({ items: [] }),
  validate: (v) => {
    if (!Array.isArray(v.items) || v.items.some((i) => typeof i !== 'string')) throw new Error('items must be strings');
  },
  schema: Type.Object({ items: Type.Array(Type.String()) }),
});
const Notes = defineDoc<{ text: string }>({ kind: 'crm.notes-v2', version: 1, initial: () => ({ text: '' }) });

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function session() {
  const st = await localStore('hw-doctools-');
  stores.push(st);
  const world = st.open();
  const s = durableSessions({ world, harness: scripted(docTools([Todos, Notes])) });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  const { sessionId } = await s.start();
  const call = async (c: Call): Promise<SessionState> => {
    const n = toolRecords(await s.inspect(sessionId)).length;
    await s.send(sessionId, JSON.stringify(c));
    let state!: SessionState;
    await until(async () => {
      state = await s.inspect(sessionId);
      const recs = toolRecords(state);
      return recs.length === n + 1 && (recs.at(-1)!.status === 'completed' || recs.at(-1)!.status === 'failed');
    }, c.tool);
    return state;
  };
  return { s, sessionId, call };
}

describe('docTools', () => {
  it('names a read and an update tool per document', () => {
    const tools = docTools([Todos, Notes]);
    expect(tools.map((t) => [t.name, t.replay])).toEqual([
      ['read_todos', 'safe'],
      ['update_todos', 'safe'],
      ['read_notes-v2', 'safe'],
      ['update_notes-v2', 'safe'],
    ]);
    expect(docTools({ list: Todos }).map((t) => t.name)).toEqual(['read_list', 'update_list']);
    // The definition's schema is the model-facing type of the value.
    expect((tools[1]!.inputSchema as { properties: { value: unknown } }).properties.value).toBe(Todos.definition.schema);
    // Without one the value is JSON text (strict tool calling makes an open object `{}`).
    expect((tools[3]!.inputSchema as { properties: { value: { type: string } } }).properties.value.type).toBe('string');
    expect(() => docTools([Todos, defineDoc({ kind: 'other.todos', version: 1, initial: () => ({}) })])).toThrow(/two documents are named "todos"/);
  });

  it('reads and replaces a document through the kernel, with the edit on the call outcome', async () => {
    const { s, sessionId, call } = await session();
    let state = await call({ tool: 'read_todos', input: {} });
    expect(JSON.parse(String(toolRecords(state).at(-1)!.output))).toEqual({ revision: 0, value: { items: [] } });

    state = await call({ tool: 'update_todos', input: { value: { items: ['buy milk'] }, expectRevision: 0 } });
    expect(toolRecords(state).at(-1)!.output).toBe('updated todos');
    expect(readDoc(state, Todos)).toEqual({ revision: 1, value: { items: ['buy milk'] } });
    // App code reads it from the log.
    expect(await s.doc(sessionId, Todos)).toEqual({ revision: 1, value: { items: ['buy milk'] } });

    // A model that sends the value as JSON text, and the revision as a string.
    state = await call({ tool: 'update_todos', input: { value: JSON.stringify({ items: ['buy milk', 'ship it'] }), expectRevision: '1' } });
    expect(readDoc(state, Todos).value).toEqual({ items: ['buy milk', 'ship it'] });
  });

  it('refuses a stale revision, an invalid value, and a value over the limit, as tool errors that change nothing', async () => {
    const { s, sessionId, call } = await session();
    await call({ tool: 'update_todos', input: { value: { items: ['a'] } } });
    await s.updateDoc(sessionId, Todos, (d) => {
      d.items.push('from the app');
    });
    let state = await call({ tool: 'update_todos', input: { value: { items: ['b'] }, expectRevision: 1 } });
    expect(toolRecords(state).at(-1)!.error?.message).toBe('todos changed since revision 1 (now 2): read it again');
    state = await call({ tool: 'update_todos', input: { value: { items: [3] } } });
    expect(toolRecords(state).at(-1)!.error?.message).toBe('items must be strings');
    state = await call({ tool: 'update_todos', input: { value: ['not', 'an', 'object'] } });
    expect(toolRecords(state).at(-1)!.error?.message).toMatch(/must be the whole document/);
    state = await call({ tool: 'update_notes-v2', input: { value: { text: 'x'.repeat(70_000) } } });
    expect(toolRecords(state).at(-1)!.error?.message).toMatch(/would be 70,\d{3} bytes; the limit is 65,536/);
    expect(readDoc(state, Todos)).toEqual({ revision: 2, value: { items: ['a', 'from the app'] } });
    expect(readDoc(state, Notes).revision).toBe(0);
  });
});
