/**
 * The gated live test of deleting a session's sandbox and Drive
 * (`cleanup.ts`, docs/workspaces.md §5.7 "Cleanup", §11.4 A7) on the
 * platform, through `vercelSandboxApi`:
 *
 * - a session's named sandbox, running with its Drive mounted, is stopped,
 *   deleted, and its Drive deleted, retried while the platform still has it
 *   attached; nothing is booted (the sandbox is gone, not resumed);
 * - `cleanupIdle` deletes an idle session's Drive whose log activity is old,
 *   keeps a session whose VM runs, and never touches a Drive it is not told
 *   about (every other session of the project is `unknown`).
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * project (`probes/lib.ts`). The names are real session names
 * (`sessionName(project, 'wrun_a7live_<id>')`, which `probes/sweep.ts`
 * doesn't take), so `afterAll` deletes every one this run made, whatever
 * happened. No secret is printed.
 */
import { randomBytes } from 'node:crypto';
import { Drive, Sandbox } from '@vercel/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { vercelSandboxApi } from '../src/api.ts';
import { cleanupIdle, deleteSession } from '../src/cleanup.ts';
import { resolveProjectId, sessionName } from '../src/names.ts';
import { cleanup, created, describeError, TAGS, track } from '../probes/lib.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const RUN = randomBytes(3).toString('hex');

afterAll(async () => {
  if (LIVE) expect(await cleanup()).toEqual([]);
}, 240_000);

/** A session's sandbox as the factory leaves it: its Drive, and (when `vm`) a running VM with the Drive at /workspace. */
async function session(runId: string, vm: boolean): Promise<string> {
  const name = sessionName(resolveProjectId(), runId);
  track('drive', name);
  const drive = await Drive.getOrCreate({ name, region: 'iad1' });
  if (vm) {
    track('sandbox', name);
    await Sandbox.create({ name, region: 'iad1', persistent: false, timeout: 5 * 60_000, mounts: { '/workspace': drive }, tags: TAGS } as Parameters<typeof Sandbox.create>[0]);
  }
  return name;
}

describe.runIf(LIVE)('live: deleting a session sandbox never boots a VM', () => {
  it(
    'a running session: stopped, deleted, its Drive deleted once the platform lets go',
    async () => {
      const name = await session(`wrun_a7live_${RUN}_1`, true);
      const api = vercelSandboxApi();
      const seen: Record<string, unknown>[] = [];
      const t0 = Date.now();
      const result = await deleteSession(name, { api, detachMs: 90_000, log: (m, f) => (console.log(`[live] ${m}`, f ?? ''), seen.push({ m, ...f })) });
      console.log('[live] deleted in', Date.now() - t0, 'ms, retries', seen.length - 1);
      expect(result).toEqual({ name, sandbox: 'deleted', drive: 'deleted' });
      expect(await api.getSandbox(name)).toBeUndefined();
      expect(await api.getDrive(name)).toBeUndefined();
      // Deleted, not resumed: the named sandbox is gone.
      const after = await Sandbox.get({ name }).then(
        (sb) => sb.status,
        (err: unknown) => describeError(err).status
      );
      expect(after).toBe(404);
    },
    180_000
  );

  it(
    'cleanupIdle: an idle session goes, a running one stays, and Drives it is not told about are left alone',
    async () => {
      const idle = await session(`wrun_a7live_${RUN}_2`, false);
      const running = await session(`wrun_a7live_${RUN}_3`, true);
      const api = vercelSandboxApi();
      const old = Date.now() - 40 * 86_400_000;
      const result = await cleanupIdle({ api, idleDays: 30, detachMs: 90_000, lastActivity: async (n) => (n === idle || n === running ? old : undefined) });
      console.log('[live] cleanup', JSON.stringify({ deleted: result.deleted, kept: result.kept.filter((k) => k.name === idle || k.name === running) }));
      expect(result.deleted).toEqual([{ name: idle, sandbox: 'none', drive: 'deleted' }]);
      expect(result.kept).toContainEqual({ name: running, reason: 'running' });
      // Every other Drive of the project: unknown, kept.
      expect(result.kept.filter((k) => k.name !== running).every((k) => k.reason === 'unknown')).toBe(true);
      expect(await api.getDrive(idle)).toBeUndefined();
      expect((await api.getSandbox(running))?.status).toBe('running');
      expect(created.drives.has(running)).toBe(true);
    },
    180_000
  );
});
