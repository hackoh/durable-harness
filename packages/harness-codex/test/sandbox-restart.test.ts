/**
 * Codex on the session's sandbox (docs/workspaces.md §5.6, §11.4 A6), on the
 * stand-in (`localMachine()`'s relay through the fake Sandbox API) with the
 * fake app-server (`FAKE_CODEX_MODEL=remote`): its model calls go through
 * the VM's model port, the relay's `/model` and the drive's
 * `gatewayHandler`; its rollout comes back over `TAIL`/`SYNC`; its built-ins
 * run on the Drive. The restart case mirrors Claude Code's R1: a file
 * written, the VM torn down, and a new VM on the same Drive resumes the
 * thread from the log alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDoc, type HostTool, UNAVAILABLE_STEP } from 'harness-world';
import { journalRecords, transcriptOf } from 'harness-world-process';
import { FILES_LOST_NOTE, readDriveManifest, SANDBOX_DOC } from 'harness-world-sandbox';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { codexHarness, KEY_ENV, LAGGING_NOTE, LAGGING_RESULT, NO_TIME_TEXT, SPEND_STREAM, TAIL_STREAM, TIMEOUT_TEXT } from '../src/harness.ts';
import { rolloutStream, summarizeRollout } from '../src/rollout.ts';
import { cacheRootOf, driveOf, fileLines, nameOf, type Rig, rig, rolloutFile, rolloutLines, session, standInEnv, tearDown, threadOf, tmp, until, vmOf, waitTurns } from './stand-in.ts';

beforeAll(standInEnv);

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});
const newRig = async (...args: Parameters<typeof rig>) => {
  const r = await rig(...args);
  rigs.push(r);
  return r;
};

const configOf = (r: Rig, sessionId: string) => readFileSync(join(cacheRootOf(r, sessionId), 'codex-home', 'config.toml'), 'utf8');
const assistantTexts = (state: Parameters<typeof transcriptOf>[0]) =>
  transcriptOf(state)
    .map((e) => e.data)
    .filter((d) => d.type === 'message' && d.role === 'assistant')
    .map((d) => (d as { text: string }).text);

describe('Codex on the session sandbox (stand-in)', () => {
  it("the tunnel: Codex's model calls leave the VM only through its model port, to the drive's gateway handler, with the VM's config pointing there", async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r);
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(assistantTexts(state)).toEqual(['echo: hello']);
    // The fake model behind the handler saw the request, on the table's path.
    expect(r.model.requests.map((q) => q.path)).toEqual(['/v1/responses']);
    expect(r.model.requests.every((q) => q.completed)).toBe(true);
    // The VM's config.toml: the base URL is the VM's own model port, the key a placeholder env var, no websockets, the commands' env filtered, the cwd untrusted.
    const vm = vmOf(r, sessionId)!;
    const config = configOf(r, sessionId);
    expect(config).toContain(`base_url = "http://127.0.0.1:${vm.relay!.config.modelPort}/v1"`);
    expect(config).toContain(`env_key = "${KEY_ENV}"`);
    expect(config).toContain('supports_websockets = false');
    expect(config).toContain('[shell_environment_policy]\ninherit = "core"\nexclude = ["HARNESS_*", "*TOKEN*"]');
    expect(config).toContain(`[projects.${JSON.stringify(driveOf(r, sessionId))}]\ntrust_level = "untrusted"`);
    expect(config).toMatch(/^sandbox_mode = "read-only"$/m);
    // The thread runs on the Drive.
    expect(threadOf(state)!.path).toMatch(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.*\.jsonl$/);
    expect(JSON.parse(rolloutLines(state)[0]!).payload.cwd).toBe(driveOf(r, sessionId));
    // The rollout in the log is the VM's file, line for line.
    expect(rolloutLines(state)).toEqual(fileLines(rolloutFile(r, sessionId, state)));
  });

  it('a built-in call: its function_call line is in the log before its intent, and before its approval; its outcome after the Drive flush', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo hi > a.txt' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    const call = state.effectOrder.find((e) => e.name === 'tool.shell')!;
    expect(call).toMatchObject({ status: 'completed', replay: 'never' });
    const callId = call.key.slice('tool:'.length);
    const line = journalRecords<string>(state, rolloutStream(threadOf(state)!.threadId)).find((x) => x.data.includes('"function_call"') && x.data.includes(callId))!;
    expect(line.at).toBeLessThan(state.effectOrder.indexOf(call));
    // It ran on the Drive.
    expect(readFileSync(join(driveOf(r, sessionId), 'a.txt'), 'utf8')).toBe('hi\n');
    // The self-test passed on the stand-in: workspace-write, the Drive and HOME writable, network on.
    const config = configOf(r, sessionId);
    expect(config).toMatch(/^sandbox_mode = "workspace-write"$/m);
    expect(config).toContain(`[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [${JSON.stringify(driveOf(r, sessionId))}, ${JSON.stringify(join(cacheRootOf(r, sessionId), 'home'))}]`);
  });

  it("a lagging tail: a call whose function_call line isn't in the log is declined, never run, no intent committed, and the model is told to try again", async () => {
    const r = await newRig();
    const sendEmail: HostTool<{ to: string }> = { name: 'send_email', description: 'Send an email.', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, replay: 'never', execute: async ({ to }) => `sent to ${to}` };
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true, tools: [sendEmail], env: { FAKE_CODEX_LAG: '1' } });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo x > lag.txt' });
    let state = await waitTurns(a.sessions, sessionId, 1);
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.'))).toEqual([]);
    expect(existsSync(join(driveOf(r, sessionId), 'lag.txt'))).toBe(false);
    expect(transcriptOf(state).some((e) => e.data.type === 'message' && e.data.role === 'user' && (e.data as { text: string }).text === LAGGING_NOTE)).toBe(true);
    expect(r.logs.some((l) => l.message.includes('function_call line is not in the log'))).toBe(true);
    // A dynamic `never` tool: declined the same way, its effect never written.
    await a.sessions.send(sessionId, 'call send_email {"to":"a@b.c"}');
    state = await waitTurns(a.sessions, sessionId, 2);
    expect(state.effectOrder.filter((e) => e.name.startsWith('tool.'))).toEqual([]);
    expect(assistantTexts(state).at(-1)).toContain(`send_email failed: ${LAGGING_RESULT}`);
  });

  it('the rollout replaced or shrunk under the tail stops the drive: nothing more is mirrored from it', async () => {
    for (const how of ['shrink', 'replace'] as const) {
      const r = await newRig();
      const a = await session(await tmp('hwc-sbx-'), r);
      const { sessionId } = await a.sessions.start({ prompt: `tamper ${how}` });
      await until(async () => (r.logs.some((l) => l.message.includes('the rollout tail failed')) ? true : undefined));
      const failure = r.logs.find((l) => l.message.includes('the rollout tail failed'))!;
      expect(String(failure.fields?.error)).toMatch(how === 'shrink' ? /shrank/ : /replaced/);
      const state = await a.sessions.inspect(sessionId);
      // The turn never ended on that drive, and the mirrored lines are a clean prefix: no line came after the tamper.
      expect(assistantTexts(state)).not.toContain('tampered');
      const ordinals = rolloutLines(state).map((l) => JSON.parse(l).ordinal as number);
      expect(ordinals).toEqual(ordinals.map((_, i) => i));
      await r.dispose();
      rigs.splice(rigs.indexOf(r), 1);
    }
  });

  it('a rollout tampered with in every delivery: after three tail failures in the turn, the turn ends with an Unavailable instead of another redelivery', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { env: { FAKE_CODEX_TAMPER: 'shrink' } });
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    const fact = await until(async () => [...(await a.sessions.inspect(sessionId)).effects.values()].find((e) => e.name === UNAVAILABLE_STEP), 120_000);
    expect(fact.input).toMatchObject({ code: 'unavailable', message: expect.stringContaining('replaced or shrunk 3 times') });
    const state = await a.sessions.inspect(sessionId);
    expect(journalRecords(state, TAIL_STREAM)).toHaveLength(3);
    // The next turn starts its own count.
    expect(journalRecords<{ turn: number }>(state, TAIL_STREAM).map((x) => x.data.turn)).toEqual([0, 0, 0]);
  }, 150_000);

  it('an approval asking for more permissions is declined, whatever its intent', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'escalate echo hi > esc.txt' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(existsSync(join(driveOf(r, sessionId), 'esc.txt'))).toBe(false);
    expect(state.effectOrder.find((e) => e.name === 'tool.shell')).toMatchObject({ status: 'failed' });
    expect(r.logs.some((l) => l.message.includes('asking for more than its call') && l.fields?.escalation === 'additionalPermissions')).toBe(true);
    expect(assistantTexts(state).at(-1)).toContain('shell declined');
  });

  it("the provider key's placeholder is hidden from the model's commands, and is never a credential; sandbox({ env }) reaches them", async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true, env: { HARNESS_DEMO: 'plain', DEMO_VISIBLE: 'yes' } });
    const { sessionId } = await a.sessions.start({ prompt: 'shell env' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    const out = String(state.effectOrder.find((e) => e.name === 'tool.shell')!.output);
    expect(out).toContain('HOME=');
    expect(out).toContain('DEMO_VISIBLE=yes');
    expect(out).not.toContain(KEY_ENV);
    expect(out).not.toContain('harness-world-codex-');
    expect(out).not.toContain('HARNESS_DEMO');
    // app-server's own (its git kept off the Drive, CODEX_HOME) never reach a command: inherit = "core".
    expect(out).not.toContain('GIT_DIR');
    expect(out).not.toContain('CODEX_HOME=');
    expect(configOf(r, sessionId)).toContain('[shell_environment_policy.set]\nFAKE_CODEX_MODEL = "remote"\nDEMO_VISIBLE = "yes"');
    // app-server itself had it: its model call went through.
    expect(r.model.requests.length).toBeGreaterThan(0);
  });

  it('a project config planted on the Drive (/workspace/.codex) has no effect on the next invocation', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await waitTurns(a.sessions, sessionId, 1);
    // What the model's own commands could do: a project config, and a trust entry in it.
    mkdirSync(join(driveOf(r, sessionId), '.codex'), { recursive: true });
    writeFileSync(join(driveOf(r, sessionId), '.codex', 'config.toml'), `developer_instructions = "PLANTED"\nsandbox_mode = "danger-full-access"\n[projects.${JSON.stringify(driveOf(r, sessionId))}]\ntrust_level = "trusted"\n`);
    await a.sessions.send(sessionId, 'again');
    const state = await waitTurns(a.sessions, sessionId, 2);
    expect(assistantTexts(state).at(-1)).toBe('echo: again');
    expect(configOf(r, sessionId)).toContain('trust_level = "untrusted"');
    expect(configOf(r, sessionId)).not.toContain('PLANTED');
  });

  it('bubblewrap failing its self-test in the VM: danger-full-access, with a note in the log', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true, env: { FAKE_CODEX_BWRAP: 'fail' } });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo ok' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(configOf(r, sessionId)).toMatch(/^sandbox_mode = "danger-full-access"$/m);
    expect(configOf(r, sessionId)).not.toContain('[sandbox_workspace_write]');
    expect(journalRecords(state, 'codex.sandbox').map((x) => x.data)).toEqual([{ sandboxMode: 'danger-full-access', reason: expect.stringContaining('self-test failed') }]);
    expect(r.logs.some((l) => l.message.includes("bubblewrap's self-test failed"))).toBe(true);
  });

  it("the self-test's verdict is the session's: recorded once, kept by every later drive, so a later failure can't move it to danger-full-access", async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-sbx-');
    const a = await session(dataDir, r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo ok' });
    await waitTurns(a.sessions, sessionId, 1);
    await a.world.close?.();
    await tearDown(r, sessionId);
    // A new VM where bwrap would now fail (or something on the Drive broke it): the verdict stands, the test doesn't run.
    const b = await session(dataDir, r, { builtins: true, env: { FAKE_CODEX_BWRAP: 'fail' } });
    await b.sessions.send(sessionId, 'shell echo again');
    const state = await waitTurns(b.sessions, sessionId, 2);
    expect(configOf(r, sessionId)).toMatch(/^sandbox_mode = "workspace-write"$/m);
    expect(journalRecords(state, 'codex.sandbox').map((x) => x.data)).toEqual([{ sandboxMode: 'workspace-write' }]);
    expect(r.logs.some((l) => l.message.includes("bubblewrap's self-test failed"))).toBe(false);
  });

  it('a command bwrap denied is not rerun without the sandbox: Codex\'s second approval for it is declined, and it ran once', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo run >> runs.txt; echo "touch: /var/lib/dh/s/codex-home/evil: Read-only file system" >&2; exit 1' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(readFileSync(join(driveOf(r, sessionId), 'runs.txt'), 'utf8')).toBe('run\n');
    expect(state.effectOrder.filter((e) => e.name === 'tool.shell')).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(r.logs.filter((l) => l.message.includes('asking for more than its call')).map((l) => l.fields?.escalation)).toEqual(['unsandboxed']);
  });

  it('input to a running command (writeStdin, its own approvalId) is declined: it is not the call its intent names', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'stdin echo hi' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(String(state.effectOrder.find((e) => e.name === 'tool.shell')!.output)).toContain('stdin rejected');
    expect(r.logs.filter((l) => l.message.includes('asking for more than its call')).map((l) => l.fields?.escalation)).toEqual(['writeStdin']);
  });

  it('a command asked for too close to the end of the invocation is declined, never run, with a definite outcome', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true });
    // 20 s left: under the 25 s margin a command needs to run and be recorded.
    (a.world as { getRuntimeDeadline?: () => Promise<Date> }).getRuntimeDeadline = async () => new Date(Date.now() + 20_000);
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo x > late.txt' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(existsSync(join(driveOf(r, sessionId), 'late.txt'))).toBe(false);
    expect(state.effectOrder.filter((e) => e.name === 'tool.shell')).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ message: NO_TIME_TEXT }) })]);
    // Declined, not accepted then interrupted: the turn went on.
    expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });
  });

  it('restart on a new sandbox: a file written, the VM torn down, then thread/resume from the log recalls the code word and the file is there', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-sbx-');
    const a = await session(dataDir, r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'the code word is heron' });
    await waitTurns(a.sessions, sessionId, 1);
    await a.sessions.send(sessionId, 'shell echo heron > note.txt');
    let state = await waitTurns(a.sessions, sessionId, 2);
    const vmA = vmOf(r, sessionId)!.sessionId;
    const linesA = rolloutLines(state);
    // The Drive's snapshot, taken after the turn that wrote note.txt (the Files panel's, docs/workspaces.md §8).
    const noted = async (s: { inspect(id: string): Promise<import('harness-world').SessionState> }) => readDriveManifest(await s.inspect(sessionId))?.files.find((f) => f.path === '/workspace/note.txt');
    await until(() => noted(a.sessions));
    // VM A goes: its relay, rootfs and cache dirs (CODEX_HOME with the rollout). The Drive stays. Another process drives next.
    await tearDown(r, sessionId);
    await a.world.close?.();
    const b = await session(dataDir, r, { builtins: true });
    // Read from the log with VM A gone and no VM yet.
    expect(await noted(b.sessions)).toMatchObject({ text: 'heron\n' });
    await b.sessions.send(sessionId, 'recall');
    state = await waitTurns(b.sessions, sessionId, 3);
    expect(vmOf(r, sessionId)!.sessionId).not.toBe(vmA);
    expect(assistantTexts(state).at(-1)).toBe('the code word is heron');
    await b.sessions.send(sessionId, 'shell cat note.txt');
    state = await waitTurns(b.sessions, sessionId, 4);
    expect(state.effectOrder.filter((e) => e.name === 'tool.shell').at(-1)).toMatchObject({ status: 'completed', output: expect.stringContaining('heron') });
    // One thread throughout: VM B's rollout is the log's, VM A's lines first.
    const lines = rolloutLines(state);
    expect(fileLines(rolloutFile(r, sessionId, state))).toEqual(lines);
    expect(lines.slice(0, linesA.length)).toEqual(linesA);
    expect(summarizeRollout(lines).idle).toBe(true);
    expect(journalRecords(state, 'codex.thread')).toHaveLength(1);
  });

  it('the Drive deleted between turns: the model hears its files were lost, once, and the record is told', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-sbx-');
    const a = await session(dataDir, r);
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await waitTurns(a.sessions, sessionId, 1);
    await tearDown(r, sessionId);
    r.api.dropDrive(nameOf(sessionId));
    await a.sessions.send(sessionId, 'second');
    let state = await waitTurns(a.sessions, sessionId, 2);
    expect(assistantTexts(state).at(-1)).toBe(`echo: [Sandbox] ${FILES_LOST_NOTE}\n\nsecond`);
    // The turn that told the model is in the log: the record is told after it, so the next attach stops repeating it.
    state = await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.name === 'sandbox.notes' && e.status === 'completed') ? s : undefined;
    });
    expect(readDoc(state, SANDBOX_DOC).value.filesLost).toBeUndefined();
    await a.sessions.send(sessionId, 'third');
    state = await waitTurns(a.sessions, sessionId, 3);
    expect(assistantTexts(state).at(-1)).toBe('echo: third');
  });

  it('a command past the time it has: stopped, with a definite outcome (never an open intent), and the turn ends interrupted', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-sbx-'), r, { builtins: true, commandTimeoutMs: 500 });
    const { sessionId } = await a.sessions.start({ prompt: 'shell sleep 3 && echo done > late.txt' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(state.effectOrder.find((e) => e.name === 'tool.shell')).toMatchObject({ status: 'failed', error: { message: expect.stringContaining(TIMEOUT_TEXT) } });
    expect(transcriptOf(state).at(-1)?.data).toMatchObject({ type: 'turn', status: 'interrupted' });
    await new Promise((res) => setTimeout(res, 3000));
    expect(existsSync(join(driveOf(r, sessionId), 'late.txt'))).toBe(false);
  });

  it("a spend cap: the model call is refused in the Function and the turn ends at once, saying which cap", async () => {
    const r = await newRig({ model: { cost: '0.6' } });
    const a = await session(await tmp('hwc-sbx-'), r, { budget: { turnUsd: 0.5 } });
    const { sessionId } = await a.sessions.start({ prompt: 'call write_file {"path":"a.txt","content":"x"}' });
    const capped = await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      const fact = [...s.effects.values()].find((e) => e.name === UNAVAILABLE_STEP);
      return fact ? (fact.input as { message?: string }) : undefined;
    });
    expect(capped.message).toMatch(/turn's model spend reached its cap \(sandbox\(\{ budget: \{ turnUsd \} \}\)\)/);
    // The first call was forwarded and charged; the second, past the cap, never left the Function.
    expect(r.model.requests).toHaveLength(1);
  });

  it("the session's spend is in the log: a cap holds across invocations and machines", async () => {
    const r = await newRig({ model: { cost: '0.6' } });
    const dataDir = await tmp('hwc-sbx-');
    const a = await session(dataDir, r, { budget: { sessionUsd: 1 } });
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await waitTurns(a.sessions, sessionId, 1);
    await a.world.close?.();
    await tearDown(r, sessionId);
    // Another machine: $0.60 spent so far, under the cap, so its first call goes out; then the session is at $1.20.
    const b = await session(dataDir, r, { budget: { sessionUsd: 1 } });
    await b.sessions.send(sessionId, 'again');
    let state = await waitTurns(b.sessions, sessionId, 2);
    expect(journalRecords(state, SPEND_STREAM).map((x) => x.data)).toEqual([
      { usd: 0.6, turn: 0 },
      { usd: 0.6, turn: 1 },
    ]);
    await b.sessions.send(sessionId, 'third');
    const capped = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      const fact = [...s.effects.values()].find((e) => e.name === UNAVAILABLE_STEP);
      return fact ? (fact.input as { message?: string }) : undefined;
    });
    expect(capped.message).toMatch(/session's model spend reached its cap/);
    expect(r.model.requests).toHaveLength(2);
    state = await b.sessions.inspect(sessionId);
    expect(journalRecords(state, SPEND_STREAM)).toHaveLength(2);
  });
});

describe('Codex on the session sandbox: what the factory refuses', () => {
  it('reserved config keys throw at construction', () => {
    for (const config of [
      { sandbox_mode: 'danger-full-access' },
      { approval_policy: 'never' },
      { shell_environment_policy: { inherit: 'all' } },
      { model_providers: {} },
      { projects: {} },
      { mcp_servers: {} },
      { notify: ['x'] },
      { tools: { web_search: true } },
      { 'tools.web_search': true },
      { features: { shell_tool: true } },
      { model_provider: 'x' },
      { codex_linux_sandbox_exe: '/tmp/x' },
      { zsh_path: '/tmp/zsh' },
      { model_instructions_file: '/etc/passwd' },
      { experimental_compact_prompt_file: '/etc/passwd' },
      { ghost_snapshot: { disable_warnings: true } },
      { otel: { exporter: 'otlp-http' } },
      { chatgpt_base_url: 'https://x.example' },
      { history: { persistence: 'save-all' } },
      { default_permissions: 'full' },
      { sqlite_home: '/tmp' },
      { tui: { log_dir: '/tmp' } },
    ]) {
      expect(() => codexHarness({ config } as never)).toThrow(TypeError);
    }
    expect(() => codexHarness({ config: { model_reasoning_effort: 'low', tools: { view_image: true } } })).not.toThrow();
  });

  it('removed options throw, naming their replacement; sandboxMode needs builtins', () => {
    for (const [key, value] of [['sandbox', 'workspace-write'], ['host', {}], ['cwd', '/x'], ['bin', 'codex'], ['env', {}], ['keepSessionDir', true], ['workspaceNote', false]] as const) {
      expect(() => codexHarness({ [key]: value } as never)).toThrow(new RegExp(`the ${key} option is gone`));
    }
    expect(() => codexHarness({ sandboxMode: 'workspace-write' })).toThrow(/needs builtins: true/);
    expect(() => codexHarness({ builtins: true, sandboxMode: 'workspace-write' })).not.toThrow();
  });

  it('no sandbox machine, or one the session factory never branded (whatever its shape, a spawn of its own included): the turn fails with sandbox_required, and nothing is spawned', async () => {
    const r = await newRig();
    const fake = { sessionId: 'x', notes: [], signal: new AbortController().signal, close: async () => {} };
    let spawned = 0;
    // Every property a branded machine has, a spawn that would run on this host among them: refused by provenance, not by shape.
    const handWritten = {
      ...fake,
      brand: Object.freeze({}),
      fence: { count: 1, fenced: true },
      root: '/workspace',
      dirs: { home: '/tmp', config: '/tmp', 'codex-home': '/tmp', tmp: '/tmp', cache: '/tmp' },
      modelUrl: 'http://127.0.0.1:4100',
      modelKey: 'dhm-hand-written-key-000000000000',
      files: { upload: async () => {}, wipe: async () => {}, tail: () => { throw new Error('no'); }, fsync: async () => {} },
      workspace: {},
      spawn: async () => {
        spawned++;
        throw new Error('a hand-written spawn ran');
      },
    };
    for (const machine of [undefined, { acquire: async () => fake as never }, { acquire: async () => handWritten as never }]) {
      const a = await session(await tmp('hwc-sbx-'), r, { harness: { machine } as never });
      const { sessionId } = await a.sessions.start({ prompt: 'hello' });
      const fact = await until(async () => [...(await a.sessions.inspect(sessionId)).effects.values()].find((e) => e.name === UNAVAILABLE_STEP));
      expect(fact.input).toMatchObject({ code: 'sandbox_required' });
    }
    expect(spawned).toBe(0);
  });
});
