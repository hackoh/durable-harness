export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { default: runs } = await import('./agent-runs');
  runs.register();
  const { getWorld, worldName } = await import('./lib/world');
  // world-vercel has nothing to start (its queue redrives sessions), and
  // loading the sessions here would bill every route's first request on a
  // new instance (the native baseline's too) for the durable machinery.
  if (worldName() === 'vercel') return;
  const [{ getSessions }, { recoverSessions }] = await Promise.all([import('./lib/sessions'), import('harness-world')]);
  const world = await getWorld();
  await getSessions();
  // world-postgres starts its queue worker (and re-enqueues the sessions that
  // recorded the kernel's queue namespace). Then the kernel re-enqueues the
  // sessions a dead process left running, on its own prefix: on world-local
  // all of them (its own recovery is off, lib/world.ts), on world-postgres
  // those from before sessions recorded a namespace. Either way, a restarted
  // server resumes every session from its log.
  await world.start?.();
  await recoverSessions(world, { unrecorded: worldName() === 'postgres' });
}
