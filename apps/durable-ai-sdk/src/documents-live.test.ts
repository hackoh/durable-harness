import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDoc, durableAgent, getWorld } from 'durable-harness';
import { docTools } from 'durable-harness/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiSdkHarness, type Checkpoint } from './harness.ts';
import { fromHostTools } from './tools.ts';

/**
 * Documents with a real model, on the AI SDK harness as a `durableAgent`
 * (your own kernel harness, with durable-harness's chat route and sessions):
 * the model edits a document through `docTools`, app code reads it, and
 * `promptDocs` shows an app edit to the next model call. Skipped without a
 * Gateway credential (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN).
 */
const credential = !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MODEL = process.env.DURABLE_AI_SDK_MODEL ?? 'anthropic/claude-haiku-4.5';

const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });

const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe.skipIf(!credential)(`durableAgent over the AI SDK harness, documents, live (${MODEL})`, () => {
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'durable-ai-sdk-docs-live-'));
  });
  afterAll(async () => {
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });

  it('the model edits a document through a tool, app code reads it, and promptDocs shows an app edit to the next turn', async () => {
    const agent = durableAgent({
      harness: aiSdkHarness({
        model: MODEL,
        instructions: 'You keep the user\'s todo list in the "todos" document. Keep answers short.',
        tools: fromHostTools(docTools([Todos])),
        promptDocs: [Todos],
      }),
    });
    const route = agent.chatRoute();
    const first = await route.POST(post({ text: "Add 'buy milk' and 'ship documents' to my todo list." }));
    await first.text();
    const sessionId = first.headers.get('x-session-id')!;
    let state = await agent.sessions.inspect(sessionId);
    console.log('[live ai-sdk] turn 0 effects:', state.effectOrder.map((e) => `${e.name}:${e.status}`).join(' '));
    const update = state.effectOrder.findLast((e) => e.name === 'tool.update_todos' && e.status === 'completed');
    expect(update?.docs?.[0]?.kind).toBe('app.todos');
    const doc = await agent.sessions.doc(sessionId, Todos);
    console.log('[live ai-sdk] todos:', JSON.stringify(doc));
    expect(doc.value.items.map((i) => i.toLowerCase())).toEqual(expect.arrayContaining([expect.stringContaining('milk'), expect.stringContaining('ship documents')]));

    await agent.sessions.updateDoc(sessionId, Todos, (d) => void d.items.push('call the bank'));
    const second = await route.POST(post({ sessionId, text: 'What is on my todo list now? Answer from the documents in your instructions, without calling a tool.' }));
    await second.text();
    state = await agent.sessions.inspect(sessionId);
    const answer = (state.effects.get('checkpoint:1')?.output as Checkpoint | undefined)?.messages.findLast((m) => m.role === 'assistant');
    const text = typeof answer?.content === 'string' ? answer.content : (answer?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
    console.log('[live ai-sdk] turn 1 answer:', JSON.stringify(text));
    expect(text.toLowerCase()).toContain('call the bank');
  }, 300_000);
});
