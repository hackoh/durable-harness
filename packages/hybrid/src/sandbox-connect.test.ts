import { beforeEach, describe, expect, it, vi } from 'vitest';

// A VM that was just stopped reports `stopping` for a few seconds and
// `getOrCreate` hands it back as is; every command then fails with 422
// ("Sandbox is stopping and no longer accepts commands"). Seen in production
// after Kill Sandbox VM: the model's retries failed until the VM settled.
const state = vi.hoisted(() => ({
  statuses: [] as string[],
  calls: 0,
  commands: 0,
  resumed: [] as unknown[],
  /** Every `Sandbox.update` and command, in order, with the session it went to. */
  log: [] as unknown[],
  /** How many `Sandbox.update` calls reject with a 422 `sandbox_stopping` before one succeeds. */
  updateFailures: 0,
}));

vi.mock('@vercel/sandbox', () => {
  class APIError extends Error {
    constructor(
      message: string,
      readonly response: { status: number },
      readonly json?: unknown
    ) {
      super(message);
    }
  }
  class StreamError extends Error {}
  const Sandbox = {
    getOrCreate: async (params: { resume?: boolean }) => {
      state.resumed.push(params.resume);
      const status = state.statuses[Math.min(state.calls, state.statuses.length - 1)]!;
      state.calls++;
      return {
        name: 'hybrid-test',
        status,
        currentSession: () => ({
          sessionId: `s${state.calls}`,
          // A session-level call never resumes: on a stopped VM it just fails.
          update: async () => {
            throw new APIError('Status code 410 is not ok: Sandbox has stopped execution', { status: 410 });
          },
        }),
        // `Sandbox.update` swallows a stopping session's 422 (it applies to
        // the next session too), but its own PATCH on the sandbox can still
        // answer 422 while the VM goes away.
        update: async (params: unknown) => {
          state.log.push({ update: params, session: `s${state.calls}` });
          if (state.updateFailures > 0) {
            state.updateFailures--;
            throw new APIError('Status code 422 is not ok', { status: 422 }, { error: { code: 'sandbox_stopping' } });
          }
        },
        runCommand: async () => {
          state.log.push({ command: true, session: `s${state.calls}` });
          if (status !== 'running') throw new APIError('Status code 422 is not ok: Sandbox is stopping and no longer accepts commands.', { status: 422 });
          state.commands++;
          return { exitCode: 0, stderr: async () => '' };
        },
      };
    },
  };
  return { APIError, StreamError, Sandbox };
});

const { VercelSandboxProvider, callbackPolicy, isSandboxLost } = await import('./sandbox.ts');
const { APIError } = await import('@vercel/sandbox');

describe('VercelSandboxProvider.open on a VM that is still stopping', () => {
  beforeEach(() => {
    state.calls = 0;
    state.commands = 0;
    state.resumed = [];
    state.log = [];
    state.updateFailures = 0;
  });

  const callback = { url: 'https://example.test/api/hybrid/sandbox-result', secret: 's', bypass: 'b' };

  it('waits until the VM settles, then resumes it', async () => {
    state.statuses = ['stopping', 'snapshotting', 'running'];
    const provider = new VercelSandboxProvider({ settleTimeoutMs: 30_000, callback });
    const handle = await provider.open('wrun_test');
    expect(state.calls).toBe(3);
    expect(state.resumed).toEqual([true, true, true]);
    expect(state.commands).toBe(1);
    expect(handle.sessionId).toBe('s3');
  });

  it('applies the callback policy through update({ networkPolicy }), once, before the prep command', async () => {
    state.statuses = ['running'];
    await new VercelSandboxProvider({ settleTimeoutMs: 30_000, callback }).open('wrun_test');
    expect(state.log).toEqual([{ update: { networkPolicy: callbackPolicy(callback) }, session: 's1' }, { command: true, session: 's1' }]);
  });

  it('retries a 422 sandbox_stopping from update as a lost VM, then applies the policy to the next session', async () => {
    state.statuses = ['running'];
    state.updateFailures = 1;
    const handle = await new VercelSandboxProvider({ settleTimeoutMs: 30_000, callback }).open('wrun_test');
    expect(state.calls).toBe(2);
    expect(state.log).toEqual([
      { update: { networkPolicy: callbackPolicy(callback) }, session: 's1' },
      { update: { networkPolicy: callbackPolicy(callback) }, session: 's2' },
      { command: true, session: 's2' },
    ]);
    expect(handle.sessionId).toBe('s2');
  });

  it('gives up as a lost sandbox after the settle timeout', async () => {
    state.statuses = ['stopping'];
    const provider = new VercelSandboxProvider({ settleTimeoutMs: 0 });
    await expect(provider.open('wrun_test')).rejects.toThrow(/was lost/);
  });

  it('counts a 422 "stopping" without an error code as a lost VM', () => {
    const err = new (APIError as unknown as new (m: string, r: { status: number }) => Error)(
      'Status code 422 is not ok: Sandbox is stopping and no longer accepts commands.',
      { status: 422 }
    );
    expect(isSandboxLost(err)).toBe(true);
  });
});
