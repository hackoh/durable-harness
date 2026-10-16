import { markTime, PROCESS_ID } from 'harness-world/marks';
import { MODEL } from '@/lib/model';
import { worldName } from '@/lib/world';

/**
 * What the benchmark records about the deployment it measured, and a cheap
 * round trip to a warm Function (the hop every server-side measurement pays).
 */
export function GET() {
  return Response.json(
    {
      t: markTime(),
      pid: PROCESS_ID,
      world: worldName(),
      model: MODEL,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      url: process.env.VERCEL_URL ?? null,
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      region: process.env.VERCEL_REGION ?? null,
      env: process.env.VERCEL_ENV ?? 'development',
      chaos: process.env.HARNESS_CHAOS !== '0',
      marks: process.env.HARNESS_MARKS !== '0',
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
