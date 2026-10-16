// P0.4: a stopped non-persistent named sandbox with a Drive (the session
// VM's normal state between turns, docs/workspaces.md §5.7). Does
// `Sandbox.get({ resume: true })` boot a fresh VM with the Drive remounted
// from the stored mounts, or 410? Does `Sandbox.create({ name })` conflict
// while it is stopped? Which path does `getOrCreate` take? Everything is
// deleted at the end.
import { Drive, Sandbox } from '@vercel/sandbox';
import { BASE, attempt, log, probe, probeName, sh, timed, track } from './lib.ts';

const NAME = track('sandbox', probeName('resume'));
const DRIVE = track('drive', probeName('resumedrive'));

const state = async (sb: Sandbox, label: string) =>
  log(label, {
    status: sb.status,
    sessionId: sb.currentSession().sessionId.slice(-6),
    mounts: Object.keys(sb.mounts ?? {}),
    files: (await sh(sb, 'cat /workspace/f.txt 2>&1; cat /vercel/rootfs.txt 2>&1; grep -c " /workspace " /proc/self/mounts')).out,
  });

await probe(async () => {
  const drive = await Drive.getOrCreate({ name: DRIVE, maxSize: 1024 ** 3 });
  const sb = await timed('create', () => Sandbox.create({ ...BASE, name: NAME, mounts: { '/workspace': drive } }));
  await sh(sb, 'echo on-drive > /workspace/f.txt && echo on-rootfs > /vercel/rootfs.txt && sync');
  await state(sb, 'first');
  const firstSession = sb.currentSession().sessionId;

  await timed('stop', () => sb.stop());
  const got = await timed('get(no resume)', () => Sandbox.get({ name: NAME }));
  log('afterStop', { status: got.status, persistent: got.persistent, mounts: Object.keys(got.mounts ?? {}) });
  log('drive.afterStop', { attachedTo: (await Drive.get({ name: DRIVE })).currentSandboxName ?? null });

  const conflict = await attempt('create(sameName, while stopped)', () => Sandbox.create({ ...BASE, name: NAME, mounts: { '/workspace': drive } }));
  if (conflict.ok) log('create.whileStopped.sessionChanged', conflict.value.currentSession().sessionId !== firstSession);

  const resumed = await attempt('get(resume: true)', () => Sandbox.get({ name: NAME, resume: true }));
  if (resumed.ok) {
    await state(resumed.value, 'resumed');
    log('resumed.newSession', resumed.value.currentSession().sessionId !== firstSession);
    log('drive.afterResume', { attachedSession: (await Drive.get({ name: DRIVE })).currentSessionId === resumed.value.currentSession().sessionId });
    await timed('stop(2)', () => resumed.value.stop());
  }

  // getOrCreate's Sandbox.get carries no `resume`, so it hands back the
  // stopped sandbox as is; its first command resumes (withResume), and that
  // resume fails like the one above. Its delete-and-recreate path is for a
  // 410, not this 400.
  const goc = await attempt('getOrCreate(after stop)', () => Sandbox.getOrCreate({ ...BASE, name: NAME, mounts: { '/workspace': drive } }));
  if (goc.ok) {
    log('getOrCreate.handle', { status: goc.value.status, sameSession: goc.value.currentSession().sessionId === firstSession });
    await attempt('getOrCreate.firstCommand', () => sh(goc.value, 'true'));
  }

  // With `resume: true`, getOrCreate's get fails with the 400, which is not
  // the 410 its delete-and-recreate path looks for, so it throws.
  await attempt('getOrCreate(resume: true, after stop)', () => Sandbox.getOrCreate({ ...BASE, name: NAME, resume: true, mounts: { '/workspace': drive } }));

  // What works: delete the stopped sandbox, create it again with the mounts.
  const t = Date.now();
  await timed('delete(stopped)', () => got.delete());
  const fresh = await attempt('create(sameName, right after delete)', () => Sandbox.create({ ...BASE, name: NAME, mounts: { '/workspace': drive } }));
  if (fresh.ok) {
    log('deleteThenCreate.ms', Date.now() - t);
    await state(fresh.value, 'recreated');
    log('sessions', (await fresh.value.listSessions()).sessions.map((x) => x.status));
  }
});
