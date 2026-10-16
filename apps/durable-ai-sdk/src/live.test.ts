import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import type { ModelMessage } from 'ai';
import { durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { workspaceTools } from 'harness-world-hands';
import { afterEach, describe, expect, it } from 'vitest';
import { crashDuringPayment, recoverInChild, until } from './crash.ts';
import { aiSdkHarness, type Checkpoint, transcript } from './harness.ts';
import { fromHostTools, readLedger } from './tools.ts';

/**
 * Live tests: a real model through the AI Gateway. They need a credential
 * (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN in the environment) and skip
 * without one.
 */
const credential = !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MODEL = process.env.DURABLE_AI_SDK_MODEL ?? 'anthropic/claude-haiku-4.5';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

const checkpointed = (sessions: { inspect(id: string): Promise<SessionState> }, id: string, turn: number) =>
  until(async () => {
    const state = await sessions.inspect(id);
    if (state.status === 'failed') throw new Error(`session failed: ${state.failure?.message}`);
    return state.effects.get(`checkpoint:${turn}`)?.status === 'completed' ? state : undefined;
  }, 150_000, `checkpoint:${turn}`);

const lastText = (messages: ModelMessage[]) => {
  const m = messages.findLast((x) => x.role === 'assistant');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
};

describe.skipIf(!credential)(`ai-sdk harness, live (${MODEL})`, () => {
  it('runs the workspace tools, and answers a second turn from the folded log', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'durable-ai-sdk-live-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({
      world,
      harness: aiSdkHarness({
        model: MODEL,
        instructions: 'You are a coding agent with a workspace at /workspace. Keep answers short.',
        tools: fromHostTools(workspaceTools()),
      }),
    });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({
      prompt: "Use write_file to write the text 'durable hello' to notes.txt, then read it back with read_file. Reply with exactly what the file contains.",
    });
    let state = await checkpointed(sessions, sessionId, 0);
    const names = state.effectOrder.map((e) => e.name);
    console.log('[live] turn 0 effects:', names.join(' '));
    expect(names).toContain('tool.write_file');
    expect(names).toContain('tool.read_file');
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.')).every((e) => e.status === 'completed')).toBe(true);
    const first = state.effects.get('checkpoint:0')!.output as Checkpoint;
    console.log('[live] turn 0 answer:', JSON.stringify(lastText(first.messages)));
    expect(lastText(first.messages)).toContain('durable hello');

    await sessions.send(sessionId, 'Which file did you write? Answer with just the file name.');
    state = await checkpointed(sessions, sessionId, 1);
    const second = state.effects.get('checkpoint:1')!.output as Checkpoint;
    console.log('[live] turn 1 answer:', JSON.stringify(lastText(second.messages)));
    expect(lastText(second.messages)).toContain('notes.txt');
    // Turn 1's request was the fold of turn 0 plus the new prompt.
    expect((state.effects.get('model:1:0')!.input as { messages: number }).messages).toBe(1 + transcript(state, 1).length);
  }, 300_000);

  it('SIGKILL mid-payment: a new process recovers from the log, one ledger record, the model gets an interrupted result', async () => {
    const { dataDir, ledger, sessionId, signal, childPid } = await crashDuringPayment(MODEL);
    const killedAt = Date.now();
    expect(signal).toBe('SIGKILL');
    expect(await readLedger(ledger)).toHaveLength(1);

    // Another OS process, which never drove the session, recovers it.
    const r = await recoverInChild({ dataDir, ledger, sessionId, model: MODEL });
    expect(r.pid).not.toBe(childPid);
    expect(r.pid).not.toBe(process.pid);

    const payments = await readLedger(ledger);
    console.log('[live] ledger:', payments.map((p) => `${p.id} ${p.toolCallId} $${p.amountUsd} pid ${p.pid}`).join('; '));
    console.log(`[live] killed pid ${childPid}, recovered in pid ${r.pid}`);
    console.log('[live] effects:', r.effects.map((e) => `${e.key}=${e.status}`).join(' '));
    console.log(
      `[live] no lease: kill → recoverer started ${r.startedAt - killedAt} ms, kill → interrupted result ${r.interruptedAt! - killedAt} ms, kill → checkpoint ${r.checkpointedAt - killedAt} ms`
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.pid).toBe(childPid);
    const pay = r.effects.filter((e) => e.name === 'tool.make_payment');
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ replay: 'never', status: 'failed', error: { interrupted: true } });
    expect(pay[0]!.key).toBe(`tool:${payments[0]!.toolCallId}`);
    // The step that asked for the payment ran once, in the killed process.
    expect(r.effects.filter((e) => e.key === 'model:0:0')).toEqual([expect.objectContaining({ status: 'completed' })]);
    const toolResult = r.checkpoint.messages.find((m) => m.role === 'tool');
    console.log('[live] tool result the model got:', JSON.stringify(toolResult?.content));
    expect(JSON.stringify(toolResult?.content)).toContain('interrupted');
    console.log('[live] answer after the crash:', JSON.stringify(lastText(r.checkpoint.messages)));
  }, 300_000);
});
