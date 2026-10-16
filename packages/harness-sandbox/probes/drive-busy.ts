// P0.5: one sandbox name, and a VM session that still holds the Drive while
// a new driver wants a fresh VM on it (docs/workspaces.md §5.7, Restart on a
// new VM). Three ways the old session goes: a graceful stop, a delete while
// running, and a crash inside the VM. For each, how long the Drive stays
// attached, and what `create({ name, mounts })` answers meanwhile (409
// `drive_attached`, a name conflict, or a wait). Also whether
// `drive.currentSessionId` names the same session as `currentSession()`, and
// whether the platform notices the crashed VM before (or when) its own
// timeout ends it. Everything is deleted at the end.
//
// The probe is the only driver here, so `recreate` deletes whatever holds
// the name. A real driver must not copy that: a name conflict there means
// another driver may have just created the sandbox (docs/sandbox-probes.md,
// P0.4, the guards on delete).
import { Drive, Sandbox } from '@vercel/sandbox';
import { BASE, describeError, log, probe, probeName, sh, sleep, timed, track } from './lib.ts';

const NAME = track('sandbox', probeName('busy'));
const DRIVE = track('drive', probeName('busydrive'));
/** The crashed VM's own timeout, short enough to watch past. */
const CRASH_TIMEOUT = 2 * 60_000;

/** Retry `create(NAME, mounts)` until it succeeds; log what each attempt got. */
async function recreate(label: string, drive: Drive, t0: number, timeout: number = BASE.timeout): Promise<Sandbox> {
  const tries: string[] = [];
  for (let i = 0; i < 60; i++) {
    const d = await Drive.get({ name: DRIVE });
    try {
      const sb = await Sandbox.create({ ...BASE, timeout, name: NAME, mounts: { '/workspace': drive } });
      log(`${label}.recreate`, { afterMs: Date.now() - t0, tries, driveWasAttached: !!d.currentSessionId });
      return sb;
    } catch (err) {
      const e = describeError(err);
      tries.push(`${Math.round((Date.now() - t0) / 100) / 10}s:${e.status}/${e.code}${d.currentSessionId ? '/held' : ''}`);
      if (e.code === 'bad_request' && /already exists/.test(e.msg)) {
        // The name is still taken: delete what holds it (the stale sandbox).
        await Sandbox.get({ name: NAME }).then((s) => s.delete(), () => {});
      }
      await sleep(1000);
    }
  }
  throw new Error(`${label}: never recreated`);
}

/** Poll the Drive until it detaches; returns when, in ms after t0. */
async function detached(label: string, t0: number, limitMs = 90_000): Promise<void> {
  for (;;) {
    const d = await Drive.get({ name: DRIVE });
    if (!d.currentSessionId) return log(`${label}.detachedAfterMs`, Date.now() - t0);
    if (Date.now() - t0 > limitMs) return log(`${label}.stillAttachedAfterMs`, Date.now() - t0);
    await sleep(500);
  }
}

await probe(async () => {
  const drive = await Drive.getOrCreate({ name: DRIVE, maxSize: 1024 ** 3 });
  let sb: Sandbox = await timed('create', () => Sandbox.create({ ...BASE, name: NAME, mounts: { '/workspace': drive } }));
  await sh(sb, 'echo v1 > /workspace/f.txt && sync');
  const d = await Drive.get({ name: DRIVE });
  log('ids', { driveSessionIsCurrent: d.currentSessionId === sb.currentSession().sessionId, driveSandboxName: d.currentSandboxName === NAME });

  // 1. Graceful stop, not awaited: a new driver races it.
  let t0 = Date.now();
  const stopping = sb.stop().catch((err) => log('stop.error', describeError(err)));
  await sleep(100);
  await Promise.all([detached('stop', t0), stopping.then(() => log('stop.returnedAfterMs', Date.now() - t0))]);
  sb = await recreate('stop', drive, t0);

  // 2. Delete while running: the takeover of a stale session.
  t0 = Date.now();
  await timed('delete(running)', () => sb.delete());
  log('delete.driveHeld', !!(await Drive.get({ name: DRIVE })).currentSessionId);
  // This VM is the one that crashes: a short timeout, so the watch below can
  // run past it.
  sb = await recreate('delete', drive, t0, CRASH_TIMEOUT);
  const crashCreated = Date.now();
  log('delete.files', (await sh(sb, 'cat /workspace/f.txt')).out);

  // 3. A crash inside the VM (immediate reboot, no sync, no unmount). Watch
  // the platform's status, the Drive, and whether the VM answers a command
  // (a guest that rebooted and came back would also show `running`), until
  // the platform lets go or a minute past the VM's own timeout.
  await sh(sb, 'echo v2 > /workspace/f.txt && sync');
  t0 = Date.now();
  await sb.runCommand({ cmd: 'bash', args: ['-c', 'echo b > /proc/sysrq-trigger'], sudo: true, detached: true }).catch((err) => log('crash.command', describeError(err)));
  const statuses: string[] = [];
  const crashed = sb;
  while (Date.now() - crashCreated < CRASH_TIMEOUT + 60_000) {
    const s = await Sandbox.get({ name: NAME });
    const held = !!(await Drive.get({ name: DRIVE })).currentSessionId;
    // Only a running VM is asked: a command on a stopped one would try to resume it.
    const alive =
      s.status !== 'running'
        ? '-'
        : await crashed.runCommand('true', [], { signal: AbortSignal.timeout(5000) }).then(
            (c) => (c.exitCode === 0 ? 'alive' : `exit${c.exitCode}`),
            (err) => describeError(err).status ?? 'noanswer'
          );
    statuses.push(`${Math.round((Date.now() - t0) / 1000)}s:${s.status}${held ? '/held' : ''}/${alive}`);
    if (s.status === 'stopped' && !held) break;
    await sleep(4000);
  }
  log('crash.timeline', statuses);
  log('crash.watchedS', { afterCrash: Math.round((Date.now() - t0) / 1000), vmTimeoutS: CRASH_TIMEOUT / 1000, afterVmCreatedS: Math.round((Date.now() - crashCreated) / 1000) });
  sb = await recreate('crash', drive, t0);
  log('crash.files', (await sh(sb, 'cat /workspace/f.txt')).out);
});
