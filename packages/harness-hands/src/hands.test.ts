import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { piHarness } from 'harness-world-pi';
import { afterEach, describe, expect, it } from 'vitest';
import { filesFromState, workspaceTools } from './index.ts';

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

describe('workspace tools', () => {
  it('keeps files in the log, so a new process sees them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-hands-'));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let lsOutput = '';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write_file', { path: 'notes/todo.md', content: '- ship it\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'sed -i s/ship/test/ notes/todo.md && cat notes/todo.md' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('done')),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'find . -type f && cat notes/todo.md' }), { stopReason: 'toolUse' }),
      (context) => {
        lsOutput = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage(fauxText('listed'));
      },
    ]);
    const harness = piHarness({ model: faux.getModel(), streamFn: models.streamSimple.bind(models), tools: workspaceTools() });

    const worldA = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(worldA);
    const a = durableSessions({ world: worldA, harness });
    worldA.registerHandler(QUEUE_PREFIX, a.handler);
    const { sessionId } = await a.start({ prompt: 'make a todo' });
    const first = await until(async () => {
      const s = await a.inspect(sessionId);
      return s.effects.get('model:2')?.status === 'completed' ? s : undefined;
    });
    expect(filesFromState(first)).toEqual({ '/workspace/notes/todo.md': '- test it\n' });
    await worldA.close?.();

    // A fresh process: its workspace starts empty and is rebuilt from the log.
    const worldB = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(worldB);
    const b = durableSessions({ world: worldB, harness });
    worldB.registerHandler(QUEUE_PREFIX, b.handler);
    await b.send(sessionId, 'what files are there?');
    await until(async () => {
      const s = await b.inspect(sessionId);
      return s.effects.get('model:4')?.status === 'completed' ? s : undefined;
    });
    expect(lsOutput).toContain('./notes/todo.md');
    expect(lsOutput).toContain('- test it');
  });
});
