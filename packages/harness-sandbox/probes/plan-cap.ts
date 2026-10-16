// The plan's cap on one VM session (planCapMs): what a create and an
// extendTimeout past it answer, so the session factory can learn the cap
// from the refusal instead of assuming the smallest (45 min, Hobby). A
// create with a 25 h timeout (past every plan's cap: refused before
// anything boots), then a 10 min VM extended to 24 h and past it. The VM is
// deleted at once.
import { Sandbox } from '@vercel/sandbox';
import { BASE, attempt, log, probe, probeName, track } from './lib.ts';

const H = 60 * 60_000;

await probe(async () => {
  const over = track('sandbox', probeName('capover'));
  await attempt('create.25h', () => Sandbox.create({ ...BASE, name: over, timeout: 25 * H }));
  const name = track('sandbox', probeName('cap'));
  const sb = await Sandbox.create({ ...BASE, name, timeout: 10 * 60_000 });
  log('vm.timeout', sb.timeout);
  await attempt('extend.to24h', () => sb.extendTimeout(24 * H - 10 * 60_000 - 60_000));
  log('vm.timeoutAfter', (await Sandbox.get({ name })).timeout);
  await attempt('extend.past24h', () => sb.extendTimeout(2 * H));
});
