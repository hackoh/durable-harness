import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobFiles, type SandboxJob, type SandboxOwner } from 'harness-world-hybrid';
import { describe, expect, it } from 'vitest';
import { LocalSandboxProvider } from './local-sandbox.ts';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'local-sb-'));
  const provider = new LocalSandboxProvider({ name: 'vm1', sessionId: 'sess1', base });
  const handle = provider.handle;
  let n = 0;
  const run = async (command: string, timeoutSeconds = 30) => {
    const stepId = `step_${++n}`;
    const job: SandboxJob = { runId: 'wrun_1', stepId, key: `tool:${stepId}`, command, timeoutSeconds, startedAt: Date.now() };
    await handle.writeFiles(jobFiles(job, new Map()));
    const started = await handle.start(job);
    const owner: SandboxOwner = {
      kind: 'sandbox',
      sandbox: 'vm1',
      sessionId: started.sessionId,
      cmdId: started.cmdId,
      jobDir: `/tmp/harness/${stepId}`,
      startedAt: job.startedAt,
      deadlineAt: job.startedAt + timeoutSeconds * 1000,
      timeoutSeconds,
      push: false,
    };
    return { started, owner };
  };
  return { base, provider, handle, run };
}

describe('LocalSandboxProvider', () => {
  it('runs a job with the same job dir format and reports through result.json', async () => {
    const { handle, provider, run, base } = await setup();
    await handle.writeFiles([{ path: '/workspace/a.txt', content: 'hello\n' }]);
    const { started, owner } = await run('cat a.txt; echo oops >&2; echo made > b.txt; exit 3');
    expect(started.cmdId).toMatch(/^pid:\d+$/);
    expect(await handle.waitFor(started.cmdId, 10_000)).toEqual({ exitCode: 3 });
    const job = await handle.readJob(owner.jobDir);
    expect(job.result).toMatchObject({ v: 1, exitCode: 3, stdout: { head: 'hello\n' }, stderr: { head: 'oops\n' } });
    expect(await provider.inspect(owner)).toEqual({ state: 'exited', exitCode: 3 });
    expect(await handle.readTextFile('/workspace/b.txt')).toBe('made\n');
    expect([...(await handle.manifest('/workspace', { skipDirs: ['node_modules'] })).keys()].sort()).toEqual([
      '/workspace/a.txt',
      '/workspace/b.txt',
    ]);
    // Logical paths live under the base.
    expect(await readFile(join(base, 'workspace/a.txt'), 'utf8')).toBe('hello\n');
  });

  it('gives commands a scrubbed environment: no token, no host secret', async () => {
    const { handle, run } = await setup();
    process.env.VERCEL_OIDC_TOKEN_TEST_LEAK = 'leak-token';
    process.env.HOST_SECRET_TEST_LEAK = 'leak-secret';
    const { started, owner } = await run('env');
    await handle.waitFor(started.cmdId, 10_000);
    const out = (await handle.readJob(owner.jobDir)).result!.stdout.head;
    expect(out).toContain('PATH=');
    expect(out).not.toContain('leak-token');
    expect(out).not.toContain('leak-secret');
    expect(out).not.toContain('VERCEL_OIDC_TOKEN');
  });

  it('enforces the command budget (exit 124) and kills a command group', async () => {
    const { handle, provider, run } = await setup();
    const slow = await run('sleep 30', 1);
    expect(await handle.waitFor(slow.started.cmdId, 10_000)).toEqual({ exitCode: 124 });
    const held = await run('sleep 30; echo never');
    await new Promise((r) => setTimeout(r, 300));
    expect(await provider.inspect(held.owner)).toEqual({ state: 'running' });
    await handle.killCommand({ cmdId: held.started.cmdId, jobDir: held.owner.jobDir });
    const done = await handle.waitFor(held.started.cmdId, 10_000);
    expect(done?.exitCode).toBe(137);
  });

  it('treats an owner from another VM session as lost', async () => {
    const { provider, run } = await setup();
    const { owner } = await run('true');
    expect(await provider.inspect({ ...owner, sessionId: 'other' })).toEqual({ state: 'lost', why: 'replaced' });
    expect(await provider.attach({ ...owner, sandbox: 'vm2' })).toBe('lost');
  });
});
