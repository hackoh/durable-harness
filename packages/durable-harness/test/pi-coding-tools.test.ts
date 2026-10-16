import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { isWorkspaceTool } from 'harness-world-hands/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSettled, sandbox, virtual } from '../src/index.ts';
import { createCodingTools, pi, piHarness } from '../src/pi.ts';
import { readWorkspace } from '../src/tools.ts';
import { getWorld } from '../src/world.ts';

/**
 * durable-harness/pi's tools (docs/workspaces.md §3.2, §3.3): tool-less by
 * default, Pi's coding tools on a workspace in one line, and
 * pi-coding-agent's own tools refused.
 */

const FIXTURE = JSON.parse(readFileSync(new URL('../../harness-hands/test/fixtures/pi-coding-agent-1.0.4.json', import.meta.url), 'utf8')) as {
  allTools: { name: string; description: string }[];
  agentToolKeys: { name: string; keys: string[] }[];
};

/** A tool shaped as pi-coding-agent's `createCodingTools(cwd)` makes it (its keys, name and description). */
function piCodingAgentTool(name: string) {
  // grep, find, ls and powershell come from the same wrapper as the four createCodingTools() returns.
  const { keys } = FIXTURE.agentToolKeys.find((t) => t.name === name) ?? FIXTURE.agentToolKeys[0]!;
  const { description } = FIXTURE.allTools.find((t) => t.name === name)!;
  const tool: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, undefined]));
  return Object.assign(tool, { name, label: name, description, parameters: { type: 'object', properties: {} }, async execute() { throw new Error('ran on the host'); } });
}

let named = 0;
/** Each agent needs a name of its own (a session's run records it). */
const agentName = () => `pi-tools-${++named}`;

function faux(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses(responses);
  return { model: provider.getModel(), streamFn: models.streamSimple.bind(models) };
}

describe('createCodingTools(workspace)', () => {
  it("is Pi's read, bash, edit and write, as workspace tools", () => {
    const tools = createCodingTools(virtual());
    expect(tools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write']);
    for (const t of tools) {
      expect(isWorkspaceTool(t)).toBe(true);
      expect(t.replay).toBe('safe');
      expect(t.description).not.toContain('Files last until the end of this turn.');
    }
    expect(tools.find((t) => t.name === 'bash')!.description).toContain('not real Linux: no network, no package installs, no real processes');
    for (const t of createCodingTools(virtual({ durable: false }))) expect(t.description).toContain('Files last until the end of this turn.');
  });

  it("on sandbox(): the same four, in the session's VM: read safe to rerun, the rest never", () => {
    const tools = createCodingTools(sandbox());
    expect(tools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write']);
    const virtualOnes = createCodingTools(virtual());
    for (const [i, t] of tools.entries()) {
      expect(isWorkspaceTool(t)).toBe(true);
      expect(t.replay).toBe(t.name === 'read' ? 'safe' : 'never');
      expect(JSON.stringify(t.inputSchema)).toBe(JSON.stringify(virtualOnes[i]!.inputSchema));
      expect(t.description).not.toContain('not real Linux');
    }
    expect(tools.find((t) => t.name === 'bash')!.description).toContain("It runs in this session's own sandbox, a Linux VM");
  });

  it('refuses a copy of a descriptor', () => {
    expect(() => createCodingTools({ ...virtual() })).toThrow(TypeError);
    expect(() => createCodingTools({ ...sandbox() })).toThrow(TypeError);
  });
});

describe("pi() refuses pi-coding-agent's own tools", () => {
  it('in pi() and in piHarness(), naming the replacement', () => {
    for (const { name } of FIXTURE.allTools) {
      const tool = piCodingAgentTool(name);
      expect(() => pi({ model: 'anthropic/claude-haiku-4.5', name: agentName(), tools: [tool as never] })).toThrow(TypeError);
      expect(() => pi({ model: 'anthropic/claude-haiku-4.5', name: agentName(), tools: [tool as never] })).toThrow(/pi-coding-agent's own[\s\S]*createCodingTools\(virtual\(\)\)/);
      const { model, streamFn } = faux([]);
      expect(() => piHarness({ model, streamFn, tools: [tool as never] })).toThrow(/createCodingTools\(virtual\(\)\)/);
    }
  });

  it('and takes its own coding tools, and none (tool-less by default)', () => {
    expect(() => pi({ model: 'anthropic/claude-haiku-4.5', name: agentName(), tools: createCodingTools(virtual()) })).not.toThrow();
    expect(() => pi({ model: 'anthropic/claude-haiku-4.5', name: agentName() })).not.toThrow();
  });
});

describe('Pi with createCodingTools(virtual()), on a session', () => {
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'durable-harness-pi-tools-'));
  });
  afterAll(async () => {
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });

  it("writes and reads through Pi's tools, with a failing command an error result whose files stay", async () => {
    const { model, streamFn } = faux([
      fauxAssistantMessage(fauxToolCall('write', { path: 'notes/a.txt', content: 'hello\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'cat notes/a.txt; echo kept > b.txt; exit 3' }), { stopReason: 'toolUse' }),
      // A model's edit with `edits` as a JSON string: pi-coding-agent's prepareArguments takes it.
      fauxAssistantMessage(fauxToolCall('edit', { path: 'notes/a.txt', edits: JSON.stringify([{ oldText: 'hello', newText: 'hi' }]) }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read', { path: 'notes/a.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('done')),
    ]);
    const agent = pi({ model, streamFn, getApiKey: () => 'faux', name: agentName(), tools: createCodingTools(virtual()) });
    await getWorld();
    const { sessionId } = await agent.sessions.start({ prompt: 'write, run, edit and read' });
    const deadline = Date.now() + 60_000;
    let state = await agent.sessions.inspect(sessionId);
    while (!(state.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length === 5 && isSettled(state))) {
      if (state.status === 'failed' || Date.now() > deadline) throw new Error(`session did not finish: ${state.failure?.message ?? 'timed out'} ${JSON.stringify(state.effectOrder.map((e) => [e.name, e.status, e.error?.message]))} ${state.status}`);
      await new Promise((r) => setTimeout(r, 50));
      state = await agent.sessions.inspect(sessionId);
    }
    const tools = state.effectOrder.filter((e) => e.name.startsWith('tool.'));
    expect(tools.map((e) => [e.name, e.status])).toEqual([
      ['tool.write', 'completed'],
      ['tool.bash', 'completed'],
      ['tool.edit', 'completed'],
      ['tool.read', 'completed'],
    ]);
    // What Pi put in the transcript for each call: the bash call is an error result, the others are not.
    const results = state.effectOrder
      .filter((e) => e.name === 'model')
      .flatMap((e) => ((e.input as { appended?: { role: string; toolName?: string; isError?: boolean; content: { text?: string }[] }[] }).appended ?? []))
      .filter((m) => m.role === 'toolResult')
      .map((m) => [m.toolName, m.isError, m.content.map((c) => c.text).join('')]);
    expect(results).toEqual([
      ['write', false, 'Successfully wrote to notes/a.txt'],
      ['bash', true, 'hello\n\n\nCommand exited with code 3'],
      ['edit', false, 'Successfully replaced 1 block(s) in notes/a.txt.'],
      ['read', false, 'hi\n'],
    ]);
    expect(await readWorkspace(await getWorld(), state)).toEqual({ '/workspace/notes/a.txt': 'hi\n', '/workspace/b.txt': 'kept\n' });
  }, 90_000);

  it("with createCodingTools(sandbox()), attaches the session's sandbox at the first call (the sandbox tier loaded then), and a call it can't attach for doesn't run, saying why", async () => {
    // No Vercel project here (no link up the tree, no VERCEL_PROJECT_ID): the session factory stops before any Sandbox API call.
    const cwd = process.cwd();
    const projectId = process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_PROJECT_ID;
    process.chdir(mkdtempSync(join(tmpdir(), 'durable-harness-pi-sandbox-')));
    try {
      const { model, streamFn } = faux([fauxAssistantMessage(fauxToolCall('bash', { command: 'echo hi' }), { stopReason: 'toolUse' }), fauxAssistantMessage(fauxText('done'))]);
      const agent = pi({ model, streamFn, getApiKey: () => 'faux', name: agentName(), tools: createCodingTools(sandbox()) });
      await getWorld();
      const { sessionId } = await agent.sessions.start({ prompt: 'run it' });
      const deadline = Date.now() + 60_000;
      let state = await agent.sessions.inspect(sessionId);
      while (!(state.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length === 2 && isSettled(state))) {
        if (state.status === 'failed' || Date.now() > deadline) throw new Error(`session did not finish: ${state.failure?.message ?? 'timed out'} ${JSON.stringify(state.effectOrder.map((e) => [e.name, e.status, e.error?.message]))}`);
        await new Promise((r) => setTimeout(r, 50));
        state = await agent.sessions.inspect(sessionId);
      }
      expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([
        ['model', 'completed'],
        ['sandbox.attach', 'completed'],
        ['tool.bash', 'failed'],
        ['model', 'completed'],
      ]);
      expect(state.effectOrder[1]!.output).toMatchObject({ attached: false, error: expect.stringMatching(/no Vercel project for the sandbox/) });
      expect(state.effectOrder[2]!.error?.message).toMatch(/^not run: the sandbox could not be attached \(harness-sandbox: no Vercel project for the sandbox: set VERCEL_PROJECT_ID/);
      expect(state.effectOrder[2]!.error?.interrupted).toBeFalsy();
    } finally {
      process.chdir(cwd);
      if (projectId !== undefined) process.env.VERCEL_PROJECT_ID = projectId;
    }
  }, 90_000);
});
