/**
 * Restart on a new sandbox for Codex (docs/workspaces.md §11.4, R1-R8), on
 * the stand-in with the fake app-server. R1 (a VM torn down between turns)
 * and R8 (a lost Drive) are in `sandbox-restart.test.ts`, R3 and R5 (a crash
 * mid-tool, mid-model-stream) in `harness.test.ts`; here: a driver process
 * SIGKILLed and the session recovered by another process on a new VM (R1,
 * R2), the VM itself killed mid-command (R2), a stalled driver after a
 * takeover (R4), one relay socket dropped alone (R5), a crash between the
 * command and its outcome with the old VM session still holding the Drive
 * (R6), three VMs and a compaction (R7), and an app tool still running when
 * the link drops.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HostTool, readDoc } from 'harness-world';
import { FILES_LOST_NOTE, SANDBOX_DOC } from 'harness-world-sandbox';
import { readLedger, unsafeTools } from 'harness-world-hands';
import { journalRecords, transcriptOf } from 'harness-world-process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { summarizeRollout } from '../src/rollout.ts';
import { driveOf, fileLines, nameOf, type Rig, rig, rolloutFile, rolloutLines, session, standInEnv, tearDown, threadOf, tmp, turnsEnded, until, vmOf, waitTurns } from './stand-in.ts';

beforeAll(standInEnv);

const rigs: Rig[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.pid && c.exitCode === null) killGroup(c);
  for (const r of rigs.splice(0)) await r.dispose();
});
const newRig = async (...args: Parameters<typeof rig>) => {
  const r = await rig(...args);
  rigs.push(r);
  return r;
};
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, 'SIGKILL');
  } catch {}
};

const CHILD = fileURLToPath(new URL('./drive-child.ts', import.meta.url));

/** A driver in a process of its own (`drive-child.ts`), on its own stand-in API: its JSON lines as they come. */
function driver(dataDir: string, r: Rig, prompt: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, dataDir, r.model.url, prompt], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test', DH_TEST_LOCAL_SANDBOX: '1', VITEST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: the kill takes its relays (its "VMs") with it.
    detached: true,
  });
  children.push(child);
  const seen: Record<string, any>[] = [];
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += d;
    for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      try {
        seen.push(JSON.parse(line));
      } catch {}
    }
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  return {
    seen,
    stderr: () => stderr,
    wait: <T>(pick: (m: Record<string, any>) => T | undefined, timeoutMs = 60_000) => until(async () => seen.map(pick).find((x) => x !== undefined), timeoutMs),
    kill: () => killGroup(child),
  };
}

describe('Codex: restart on a new sandbox (§11.4)', () => {
  it('R1/R2, a driver process SIGKILLed mid-command: another process recovers the session on a new VM over the same Drive, the call interrupted, never rerun', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-rs-');
    const a = driver(dataDir, r, 'shell echo started >> runs.txt; sleep 3; echo done >> out.txt');
    const sessionId = await a.wait((m) => m.sessionId as string | undefined);
    const drive = await a.wait((m) => m.drive as { name: string; driveId: string; region: string; maxSize: number; dir: string } | undefined);
    await until(async () => (existsSync(join(drive.dir, 'runs.txt')) ? true : undefined));
    // The Function goes, with everything it held: its links, its caches, its fake API, its relays.
    a.kill();
    await sleep(200);
    r.api.adoptDrive(drive, drive.dir);
    const b = await session(dataDir, r, { builtins: true, recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1, 60_000);
    const shell = state.effectOrder.filter((e) => e.name === 'tool.shell');
    expect(shell).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ interrupted: true }) })]);
    await sleep(3500);
    expect(readFileSync(join(drive.dir, 'runs.txt'), 'utf8')).toBe('started\n');
    expect(existsSync(join(drive.dir, 'out.txt'))).toBe(false);
    // The dangling exec_command got its output from the log, and the turn recovered on the new VM.
    const id = shell[0]!.key.slice('tool:'.length);
    expect(rolloutLines(state).filter((l) => l.includes('"function_call_output"') && l.includes(id))).toHaveLength(1);
    expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });
    expect(fileLines(rolloutFile(r, sessionId, state))).toEqual(rolloutLines(state));
  }, 120_000);

  it('R1, a driver process SIGKILLed between turns: another process, on a new VM over the same Drive, resumes the thread from the log alone', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-rs-');
    const a = driver(dataDir, r, 'the code word is heron');
    const sessionId = await a.wait((m) => m.sessionId as string | undefined);
    const drive = await a.wait((m) => m.drive as { name: string; driveId: string; region: string; maxSize: number; dir: string } | undefined);
    a.kill();
    await sleep(200);
    r.api.adoptDrive(drive, drive.dir);
    const b = await session(dataDir, r, { builtins: true });
    await b.sessions.send(sessionId, 'recall');
    const state = await waitTurns(b.sessions, sessionId, 2, 60_000);
    const said = transcriptOf(state)
      .map((e) => e.data)
      .filter((d) => d.type === 'message' && d.role === 'assistant')
      .map((d) => (d as { text: string }).text);
    expect(said.at(-1)).toBe('the code word is heron');
    expect(journalRecords(state, 'codex.thread')).toHaveLength(1);
    expect(fileLines(rolloutFile(r, sessionId, state))).toEqual(rolloutLines(state));
  }, 120_000);

  it('R2, the VM itself killed mid-command: the drive re-attaches to a new VM in the same invocation, the call interrupted, never rerun', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-rs-'), r, { builtins: true });
    const { sessionId } = await a.sessions.start({ prompt: 'shell echo started >> runs.txt; sleep 3; echo done >> out.txt' });
    await until(async () => (r.api.drives.has(nameOf(sessionId)) && existsSync(join(driveOf(r, sessionId), 'runs.txt')) ? true : undefined));
    const vmA = vmOf(r, sessionId)!.sessionId;
    await tearDown(r, sessionId);
    const state = await waitTurns(a.sessions, sessionId, 1);
    expect(vmOf(r, sessionId)!.sessionId).not.toBe(vmA);
    expect(state.effectOrder.filter((e) => e.name === 'tool.shell')).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ interrupted: true }) })]);
    await sleep(3500);
    expect(readFileSync(join(driveOf(r, sessionId), 'runs.txt'), 'utf8')).toBe('started\n');
    expect(existsSync(join(driveOf(r, sessionId), 'out.txt'))).toBe(false);
    expect(r.logs.some((l) => l.message.includes('re-attaching'))).toBe(true);
    expect(turnsEnded(state)).toBe(1);
  });

  it('R4, a stalled driver after a takeover: its link is superseded, its re-attach yields preempted, and it spawns and writes nothing more', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-rs-');
    const aLogs: string[] = [];
    // A drive whose model thinks for 5 s: it is "stalled" mid-turn when the next owner takes the session.
    const a = await session(dataDir, r, { env: { FAKE_CODEX_THINK_MS: '5000' }, harness: { log: (m) => void aLogs.push(m) } });
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await until(async () => ((await a.sessions.inspect(sessionId)).placed.size > 0 && vmOf(r, sessionId) ? true : undefined));
    await sleep(300);
    const attachesBefore = (await a.sessions.inspect(sessionId)).effectOrder.filter((e) => e.name === 'sandbox.attach').length;
    // Another machine drives the session: a higher fence, which the relay prefers.
    const b = await session(dataDir, r, { recover: true });
    const driven = b.sessions.drive(sessionId).catch((err: unknown) => err);
    const state = await waitTurns(b.sessions, sessionId, 1, 60_000);
    await driven;
    await sleep(1000);
    const losses = r.logs.filter((l) => l.message === 'relay link lost');
    expect(String(losses[0]?.fields?.reason)).toMatch(/superseded by a newer owner/);
    // The relay was armed twice: A at its fence, then B at a higher one. A's re-attach after the takeover armed nothing (it yielded preempted).
    const arms = r.logs.filter((l) => l.message === 'attached').map((l) => l.fields?.fence as number);
    expect(arms).toHaveLength(2);
    expect(arms[1]!).toBeGreaterThan(arms[0]!);
    expect(aLogs.filter((m) => m.includes('re-attaching')).length).toBeLessThanOrEqual(1);
    // One successful attach per owner in the log, and one turn, B's.
    const after = await b.sessions.inspect(sessionId);
    expect(after.effectOrder.filter((e) => e.name === 'sandbox.attach' && (e.output as { attached?: boolean } | undefined)?.attached).length).toBe(attachesBefore + 1);
    expect(transcriptOf(state).filter((e) => e.data.type === 'turn').map((e) => e.data)).toEqual([{ type: 'turn', status: 'completed' }]);
  }, 90_000);

  for (const path of ['/ctl', '/model'] as const) {
    it(`R5, ${path} dropped alone mid-turn: the link is lost as a whole, re-attached, and the turn ends once`, async () => {
      const r = await newRig({ api: { proxy: true }, model: { pieceMs: () => 150 } });
      const a = await session(await tmp('hwc-rs-'), r);
      const { sessionId } = await a.sessions.start({ prompt: 'the reply streams slowly enough to cut it' });
      // Mid-stream: a model request streaming through the tunnel.
      await until(async () => (r.model.requests.some((q) => !q.completed) ? true : undefined));
      await sleep(300);
      expect(r.api.dropSockets(nameOf(sessionId), path)).toBeGreaterThan(0);
      const state = await waitTurns(a.sessions, sessionId, 1);
      expect(r.logs.some((l) => l.message === 'relay link lost')).toBe(true);
      expect(r.logs.some((l) => l.message.includes('re-attaching'))).toBe(true);
      expect(state.effectOrder.filter((e) => e.status === 'running' || e.status === 'pending')).toEqual([]);
      // The cut request was made again on the new attach (the recovery's turn), and every request ended.
      expect(r.model.requests.length).toBeGreaterThanOrEqual(2);
      expect(turnsEnded(state)).toBe(1);
      expect(transcriptOf(state).at(-1)?.data).toEqual({ type: 'turn', status: 'completed' });
    });
  }

  it('the Drive deleted, then /ctl dropped right after turn/start: the files-lost note reaches a turn that completes before the record is told', async () => {
    const r = await newRig({ api: { proxy: true }, model: { pieceMs: () => 150 } });
    const a = await session(await tmp('hwc-rs-'), r);
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await waitTurns(a.sessions, sessionId, 1);
    await tearDown(r, sessionId);
    r.api.dropDrive(nameOf(sessionId));
    const from = r.model.requests.length;
    await a.sessions.send(sessionId, 'second');
    // The turn that carries the note is streaming: the link drops under it, before it commits.
    await until(async () => (r.model.requests.slice(from).some((q) => !q.completed && q.text.includes(FILES_LOST_NOTE)) ? true : undefined));
    expect(r.api.dropSockets(nameOf(sessionId), '/ctl')).toBeGreaterThan(0);
    await waitTurns(a.sessions, sessionId, 2);
    const state = await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.name === 'sandbox.notes' && e.status === 'completed') ? s : undefined;
    });
    expect(r.logs.some((l) => l.message.includes('re-attaching'))).toBe(true);
    // A model request that carried the note ran to its end: the model heard it in a turn that committed, then the record was told.
    expect(r.model.requests.slice(from).some((q) => q.completed && q.text.includes(FILES_LOST_NOTE))).toBe(true);
    expect(readDoc(state, SANDBOX_DOC).value.filesLost).toBeUndefined();
  }, 90_000);

  it('R6, a crash between the command and its outcome, the old VM session still holding the Drive: the new VM waits for it, the call is interrupted, its write is on the Drive once', async () => {
    const r = await newRig({ api: { detachMs: 2500 } });
    const dataDir = await tmp('hwc-rs-');
    let crashed!: () => void;
    const died = new Promise<void>((res) => (crashed = res));
    // The command is done in a moment; Codex reports it completed 3 s later: the crash lands between them, before FSYNC and the outcome.
    const a = await session(dataDir, r, { builtins: true, chaos: true, crash: () => crashed(), env: { FAKE_CODEX_COMPLETE_MS: '3000' } });
    const { sessionId } = await a.sessions.start();
    await a.sessions.chaos(sessionId, { at: 'tool', afterMs: 800 });
    await a.sessions.send(sessionId, 'shell echo once >> f.txt');
    await died;
    await a.world.close?.();
    expect(readFileSync(join(driveOf(r, sessionId), 'f.txt'), 'utf8')).toBe('once\n');
    await tearDown(r, sessionId);
    const b = await session(dataDir, r, { builtins: true, chaos: true, recover: true });
    const state = await waitTurns(b.sessions, sessionId, 1, 60_000);
    // B's first create met the Drive still held by the old VM session (409 drive_attached), and was retried.
    expect(r.api.calls.filter((c) => c.startsWith('createSandbox')).length).toBeGreaterThanOrEqual(3);
    expect(state.effectOrder.filter((e) => e.name === 'tool.shell')).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ interrupted: true }) })]);
    expect(readFileSync(join(driveOf(r, sessionId), 'f.txt'), 'utf8')).toBe('once\n');
    expect(transcriptOf(state).map((e) => e.data).find((e) => e.type === 'message' && e.role === 'user')).toMatchObject({ synthetic: 'recovery', text: expect.stringContaining('may have taken effect') });
  }, 90_000);

  it('R7, three VMs in turn and a compaction between them: one thread, resumed from the log each time, the code word recalled past the compaction', async () => {
    const r = await newRig();
    const dataDir = await tmp('hwc-rs-');
    const vms: string[] = [];
    const turn = async (text: string, n: number, sessionId?: string) => {
      const m = await session(dataDir, r);
      const id = sessionId ?? (await m.sessions.start({ prompt: text })).sessionId;
      if (sessionId) await m.sessions.send(sessionId, text);
      const state = await waitTurns(m.sessions, id, n);
      vms.push(vmOf(r, id)!.sessionId);
      await m.world.close?.();
      await tearDown(r, id);
      return { id, state };
    };
    const { id } = await turn('the code word is heron', 1);
    await turn('compact', 2, id);
    const { state } = await turn('recall', 3, id);
    expect(new Set(vms).size).toBe(3);
    const said = transcriptOf(state)
      .map((e) => e.data)
      .filter((d) => d.type === 'message' && d.role === 'assistant')
      .map((d) => (d as { text: string }).text);
    expect(said.at(-1)).toBe('the code word is heron');
    const lines = rolloutLines(state);
    expect(lines.some((l) => JSON.parse(l).type === 'compacted')).toBe(true);
    expect(summarizeRollout(lines).idle).toBe(true);
    expect(journalRecords(state, 'codex.thread')).toHaveLength(1);
    expect(threadOf(state)).toBeDefined();
  }, 90_000);

  it('an app tool still running when the link drops: the re-attach waits for it, so its real outcome is what the model hears, and it ran once', async () => {
    const r = await newRig();
    const a = await session(await tmp('hwc-rs-'), r, { confirmMs: 2000, tools: unsafeTools({ confirmMs: 2000 }) as HostTool[] });
    const { sessionId } = await a.sessions.start({ prompt: 'call unsafe_send_email {"to":"a@b.c","subject":"hi","body":"x"}' });
    // Mid-confirm: its effect is open, the email not yet out.
    await until(async () => ((await a.sessions.inspect(sessionId)).effectOrder.some((e) => e.name === 'tool.unsafe_send_email' && e.status === 'running') ? true : undefined));
    await r.api.relayOf(nameOf(sessionId))!.kill();
    const state = await waitTurns(a.sessions, sessionId, 1, 60_000);
    const email = state.effectOrder.filter((e) => e.name === 'tool.unsafe_send_email');
    expect(email).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect((await readLedger(a.world, sessionId)).map((l) => l.callKey)).toEqual([email[0]!.key]);
    // The output injected for the dangling call is the completed result, not "it may have taken effect".
    const id = email[0]!.key.slice('tool:'.length);
    const outputs = rolloutLines(state).filter((l) => l.includes('"function_call_output"') && l.includes(id));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain(String(email[0]!.output).slice(0, 20));
    expect(outputs[0]).not.toContain('may have taken effect');
    expect(r.logs.some((l) => l.message.includes('re-attaching'))).toBe(true);
  });
});
