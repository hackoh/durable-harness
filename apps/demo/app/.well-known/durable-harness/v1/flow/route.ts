import { getSessions } from '@/lib/sessions';

export const maxDuration = 800;

/**
 * Where every World delivers the kernel's queue (`__harness_wkf_workflow_*`):
 * the harness driver. world-local and world-postgres deliver here over HTTP
 * (lib/world.ts registers this route for the kernel's prefix); on Vercel this
 * Function subscribes to the topic (vercel.json).
 */
export async function POST(request: Request) {
  const sessions = await getSessions();
  return sessions.handler(request);
}
