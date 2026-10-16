import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, Harness } from '@earendil-works/pi-durable';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { NativeWorkspace } from 'harness-world-hands/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceTools } from './agent.ts';
import { worldStorage } from './index.ts';
import { JournalReader } from './reader.ts';

const ctx = BACKGROUND_CONTEXT;
const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

describe('JournalReader', () => {
  it('follows a session from its log: entries, tasks, files recorded by the workspace tools', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'pi-reader-')), recoverActiveRuns: false });
    worlds.push(world);
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'a.txt', content: 'hi' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat a.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Done.')]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const sessionId = await worldStorage.create(world, { name: 'pi-durable' });
    const reader = new JournalReader(world, sessionId);
    await reader.refresh();
    expect((await reader.snapshot()).entries).toEqual([]);

    const storage = await worldStorage(world, sessionId);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'workspace', tools: workspaceTools(() => NativeWorkspace.from()) }));
    const harness = await Harness.open(storage, { models, registry, settings: { toolExecution: 'sequential' } }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    await (await root.submit({ type: 'input', content: 'write a file', requestId: 'r1' }, ctx)).wait(ctx);
    await harness.close(ctx);

    expect(await reader.refresh()).toBe(true);
    const snap = await reader.snapshot();
    if (process.env.PI_WORLD_DEBUG) console.log(JSON.stringify(snap, null, 2));
    expect(snap.entries.map((e) => e.kind).filter((k) => k !== 'pi.system')).toEqual([
      'pi.user',
      'pi.assistant',
      'pi.tool-result',
      'pi.assistant',
      'pi.tool-result',
      'pi.assistant',
    ]);
    const results = snap.entries.filter((e) => e.kind === 'pi.tool-result');
    expect((results[1]!.model![0] as { details?: { files?: Record<string, string> } }).details?.files).toEqual({ '/workspace/a.txt': 'hi' });
    expect(snap.unfinished).toBe(false);
    expect(snap.commits).toBeGreaterThan(5);
    expect(snap.log.every((c) => c.valid && c.by)).toBe(true);
    const tools = snap.tasks.filter((t) => t.starts.length > 0 && results.some((r) => r.byTaskId === t.id));
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.starts.length === 1 && t.status === 'terminal')).toBe(true);
    // Nothing new: refresh reads one empty page.
    expect(await reader.refresh()).toBe(false);
  });
});
