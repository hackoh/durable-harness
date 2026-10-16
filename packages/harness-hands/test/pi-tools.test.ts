import { readFileSync } from 'node:fs';
import { durableSessions, type Harness, type HostTool, QUEUE_PREFIX, rawSessions, type SessionState } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { isPiCodingAgentTool, PI_CODING_AGENT_TOOLS, type PiCodingTool, piCodingTools, prepareEditArguments } from '../src/pi-tools.ts';
import { EPHEMERAL_NOTE, isWorkspaceTool, VIRTUAL_NOTE, type WorkspaceDescriptor, workspaceRuntime } from '../src/runtime.ts';
import { allEvents, type Call, localStore, scripted, toolRecords, until } from '../src/test-harness.ts';
import { WorkspaceDoc, workspaceManifest } from '../src/tools.ts';

/**
 * Pi's coding tools on the workspace (docs/workspaces.md §4.4, the B3 tests
 * of §11.4): pi-coding-agent 1.0.4's definitions, its behaviour on the
 * workspace, and each call's file changes committed with its outcome.
 */

interface FixtureTool {
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/pi-coding-agent-1.0.4.json', import.meta.url), 'utf8')) as {
  version: string;
  createCodingTools: FixtureTool[];
  allTools: FixtureTool[];
  agentToolKeys: { name: string; keys: string[] }[];
};

/**
 * The reviewed edits to pi-coding-agent's descriptions: `read` reads text
 * files only (no image attachments: a HostTool returns text), so it takes
 * Pi's text-file description. Every other description is copied as is; the
 * runtime then adds where the shell runs and, in memory, how long files last.
 */
const EDITED: Record<string, [from: string, to: string]> = {
  read: [
    'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated',
    'Read the contents of a text file. Output is truncated',
  ],
};

const expectedDescription = (t: FixtureTool, durable: boolean): string => {
  const edit = EDITED[t.name];
  if (edit) expect(t.description).toContain(edit[0]);
  let text = edit ? t.description.replace(edit[0], edit[1]) : t.description;
  const notes = [t.name === 'bash' ? VIRTUAL_NOTE : undefined, durable ? undefined : EPHEMERAL_NOTE].filter(Boolean);
  if (notes.length) text = `${text} ${notes.join(' ')}`;
  return text;
};

const durable: WorkspaceDescriptor = { kind: 'virtual', durable: true };
const ephemeral: WorkspaceDescriptor = { kind: 'virtual', durable: false };

describe("Pi's coding tools: pi-coding-agent 1.0.4's definitions", () => {
  it('has its createCodingTools, in order, with its labels and input schemas byte for byte', () => {
    expect(FIXTURE.version).toBe('1.0.4');
    for (const workspace of [durable, ephemeral]) {
      const tools = piCodingTools(workspaceRuntime(workspace));
      expect(tools.map((t) => t.name)).toEqual(FIXTURE.createCodingTools.map((t) => t.name));
      expect(tools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write']);
      for (const [i, native] of FIXTURE.createCodingTools.entries()) {
        const tool = tools[i]!;
        expect(tool.label).toBe(native.label);
        expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(native.parameters));
      }
    }
  });

  it('copies its descriptions, with the reviewed edits and the notes on where they run', () => {
    for (const workspace of [durable, ephemeral]) {
      const tools = piCodingTools(workspaceRuntime(workspace));
      for (const [i, native] of FIXTURE.createCodingTools.entries()) {
        expect(tools[i]!.description).toBe(expectedDescription(native, workspace.kind === 'virtual' && workspace.durable));
      }
    }
    // Only the edits listed above: every other tool's description starts with pi-coding-agent's verbatim.
    const tools = piCodingTools(workspaceRuntime(durable));
    for (const [i, native] of FIXTURE.createCodingTools.entries()) {
      if (!EDITED[native.name]) expect(tools[i]!.description.startsWith(native.description)).toBe(true);
    }
  });

  it('are workspace tools (Claude Code and Codex refuse them), safe to rerun', () => {
    for (const t of piCodingTools(workspaceRuntime(durable))) {
      expect(isWorkspaceTool(t)).toBe(true);
      expect(t.replay).toBe('safe');
    }
  });

  it("knows pi-coding-agent's own tools by name and description, and not its own", () => {
    for (const native of FIXTURE.allTools) expect(native.description.startsWith(PI_CODING_AGENT_TOOLS[native.name]!)).toBe(true);
    expect(Object.keys(PI_CODING_AGENT_TOOLS).sort()).toEqual(FIXTURE.allTools.map((t) => t.name).sort());
    // As createCodingTools() makes them: an AgentTool with these keys.
    for (const { name, keys } of FIXTURE.agentToolKeys) {
      const native = FIXTURE.allTools.find((t) => t.name === name)!;
      const agentTool = Object.fromEntries(keys.map((k) => [k, k === 'name' ? name : k === 'description' ? native.description : undefined]));
      expect(isPiCodingAgentTool(agentTool)).toBe(true);
      // A copy of its description alone, or its keys alone.
      expect(isPiCodingAgentTool({ name, description: native.description, parameters: {}, execute() {} })).toBe(true);
      expect(isPiCodingAgentTool({ ...agentTool, description: 'Something else.' })).toBe(true);
    }
    for (const ours of piCodingTools(workspaceRuntime(durable))) expect(isPiCodingAgentTool(ours)).toBe(false);
    expect(isPiCodingAgentTool({ name: 'shout', description: 'Uppercase some text.', parameters: {}, execute() {} })).toBe(false);
    expect(isPiCodingAgentTool({ name: 'bash', description: 'My own bash.', parameters: {}, execute() {} })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// On a session

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function serve(tools: HostTool[]) {
  const st = await localStore('hw-pi-tools-');
  stores.push(st);
  const world = st.open();
  const s = durableSessions({ world, harness: scripted(tools) });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  return { s, world };
}

type Served = Awaited<ReturnType<typeof serve>>;

async function run({ s }: Served, sessionId: string, calls: Call[]): Promise<SessionState> {
  const before = toolRecords(await s.inspect(sessionId)).length;
  await s.send(sessionId, JSON.stringify({ seq: calls }));
  let state!: SessionState;
  await until(async () => {
    state = await s.inspect(sessionId);
    if (state.status === 'failed') return true;
    const recs = toolRecords(state);
    return recs.length === before + calls.length && recs.every((r) => r.status === 'completed' || r.status === 'failed');
  }, 'tool calls');
  return state;
}

const results = (state: SessionState) => toolRecords(state).map((r) => (r.status === 'completed' ? String(r.output) : `error: ${r.error?.message}`));
const revision = (s: SessionState) => s.docs.get(WorkspaceDoc.definition.kind)?.revision ?? 0;
const files = (s: SessionState) => Object.fromEntries(workspaceManifest(s).map((f) => [f.path, f.text]));
const bashTool = (tools: PiCodingTool[]) => tools.find((t) => t.name === 'bash')!;

describe("Pi's coding tools on a durable virtual workspace", () => {
  it('read, write, edit and bash as pi-coding-agent does, on /workspace', async () => {
    const tools = piCodingTools(workspaceRuntime(durable));
    const served = await serve(tools);
    const { sessionId } = await served.s.start();
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const state = await run(served, sessionId, [
      { tool: 'write', input: { path: 'notes/a.txt', content: 'hello “world”\nsecond\n' } },
      { tool: 'read', input: { path: 'notes/a.txt' } },
      { tool: 'edit', input: { path: '/workspace/notes/a.txt', edits: [{ oldText: 'hello "world"', newText: 'hi' }, { oldText: 'second', newText: '2nd' }] } },
      { tool: 'bash', input: { command: 'cat notes/a.txt; pwd; echo "home=$HOME"' } },
      { tool: 'write', input: { path: 'ten.txt', content: ten } },
      { tool: 'read', input: { path: 'ten.txt', offset: 3, limit: 2 } },
      { tool: 'read', input: { path: '~/ten.txt', offset: 11 } },
      { tool: 'edit', input: { path: 'ten.txt', edits: [{ oldText: 'line', newText: 'x' }] } },
      { tool: 'edit', input: { path: 'ten.txt', edits: [{ oldText: 'nowhere', newText: 'x' }] } },
      { tool: 'edit', input: { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] } },
      { tool: 'read', input: { path: 'missing.txt' } },
    ]);
    const out = results(state);
    expect(out[0]).toBe('Successfully wrote to notes/a.txt');
    expect(out[1]).toBe('hello “world”\nsecond\n');
    // Fuzzy matching (smart quotes), both edits against the original.
    expect(out[2]).toBe('Successfully replaced 2 block(s) in /workspace/notes/a.txt.');
    expect(out[3]).toBe('hi\n2nd\n/workspace\nhome=/workspace\n');
    expect(out[5]).toBe('line 3\nline 4\n\n[6 more lines in file. Use offset=5 to continue.]');
    expect(out[6]).toBe('error: Offset 11 is beyond end of file (10 lines total)');
    expect(out[7]).toBe('error: Found 10 occurrences of the text in ten.txt. The text must be unique. Please provide more context to make it unique.');
    expect(out[8]).toBe('error: Could not find the exact text in ten.txt. The old text must match exactly including all whitespace and newlines.');
    expect(out[9]).toBe('error: Could not edit file: missing.txt. Error code: ENOENT.');
    expect(out[10]).toMatch(/^error: .*ENOENT/);
    expect(files(state)).toEqual({ '/workspace/notes/a.txt': 'hi\n2nd\n', '/workspace/ten.txt': ten });
  });

  it('truncates as pi-coding-agent does: a file from its head, a command from its tail, the rest in /tmp', async () => {
    const served = await serve(piCodingTools(workspaceRuntime(durable)));
    const { sessionId } = await served.s.start();
    const state = await run(served, sessionId, [
      { tool: 'bash', input: { command: 'seq 1 2500 > big.txt; seq 1 3000' } },
      { tool: 'read', input: { path: 'big.txt' } },
      { tool: 'bash', input: { command: 'true' } },
    ]);
    const [cmd, read, quiet] = results(state);
    expect(cmd).toMatch(/^1001\n1002\n[\s\S]*\n3000\n\n\[Showing lines 1001-3000 of 3000\. Full output: \/tmp\/pi-bash-[a-z0-9]+\.log\]$/);
    expect(read).toMatch(/^1\n2\n[\s\S]*\n2000\n\n\[Showing lines 1-2000 of 2501\. Use offset=2001 to continue\.\]$/);
    expect(quiet).toBe('(no output)');
    // The full output is a temp file of the workspace's shell, not one of the session's files.
    const spilled = cmd!.match(/Full output: (\S+)\]/)![1]!;
    const later = await run(served, sessionId, [{ tool: 'bash', input: { command: `wc -l < ${spilled}` } }]);
    expect(results(later)[3]).toBe('3000\n');
    expect(Object.keys(files(later))).toEqual(['/workspace/big.txt']);
  });

  it("commits each call's changes with its outcome: a failing command keeps what it changed, a call that throws keeps nothing", async () => {
    const tools = piCodingTools(workspaceRuntime({ kind: 'virtual', durable: true, timeoutMs: 1500 }));
    const served = await serve(tools);
    const { sessionId } = await served.s.start();
    let state = await run(served, sessionId, [{ tool: 'write', input: { path: 'a.txt', content: 'one\n' } }]);
    // One edit of the manifest, on the call's own outcome: the call's intent and outcome are the only steps it wrote.
    expect(revision(state)).toBe(1);
    expect(files(state)).toEqual({ '/workspace/a.txt': 'one\n' });
    const steps = (await allEvents(served.world, sessionId)).filter((e) => e.eventType === 'step_started' || e.eventType === 'step_completed');
    expect(steps).toHaveLength(2);
    expect(state.effectOrder.some((e) => e.name === 'fs')).toBe(false);

    state = await run(served, sessionId, [
      // Exits 3 after writing: an error result for Pi, a call that succeeded, so its file stays.
      { tool: 'bash', input: { command: 'echo two > b.txt; echo oops >&2; exit 3' } },
      // Past the workspace's time limit: the call fails and nothing it changed is kept.
      { tool: 'bash', input: { command: 'echo three > c.txt; sleep 5' } },
      // Past the timeout the model gave: an error result; what it wrote before stays.
      { tool: 'bash', input: { command: 'echo four > d.txt; sleep 3', timeout: 0.5 } },
      { tool: 'bash', input: { command: 'ls' } },
    ]);
    const out = results(state);
    expect(out[1]).toBe('oops\n\n\nCommand exited with code 3');
    expect(bashTool(tools).isErrorResult!(out[1]!)).toBe(true);
    expect(out[2]).toMatch(/^error: the command ran past its time limit/);
    expect(out[3]).toBe('Command timed out after 0.5 seconds');
    expect(bashTool(tools).isErrorResult!(out[3]!)).toBe(true);
    expect(out[4]).toBe('a.txt\nb.txt\nd.txt\n');
    expect(bashTool(tools).isErrorResult!(out[4]!)).toBe(false);
    expect(Object.keys(files(state)).sort()).toEqual(['/workspace/a.txt', '/workspace/b.txt', '/workspace/d.txt']);
  });

  it('reads text files, refuses an image, and leaves bytes that are not UTF-8 to bash', async () => {
    const served = await serve(piCodingTools(workspaceRuntime(durable)));
    const { sessionId } = await served.s.start();
    // A 1x1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const state = await run(served, sessionId, [
      { tool: 'bash', input: { command: `echo ${png} | base64 -d > dot.png; echo //54 | base64 -d > bin.dat` } },
      { tool: 'read', input: { path: 'dot.png' } },
      { tool: 'edit', input: { path: 'bin.dat', edits: [{ oldText: 'x', newText: 'y' }] } },
    ]);
    const out = results(state);
    expect(out[1]).toBe('error: dot.png is an image (image/png); reading images is not supported');
    expect(out[2]).toBe('error: Could not edit file: bin.dat. It is not UTF-8 text: edit it with bash.');
  });

  it("takes edits as models send them (pi-coding-agent's prepareArguments)", () => {
    const one = { oldText: 'a', newText: 'b' };
    expect(prepareEditArguments({ path: 'f', edits: JSON.stringify([one]) })).toEqual({ path: 'f', edits: [one] });
    expect(prepareEditArguments({ path: 'f', edits: JSON.stringify(one) })).toEqual({ path: 'f', edits: [one] });
    expect(prepareEditArguments({ path: 'f', edits: one })).toEqual({ path: 'f', edits: [one] });
    expect(prepareEditArguments({ path: 'f', oldText: 'a', newText: 'b' })).toEqual({ path: 'f', edits: [one] });
    const edit = piCodingTools(workspaceRuntime(durable)).find((t) => t.name === 'edit')!;
    expect(edit.prepareArguments).toBe(prepareEditArguments);
  });
});

describe("Pi's coding tools in memory", () => {
  it('keep files for the turn, write nothing to the log, and say so', async () => {
    const tools = piCodingTools(workspaceRuntime(ephemeral));
    for (const t of tools) expect(t.description).toContain(EPHEMERAL_NOTE);
    const served = await serve(tools);
    const { sessionId } = await served.s.start();
    let state = await run(served, sessionId, [
      { tool: 'write', input: { path: 'a.txt', content: 'turn one' } },
      { tool: 'read', input: { path: 'a.txt' } },
    ]);
    expect(results(state)[1]).toBe('turn one');
    expect(revision(state)).toBe(0);
    state = await run(served, sessionId, [{ tool: 'read', input: { path: 'a.txt' } }]);
    expect(results(state)[2]).toMatch(/^error: .*ENOENT/);
  });

  it('serve a durable workspace whose session has no World (durability off), for the turn', async () => {
    const tools = piCodingTools(workspaceRuntime(durable), { inMemory: workspaceRuntime(ephemeral) });
    // The descriptions are the durable ones: the same tools, whatever the session's durability.
    expect(tools.map((t) => t.description)).toEqual(piCodingTools(workspaceRuntime(durable)).map((t) => t.description));
    const raw = rawSessions({ harness: scripted(tools) as Harness });
    const { sessionId } = await raw.start();
    await raw.send(sessionId, JSON.stringify({ seq: [{ tool: 'write', input: { path: 'a.txt', content: 'no world' } }, { tool: 'read', input: { path: 'a.txt' } }] }));
    await raw.idle(sessionId);
    const state = await raw.inspect(sessionId);
    expect(results(state)).toEqual(['Successfully wrote to a.txt', 'no world']);
    // Without the fallback, a durable workspace refuses a session with no World.
    const bare = rawSessions({ harness: scripted(piCodingTools(workspaceRuntime(durable))) });
    const b = await bare.start();
    await bare.send(b.sessionId, JSON.stringify({ tool: 'write', input: { path: 'a.txt', content: 'x' } }));
    await bare.idle(b.sessionId);
    expect(results(await bare.inspect(b.sessionId))[0]).toMatch(/^error: .*use virtual\(\{ durable: false \}\)/);
  });
});
