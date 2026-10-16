/**
 * The drills on a session's own sandbox (docs/workspaces.md §8 "Drills"),
 * wired end to end on the stand-in: the kernel arms and records each one
 * (harness-world's `drills.test.ts`), and the session factory carries it out
 * on the stand-in's VMs and Drives (`fake-api.ts`), under a small kernel
 * harness whose tool runs each prompt as a command on the VM's `/workspace`.
 * What each drill looks like under Claude Code (the real CLI's recovery note,
 * no rerun) is its twin in `harness-claude-code/test/sandbox-restart.test.ts`:
 * D1 is R2, D2 is R1, D3 is R6's detach lag, D4 is R5's dropped `/ctl` and
 * `/model`, D5 is R3.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type ChaosSpec, type DriveContext, durableSessions, EffectFailure, EffectInterrupted, type Harness, QUEUE_PREFIX, type SessionState } from 'harness-world';
import type { AcquireMachine } from 'harness-world-process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionName } from '../src/names.ts';
import { attachInDrive, sandboxSession } from '../src/session.ts';
import { FakeSandboxApi, type FakeApiOptions } from './fake-api.ts';

beforeAll(() => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

const worlds: LocalWorld[] = [];
const apis: FakeSandboxApi[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
  for (const a of apis.splice(0)) await a.dispose();
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Per prompt: attach, run it as a command (`tool.Bash`, `never`); a command
 * the link's loss cut off is interrupted, and the drive re-attaches in the
 * same invocation to run `cat runs.txt` (`tool.again`).
 */
function shell(acquire: AcquireMachine): Harness {
  return {
    name: 'shell',
    async drive(ctx: DriveContext) {
      for (const s of ctx.pending()) {
        let machine = await attachInDrive(ctx, acquire);
        const run = (key: string, name: string, command: string, placed: string[] = []) =>
          ctx.effect(key, { name, replay: 'never', input: command, placed }, async () => {
            try {
              return (await machine.workspace.exec(command)).stdout;
            } catch (err) {
              throw new EffectInterrupted(String((err as Error)?.message ?? err));
            }
          });
        try {
          await run(`tool:${s.id}`, 'tool.Bash', s.text ?? '', [s.id]);
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
          machine = await attachInDrive(ctx, acquire);
          await run(`again:${s.id}`, 'tool.again', 'cat runs.txt 2>/dev/null; echo reattached').catch((e) => {
            if (!(e instanceof EffectFailure)) throw e;
          });
        }
      }
    },
  };
}

async function session(options: FakeApiOptions = {}) {
  const api = new FakeSandboxApi(options);
  apis.push(api);
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const acquire = sandboxSession({
    spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
    test: { api, allowDegraded: true, allowUnauthenticatedModel: true, probeMs: 50 },
    log: (message, fields) => void logs.push({ message, ...(fields ? { fields } : {}) }),
  });
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'dh-drills-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness: shell(acquire), chaos: true });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  const { sessionId } = await sessions.start();
  const name = sessionName('prj_stand_in', sessionId);
  /** Send a prompt and wait for its command's outcome. */
  const turn = async (command: string, crash?: ChaosSpec): Promise<SessionState> => {
    if (crash) await sessions.chaos(sessionId, crash);
    const before = (await sessions.inspect(sessionId)).effectOrder.filter((e) => e.name === 'tool.Bash').length;
    await sessions.send(sessionId, command);
    return until(async () => {
      const s = await sessions.inspect(sessionId);
      const calls = s.effectOrder.filter((e) => e.name === 'tool.Bash');
      const last = calls.at(-1);
      const again = s.effectOrder.find((e) => e.key === `again:${String(last?.placed?.[0] ?? '')}`);
      if (calls.length <= before || !settled(last)) return undefined;
      return last!.status === 'failed' && !settled(again) ? undefined : s;
    });
  };
  const vmSession = () => api.vms.get(name)?.sessionId;
  return { api, logs, sessions, sessionId, name, turn, vmSession };
}

/** Whether an effect has its outcome: `pending` (its intent written, not yet started) and `running` haven't. */
const settled = (e?: { status: string }) => e !== undefined && e.status !== 'pending' && e.status !== 'running';
const chaosOf = (state: SessionState) => state.effectOrder.filter((e) => e.name === 'chaos').map((e) => e.input as { kind: string; effect: string });
const lastBash = (state: SessionState) => state.effectOrder.filter((e) => e.name === 'tool.Bash').at(-1)!;
const again = (state: SessionState) => state.effectOrder.filter((e) => e.name === 'tool.again').at(-1);

describe('the drills on the session sandbox, on the stand-in', () => {
  it('D1: the VM stopped mid-command: the call comes back interrupted, not rerun; the next turn runs on a new VM over the same Drive', async () => {
    const s = await session();
    await s.turn('echo boot');
    const vmA = s.vmSession();
    const one = await s.turn('echo started >> runs.txt; sleep 3; echo done >> runs.txt', { at: 'tool', kind: 'sandbox-vm', afterMs: 700 });
    expect(chaosOf(one)).toEqual([expect.objectContaining({ kind: 'sandbox-vm', effect: 'tool.Bash' })]);
    expect(s.api.calls).toContain(`stop:${s.name}`);
    expect(lastBash(one)).toMatchObject({ status: 'failed', error: { interrupted: true } });
    // Re-attached in the same invocation: the stopped VM deleted by its owner, a new one on the same Drive, which kept the half-run.
    expect(again(one)).toMatchObject({ status: 'completed', output: 'started\nreattached\n' });
    expect(s.vmSession()).not.toBe(vmA);
  }, 60_000);

  it('D2: the VM deleted between turns, the Drive kept: the turn boots a new VM on the same Drive, with no wait on the old one', async () => {
    const s = await session({ detachMs: 800 });
    await s.turn('echo heron > note.txt');
    const vmA = s.vmSession();
    const two = await s.turn('cat note.txt', { at: 'sandbox', kind: 'sandbox-new-vm' });
    expect(chaosOf(two)).toEqual([expect.objectContaining({ kind: 'sandbox-new-vm', effect: 'sandbox.attach' })]);
    expect(s.api.calls).toContain(`delete:${s.name}:${vmA}`);
    expect(s.vmSession()).not.toBe(vmA);
    expect(lastBash(two)).toMatchObject({ status: 'completed', output: 'heron\n' });
    // The drill waited for the Drive to let go, so the new VM's create met no 409.
    expect(s.logs.some((l) => l.message.includes('still attached'))).toBe(false);
  }, 60_000);

  it('D3: the old VM left holding the Drive: the new driver deletes it once stopped, waits out the 409, and resumes on the same Drive', async () => {
    const s = await session({ detachMs: 1500 });
    await s.turn('echo kestrel > note.txt');
    const vmA = s.vmSession();
    const two = await s.turn('cat note.txt', { at: 'sandbox', kind: 'sandbox-zombie' });
    expect(chaosOf(two)).toEqual([expect.objectContaining({ kind: 'sandbox-zombie', effect: 'sandbox.attach' })]);
    expect(s.api.calls).toContain(`stop:${s.name}`);
    expect(s.api.calls).toContain(`delete:${s.name}:${vmA}`);
    expect(s.logs.some((l) => l.message.includes('still attached to an earlier VM session'))).toBe(true);
    expect(s.vmSession()).not.toBe(vmA);
    expect(lastBash(two)).toMatchObject({ status: 'completed', output: 'kestrel\n' });
  }, 60_000);

  it('D4: a socket of the relay link dropped mid-command: the drive re-attaches to the same VM in the same invocation', async () => {
    const s = await session();
    await s.turn('echo boot');
    const vmA = s.vmSession();
    const creates = () => s.api.calls.filter((c) => c.startsWith('createSandbox')).length;
    const before = creates();
    const one = await s.turn('echo started >> runs.txt; sleep 3; echo done >> runs.txt', { at: 'tool', kind: 'relay-drop', afterMs: 700 });
    expect(chaosOf(one)).toEqual([expect.objectContaining({ kind: 'relay-drop', effect: 'tool.Bash' })]);
    expect(s.logs.some((l) => l.message === 'drill: dropping a socket of the relay link' && l.fields?.socket === 'ctl')).toBe(true);
    expect(s.logs.some((l) => l.message === 'relay link lost')).toBe(true);
    expect(lastBash(one)).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(again(one)).toMatchObject({ status: 'completed' });
    expect(String(again(one)?.output)).toContain('reattached');
    // The same VM: re-armed, not replaced.
    expect(s.vmSession()).toBe(vmA);
    expect(creates()).toBe(before);
  }, 60_000);
});
