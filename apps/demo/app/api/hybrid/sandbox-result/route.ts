import { handleSandboxResult } from 'harness-world-hybrid';
import { wakeLane } from '@/lib/hybrid';
import { getSandboxProvider, getSessions } from '@/lib/sessions';
import { getWorld } from '@/lib/world';

export const maxDuration = 60;

/**
 * Where a finished `sandbox_exec` reports: the wrapper in the VM POSTs its
 * result with a capability token for that one step (see harness-world-hybrid
 * callback.ts). The VM reaches this route past deployment protection only
 * because the sandbox's egress proxy injects the bypass header for exactly
 * this method and path; the VM itself never holds it. Collects the step,
 * then wakes the sandbox lane to take the result.
 */
export async function POST(request: Request) {
  const secret = process.env.HYBRID_CALLBACK_SECRET;
  if (!secret) return Response.json({ error: 'push is not configured here' }, { status: 404 });
  await getSessions(); // one provider and World per process, shared with the flow route
  const world = await getWorld();
  return handleSandboxResult(request, {
    world,
    provider: await getSandboxProvider(),
    secret,
    chaos: process.env.HARNESS_CHAOS !== '0',
    wake: async (runId, stepId) => {
      const result = await wakeLane(world, runId, 'sandbox', { key: `${runId}:settled:${stepId}:0` });
      console.log('[harness] wake after a pushed result', { runId, stepId, ...result });
    },
    log: (message, fields) => console.log(`[harness] ${message}`, fields ?? ''),
  });
}
