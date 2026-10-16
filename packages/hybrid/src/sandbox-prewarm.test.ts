import { beforeEach, describe, expect, it, vi } from 'vitest';

// The pre-warming calls of VercelSandboxProvider:
// keepalive never resumes a VM, the team count only counts warm VMs of this
// app, and deleting a pool VM can be vetoed while a session uses it.
const state = vi.hoisted(() => ({
  vms: new Map<string, { status: string; expiresAt?: Date; extended: number[]; deleted: boolean }>(),
  listed: [] as unknown[],
}));

vi.mock('@vercel/sandbox', () => {
  class APIError extends Error {
    constructor(
      message: string,
      readonly response: { status: number }
    ) {
      super(message);
    }
  }
  class StreamError extends Error {}
  const Sandbox = {
    get: async ({ name }: { name: string }) => {
      const vm = state.vms.get(name);
      if (!vm || vm.deleted) throw new APIError('Status code 404 is not ok', { status: 404 });
      return {
        name,
        status: vm.status,
        expiresAt: vm.expiresAt,
        domain: (port: number) => `https://${name}-${port}.vercel.run`,
        extendTimeout: async (ms: number) => {
          vm.extended.push(ms);
        },
        delete: async () => {
          vm.deleted = true;
        },
      };
    },
    list: async (params: unknown) => {
      state.listed.push(params);
      return {
        sandboxes: [...state.vms.entries()].map(([name, vm]) => ({ name, status: vm.status })),
      };
    },
  };
  return { APIError, StreamError, Sandbox };
});

const { VercelSandboxProvider } = await import('./sandbox.ts');

const vm = (status: string, leftMs?: number) => ({
  status,
  ...(leftMs !== undefined ? { expiresAt: new Date(Date.now() + leftMs) } : {}),
  extended: [] as number[],
  deleted: false,
});

describe('VercelSandboxProvider pre-warming', () => {
  beforeEach(() => {
    state.vms.clear();
    state.listed = [];
  });

  it('keepalive extends a running VM that is short of time, and leaves one with enough alone', async () => {
    const provider = new VercelSandboxProvider();
    state.vms.set('hybrid-short', vm('running', 2 * 60_000));
    state.vms.set('hybrid-long', vm('running', 12 * 60_000));
    const short = await provider.keepalive('hybrid-short', 10 * 60_000);
    expect(short.status).toBe('running');
    expect(short.extendedMs).toBeGreaterThanOrEqual(8 * 60_000);
    expect(short.leftMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(state.vms.get('hybrid-short')!.extended).toHaveLength(1);
    const long = await provider.keepalive('hybrid-long', 10 * 60_000);
    expect(long.extendedMs).toBeUndefined();
    expect(state.vms.get('hybrid-long')!.extended).toHaveLength(0);
  });

  it('keepalive never resumes: a stopped VM stays stopped (its idle teardown), a missing one is absent', async () => {
    const provider = new VercelSandboxProvider();
    state.vms.set('hybrid-stopped', vm('stopped'));
    expect(await provider.keepalive('hybrid-stopped', 10 * 60_000)).toEqual({ status: 'stopped' });
    expect(state.vms.get('hybrid-stopped')!.extended).toHaveLength(0);
    expect(await provider.keepalive('hybrid-nope', 10 * 60_000)).toEqual({ status: 'absent' });
  });

  it('counts only warm VMs, filtered by the app tag', async () => {
    const provider = new VercelSandboxProvider();
    state.vms.set('a', vm('running'));
    state.vms.set('b', vm('pending'));
    state.vms.set('c', vm('stopped'));
    state.vms.set('d', vm('snapshotting'));
    expect(await provider.countWarm()).toBe(2);
    expect(state.listed[0]).toMatchObject({ tags: { app: 'harness-on-world' } });
  });

  it('deletes an unused pool VM, keeps one whose veto says it is in use, and reports a missing one', async () => {
    const provider = new VercelSandboxProvider();
    state.vms.set('hybrid-pool-free', vm('running'));
    state.vms.set('hybrid-pool-used', vm('running'));
    const veto = vi.fn(async (domain: (port: number) => string) => domain(3000).includes('used'));
    expect(await provider.deleteVm('hybrid-pool-free', veto)).toBe('deleted');
    expect(await provider.deleteVm('hybrid-pool-used', veto)).toBe('kept');
    expect(state.vms.get('hybrid-pool-used')!.deleted).toBe(false);
    expect(await provider.deleteVm('hybrid-pool-gone')).toBe('absent');
  });

  it('a veto that fails does not keep the VM (an unreachable daemon is not using it)', async () => {
    const provider = new VercelSandboxProvider();
    state.vms.set('hybrid-pool-x', vm('running'));
    expect(await provider.deleteVm('hybrid-pool-x', async () => Promise.reject(new Error('timeout')))).toBe('deleted');
  });
});
