import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostTool } from 'harness-world';
import { transcriptOf } from 'harness-world-process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptedGateway, text, toolCall, toolResults } from '../../harness-opencode/test/scripted-gateway.ts';
import type { Agent } from '../src/index.ts';
import { sandbox, virtual } from '../src/index.ts';
import { OPENCODE_TOOLS, opencode, opencodeHarness } from '../src/opencode.ts';
import { filesFromState } from '../src/tools.ts';
import { getWorld } from '../src/world.ts';

/**
 * durable-harness/opencode's line (docs/workspaces.md §3.2, §3.3): tool-less
 * by default, OpenCode's own tools with `workspace: virtual()` (narrowed by
 * `builtins`), and the options that need a workspace, or are gone, refused.
 * The turns run real OpenCode against a scripted model.
 */

let named = 0;
/** Each agent needs a name of its own (a session's run records it). */
const agentName = () => `opencode-line-${++named}`;
const MODEL = 'anthropic/claude-haiku-4.5';

describe('opencode(): the options', () => {
  it('tool-less without a line; `builtins` needs a workspace; a copy of a descriptor is refused; sandbox() resolves to the sandbox tier', () => {
    expect(() => opencode({ model: MODEL, name: agentName() })).not.toThrow();
    expect(() => opencode({ model: MODEL, name: agentName(), builtins: true })).toThrow(/^durable-harness\/opencode: `builtins` needs a `workspace`/);
    expect(() => opencode({ model: MODEL, name: agentName(), builtins: ['read'] })).toThrow(TypeError);
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: { ...virtual() } })).toThrow(/copy of a descriptor/);
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: sandbox() })).not.toThrow();
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: sandbox(), builtins: ['read', 'grep'] })).not.toThrow();
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: { ...sandbox() } })).toThrow(/copy of a descriptor/);
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: virtual() })).not.toThrow();
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: virtual(), builtins: ['read', 'glob'] })).not.toThrow();
    expect(() => opencode({ model: MODEL, name: agentName(), workspace: virtual(), builtins: ['webfetch' as never] })).toThrow(/not one of OpenCode's own tools/);
    expect(() => opencodeHarness({ mode: 'embedded' } as never)).toThrow(/^durable-harness\/opencode: `mode` is gone/);
    // The raw harness's test seams are not options here: nothing starts OpenCode elsewhere.
    expect(() => opencode({ model: MODEL, name: agentName(), connect: async () => ({}) } as never)).toThrow(/^durable-harness\/opencode: `connect` is not an option/);
    expect(() => opencodeHarness({ workspace: virtual(), hostHas: () => false } as never)).toThrow(/^durable-harness\/opencode: `hostHas` is not an option/);
    expect(OPENCODE_TOOLS).toEqual(['shell', 'read', 'write', 'edit', 'patch', 'glob', 'grep']);
  });
});

describe('opencode(): turns, real OpenCode, a scripted model', () => {
  let gateway: ScriptedGateway;
  let root: string;
  beforeAll(async () => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'durable-harness-opencode-'));
    root = mkdtempSync(join(tmpdir(), 'dh-opencode-root-'));
    gateway = await scriptedGateway();
  });
  afterAll(async () => {
    await gateway?.close();
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });

  const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** One turn through the agent's chat route; resolves with the session's state once the turn is over. */
  async function turn(agent: Agent, prompt: string) {
    const before = gateway.requests.length;
    const res = await agent.chatRoute({ authorize: 'public' }).POST(post({ text: prompt }));
    expect(res.status).toBe(200);
    await res.text();
    const sessionId = res.headers.get('x-session-id')!;
    for (const start = Date.now(); ; ) {
      const state = await agent.sessions.inspect(sessionId);
      if (transcriptOf(state).some((r) => r.data.type === 'turn')) return { state, requests: gateway.requests.slice(before) };
      if (Date.now() - start > 90_000) throw new Error('the turn did not end');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const toolNames = (body: any) => (body?.tools ?? []).map((t: { name: string }) => t.name).sort();
  const echo: HostTool<{ text: string }> = {
    name: 'echo',
    description: 'Echo the text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    replay: 'safe',
    execute: async ({ text }) => `echo: ${text}`,
  };
  const options = () => ({ model: MODEL, name: agentName(), root, gatewayUrl: gateway.url, credential: async () => 'the-credential' });

  it("no line: only the app's tools are offered, and a call to OpenCode's shell is refused", { timeout: 120_000 }, async () => {
    gateway.script.push(() => toolCall('a1', 'shell', { command: 'printenv' }), () => toolCall('a2', 'echo', { text: 'hi' }), () => text('done'));
    const { requests, state } = await turn(opencode({ ...options(), tools: [echo as HostTool] }), 'Hello.');
    for (const body of requests) expect(toolNames(body)).toEqual(['echo']);
    const r = toolResults(requests.at(-1));
    expect(r.get('a1')).toMatch(/not (currently )?available|No tool named/);
    expect(r.get('a2')).toBe('echo: hi');
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => e.name)).toEqual(['tool.echo']);
  });

  it("workspace: virtual(): OpenCode's own tools next to the app's, writing and reading the session's files in its log", { timeout: 120_000 }, async () => {
    gateway.script.push(
      () => toolCall('b1', 'write', { path: 'notes.md', content: 'kept with the session\n' }),
      () => toolCall('b2', 'read', { path: 'notes.md' }),
      () => text('done')
    );
    const { requests, state } = await turn(opencode({ ...options(), workspace: virtual(), tools: [echo as HostTool] }), 'Write it down.');
    // patch is OpenCode's alternative to edit for some models: OpenCode offers one of the two.
    expect(toolNames(requests[0])).toEqual(['echo', 'edit', 'glob', 'grep', 'read', 'shell', 'write']);
    const r = toolResults(requests.at(-1));
    expect(r.get('b1')).toBe('Created file successfully: notes.md');
    expect(r.get('b2')).toContain('1: kept with the session');
    expect(filesFromState(state)).toEqual({ '/workspace/notes.md': 'kept with the session\n' });
  });

  it('builtins narrows them', { timeout: 120_000 }, async () => {
    gateway.script.push(() => text('done'));
    const { requests } = await turn(opencode({ ...options(), workspace: virtual({ durable: false }), builtins: ['read', 'grep'] }), 'Hello.');
    expect(toolNames(requests[0])).toEqual(['grep', 'read']);
  });
});
