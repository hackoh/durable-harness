import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { deliver, durableSessions, type HostTool, Parked, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { piHarness } from 'harness-world-pi';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSandboxResult, mintResultToken, verifyResultToken } from './callback.ts';
import { FakeSandboxProvider } from './fake-sandbox.ts';
import { baselineText, jobDirFor, jobFiles, MAX_REPORT_BYTES } from './sandbox-job.ts';
import { type SandboxJob, type SandboxOwner, sha256Hex, syncIn } from './sandbox-sync.ts';
import { piSetup, PUSH_SECRET, until } from './testing.ts';

let setup: { world: LocalWorld; sandbox: FakeSandboxProvider; sessionId: string; queue: string[]; inspect(): Promise<SessionState> } | undefined;
afterEach(async () => {
  await setup?.world.close?.();
  setup = undefined;
});

const report = { v: 1, exitCode: 0, stdout: { bytes: 3, head: 'hi\n', tail: '' }, stderr: { bytes: 0, head: '', tail: '' } };

describe('sandbox result tokens', () => {
  const payload = { r: 'wrun_1', s: 'step_1', n: 'hybrid-wrun_1', x: Math.floor(Date.now() / 1000) + 60 };

  it('verifies what it minted, and nothing else', async () => {
    const token = await mintResultToken('k', payload);
    expect(token.startsWith('hsr1.')).toBe(true);
    expect(await verifyResultToken('k', token)).toEqual(payload);
    // Another key, a tampered payload, a tampered signature, an expired token.
    expect(await verifyResultToken('other', token)).toBeUndefined();
    const [p, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, s: 'step_2' })).toString('base64url');
    expect(await verifyResultToken('k', `${p}.${forged}.${sig}`)).toBeUndefined();
    expect(await verifyResultToken('k', `${p}.${body}.${sig!.slice(0, -2)}AA`)).toBeUndefined();
    expect(await verifyResultToken('k', 'garbage')).toBeUndefined();
    const expired = await mintResultToken('k', { ...payload, x: Math.floor(Date.now() / 1000) - 1 });
    expect(await verifyResultToken('k', expired)).toBeUndefined();
  });
});

describe('POST /api/hybrid/sandbox-result', () => {
  /**
   * The detached path's endpoint (the sandbox host lane's). `run_on_machine`
   * waits for its command inside the call, so a parked step comes from a
   * tool of this test's own that parks the way that path does.
   */
  async function parkedStep() {
    const provider = new FakeSandboxProvider({ push: { url: 'https://app.test/api/hybrid/sandbox-result', secret: PUSH_SECRET } });
    provider.hold('parked');
    const tool: HostTool<{ command: string }> = {
      name: 'park_exec',
      description: 'Run a command detached (test).',
      inputSchema: Type.Object({ command: Type.String() }),
      replay: 'safe',
      async execute({ command }, io) {
        if (io.settlement) {
          if (io.settlement.ok) return io.settlement.value;
          throw new Error(io.settlement.error.message);
        }
        const handle = await provider.open(io.ctx.runId);
        const job: SandboxJob = { runId: io.ctx.runId, stepId: io.stepId!, key: `tool:${io.stepId}`, command, timeoutSeconds: 60, startedAt: Date.now() };
        job.report = (await provider.reportFor({ runId: job.runId, stepId: job.stepId, sandbox: handle.name, timeoutSeconds: 60, startedAt: job.startedAt }))!;
        const synced = await syncIn(handle, '/workspace', new Map(), new Set(), (baseline) => jobFiles(job, baseline));
        const started = await handle.start(job);
        const owner: SandboxOwner = {
          kind: 'sandbox',
          sandbox: handle.name,
          sessionId: started.sessionId,
          cmdId: started.cmdId,
          jobDir: jobDirFor(job.stepId),
          startedAt: job.startedAt,
          deadlineAt: job.startedAt + 60_000,
          timeoutSeconds: 60,
          push: true,
          baselineSha256: await sha256Hex(baselineText(synced.baseline)),
        };
        await io.park!(owner);
        throw new Parked();
      },
    };
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-callback-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const pi = piSetup([fauxAssistantMessage(fauxToolCall('park_exec', { command: 'echo parked' }), { stopReason: 'toolUse' }), fauxAssistantMessage(fauxText('ok'))]);
    const harness = piHarness({ ...pi, tools: [tool] });
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({ prompt: 'go' });
    await deliver({ world, harness }, sessionId);
    const exec = (await sessions.inspect(sessionId)).effectOrder.find((e) => e.name === 'tool.park_exec')!;
    setup = { world, sandbox: provider, sessionId, queue: [], inspect: () => sessions.inspect(sessionId) };
    return { exec, sandboxName: exec.park!.sandbox as string };
  }
  const post = (token: string, body: string = JSON.stringify(report)) =>
    handleSandboxResult(new Request('https://app.test/api/hybrid/sandbox-result', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body }), {
      world: setup!.world,
      provider: setup!.sandbox,
      secret: PUSH_SECRET,
      wake: async () => void setup!.queue.push('sandbox'),
    });

  it('refuses bad, expired, other-step and other-run tokens (401), unknown steps (404) and oversize bodies (413)', async () => {
    const { exec, sandboxName } = await parkedStep();
    const x = Math.floor(Date.now() / 1000) + 60;
    const good = { r: setup!.sessionId, s: exec.stepId, n: sandboxName, x };
    expect((await post('nope')).status).toBe(401);
    expect((await post(await mintResultToken('wrong-secret', good))).status).toBe(401);
    expect((await post(await mintResultToken(PUSH_SECRET, { ...good, x: x - 3600 }))).status).toBe(401);
    expect((await post(await mintResultToken(PUSH_SECRET, { ...good, n: 'hybrid-someone-else' }))).status).toBe(401);
    expect((await post(await mintResultToken(PUSH_SECRET, { ...good, s: 'step_nope' }))).status).toBe(404);
    expect((await post(await mintResultToken(PUSH_SECRET, { ...good, r: 'wrun_nope' }))).status).toBe(404);
    expect((await post(await mintResultToken(PUSH_SECRET, good), 'x'.repeat(MAX_REPORT_BYTES + 1))).status).toBe(413);
    expect((await post(await mintResultToken(PUSH_SECRET, good), '{"v":2}')).status).toBe(400);
  });

  it('settles a parked step once; a replayed POST is 200 already', async () => {
    const { exec, sandboxName } = await parkedStep();
    const token = await mintResultToken(PUSH_SECRET, { r: setup!.sessionId, s: exec.stepId, n: sandboxName, x: Math.floor(Date.now() / 1000) + 60 });
    setup!.sandbox.release('parked');
    await until(async () => (setup!.sandbox.job(exec.park!.cmdId as string)?.exitCode !== undefined ? true : undefined));
    const first = await post(token);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ state: 'settled' });
    expect(setup!.queue).toEqual(['sandbox']);
    const again = await post(token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ state: 'already' });
    const settles = (await setup!.inspect()).effectOrder.filter((e) => e.name === 'settle');
    expect(settles).toHaveLength(1);
    expect(settles[0]!.input).toMatchObject({ by: 'push', exitCode: 0 });
  });
});
