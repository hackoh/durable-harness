import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCode } from '../src/claude-code.ts';
import { type Agent, defineDoc, type SessionState } from '../src/index.ts';
import { pi } from '../src/pi.ts';
import { docTools, readWorkspace, workspaceTools } from '../src/tools.ts';
import { getWorld } from '../src/world.ts';

/**
 * Documents with a real model through the AI Gateway, on world-local: a
 * model edits a document through `docTools` (as app HostTools) and app code
 * reads it with `agent.sessions.doc`. Pi (a kernel harness) also shows the
 * documents in its prompt (`promptDocs`); Claude Code (a process harness)
 * reaches them only through the tools. Skipped without a credential:
 *
 *   (set -a; . ../../apps/demo/.env.local; set +a; pnpm vitest run test/documents-live.test.ts)
 */
const credential = !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MODEL = process.env.DOCS_LIVE_MODEL ?? 'anthropic/claude-haiku-4.5';

const Todos = defineDoc<{ items: string[] }>({
  kind: 'app.todos',
  version: 1,
  initial: () => ({ items: [] }),
  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
});

const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** One turn through the agent's chat route (it drives the turn and ends once it is over). */
async function turn(agent: Agent, text: string, sessionId?: string): Promise<{ sessionId: string; said: string; state: SessionState }> {
  const res = await agent.chatRoute().POST(post({ ...(sessionId ? { sessionId } : {}), text }));
  expect(res.status).toBe(200);
  const body = await res.text();
  const said = body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        const e = JSON.parse(l.slice(6)) as { type?: string; delta?: string };
        return e.type === 'text' ? (e.delta ?? '') : '';
      } catch {
        return '';
      }
    })
    .join('');
  const id = res.headers.get('x-session-id')!;
  return { sessionId: id, said, state: await agent.sessions.inspect(id) };
}

const tools = (s: SessionState) => s.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => `${e.name}:${e.status}`);

describe.skipIf(!credential)(`documents with a real model (${MODEL})`, () => {
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'durable-harness-docs-live-'));
  });
  afterAll(async () => {
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });

  it('pi: the model edits a document through a tool, app code reads it, and promptDocs shows an app edit to the next turn', async () => {
    const agent = pi({
      model: MODEL,
      name: 'docs-live-pi',
      instructions: 'You keep the user\'s todo list in the "todos" document. Keep answers short.',
      tools: [...docTools([Todos]), ...workspaceTools()],
      promptDocs: [Todos],
    });
    const first = await turn(agent, "Add 'buy milk' and 'ship documents' to my todo list. Also write the list, one item per line, to todos.txt.");
    console.log('[live pi] turn 1 tools:', tools(first.state).join(' '), '| said:', first.said.slice(0, 200));
    expect(first.state.status).toBe('running');
    expect(tools(first.state)).toContain('tool.update_todos:completed');
    const doc = await agent.sessions.doc(first.sessionId, Todos);
    expect(doc.revision).toBeGreaterThanOrEqual(1);
    expect(doc.value.items.map((i) => i.toLowerCase())).toEqual(expect.arrayContaining([expect.stringContaining('milk'), expect.stringContaining('ship documents')]));
    // The workspace tools wrote todos.txt into the workspace document.
    expect((await readWorkspace(await getWorld(), first.state))['/workspace/todos.txt']).toMatch(/milk/i);

    // The app edits the document out of band; the next turn's prompt has it.
    await agent.sessions.updateDoc(first.sessionId, Todos, (d) => void d.items.push('call the bank'));
    const second = await turn(agent, 'What is on my todo list now? Answer from the documents in your instructions, without calling a tool.', first.sessionId);
    console.log('[live pi] turn 2 tools:', tools(second.state).join(' '), '| said:', second.said.slice(0, 300));
    expect(second.said.toLowerCase()).toContain('call the bank');
    expect(tools(second.state).filter((t) => t.startsWith('tool.read_todos'))).toHaveLength(tools(first.state).filter((t) => t.startsWith('tool.read_todos')).length);
  }, 300_000);

  // Claude Code runs in the session's Vercel Sandbox: a live sandbox run (DH_LIVE_SANDBOX=1, a linked project).
  it.runIf(process.env.DH_LIVE_SANDBOX === '1')('Claude Code: the model edits a document through docTools as app HostTools, and app code reads it', async () => {
    const agent = claudeCode({
      model: MODEL,
      name: 'docs-live-claude-code',
      instructions: 'You keep the user\'s todo list in the "todos" document: read it with read_todos and change it with update_todos (the whole list). Keep answers short.',
      tools: docTools([Todos]),
    });
    const first = await turn(agent, "Add 'buy milk' and 'ship documents' to my todo list.");
    console.log('[live claude-code] tools:', tools(first.state).join(' '), '| said:', first.said.slice(0, 200));
    expect(tools(first.state)).toContain('tool.update_todos:completed');
    const doc = await agent.sessions.doc(first.sessionId, Todos);
    expect(doc.revision).toBeGreaterThanOrEqual(1);
    expect(doc.value.items.map((i) => i.toLowerCase())).toEqual(expect.arrayContaining([expect.stringContaining('milk'), expect.stringContaining('ship documents')]));
    // The edit rode on the tool call's outcome.
    const update = first.state.effectOrder.findLast((e) => e.name === 'tool.update_todos' && e.status === 'completed')!;
    expect(update.docs).toEqual([{ kind: 'app.todos', revision: doc.revision }]);
  }, 300_000);
});
