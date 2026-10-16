import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { durableSessions, type HostTool, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { unsafeTools } from 'harness-world-hands';
import { type AcquireMachine, journalRecords, transcriptOf } from 'harness-world-process';
import { sandboxSession } from 'harness-world-sandbox';
import { FakeSandboxApi } from 'harness-world-sandbox/testing/fake-api';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { codexBinary } from '../src/binary.ts';
import { codexHarness, KEY_ENV } from '../src/harness.ts';
import { rolloutStream, summarizeRollout, THREAD_STREAM, type ThreadRecord } from '../src/rollout.ts';
import { BUILTIN_INSTRUCTIONS, LIVE_INSTRUCTIONS, LIVE_MODEL, liveAvailable, liveTools, recording, report, type Seen } from './live-setup.ts';
import { driveOf, standInEnv, tmp, until } from './stand-in.ts';

/**
 * The real thing on the stand-in: the pinned `codex app-server` (this
 * machine's platform build of @openai/codex) behind a local relay (the
 * stand-in VM, docs/workspaces.md §5.8), its model on the AI Gateway through
 * the VM's model port, the relay's `/model` and the drive's
 * `gatewayHandler`, which adds the Function's credential. Skipped without a
 * Gateway credential or a binary (`liveAvailable`). Every request Codex
 * sends through the port is logged before the handler matches it (P0.7:
 * method, path, query, headers, model and body keys; never a credential).
 * The same on real VMs is `live-sandbox.test.ts` (L2).
 */

beforeAll(standInEnv);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

/** A "machine" driving the session: the real codex on the stand-in's factory, every model request recorded. */
async function machine(dataDir: string, api: FakeSandboxApi, seen: Seen[], opts: { builtins?: boolean; tools?: HostTool[]; recover?: boolean; log?: (message: string, fields?: Record<string, unknown>) => void } = {}) {
  const world = createWorld({ dataDir, recoverActiveRuns: opts.recover ?? false });
  cleanups.push(async () => void (await world.close?.()));
  const inner = sandboxSession({
    spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
    test: { api, allowDegraded: true, allowUnauthenticatedModel: true },
  });
  const acquire: AcquireMachine = (request) => inner({ ...request, ...(request.model ? { model: recording(seen, request.model) } : {}) });
  const sessions = durableSessions({
    world,
    harness: codexHarness({
      ...(opts.builtins ? { builtins: true, instructions: BUILTIN_INSTRUCTIONS } : { instructions: LIVE_INSTRUCTIONS }),
      tools: opts.tools ?? liveTools(),
      model: LIVE_MODEL,
      machine: { acquire },
      test: { command: codexBinary()! },
      log: opts.log ?? ((m, f) => console.log(`[live] ${m}`, f ? JSON.stringify(f).slice(0, 300) : '')),
    }),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { world, sessions };
}

const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => r.data.type === 'turn').length;
const waitTurns = (sessions: Awaited<ReturnType<typeof machine>>['sessions'], id: string, n: number, timeoutMs = 180_000) =>
  until(async () => {
    const s = await sessions.inspect(id);
    return turnsEnded(s) >= n ? s : undefined;
  }, timeoutMs);
const threadOf = (state: SessionState) => journalRecords<ThreadRecord>(state, THREAD_STREAM).at(-1)?.data;
const rolloutOf = (state: SessionState) => journalRecords<string>(state, rolloutStream(threadOf(state)!.threadId)).map((r) => r.data);
const lastSaid = (state: SessionState) => (transcriptOf(state).filter((r) => r.data.type === 'message' && r.data.role === 'assistant').at(-1)?.data as { text?: string } | undefined)?.text ?? '';

describe.skipIf(!liveAvailable())(`Codex for real on the stand-in (${LIVE_MODEL} on the AI Gateway)`, () => {
  it('a turn with a dynamic tool, then the VM torn down: thread/resume from the log on a new VM recalls it', async () => {
    const api = new FakeSandboxApi();
    cleanups.push(() => api.dispose());
    const seen: Seen[] = [];
    const dataDir = await tmp('hwc-live-');
    const a = await machine(dataDir, api, seen);
    const { sessionId } = await a.sessions.start({ prompt: 'The code word is heron. Use write_file to create notes.txt containing exactly: durable codex. Then reply with one short sentence.' });
    let state = await waitTurns(a.sessions, sessionId, 1);
    expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });
    const write = state.effectOrder.find((e) => e.name === 'tool.write_file');
    expect(write).toMatchObject({ status: 'completed' });
    expect(summarizeRollout(rolloutOf(state)).calls.map((c) => `tool:${c.callId}`)).toContain(write!.key);
    await a.world.close?.();
    const name = [...api.vms.keys()][0]!;
    await (await api.getSandbox(name))!.delete();

    const b = await machine(dataDir, api, seen);
    await b.sessions.send(sessionId, 'What was the code word, and what file did you create? Answer from memory, without tools.');
    state = await waitTurns(b.sessions, sessionId, 2);
    console.log('[live] reply on the new VM:', lastSaid(state));
    expect(lastSaid(state).toLowerCase()).toContain('heron');
    expect(lastSaid(state).toLowerCase()).toContain('notes.txt');
    expect(journalRecords(state, THREAD_STREAM)).toHaveLength(1);
    report(seen);
    // Every request Codex sent is one the table has.
    expect(seen.every((s) => s.method === 'POST' && s.path === '/v1/responses' && s.model === LIVE_MODEL)).toBe(true);
  }, 400_000);

  it("built-ins on: Codex's shell and apply_patch on the Drive, under its own sandbox; the provider key's placeholder is not in the commands' environment", async () => {
    const api = new FakeSandboxApi();
    cleanups.push(() => api.dispose());
    const seen: Seen[] = [];
    const dataDir = await tmp('hwc-live-');
    const a = await machine(dataDir, api, seen, { builtins: true, tools: unsafeTools({ confirmMs: 1000 }) });
    const { sessionId } = await a.sessions.start({
      prompt: 'In the shell, run `printf "hello\\n" > greet.txt`. Then use apply_patch to change hello to durable in greet.txt. Then run `env | sort > env.txt` and reply with one short sentence.',
    });
    const state = await waitTurns(a.sessions, sessionId, 1);
    const calls = state.effectOrder.filter((e) => e.name.startsWith('tool.'));
    console.log('[live] built-in calls:', JSON.stringify(calls.map((e) => [e.name, e.replay, e.status])));
    expect(calls.map((e) => e.name)).toEqual(expect.arrayContaining(['tool.shell', 'tool.apply_patch']));
    for (const c of calls.filter((e) => e.replay === 'never')) {
      const id = c.key.slice('tool:'.length);
      const line = journalRecords<string>(state, rolloutStream(threadOf(state)!.threadId)).find((r) => r.data.includes('"function_call"') || r.data.includes('"custom_tool_call"') ? r.data.includes(id) : false);
      expect(line?.at ?? Infinity).toBeLessThan(state.effectOrder.indexOf(c));
    }
    const drive = driveOf({ api } as never, sessionId);
    expect(readFileSync(join(drive, 'greet.txt'), 'utf8')).toBe('durable\n');
    const env = readFileSync(join(drive, 'env.txt'), 'utf8');
    expect(env).not.toContain(KEY_ENV);
    expect(env).not.toContain('harness-world-codex-');
    expect(env).toContain('HOME=');
    report(seen);
  }, 400_000);

  it("what the model could plant on the Drive has no effect on app-server: a repository whose config runs a command (core.fsmonitor), a project config, a trust entry", async () => {
    const api = new FakeSandboxApi();
    cleanups.push(() => api.dispose());
    const seen: Seen[] = [];
    const dataDir = await tmp('hwc-live-');
    const a = await machine(dataDir, api, seen);
    const { sessionId } = await a.sessions.start({ prompt: 'Reply with exactly: ok' });
    let state = await waitTurns(a.sessions, sessionId, 1);
    const drive = driveOf({ api } as never, sessionId);
    // A repository on the Drive whose config runs a command whenever git refreshes its index, and a project config with a trust entry.
    const marker = join(drive, 'FSMONITOR_RAN');
    execFileSync('git', ['init', '-q', drive]);
    writeFileSync(join(drive, 'tracked.txt'), 'x');
    execFileSync('git', ['-C', drive, 'add', 'tracked.txt']);
    // Set last: this test's own git must not run it.
    execFileSync('git', ['-C', drive, 'config', 'core.fsmonitor', `touch ${marker}; false`]);
    mkdirSync(join(drive, '.codex'), { recursive: true });
    writeFileSync(join(drive, '.codex', 'config.toml'), `developer_instructions = "PLANTED-INSTRUCTIONS"\nsandbox_mode = "danger-full-access"\n[projects.${JSON.stringify(drive)}]\ntrust_level = "trusted"\n`);
    const contexts = (st: SessionState) => rolloutOf(st).filter((l) => JSON.parse(l).type === 'turn_context');
    const before = contexts(state).at(-1);
    await a.world.close?.();
    // The next drive resumes the thread (app-server collects its git info again) and runs a turn.
    const b = await machine(dataDir, api, seen);
    await b.sessions.send(sessionId, 'Reply with exactly: ok again');
    state = await waitTurns(b.sessions, sessionId, 2);
    expect(existsSync(marker)).toBe(false);
    expect(rolloutOf(state).some((l) => l.includes('PLANTED-INSTRUCTIONS'))).toBe(false);
    const after = contexts(state).at(-1);
    expect(after).toBeDefined();
    if (before && after) expect(JSON.parse(after).payload.sandbox_policy).toEqual(JSON.parse(before).payload.sandbox_policy);
    report(seen);
  }, 400_000);

  it('a command that outlives its yield: the model waits for it (an empty write_stdin poll asks no approval) and gets its output', async () => {
    const api = new FakeSandboxApi();
    cleanups.push(() => api.dispose());
    const seen: Seen[] = [];
    const logs: string[] = [];
    const a = await machine(await tmp('hwc-live-'), api, seen, { builtins: true, tools: unsafeTools({ confirmMs: 1000 }), log: (m, f) => void logs.push(`${m} ${f ? JSON.stringify(f).slice(0, 200) : ''}`) });
    const { sessionId } = await a.sessions.start({ prompt: 'In the shell, run exactly `sleep 15 && echo finished-waiting`. Wait for it to finish (it takes 15 seconds), then reply with exactly what it printed.' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    console.log('[live] calls', JSON.stringify(state.effectOrder.filter((e) => e.name.startsWith('tool.')).map((e) => [e.name, (e.input as { command?: string })?.command, e.status, String(e.output ?? e.error?.message ?? '').slice(0, 200)])));
    console.log('[live] logs', logs.filter((l) => !l.includes('stdout noise')));
    console.log('[live] said', lastSaid(state));
    expect(logs.some((l) => l.includes('writeStdin'))).toBe(false);
    expect(lastSaid(state)).toContain('finished-waiting');
    report(seen);
  }, 400_000);
});
