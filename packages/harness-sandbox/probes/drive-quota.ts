// P0.15: how many Drives a project can have, and whether their provisioned
// size (maxSize) or their used bytes count against a quota (the docs give a
// "maximum quota is 16 TiB" without saying per what). Phase 1 creates 1 TiB
// Drives (the SDK's default size) until one is refused or 40 exist (40 TiB
// provisioned, nothing used). Phase 2 finds the smallest and largest size one
// Drive may have. Phase 3 creates the smallest Drives until one is refused or
// 1000 exist (one per session is the design's count). Empty Drives cost nothing; every one is deleted as
// soon as its phase ends. Run it in a scratch project only.
import { Drive } from '@vercel/sandbox';
import { SWEEP_PREFIX, created, describeError, log, probe, probeName, sleep, track } from './lib.ts';

const TiB = 1024 ** 4;

async function fill(phase: string, maxSize: number, limit: number): Promise<string[]> {
  const names: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < limit; i++) {
    const name = track('drive', probeName(`q${phase}${i}`));
    try {
      await Drive.getOrCreate({ name, maxSize });
      names.push(name);
    } catch (err) {
      log(`${phase}.refused`, { at: i, provisionedTiB: (i * maxSize) / TiB, ...describeError(err) });
      break;
    }
  }
  log(`${phase}.created`, { n: names.length, provisionedTiB: (names.length * maxSize) / TiB, ms: Date.now() - t0 });
  return names;
}

async function drop(names: string[]): Promise<void> {
  const t0 = Date.now();
  let failed = 0;
  // A few at a time: the platform asks for at most ~20 deletes a second.
  for (let i = 0; i < names.length; i += 5) {
    const r = await Promise.allSettled(names.slice(i, i + 5).map(async (name) => (await Drive.get({ name })).delete()));
    for (const [j, x] of r.entries()) {
      if (x.status === 'fulfilled') created.drives.delete(names[i + j]!);
      else failed++;
    }
    await sleep(300);
  }
  log('deleted', { n: names.length - failed, failed, ms: Date.now() - t0 });
}

await probe(async () => {
  log('project.drivesBefore', (await (await Drive.list({ limit: 50 })).toArray()).length);

  const big = await fill('tib', TiB, 40);
  const listed = await (await Drive.list({ namePrefix: `${SWEEP_PREFIX}qtib`, sortBy: 'name', limit: 50 })).toArray();
  log('tib.listed', listed.map((d) => d.maxSize / TiB));
  await drop(big);

  // The smallest size the API takes, then as many of those as it allows.
  let small = 0;
  for (const size of [4096, 1024 ** 2, 64 * 1024 ** 2, 1024 ** 3]) {
    const name = track('drive', probeName('qsize'));
    try {
      const d = await Drive.getOrCreate({ name, maxSize: size });
      log('smallestSize', { asked: size, got: d.maxSize });
      small = d.maxSize;
      await drop([name]);
      break;
    } catch (err) {
      log(`size.${size}.refused`, describeError(err));
    }
  }
  for (const tib of [16, 17, 64]) {
    const name = track('drive', probeName(`qmax${tib}`));
    try {
      const d = await Drive.getOrCreate({ name, maxSize: tib * TiB });
      log(`size.${tib}TiB`, { ok: true, got: d.maxSize / TiB });
      await drop([name]);
    } catch (err) {
      log(`size.${tib}TiB`, describeError(err));
    }
  }
  if (small) await drop(await fill('small', small, 1000));
});
