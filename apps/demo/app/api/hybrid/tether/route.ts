import { serveTabTether } from 'harness-world';
import { after } from 'next/server';
import { getWorld } from '@/lib/world';

// Held open while a tab drives a session; it rotates well before this.
export const maxDuration = 800;

/**
 * `GET /api/hybrid/tether?runId=&tab=&epoch=&seq=`: the hybrid tab's tether
 * (harness-world's tether.ts). A held event stream while the tab drives the
 * session's browser lane: if the tab goes away, the stream's close queues
 * one tab-lost message, and its flow-route delivery takes the session to a
 * function if the tab did not come back. Nothing in it is a heartbeat: the
 * keepalive comments only keep proxies from cutting an idle connection.
 */
export async function GET(request: Request) {
  const world = await getWorld();
  // The close callback runs after the client has gone, outside this
  // request's scope, where `after()` cannot be called. So `after()` is
  // called now, with a wait for whatever the close hands over: it runs once
  // the response has ended, and gives a tab-lost write that comes then a few
  // seconds to land.
  let handed: () => void = () => {};
  const work: Promise<unknown>[] = [];
  const closed = new Promise<void>((resolve) => (handed = resolve));
  after(async () => {
    await Promise.race([closed, sleep(LOST_WAIT_MS)]);
    await Promise.allSettled(work);
  });
  return serveTabTether(world, request, {
    waitUntil: (p) => {
      work.push(p);
      handed();
    },
    maxMs: 700_000,
    log: (message, fields) => console.log(`[harness] ${message}`, fields ?? {}),
  });
}

/** How long the response's end waits for the tab-lost write its close may start. */
const LOST_WAIT_MS = 5000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
