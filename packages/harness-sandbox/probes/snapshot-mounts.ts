// P0.3: the base-snapshot boot path (docs/workspaces.md §5.7, Boot image).
// A builder VM writes a file to its rootfs and snapshots itself, once with
// the default expiry and once with an explicit 7-day one (not the default,
// so the call's effect shows); then
// `Sandbox.getOrCreate({ name, source: { type: 'snapshot' }, mounts })` boots
// a session VM from the snapshot with a Drive at /workspace. Does the VM have
// both the rootfs file and the Drive, and when does each snapshot expire?
// Boot times are like for like, each from the call to its first command: a
// snapshot and the image, each with and without a Drive. Everything,
// snapshots included, is deleted at the end.
import { Drive, Sandbox, Snapshot } from '@vercel/sandbox';
import { BASE, attempt, created, log, probe, probeName, sh, timed, track } from './lib.ts';

const BUILDER = track('sandbox', probeName('builder'));
const BUILDER2 = track('sandbox', probeName('builder2'));
const SESSION = track('sandbox', probeName('snap'));
const DRIVE = track('drive', probeName('snapdrive'));
const DRIVE2 = track('drive', probeName('imgdrive'));
const DAY = 24 * 3600_000;

const expiry = (s: Snapshot) => {
  const at = s.expiresAt;
  return { status: s.status, sizeMB: Math.round(s.sizeBytes / 1e6), expiresInDays: at ? Math.round(((at.getTime() - Date.now()) / DAY) * 10) / 10 : null };
};

await probe(async () => {
  const drive = await Drive.getOrCreate({ name: DRIVE, maxSize: 1024 ** 3 });
  const drive2 = await Drive.getOrCreate({ name: DRIVE2, maxSize: 1024 ** 3 });

  // Builder with no snapshot settings: the platform's default expiry.
  const b = await timed('builder.create', () => Sandbox.create({ ...BASE, name: BUILDER }));
  await sh(b, 'sudo mkdir -p /opt/dh && echo base-image-file | sudo tee /opt/dh/marker >/dev/null && echo rootfs > /vercel/rootfs.txt');
  const snapDefault = await timed('builder.snapshot(default)', () => b.snapshot());
  created.snapshots.add(snapDefault.snapshotId);
  log('snapshot.default', expiry(snapDefault));
  log('builder.statusAfterSnapshot', (await Sandbox.get({ name: BUILDER })).status);

  // A second builder with an explicit expiry on the call, unlike the default.
  const b2 = await timed('builder2.create', () => Sandbox.create({ ...BASE, name: BUILDER2 }));
  const snap7 = await timed('builder2.snapshot(expiration 7d)', () => b2.snapshot({ expiration: 7 * DAY }));
  created.snapshots.add(snap7.snapshotId);
  log('snapshot.7d', expiry(snap7));
  log('snapshot.7d.reread', expiry(await Snapshot.get({ snapshotId: snap7.snapshotId })));
  log('snapshot.reread', expiry(await Snapshot.get({ snapshotId: snapDefault.snapshotId })));

  // The session VM: snapshot source plus a Drive, timed to its first command.
  const t = Date.now();
  const r = await attempt('session.getOrCreate(snapshot+mounts)', () =>
    Sandbox.getOrCreate({ ...BASE, name: SESSION, source: { type: 'snapshot', snapshotId: snapDefault.snapshotId }, mounts: { '/workspace': drive } })
  );
  if (!r.ok) return;
  const s = r.value;
  const createMs = Date.now() - t;
  await sh(s, 'true');
  log('boot.snapshot+drive(getOrCreate)', { createMs, firstCommandMs: Date.now() - t });
  log('session.meta', { mounts: s.mounts, sourceSnapshotId: s.sourceSnapshotId === snapDefault.snapshotId });
  log('session.contents', await sh(s, 'cat /opt/dh/marker /vercel/rootfs.txt; grep " /workspace " /proc/self/mounts | cut -d" " -f1-3; echo drive-ok > /workspace/x && cat /workspace/x'));
  // A second getOrCreate on the running sandbox returns the same VM session.
  const again = await timed('session.getOrCreate(again)', () =>
    Sandbox.getOrCreate({ ...BASE, name: SESSION, source: { type: 'snapshot', snapshotId: snapDefault.snapshotId }, mounts: { '/workspace': drive } })
  );
  log('session.sameSession', again.currentSession().sessionId === s.currentSession().sessionId);
  // The other boots, each with `create`, timed to its first command: a
  // second VM from the same snapshot (no Drive: the first is attached above),
  // the image with no Drive, and the image with a Drive of its own.
  const boot = async (key: string, name: string, extra: object) => {
    track('sandbox', name);
    const t = Date.now();
    const vm = await Sandbox.create({ ...BASE, name, ...extra });
    const createMs = Date.now() - t;
    await sh(vm, 'true');
    log(key, { createMs, firstCommandMs: Date.now() - t });
  };
  await boot('boot.snapshot', probeName('snap2'), { source: { type: 'snapshot', snapshotId: snapDefault.snapshotId } });
  await boot('boot.image', probeName('img'), {});
  await boot('boot.image+drive', probeName('imgd'), { mounts: { '/workspace': drive2 } });
});
