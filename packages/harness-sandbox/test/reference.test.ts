/**
 * The reference process harness (`harness-process/reference`) end to end on the
 * sandbox tier's stand-in (docs/workspaces.md §11.4 A3): the kernel drives the
 * fake CLI on a branded machine from the session factory (`attachInDrive`: the
 * `sandbox.attach` fact, the fence read inside it, the `hw.sandbox` record), its
 * model calls go through the VM's model port, `/model` and `gatewayHandler` to
 * a fake model (the drive's model steps see them), its tool calls are served in
 * the "Function", and after the VM is torn down a later turn resumes on a fresh
 * VM, over the same Drive, from the log alone.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, type HostTool, QUEUE_PREFIX, readDoc, type SessionState, UNAVAILABLE_STEP } from 'harness-world';
import { journalRecords, transcriptOf } from 'harness-world-process';
import { referenceHarness } from 'harness-world-process/reference';
import { type FakeModel, fakeModel } from 'harness-world-process/reference/fake-model';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sessionName } from '../src/names.ts';
import { attachInDrive, SANDBOX_DOC, sandboxSession } from '../src/session.ts';
import { FakeSandboxApi } from './fake-api.ts';

beforeAll(() => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
});

const worlds: LocalWorld[] = [];
const models: FakeModel[] = [];
const apis: FakeSandboxApi[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
  for (const m of models.splice(0)) await m.close();
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

const turnsEnded = (state: SessionState) => transcriptOf(state).filter((r) => r.data.type === 'turn').length;
const nativeTypes = (state: SessionState) => journalRecords<string>(state, 'native').map((r) => JSON.parse(r.data).type as string);

/** A tool that runs in the "Function": it never sees the VM. */
const note: HostTool<{ text: string }> = {
  name: 'note',
  description: 'Remember a note.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  replay: 'never',
  execute: async ({ text }) => `noted: ${text}`,
};

/** A ledger standing in for the log's totals: how many requests were checked against the budget, and what was charged (the Gateway's figure, or an estimate). */
const ledger = {
  checked: 0,
  turn: 0,
  session: 0,
  charges: [] as { usd: number; estimated: boolean }[],
  spent: () => (ledger.checked++, { turnUsd: ledger.turn, sessionUsd: ledger.session }),
  add: (usd: number, info: { estimated?: boolean }) => {
    ledger.charges.push({ usd, estimated: info.estimated === true });
    ledger.turn += usd;
    ledger.session += usd;
  },
};

async function session(dataDir: string, api: FakeSandboxApi, model: FakeModel) {
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  const acquire = sandboxSession({
    spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
    test: { api, allowDegraded: true, allowUnauthenticatedModel: true },
  });
  const sessions = durableSessions({
    world,
    harness: referenceHarness({ tools: [note], modelUrl: model.url, budget: { turnUsd: 1, sessionUsd: 1.5 }, ledger, machine: (ctx, handler) => attachInDrive(ctx, acquire, { ...(handler ? { model: handler } : {}) }) }),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  await world.start?.();
  return { world, sessions };
}

describe('the reference harness on the sandbox stand-in', () => {
  it('a tool turn with model steps through the tunnel; the VM torn down, the next turn resumes on a fresh VM from the log', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dh-ref-sandbox-'));
    const api = new FakeSandboxApi();
    apis.push(api);
    const model = await fakeModel({ cost: '0.6' });
    models.push(model);
    const a = await session(dataDir, api, model);
    const { sessionId } = await a.sessions.start({ prompt: 'call note {"text":"the code word is heron"}' });
    let state = await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      return turnsEnded(s) >= 1 ? s : undefined;
    });

    // The tool ran once, in the Function, after its call was in the journal.
    expect(state.effects.get('tool:call_1')).toMatchObject({ name: 'tool.note', status: 'completed', output: 'noted: the code word is heron' });
    expect(nativeTypes(state)).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'turn_end']);
    // The model calls went through the VM's model port and the tunnel: the fake model saw them, and the drive has its model steps.
    expect(model.requests.map((r) => r.path)).toEqual(['/v1/model', '/v1/model']);
    expect(model.requests.every((r) => r.completed)).toBe(true);
    // Each was checked against the budget, and charged the Gateway's own figure from its stream: the second still under the turn's $1 cap.
    expect(ledger.checked).toBe(2);
    expect(ledger.charges).toEqual([{ usd: 0.6, estimated: false }, { usd: 0.6, estimated: false }]);
    // The attach was a fact, armed with the drive's fence, and the record names the Drive.
    const attachFacts = [...state.effects.values()].filter((e) => e.name === 'sandbox.attach');
    expect(attachFacts.length).toBeGreaterThanOrEqual(1);
    expect(attachFacts.every((e) => e.status === 'completed')).toBe(true);
    const name = sessionName('prj_stand_in', sessionId);
    const record = readDoc(state, SANDBOX_DOC).value;
    expect(record).toMatchObject({ sandboxName: name, driveId: api.drives.get(name)!.info.driveId });
    const vmA = api.vms.get(name)!.sessionId;

    // A new turn: the turn's total starts again (the log keeps it per turn), the session's carries on.
    ledger.turn = 0;
    // Tear the VM down (its relay, rootfs and cache dirs go); the Drive stays. A new process drives the next turn.
    await (await api.getSandbox(name))!.delete();
    await a.world.close?.();
    const b = await session(dataDir, api, model);
    await b.sessions.send(sessionId, 'hello again');
    state = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      return turnsEnded(s) >= 2 ? s : undefined;
    });
    expect(api.vms.get(name)!.sessionId).not.toBe(vmA);
    expect(transcriptOf(state).at(-2)?.data).toEqual({ type: 'message', role: 'assistant', text: 'echo: hello again' });
    // The CLI resumed from the file the log rebuilt on the new VM: its records continue the first VM's.
    expect(nativeTypes(state)).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'turn_end', 'user', 'assistant', 'turn_end']);
    expect(model.requests).toHaveLength(3);
    expect(ledger.session).toBeCloseTo(1.8);
    // Past the session's $1.50: the next turn's model call is checked and refused in the Function, never forwarded, and the turn ends at once saying which cap.
    ledger.turn = 0;
    await b.sessions.send(sessionId, 'one more');
    const capped = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      const fact = [...s.effects.values()].find((e) => e.name === UNAVAILABLE_STEP);
      return fact ? (fact.input as { message?: string }) : undefined;
    });
    expect(capped.message).toMatch(/session's model spend reached its cap \(sandbox\(\{ budget: \{ sessionUsd \} \}\)\)/);
    expect(ledger.checked).toBe(4);
    expect(model.requests).toHaveLength(3);
    expect(ledger.charges).toHaveLength(3);
    // The same Drive, by the record too.
    expect(readDoc(state, SANDBOX_DOC).value.driveId).toBe(record.driveId);
  });
});
