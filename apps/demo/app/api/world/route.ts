import { worldHandler } from '@/lib/world-handler';

// Stream tails end themselves with a reconnect frame before this.
export const maxDuration = 300;

/** The server's World over HTTP (see lib/world-handler.ts). */
async function handle(req: Request): Promise<Response> {
  return (await worldHandler())(req);
}

export const GET = handle;
export const POST = handle;
