import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider } from './fake-sandbox.ts';
import { jobDirFor } from './sandbox-job.ts';
import { sha256Hex } from './sandbox-sync.ts';
import { cleanUpPriorAttempt } from './tools.ts';

describe('cleanUpPriorAttempt (before a run_on_machine retry)', () => {
  it('removes what the interrupted attempt created under /workspace, and nothing the log tracks or the attempt found there', async () => {
    const provider = new FakeSandboxProvider();
    const handle = await provider.open('wrun_test');
    // The first attempt's baseline: what /workspace held when it started.
    const baseline = { '/workspace/kept.txt': await sha256Hex('kept\n'), '/workspace/node_modules.txt': await sha256Hex('deps\n') };
    await handle.writeFiles([
      { path: '/workspace/kept.txt', content: 'kept\n' },
      { path: '/workspace/node_modules.txt', content: 'deps\n' },
      { path: `${jobDirFor('step_prior')}/baseline.json`, content: JSON.stringify(baseline) },
      // Then the attempt ran and created these before it died.
      { path: '/workspace/made-by-orphan.txt', content: 'half\n' },
      { path: '/workspace/tracked.txt', content: 'orphan wrote this\n' },
    ]);
    const removed = await cleanUpPriorAttempt(handle, 'step_prior', new Set(['/workspace/tracked.txt']));
    expect(removed).toEqual(['/workspace/made-by-orphan.txt']);
    const after = await handle.manifest('/workspace', { skipDirs: [] });
    expect([...after.keys()].sort()).toEqual(['/workspace/kept.txt', '/workspace/node_modules.txt', '/workspace/tracked.txt']);
  });

  it('does nothing without a baseline (the attempt never got that far)', async () => {
    const handle = await new FakeSandboxProvider().open('wrun_test');
    await handle.writeFiles([{ path: '/workspace/a.txt', content: 'a\n' }]);
    expect(await cleanUpPriorAttempt(handle, 'step_none', new Set())).toEqual([]);
  });
});
