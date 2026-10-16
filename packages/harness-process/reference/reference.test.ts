import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DurableSessions, durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { filesFromState, readLedger, workspaceTools } from 'harness-world-hands';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostedProcess, isAlive, journalRecords, ProcessHost, type SpawnOptions, transcriptOf } from '../src/index.ts';
import { type FakeModel, fakeModel } from './fake-model.ts';
import { referenceHarness } from './harness.ts';

/**
 * The shared core end to end, on world-local, with a real child process:
 * the reference harness drives `fake-cli.mjs` through a turn with a tool,
 * survives a crash in the middle of a `replay: 'never'` tool (recovered on a
 * fresh session dir, and on the same one, where the stale child is killed
 * first), and stops its child when a journal write is refused.
 */

const worlds: LocalWorld[] = [];
const models: FakeModel[] = [];
const strays = new Set<number>();
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
  for (const m of models.splice(0)) await m.close();
  for (const pid of strays) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  strays.clear();
});

/** A host that remembers what it spawned (to find the children in tests). */
class WatchedHost extends ProcessHost {
  readonly spawned: HostedProcess[] = [];
  override async spawn(runId: string, options: SpawnOptions): Promise<HostedProcess> {
    const proc = await super.spawn(runId, options);
    this.spawned.push(proc);
    strays.add(proc.pid);
    return proc;
  }
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => r.data.type === 'turn').length;

async function session(dataDir: string, root: string, opts: { chaos?: boolean; recover?: boolean; crash?: () => void; confirmMs?: number; modelUrl?: string } = {}) {
  const world = createWorld({ dataDir, recoverActiveRuns: opts.recover ?? false });
  worlds.push(world);
  const host = new WatchedHost({ root });
  const sessions = durableSessions({
    world,
    harness: referenceHarness({ tools: workspaceTools({ confirmMs: opts.confirmMs ?? 3000 }), host, ...(opts.modelUrl ? { modelUrl: opts.modelUrl } : {}) }),
    ...(opts.chaos ? { chaos: true, crash: opts.crash ?? (() => {}) } : {}),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { world, host, sessions };
}

const nativeLines = (state: SessionState) => journalRecords<string>(state, 'native').map((r) => r.data);
const fileLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
const waitTurns = (sessions: DurableSessions, id: string, n: number) =>
  until(async () => {
    const s = await sessions.inspect(id);
    return turnsEnded(s) >= n ? s : undefined;
  });

describe('the reference process harness', () => {
  it('runs a turn with a tool, and a fresh machine resumes the session from the log', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hwp-ref-'));
    const rootA = await mkdtemp(join(tmpdir(), 'hwp-root-a-'));
    const a = await session(dataDir, rootA);
    const { sessionId } = await a.sessions.start({ prompt: 'call write_file {"path":"notes.txt","content":"hi"}' });
    let state = await waitTurns(a.sessions, sessionId, 1);

    // The tool ran once, keyed by the CLI's own call id.
    expect(state.effects.get('tool:call_1')).toMatchObject({ name: 'tool.write_file', status: 'completed' });
    expect(filesFromState(state)).toEqual({ '/workspace/notes.txt': 'hi' });
    // The normalized transcript: the call, the reply, the turn's end.
    expect(transcriptOf(state).map((r) => r.data)).toEqual([
      { type: 'message', role: 'assistant', text: 'Calling write_file.', toolCalls: [{ id: 'call_1', name: 'write_file' }] },
      { type: 'message', role: 'assistant', text: expect.stringContaining('write_file returned: wrote 2 bytes') },
      { type: 'turn', status: 'completed' },
    ]);
    // The native journal is the CLI's session file, line for line.
    const fileA = join(rootA, sessionId, 'session.jsonl');
    expect(nativeLines(state)).toEqual(fileLines(fileA));
    expect(nativeLines(state).map((l) => JSON.parse(l).type)).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'turn_end']);
    // The prompt was placed before the CLI saw it.
    const place = state.effectOrder.find((e) => e.name === 'place')!;
    expect(place.placed).toEqual([state.submissions[0]!.id]);
    expect(state.effectOrder.indexOf(place)).toBeLessThan(state.effectOrder.findIndex((e) => e.name === 'journal'));

    await a.sessions.send(sessionId, 'hello');
    state = await waitTurns(a.sessions, sessionId, 2);
    expect(transcriptOf(state).at(-2)?.data).toEqual({ type: 'message', role: 'assistant', text: 'echo: hello' });
    // Each child exited at the end of its drive.
    await until(async () => (a.host.spawned.every((p) => !p.alive()) ? true : undefined));
    await a.world.close?.();

    // Another machine: an empty root. The session file comes back from the
    // log, and the workspace the tools see too.
    const rootB = await mkdtemp(join(tmpdir(), 'hwp-root-b-'));
    const b = await session(dataDir, rootB);
    await b.sessions.send(sessionId, 'call read_file {"path":"notes.txt"}');
    state = await waitTurns(b.sessions, sessionId, 3);
    expect(state.effects.get('tool:call_2')).toMatchObject({ status: 'completed', output: 'hi' });
    const fileB = join(rootB, sessionId, 'session.jsonl');
    expect(fileLines(fileB)).toEqual(nativeLines(state));
    expect(fileLines(fileB).slice(0, fileLines(fileA).length)).toEqual(fileLines(fileA));
  });

  it('a crash mid never-tool: recovered from the log on a fresh machine, with the recovery note, and the side effect happened once', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hwp-ref-'));
    const rootA = await mkdtemp(join(tmpdir(), 'hwp-root-a-'));
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const a = await session(dataDir, rootA, { chaos: true, crash: () => crashed() });
    const { sessionId } = await a.sessions.start();
    await a.sessions.chaos(sessionId, { at: 'tool', afterMs: 300 });
    await a.sessions.send(sessionId, 'call unsafe_make_payment {"to":"acme","amount_usd":5,"memo":"order 7"}');
    await died;
    // The process is gone: its World with it. Its child is not (its own
    // process group), as after a real SIGKILL of the parent.
    await a.world.close?.();
    const stale = a.host.spawned.at(-1)!;
    expect(stale.alive()).toBe(true);

    const rootB = await mkdtemp(join(tmpdir(), 'hwp-root-b-'));
    const b = await session(dataDir, rootB, { chaos: true, recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);

    // The payment's intent was committed, its outcome lost: interrupted, never rerun.
    expect(state.effects.get('tool:call_1')).toMatchObject({ name: 'tool.unsafe_make_payment', status: 'failed', error: { interrupted: true } });
    expect(state.effectOrder.filter((e) => e.name === 'tool.unsafe_make_payment')).toHaveLength(1);
    const ledger = await readLedger(b.world, sessionId);
    expect(ledger.map((l) => [l.tool, l.callKey])).toEqual([['unsafe_make_payment', 'tool:call_1']]);

    // The recovery note told the model what the log knows.
    const entries = transcriptOf(state).map((r) => r.data);
    const note = entries.find((e) => e.type === 'message' && e.role === 'user');
    expect(note).toMatchObject({ synthetic: 'recovery' });
    expect((note as { text: string }).text).toContain('unsafe_make_payment');
    expect((note as { text: string }).text).toContain('may have taken effect');
    expect(entries.at(-2)).toEqual({ type: 'message', role: 'assistant', text: expect.stringContaining('Recovered from the log') });
    // The CLI's own resume answered the dangling call; that is in the journal too.
    const native = nativeLines(state).map((l) => JSON.parse(l));
    expect(native.find((r) => r.type === 'tool_result')).toMatchObject({ id: 'call_1', synthetic: true, isError: true });
    expect(fileLines(join(rootB, sessionId, 'session.jsonl'))).toEqual(nativeLines(state));
    stale.kill();
  });

  it('a crash on the same machine: the stale child is killed before the session resumes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hwp-ref-'));
    const root = await mkdtemp(join(tmpdir(), 'hwp-root-'));
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const a = await session(dataDir, root, { chaos: true, crash: () => crashed() });
    const { sessionId } = await a.sessions.start();
    await a.sessions.chaos(sessionId, { at: 'tool', afterMs: 300 });
    await a.sessions.send(sessionId, 'call unsafe_send_email {"to":"a@b.c","subject":"hi","body":"x"}');
    await died;
    await a.world.close?.();
    const stale = a.host.spawned.at(-1)!;
    expect(isAlive(stale.pid)).toBe(true);

    const b = await session(dataDir, root, { chaos: true, recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1);
    await until(async () => (isAlive(stale.pid) ? undefined : true), 5000);
    expect(state.effects.get('tool:call_1')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect((await readLedger(b.world, sessionId)).length).toBe(1);
    expect(fileLines(join(root, sessionId, 'session.jsonl'))).toEqual(nativeLines(state));
  });

  it('a refused journal write halts the drive and kills the child', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hwp-ref-'));
    const root = await mkdtemp(join(tmpdir(), 'hwp-root-'));
    const a = await session(dataDir, root);
    const { sessionId } = await a.sessions.start();
    await a.sessions.send(sessionId, 'hello', 'prompt', { wake: 'backstop' });
    const create = a.world.events.create.bind(a.world.events);
    const refused = new Error('the World refused the write');
    a.world.events.create = (async (runId: string, request: any, params?: any) => {
      if (request?.eventType === 'step_started' && String(request.eventData?.stepName).endsWith('//journal')) throw refused;
      return create(runId, request, params);
    }) as typeof a.world.events.create;
    await expect(a.sessions.drive(sessionId)).rejects.toBe(refused);
    const child = a.host.spawned[0]!;
    await until(async () => (child.alive() ? undefined : true), 5000);
    const state = await a.sessions.inspect(sessionId);
    expect(state.effectOrder.some((e) => e.name === 'journal')).toBe(false);
  });

  it('with its model behind the gateway proxy, a turn writes no model step (no drill is armed)', async () => {
    const model = await fakeModel();
    models.push(model);
    const a = await session(await mkdtemp(join(tmpdir(), 'hwp-ref-')), await mkdtemp(join(tmpdir(), 'hwp-root-')), { modelUrl: model.url });
    const { sessionId } = await a.sessions.start({ prompt: 'call write_file {"path":"notes.txt","content":"hi"}' });
    const state = await waitTurns(a.sessions, sessionId, 1);
    // The CLI's replies streamed from the model, through the proxy.
    expect(model.requests.map((r) => r.text)).toEqual(['Calling write_file.', expect.stringContaining('write_file returned: wrote 2 bytes')]);
    expect(transcriptOf(state).at(-2)?.data).toEqual({ type: 'message', role: 'assistant', text: expect.stringContaining('write_file returned') });
    expect(state.effectOrder.filter((e) => e.name === 'model')).toEqual([]);
  });

  it('a crash while the model streams, after a never tool: the chaos step names the model step, the recovered turn makes the call again, and the email went out once', async () => {
    // The model types the reply to the tool's result slowly: that is the stream the crash cuts.
    const model = await fakeModel({ pieceMs: (text) => (text.startsWith('unsafe_send_email returned') ? 150 : 5) });
    models.push(model);
    const dataDir = await mkdtemp(join(tmpdir(), 'hwp-ref-'));
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const a = await session(dataDir, await mkdtemp(join(tmpdir(), 'hwp-root-a-')), { chaos: true, crash: () => crashed(), modelUrl: model.url, confirmMs: 500 });
    const { sessionId } = await a.sessions.start();
    await a.sessions.chaos(sessionId, { at: 'model', afterMs: 400 });
    await a.sessions.send(sessionId, 'call unsafe_send_email {"to":"a@b.c","subject":"hi","body":"x"}');
    await died;
    let state = await a.sessions.inspect(sessionId);
    // The first model request ("Calling ...") ended before the crash was due: it fired in the second.
    const steps = state.effectOrder.filter((e) => e.name === 'model');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ status: 'completed', output: { requests: 1, status: 200 } });
    const chaos = state.effectOrder.find((e) => e.name === 'chaos')!;
    expect(chaos).toMatchObject({ status: 'completed', output: { v: 2, effect: 'model', crashedDuring: steps[1]!.key } });
    expect(steps[1]).toMatchObject({ status: 'running' });
    expect(state.effects.get('tool:call_1')).toMatchObject({ name: 'tool.unsafe_send_email', status: 'completed' });
    expect(turnsEnded(state)).toBe(0);
    // The process is gone, its World with it.
    await a.world.close?.();

    const b = await session(dataDir, await mkdtemp(join(tmpdir(), 'hwp-root-b-')), { chaos: true, recover: true, modelUrl: model.url });
    state = await waitTurns(b.sessions, sessionId, 1);
    // The killed step was retried by the recovered turn's model request: attempt 2, completed. Nothing is left open.
    expect(state.effects.get(steps[1]!.key)).toMatchObject({ name: 'model', status: 'completed', attempt: 2 });
    expect(state.effectOrder.filter((e) => e.name === 'model')).toHaveLength(2);
    expect(state.effectOrder.filter((e) => e.status === 'running' || e.status === 'pending')).toEqual([]);
    // The email ran once, and the note told the model it had completed.
    expect(state.effectOrder.filter((e) => e.name === 'tool.unsafe_send_email')).toHaveLength(1);
    expect((await readLedger(b.world, sessionId)).map((l) => l.callKey)).toEqual(['tool:call_1']);
    const entries = transcriptOf(state).map((r) => r.data);
    const note = entries.find((e) => e.type === 'message' && e.role === 'user') as { text: string; synthetic?: string };
    expect(note).toMatchObject({ synthetic: 'recovery' });
    expect(note.text).toMatch(/unsafe_send_email\(.*\), call call_1: completed/);
    expect(entries.at(-2)).toEqual({ type: 'message', role: 'assistant', text: expect.stringContaining('Recovered from the log') });
    expect(entries.at(-1)).toEqual({ type: 'turn', status: 'completed' });
  });
});
