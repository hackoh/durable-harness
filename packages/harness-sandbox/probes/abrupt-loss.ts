// P0.6: what a Drive keeps after an abrupt VM loss (docs/workspaces.md §5.7:
// "files on /workspace are durable but not transactional"). Each scenario
// writes, on its own Drive: a file followed by `sync -f /workspace` (the
// relay's FSYNC), a file fsync'd on its own, a small file with no sync, a
// 20 MB file with no sync, and an appender still running when the VM goes.
// Then the VM is lost one of three ways: a crash inside it (sysrq reboot: no
// sync, no unmount), `delete()` while running, or its timeout expiring. A
// new VM mounts the Drive and reads what survived. The scenarios run in
// parallel; everything is deleted at the end.
import { Drive, Sandbox } from '@vercel/sandbox';
import { BASE, describeError, log, probe, probeName, sh, sleep, track } from './lib.ts';

const WRITE = `set -e
cd /workspace
echo synced > synced.txt && sync -f /workspace
python3 -c "import os; f=open('fsynced.txt','w'); f.write('fsynced\\n'); f.flush(); os.fsync(f.fileno())"
echo unsynced > unsynced.txt
head -c 20000000 /dev/urandom > big.bin && sha256sum big.bin | cut -c1-16 > /tmp/big.sha
nohup bash -c 'i=0; while :; do i=$((i+1)); echo $i >> append.log; done' >/dev/null 2>&1 &
sleep 2
echo "bigSha=$(cat /tmp/big.sha) appendLinesBeforeKill=$(wc -l < append.log)"`;

const READ = `cd /workspace
for f in synced.txt fsynced.txt unsynced.txt; do printf "$f=%s " "$(cat $f 2>/dev/null || echo MISSING)"; done
printf "big=%s/%s " "$(stat -c %s big.bin 2>/dev/null || echo MISSING)" "$(sha256sum big.bin 2>/dev/null | cut -c1-16)"
printf "appendLines=%s lastLine=%s " "$(wc -l < append.log 2>/dev/null)" "$(tail -c 64 append.log 2>/dev/null | tail -1 | tr -cd '0-9a-zA-Z' | cut -c1-12)"
printf "fsck=%s" "$(sudo dmesg 2>/dev/null | grep -i -E 'ext4|recovery|journal' | grep -i -E 'vdc|recover' | tail -2 | tr '\\n' ';' | cut -c1-200)"`;

type Kill = 'crash' | 'delete' | 'timeout';

async function scenario(kill: Kill): Promise<void> {
  const name = track('sandbox', probeName(`loss-${kill}`));
  const readerName = track('sandbox', probeName(`read-${kill}`));
  const driveName = track('drive', probeName(`lossdrive-${kill}`));
  const drive = await Drive.getOrCreate({ name: driveName, maxSize: 1024 ** 3 });
  const sb = await Sandbox.create({ ...BASE, name, mounts: { '/workspace': drive }, timeout: kill === 'timeout' ? 60_000 : BASE.timeout });
  const t0 = Date.now();
  const w = await sh(sb, WRITE);
  log(`${kill}.written`, w.out || w.err);
  if (kill === 'crash') await sb.runCommand({ cmd: 'bash', args: ['-c', 'echo b > /proc/sysrq-trigger'], sudo: true, detached: true }).catch(() => {});
  if (kill === 'delete') await sb.delete();
  const tKill = Date.now();
  // Wait for the platform to let go of the Drive (a crash: until we delete it).
  for (let i = 0; ; i++) {
    const d = await Drive.get({ name: driveName });
    if (!d.currentSessionId) break;
    if (kill === 'crash' && i === 5) await Sandbox.get({ name }).then((s) => s.delete(), () => {});
    if (Date.now() - tKill > 240_000) throw new Error(`${kill}: Drive still attached`);
    await sleep(2000);
  }
  log(`${kill}.detachedAfterMs`, { afterKill: Date.now() - tKill, afterStart: Date.now() - t0 });
  if (kill === 'timeout') log('timeout.status', await Sandbox.get({ name }).then((s) => s.status, (err) => describeError(err)));
  const reader = await Sandbox.create({ ...BASE, name: readerName, mounts: { '/workspace': drive } });
  log(`${kill}.survived`, (await sh(reader, READ)).out);
}

await probe(async () => {
  const results = await Promise.allSettled((['crash', 'delete', 'timeout'] as const).map(scenario));
  results.forEach((r, i) => r.status === 'rejected' && log(`scenario${i}.error`, describeError(r.reason)));
});
