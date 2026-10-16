import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, type FauxResponseStep, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, type HostTool, isSettled, QUEUE_PREFIX, rawSessions, readDoc, type SessionState } from 'harness-world';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isPiCodingAgentTool, isWorkspaceTool, type PhasedTool, piCodingTools, SANDBOX_INSTRUCTIONS, SANDBOX_NOTE, sandboxRuntime, VIRTUAL_NOTE, workspaceRuntime } from '../../harness-hands/src/runtime-exports.ts';
import { devRelayArtifact, FILES_LOST_NOTE, prepareBase, SANDBOX_DOC, sandboxSession, sessionName, vercelSandboxApi } from '../../harness-sandbox/src/index.ts';
import { piHarness } from '../src/index.ts';
import { FakeSandboxApi, relayBundle, sandboxCodingTools, seededStandIn, STAND_IN_PROJECT, standIn } from './stand-in.ts';

/**
 * B7 for Pi (docs/workspaces.md §11.4): the suites Pi's Function-tier item
 * (B3) added for `createCodingTools(virtual())` (pi-coding-agent 1.0.4's
 * definitions, its behaviour on the workspace, each call's changes kept with
 * its outcome, a SIGKILL mid-call), run on a sandbox instead: Pi's own agent
 * loop (`piHarness`, a scripted model: pi-ai's faux provider) on a World
 * (world-local), its `read`, `bash`, `edit` and `write` built the way
 * `createCodingTools(sandbox())` builds them (harness-world-hands' sandbox
 * runtime, the kernel's `attachInDrive`: a `sandbox.attach` fact with the
 * drive's own fencing token read inside it, the `hw.sandbox` record),
 * through the sandbox tier's real session factory (`sandboxSession`, A3).
 *
 * The sandbox is the stand-in (§5.8, always on: `DH_TEST_LOCAL_SANDBOX=1`):
 * each "VM" a local relay child over temp dirs (`localMachine()`'s relay,
 * through harness-sandbox's fake Sandbox API), each "Drive" a temp dir that
 * outlives the VMs mounted on it, each machine's workspace seen at
 * /workspace (`test/stand-in.ts`). In the degraded tier (macOS,
 * unprivileged Linux) its commands run as this user on this machine.
 *
 * With `DH_LIVE_SANDBOX=1`, the last case runs on a live Vercel Sandbox
 * through the same factory and the real Sandbox API (see there).
 */

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const CHILD = fileURLToPath(new URL('./sandbox-child.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

interface FixtureTool {
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
}
const FIXTURE = JSON.parse(readFileSync(new URL('../../harness-hands/test/fixtures/pi-coding-agent-1.0.4.json', import.meta.url), 'utf8')) as { version: string; createCodingTools: FixtureTool[] };

let world: LocalWorld;
let base: string;
const envKeys = ['DH_TEST_LOCAL_SANDBOX', 'VERCEL'] as const;
const env0: Partial<Record<(typeof envKeys)[number], string>> = {};
const apis: FakeSandboxApi[] = [];
const closers: (() => unknown)[] = [];

beforeAll(async () => {
  for (const k of envKeys) env0[k] = process.env[k];
  // The stand-in's guard (§5.8): the test flag, a test runner, not on Vercel.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
  // The relay bundle, built once (esbuild, in a temp dir of its own).
  await relayBundle();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-sandbox-')));
  world = createWorld({ dataDir: join(base, 'world'), recoverActiveRuns: false });
}, 120_000);

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const api of apis.splice(0)) await api.dispose();
});

afterAll(async () => {
  await world?.close?.();
  for (const k of envKeys) {
    if (env0[k] === undefined) delete process.env[k];
    else process.env[k] = env0[k];
  }
  rmSync(base, { recursive: true, force: true });
});

/** A stand-in sandbox (a fake Sandbox API, the session factory over it) and Pi's coding tools on it. */
function sandbox(options: Parameters<typeof standIn>[0] = {}) {
  const s = standIn(options);
  if (!options.api) apis.push(s.api);
  return s;
}

/** A scripted model (pi-ai's faux provider). */
function scriptedModel() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}
type Model = ReturnType<typeof scriptedModel>;

function serve(tools: HostTool[], model: Model = scriptedModel()) {
  const sessions = durableSessions({ world, harness: piHarness({ model: model.model, streamFn: model.streamFn, tools }) });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  return { sessions, model };
}
type Served = ReturnType<typeof serve>;

/** A tool call the model makes (its turn goes on after the result). */
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

/** Model steps that ended a turn (no tool call). */
const finals = (s: SessionState) => s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed' && (e.output as { stopReason?: string })?.stopReason !== 'toolUse').length;
const unavailable = (s: SessionState) => s.effectOrder.filter((e) => e.name === 'unavailable').length;

/** Send `prompt` (or start a session with it), with the model's script for the turn, and wait for the turn to end. */
async function turn({ sessions, model }: Served, prompt: string, script: FauxResponseStep[], sessionId?: string) {
  await world.start?.();
  model.faux.setResponses(script);
  let id = sessionId;
  let done = 0;
  let stopped = 0;
  if (id) {
    const before = await sessions.inspect(id);
    done = finals(before);
    stopped = unavailable(before);
    await sessions.send(id, prompt);
  } else id = (await sessions.start({ prompt })).sessionId;
  const state = await until(async () => {
    const s = await sessions.inspect(id!);
    if (s.status === 'failed') throw new Error(`session failed: ${s.failure?.message}`);
    return (finals(s) > done && isSettled(s)) || unavailable(s) > stopped ? s : undefined;
  });
  return { sessionId: id, state };
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Result {
  tool: string;
  error: boolean;
  text: string;
}
/** The tool results Pi gave the model, in order (what each model step placed). */
function results(state: SessionState): Result[] {
  type Appended = { role: string; toolName?: string; isError?: boolean; content: { type: string; text?: string }[] };
  return state.effectOrder
    .filter((e) => e.name === 'model')
    .flatMap((e) => ((e.input as { appended?: Appended[] }).appended ?? []))
    .filter((m) => m.role === 'toolResult')
    .map((m) => ({ tool: m.toolName!, error: !!m.isError, text: m.content.map((c) => c.text ?? '').join('') }));
}
const texts = (state: SessionState) => results(state).map((r) => (r.error ? `error: ${r.text}` : r.text));
const tools = (state: SessionState) => state.effectOrder.filter((e) => e.name.startsWith('tool.'));
const attaches = (state: SessionState) => state.effectOrder.filter((e) => e.name === 'sandbox.attach');
/** The session's sandbox (and Drive) name on the stand-in's project. */
const nameOf = (sessionId: string) => sessionName(STAND_IN_PROJECT, sessionId);
const onDrive = (api: FakeSandboxApi, sessionId: string, path: string) => {
  const p = join(api.driveDir(nameOf(sessionId)), path);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
};

describe("Pi's coding tools on a sandbox: pi-coding-agent 1.0.4's definitions", () => {
  it('the same tools, labels and input schemas byte for byte; the descriptions say where they run; read is safe to rerun, the rest never', () => {
    const { api, tools: onSandbox } = sandbox();
    expect(FIXTURE.version).toBe('1.0.4');
    const onVirtual = piCodingTools(workspaceRuntime({ kind: 'virtual', durable: true }));
    expect(onSandbox.map((t) => t.name)).toEqual(FIXTURE.createCodingTools.map((t) => t.name));
    for (const [i, native] of FIXTURE.createCodingTools.entries()) {
      const tool = onSandbox[i]!;
      expect(tool.label).toBe(native.label);
      expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(native.parameters));
      // Pi's description (with the reviewed text-file edit to read's, as on a virtual workspace); the shell says it runs in the session's VM.
      const virtual = onVirtual[i]!.description.replace(` ${VIRTUAL_NOTE}`, '');
      expect(tool.description).toBe(native.name === 'bash' ? `${virtual} ${SANDBOX_NOTE}` : virtual);
      expect(tool.description).not.toContain(VIRTUAL_NOTE);
      expect(tool.replay).toBe(native.name === 'read' ? 'safe' : 'never');
      expect(isWorkspaceTool(tool)).toBe(true);
      expect(isPiCodingAgentTool(tool)).toBe(false);
      expect(typeof (tool as PhasedTool).beforeIntent).toBe('function');
      expect(typeof (tool as PhasedTool).afterDrive).toBe('function');
    }
    // bash keeps Pi's prepare and error hooks.
    expect(typeof (onSandbox[1] as { isErrorResult?: unknown }).isErrorResult).toBe('function');
    expect(typeof (onSandbox[2] as { prepareArguments?: unknown }).prepareArguments).toBe('function');
    expect(sandboxRuntime({ attach: async () => Promise.reject(new Error('unused')), told() {} }).instructions).toBe(SANDBOX_INSTRUCTIONS);
    // Making them touches no Sandbox API.
    expect(api.calls).toEqual([]);
  });
});

describe("Pi's coding tools on a sandbox, on a session (the stand-in)", () => {
  it("read, write, edit and bash as pi-coding-agent does, in the session's VM, attached at the first call", { timeout: 120_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    const served = serve(onSandbox);
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const { sessionId, state } = await turn(served, 'write, read, edit and run', [
      call('write', { path: 'notes/a.txt', content: 'hello “world”\nsecond\n' }),
      call('read', { path: 'notes/a.txt' }),
      call('edit', { path: '/workspace/notes/a.txt', edits: [{ oldText: 'hello "world"', newText: 'hi' }, { oldText: 'second', newText: '2nd' }] }),
      call('bash', { command: 'cat notes/a.txt; pwd; echo "home=$HOME"' }),
      call('write', { path: 'ten.txt', content: ten }),
      call('read', { path: 'ten.txt', offset: 3, limit: 2 }),
      call('read', { path: '~/ten.txt', offset: 11 }),
      call('edit', { path: 'ten.txt', edits: [{ oldText: 'line', newText: 'x' }] }),
      call('edit', { path: 'ten.txt', edits: [{ oldText: 'nowhere', newText: 'x' }] }),
      call('edit', { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
      call('read', { path: 'missing.txt' }),
      // A model's edit with `edits` as a JSON string: pi-coding-agent's prepareArguments takes it.
      call('edit', { path: 'ten.txt', edits: JSON.stringify([{ oldText: 'line 10', newText: 'ten' }]) }),
      say('done'),
    ]);
    const out = texts(state);
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
    expect(out[11]).toBe('Successfully replaced 1 block(s) in ten.txt.');
    // The files are on the session's Drive, not in the log.
    expect(onDrive(api, sessionId, 'notes/a.txt')).toBe('hi\n2nd\n');
    expect(onDrive(api, sessionId, 'ten.txt')).toBe(ten.replace('line 10', 'ten'));
    expect(state.docs.has('hw.workspace')).toBe(false);
    expect(readDoc(state, SANDBOX_DOC).value).toMatchObject({ driveId: api.drives.get(nameOf(sessionId))!.info.driveId });
    // One attach, with the drive's own fencing token, before the first call's intent.
    const [attach] = attaches(state);
    expect(attaches(state)).toHaveLength(1);
    expect(attach).toMatchObject({ status: 'completed', output: { attached: true, fence: expect.any(Number), notes: 0 } });
    expect(state.effectOrder.indexOf(attach!)).toBeLessThan(state.effectOrder.indexOf(tools(state)[0]!));
    // Only a read is safe to run again: on a Drive a cut-off call may have half-run.
    for (const t of tools(state)) expect([t.name, t.replay]).toEqual([t.name, t.name === 'tool.read' ? 'safe' : 'never']);
    expect(api.calls.filter((c) => c.startsWith('createSandbox:'))).toHaveLength(1);
  });

  it('a turn that runs no tool boots no sandbox', { timeout: 60_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    const { state } = await turn(serve(onSandbox), 'Hello.', [say('Hi.')]);
    expect(attaches(state)).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('truncates as pi-coding-agent does: a file from its head, a command from its tail, the rest in the VM\'s /tmp', { timeout: 120_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    let spilled = '';
    const { sessionId, state } = await turn(serve(onSandbox), 'make big output', [
      call('bash', { command: 'seq 1 2500 > big.txt; seq 1 3000' }),
      call('read', { path: 'big.txt' }),
      call('bash', { command: 'true' }),
      // The fourth call reads the file the first one's output was saved to.
      (context) => {
        const first = context.messages.find((m) => m.role === 'toolResult') as { content: { text?: string }[] };
        spilled = first.content.map((c) => c.text ?? '').join('').match(/Full output: (\S+)\]/)![1]!;
        return call('bash', { command: `awk 'END { print NR }' ${spilled}` });
      },
      say('done'),
    ]);
    closers.push(() => rmSync(spilled, { force: true }));
    const [cmd, read, quiet, count] = texts(state);
    expect(cmd).toMatch(/^1001\n1002\n[\s\S]*\n3000\n\n\[Showing lines 1001-3000 of 3000\. Full output: \/tmp\/pi-bash-[a-z0-9]+\.log\]$/);
    expect(read).toMatch(/^1\n2\n[\s\S]*\n2000\n\n\[Showing lines 1-2000 of 2501\. Use offset=2001 to continue\.\]$/);
    expect(quiet).toBe('(no output)');
    expect(count).toBe('3000\n');
    // The full output is a temp file of the VM, not one of the session's files.
    expect(onDrive(api, sessionId, 'big.txt')).toBeDefined();
    expect(existsSync(join(api.driveDir(nameOf(sessionId)), 'tmp'))).toBe(false);
  });

  it('keeps what a call changed with its outcome, as a disk does: a failing command, a timeout the model gave, and (unlike a virtual workspace) a command cut off at its limit', { timeout: 120_000 }, async () => {
    const { api, tools: onSandbox } = sandbox({ spec: { commandTimeoutMs: 1500 } });
    const { sessionId, state } = await turn(serve(onSandbox), 'run them', [
      // Exits 3 after writing: an error result for Pi, a call that succeeded, so its file stays.
      call('bash', { command: 'echo two > b.txt; echo oops >&2; exit 3' }),
      // Past the sandbox's command limit: the call fails, saying what it wrote may be there; the Drive kept it.
      call('bash', { command: 'echo three > c.txt; sleep 5' }),
      // Past the timeout the model gave: an error result; what it wrote before stays.
      call('bash', { command: 'echo four > d.txt; sleep 3', timeout: 0.5 }),
      call('bash', { command: 'ls' }),
      say('done'),
    ]);
    const out = results(state);
    expect(out[0]).toEqual({ tool: 'bash', error: true, text: 'oops\n\n\nCommand exited with code 3' });
    expect(out[1]!.error).toBe(true);
    expect(out[1]!.text).toMatch(/ran past its time limit \(1\.5 s\), so it was stopped: partial effects may exist/);
    expect(out[2]).toEqual({ tool: 'bash', error: true, text: 'Command timed out after 0.5 seconds' });
    expect(out[3]).toEqual({ tool: 'bash', error: false, text: 'b.txt\nc.txt\nd.txt\n' });
    expect(tools(state).map((t) => t.status)).toEqual(['completed', 'failed', 'completed', 'completed']);
    expect(onDrive(api, sessionId, 'c.txt')).toBe('three\n');
  });

  it('reads text files, refuses an image, and leaves bytes that are not UTF-8 to bash', { timeout: 120_000 }, async () => {
    const { tools: onSandbox } = sandbox();
    // A 1x1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const { state } = await turn(serve(onSandbox), 'files', [
      call('bash', { command: `echo ${png} | base64 -d > dot.png; echo //54 | base64 -d > bin.dat` }),
      call('read', { path: 'dot.png' }),
      call('edit', { path: 'bin.dat', edits: [{ oldText: 'x', newText: 'y' }] }),
      say('done'),
    ]);
    const out = texts(state);
    expect(out[1]).toBe('error: dot.png is an image (image/png); reading images is not supported');
    expect(out[2]).toBe('error: Could not edit file: bin.dat. It is not UTF-8 text: edit it with bash.');
  });

  it('an attach that fails: the call is "not run", a definite outcome, nothing ran; the next call attaches and runs', { timeout: 120_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    // The arm's control-plane command fails for now (a 503): the attach yields `contended`.
    api.failRuns = { count: 1, error: () => Object.assign(new Error('Service Unavailable'), { response: { status: 503 } }) };
    const { sessionId, state } = await turn(serve(onSandbox), 'run them', [
      call('bash', { command: 'echo first > first.txt' }),
      call('bash', { command: 'echo second > second.txt; cat second.txt' }),
      say('done'),
    ]);
    expect(results(state)).toEqual([
      { tool: 'bash', error: true, text: 'not run: the sandbox is starting, try again' },
      { tool: 'bash', error: false, text: 'second\n' },
    ]);
    const [n1, n2] = tools(state);
    expect(n1).toMatchObject({ name: 'tool.bash', status: 'failed', error: { message: 'not run: the sandbox is starting, try again' } });
    expect(n1!.error?.interrupted).toBeFalsy();
    expect(n2).toMatchObject({ name: 'tool.bash', status: 'completed' });
    expect(onDrive(api, sessionId, 'first.txt')).toBeUndefined();
    expect(onDrive(api, sessionId, 'second.txt')).toBe('second\n');
    // Both attaches before their call's intent: the first recorded busy, the second attached.
    expect(attaches(state).map((e) => e.output)).toEqual([{ attached: false, yield: 'contended' }, expect.objectContaining({ attached: true })]);
    const order = state.effectOrder.map((e) => e.name);
    expect(order.slice(order.indexOf('sandbox.attach'))).toEqual(['sandbox.attach', 'tool.bash', 'model', 'sandbox.attach', 'tool.bash', 'model']);
  });

  it('files last across VMs: written on VM A, VM A deleted, read on VM B over the same Drive', { timeout: 180_000 }, async () => {
    const { api, tools: onA } = sandbox();
    const a = await turn(serve(onA), 'Write the notes.', [
      call('write', { path: 'notes/a.txt', content: 'written on VM A\n' }),
      call('bash', { command: 'echo "$(cat notes/a.txt) and by its shell" > notes/shell.txt; cat notes/shell.txt' }),
      say('done'),
    ]);
    expect(texts(a.state)[1]).toBe('written on VM A and by its shell\n');
    const name = nameOf(a.sessionId);
    const vmA = api.vms.get(name)!.sessionId;
    const driveId = api.drives.get(name)!.info.driveId;

    // VM A goes (its relay, rootfs and cache dirs with it); the Drive stays. Another process drives the next turn: its own factory.
    await (await api.getSandbox(name))!.delete();
    expect(api.vms.has(name)).toBe(false);
    const { tools: onB } = sandbox({ api });
    const b = await turn(serve(onB), 'Read the notes.', [call('read', { path: 'notes/a.txt' }), call('bash', { command: 'cat notes/shell.txt; ls notes' }), say('read them')], a.sessionId);
    expect(texts(b.state).slice(2)).toEqual(['written on VM A\n', 'written on VM A and by its shell\na.txt\nshell.txt\n']);
    // A new VM, the same Drive: no "files lost" note, the record unchanged.
    expect(api.vms.get(name)!.sessionId).not.toBe(vmA);
    expect(api.drives.get(name)!.info.driveId).toBe(driveId);
    expect(JSON.stringify(results(b.state))).not.toContain(FILES_LOST_NOTE);
    expect(readDoc(b.state, SANDBOX_DOC).value).toMatchObject({ driveId });
    // Each drive attached with its own token, the later one higher.
    const fences = attaches(b.state).map((e) => (e.output as { fence?: number }).fence!);
    expect(attaches(b.state).map((e) => e.status)).toEqual(['completed', 'completed']);
    expect(fences[1]!).toBeGreaterThan(fences[0]!);
  });

  it('a lost Drive: the first call after it says so, once, and the record is told', { timeout: 180_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    const served = serve(onSandbox);
    const a = await turn(served, 'Keep it.', [call('write', { path: 'keep.txt', content: 'kept\n' }), say('done')]);
    const name = nameOf(a.sessionId);
    const lost = api.drives.get(name)!.info.driveId;
    // The VM and the Drive both go.
    await (await api.getSandbox(name))!.delete();
    api.dropDrive(name);
    const b = await turn(served, 'Is it there?', [call('bash', { command: "ls -A | awk 'END { print NR }'" }), call('read', { path: 'keep.txt' }), say('gone')], a.sessionId);
    const [, l2, l3] = results(b.state);
    expect(l2!.text).toBe(`${FILES_LOST_NOTE}\n\n0\n`);
    expect(l3!.error).toBe(true);
    expect(l3!.text).toMatch(/ENOENT/);
    expect(l3!.text).not.toContain(FILES_LOST_NOTE);
    const record = readDoc(b.state, SANDBOX_DOC).value;
    expect(record.driveId).not.toBe(lost);
    expect(record.filesLost).toBeUndefined();
    // The next turn: told already.
    const c = await turn(served, 'Again.', [call('bash', { command: 'echo again' }), say('ok')], a.sessionId);
    expect(results(c.state).at(-1)).toEqual({ tool: 'bash', error: false, text: 'again\n' });
  });

  it('without a fencing token (no World) the call stops the drive, saying why, and boots no sandbox', { timeout: 60_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    const { model, streamFn, faux } = scriptedModel();
    faux.setResponses([call('bash', { command: 'echo hi' }), say('done')]);
    const raw = rawSessions({ harness: piHarness({ model, streamFn, tools: onSandbox }) });
    const { sessionId } = await raw.start();
    await raw.send(sessionId, 'run it');
    await raw.idle(sessionId);
    const state = await raw.inspect(sessionId);
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toMatch(/sandbox\(\) needs a World with the in-band writer fence/);
    // The attach was recorded; the call's intent never was.
    expect(attaches(state)).toHaveLength(1);
    expect(tools(state)).toEqual([]);
    expect(api.calls.some((c) => c.startsWith('createSandbox:') || c.startsWith('getDrive:'))).toBe(false);
  });

  it('a harness without the pre-intent phase gets the same tools: the attach inside the call', { timeout: 120_000 }, async () => {
    const { api, tools: onSandbox } = sandbox();
    // The tools without their phases: a loop that calls them as plain HostTools.
    const plain = onSandbox.map(({ beforeIntent: _b, afterDrive: _a, ...t }: HostTool & PhasedTool) => t as HostTool);
    const { sessionId, state } = await turn(serve(plain), 'write it', [call('write', { path: 'x.txt', content: 'x\n' }), call('read', { path: 'x.txt' }), say('done')]);
    expect(texts(state)).toEqual(['Successfully wrote to x.txt', 'x\n']);
    expect(onDrive(api, sessionId, 'x.txt')).toBe('x\n');
    // The attach is inside the first call (after its intent), once per drive.
    expect(attaches(state)).toHaveLength(1);
    expect(state.effectOrder.map((e) => e.name).slice(0, 3)).toEqual(['model', 'tool.write', 'sandbox.attach']);
  });

  it('a crash mid-command: a fresh process resumes the turn from the log on a new VM over the same Drive; the command is never run again, and what it wrote before the cut stays', { timeout: 180_000 }, async () => {
    const dataDir = join(base, 'crash-world');
    const drive = { name: 'dh-pi-crash-session', dir: mkdtempSync(join(tmpdir(), 'dh-pi-crash-drive-')), driveId: 'drv_picrash1' };
    closers.push(() => rmSync(drive.dir, { recursive: true, force: true }));
    // Process A: Pi runs a command that is still running when the process is SIGKILLed.
    const a = childProcess([dataDir, drive.name, drive.dir, drive.driveId]);
    const sessionId = (await a.next((l) => typeof l.sessionId === 'string')).sessionId as string;
    const vm = (await a.next((l) => l.type === 'vm')) as unknown as { relayPid: number; relayDir: string };
    await until(() => (existsSync(join(drive.dir, 'a.txt')) && existsSync(join(drive.dir, 'shell.pid')) ? true : undefined), 60_000);
    a.child.kill('SIGKILL');
    expect((await a.exited).signal).toBe('SIGKILL');
    // VM A goes with the process: its relay (and with it the helper, which kills the commands it runs), then the command's group, in case.
    kill(vm.relayPid);
    kill(-Number(readFileSync(join(drive.dir, 'shell.pid'), 'utf8').trim()));
    closers.push(() => rmSync(vm.relayDir, { recursive: true, force: true }));
    expect(readFileSync(join(drive.dir, 'a.txt'), 'utf8')).toBe('one\n');

    // Process B (this one), from the log alone, on a new VM over the same Drive.
    const b = seededStandIn(drive);
    apis.push(b.api);
    const crashWorld = createWorld({ dataDir, recoverActiveRuns: true });
    closers.push(() => crashWorld.close?.());
    const { model, streamFn, faux } = scriptedModel();
    faux.setResponses([call('read', { path: 'a.txt' }), call('write', { path: 'a.txt', content: 'one\ntwo\n' }), say('done')]);
    const sessions = durableSessions({ world: crashWorld, harness: piHarness({ model, streamFn, tools: b.tools }) });
    crashWorld.registerHandler(QUEUE_PREFIX, sessions.handler);
    await crashWorld.start?.();
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return finals(s) >= 1 && isSettled(s) ? s : undefined;
    }, 120_000);
    // The command's intent is in the log, and it never reported: `never`, never run again by itself.
    const bash = tools(state).filter((e) => e.name === 'tool.bash');
    expect(bash).toHaveLength(1);
    expect(bash[0]).toMatchObject({ replay: 'never', status: 'failed', error: { interrupted: true } });
    // The model is told; the Drive kept what it wrote before the cut (durable, not transactional).
    const [r0, r1, r2] = results(state);
    expect(r0!.error).toBe(true);
    expect(r0!.text).toMatch(/interrupted/i);
    expect(r1).toEqual({ tool: 'read', error: false, text: 'one\n' });
    expect(r2).toEqual({ tool: 'write', error: false, text: 'Successfully wrote to a.txt' });
    expect(readFileSync(join(drive.dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    // Each process attached with its drive's own token: B's is higher than A's.
    const fences = attaches(state).map((e) => (e.output as { fence?: number }).fence);
    expect(fences).toHaveLength(2);
    expect(fences[1]!).toBeGreaterThan(fences[0]!);
  });
});

/**
 * The live case (`DH_LIVE_SANDBOX=1`, the gate harness-sandbox's live tests
 * use): Pi on a real Vercel Sandbox, through the session factory and
 * `@vercel/sandbox` (no stand-in, no path view: the VM's Drive is at
 * /workspace), with the drive's own fencing token: a turn on VM A runs Pi's
 * write and bash as the VM's unprivileged user; VM A is deleted (the Drive
 * stays); the next turn, on VM B, reads the file. Run it from a directory
 * linked to a Vercel project (`DH_LIVE_SANDBOX_DIR`, default the directory
 * the test started in), with the Vercel CLI logged in: the SDK mints the
 * linked project's development token through `@vercel/oidc`. Every sandbox,
 * Drive and snapshot is named `dh-probe-*` and tagged (harness-sandbox's
 * `probes/sweep.ts` finds what a killed run left), and `afterAll` deletes
 * them. No secret is printed.
 */
describe.runIf(LIVE)('live: Pi on a Vercel Sandbox', () => {
  let lib: typeof import('../../harness-sandbox/probes/lib.ts');
  let cwd0: string;
  beforeAll(async () => {
    cwd0 = process.cwd();
    process.chdir(process.env.DH_LIVE_SANDBOX_DIR ?? cwd0);
    lib = await import('../../harness-sandbox/probes/lib.ts');
  });
  // A Drive can be deleted only once it detached (6-20 s after its VM went): the cleanup retries for longer than a hook's default.
  afterAll(async () => {
    try {
      expect(await lib.cleanup()).toEqual([]);
    } finally {
      process.chdir(cwd0);
    }
  }, 240_000);

  it("a turn on VM A writes with Pi's tools; VM A is deleted; the next turn, on VM B over the same Drive, reads them", { timeout: 15 * 60_000 }, async () => {
    const api = vercelSandboxApi();
    // A base with the relay only (Pi's tools need bash and coreutils), built in a builder named for the sweep.
    const snapshot = await prepareBase({ region: 'iad1', relay: await devRelayArtifact(), clis: [], name: lib.track('sandbox', lib.probeName('b7pibase')), tags: lib.TAGS });
    lib.created.snapshots.add(snapshot.snapshotId);
    const name = lib.probeName('b7pi');
    lib.track('sandbox', name);
    lib.track('drive', name);
    const factory = () =>
      sandboxCodingTools(
        sandboxSession({
          spec: { image: { snapshot: snapshot.snapshotId }, vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 1024 ** 3, budget: { vmSeconds: 3600 } },
          tags: lib.TAGS,
          test: { name: () => name },
        })
      );
    const a = await turn(serve(factory()), 'Write it.', [
      call('write', { path: 'notes/live.txt', content: 'written on VM A\n' }),
      call('bash', { command: 'cat /workspace/notes/live.txt; pwd; id -un; echo "[$AI_GATEWAY_API_KEY][$VERCEL_OIDC_TOKEN]"' }),
      say('done'),
    ]);
    expect(texts(a.state)).toEqual(['Successfully wrote to notes/live.txt', 'written on VM A\n/workspace\nagent\n[][]\n']);
    expect(attaches(a.state)).toEqual([expect.objectContaining({ status: 'completed', output: expect.objectContaining({ attached: true, fence: expect.any(Number) }) })]);
    const vmA = (await api.getSandbox(name))!.sessionId;

    // VM A goes; the Drive stays. Another factory (another process's) drives the next turn.
    await (await api.getSandbox(name))!.delete();
    const b = await turn(serve(factory()), 'Read it.', [call('read', { path: 'notes/live.txt' }), call('bash', { command: 'ls /workspace/notes; stat -c %U /workspace/notes/live.txt' }), say('read it')], a.sessionId);
    expect(texts(b.state).slice(2)).toEqual(['written on VM A\n', 'live.txt\nagent\n']);
    expect((await api.getSandbox(name))!.sessionId).not.toBe(vmA);
    expect(JSON.stringify(results(b.state))).not.toContain(FILES_LOST_NOTE);
    const fences = attaches(b.state).map((e) => (e.output as { fence?: number }).fence!);
    expect(fences).toHaveLength(2);
    expect(fences[1]!).toBeGreaterThan(fences[0]!);
  });
});

/** Kill a process (or, negative, a process group) that may already be gone. */
function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

/** test/sandbox-child.ts in a process of its own, whose stdout lines are JSON. */
function childProcess(args: string[]) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: PACKAGE, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  closers.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const lines: Record<string, unknown>[] = [];
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  createInterface({ input: child.stdout! }).on('line', (l) => {
    try {
      lines.push(JSON.parse(l));
    } catch {}
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const next = (pred: (l: Record<string, unknown>) => boolean) =>
    until(() => {
      const hit = lines.find(pred);
      if (hit) return hit;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the child exited (${child.exitCode ?? child.signalCode}): ${stderr}`);
      return undefined;
    }, 90_000);
  return { child, next, exited, stderr: () => stderr };
}
