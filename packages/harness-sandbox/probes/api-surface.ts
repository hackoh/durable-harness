// P0.11: the research's Sandbox API probe, re-run on the pinned 3.7.0. One
// Drive; sandbox A, then sandbox B on the same Drive (never both read-write).
// The port ingress (HTTP, WebSocket, SSE, a streamed request body), stdin,
// Command.kill, sudo, live network-policy updates through `update`, and files
// surviving a graceful stop. A silent WebSocket from the laptop is held for
// 400 s alongside, the control for the 340 s close seen from a Function
// (P0.1): does the ingress close it, or was it the Function's side?
// Everything is deleted at the end.
import { Drive, Sandbox } from '@vercel/sandbox';
import { BASE, attempt, log, percentiles, probe, probeName, sh, sleep, startEchoServer, timed, track } from './lib.ts';

const DRIVE = track('drive', probeName('drive'));
const NAME_A = track('sandbox', probeName('a'));
const NAME_B = track('sandbox', probeName('b'));
const NAME_C = track('sandbox', probeName('c'));

await probe(async () => {
  const drive = await timed('drive.getOrCreate', () => Drive.getOrCreate({ name: DRIVE, maxSize: 1024 ** 3 }));
  log('drive.meta', { region: drive.region, maxSize: drive.maxSize, attached: drive.currentSandboxName ?? null });

  const A = await timed('A.create(drive@/workspace)', () => Sandbox.create({ ...BASE, name: NAME_A, ports: [3000], mounts: { '/workspace': drive } }));
  log('A.meta', { region: A.region, sessionRegion: A.currentSession().region, vcpus: A.vcpus, memory: A.memory, cwd: A.cwd, mounts: A.mounts });
  log('A.firstCommand', await timed('A.firstCommand', () => sh(A, 'id; stat -c "%U:%G %a" /workspace; grep " /workspace " /proc/self/mounts; df -h /workspace | tail -1; which bun node; claude --version 2>/dev/null; codex --version 2>/dev/null')));
  log('A.write', await sh(A, 'cd /workspace && echo hello-from-A > a.txt && mkdir -p deep/dir && echo nested > deep/dir/n.txt && printf "#!/bin/sh\\necho script-ok\\n" > x.sh && chmod +x x.sh && ln -sf a.txt link && head -c 5000000 /dev/urandom > blob.bin && sha256sum blob.bin | cut -c1-16 && sync'));

  // One writer: a second sandbox mounting the same Drive read-write while A runs.
  await attempt('C.create(sameDriveRW, while A runs)', () => Sandbox.create({ ...BASE, name: NAME_C, mounts: { '/workspace': drive } }));
  log('C.exists', await Sandbox.get({ name: NAME_C }).then((s) => s.status, () => 'not found'));

  // The port ingress.
  const tUp = Date.now();
  const url = await startEchoServer(A);
  log('port.upMs', Date.now() - tUp);

  // The silent socket: opened now, never written to, checked at the end.
  const silent = await new Promise<{ ws: WebSocket; openedAt: number; closed: { atS: number; code: number } | null }>((ok, fail) => {
    const ws = new WebSocket(`${url.replace(/^https/, 'wss')}/ws`);
    const s = { ws, openedAt: 0, closed: null as { atS: number; code: number } | null };
    ws.onopen = () => {
      s.openedAt = Date.now();
      ok(s);
    };
    ws.onclose = (e) => {
      s.closed = { atS: Math.round((Date.now() - s.openedAt) / 100) / 10, code: e.code };
    };
    setTimeout(() => fail(new Error('silent socket never opened')), 15_000);
  });
  const health = await (await fetch(`${url}/health`, { cache: 'no-store' })).json();
  log('port.unauthenticatedGET.headerNamesSeenByVm', health.headerNames);
  const rtts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await (await fetch(`${url}/health`, { cache: 'no-store' })).text();
    rtts.push(Date.now() - t);
  }
  log('port.httpRttMs(laptop->VM)', percentiles(rtts));

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${url.replace(/^https/, 'wss')}/ws`);
    const t0 = Date.now();
    const samples: number[] = [];
    let n = 0;
    let t = 0;
    const done = (r: unknown) => {
      log('port.websocket', r);
      try {
        ws.close();
      } catch {}
      resolve();
    };
    const timer = setTimeout(() => done({ ok: false, why: 'timeout', samples }), 60_000);
    ws.onopen = () => {
      log('port.websocket.openMs', Date.now() - t0);
      t = Date.now();
      ws.send('ping-0');
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done({ ok: false, why: 'error' });
    };
    ws.onclose = (e) => {
      if (n < 12) {
        clearTimeout(timer);
        done({ ok: false, why: 'closed', code: e.code, samples });
      }
    };
    ws.onmessage = async (m) => {
      samples.push(Date.now() - t);
      n++;
      if (n < 10) {
        t = Date.now();
        ws.send(`ping-${n}`);
      } else if (n === 10) {
        t = Date.now();
        ws.send('x'.repeat(512 * 1024));
      } else if (n === 11) {
        log('port.websocket.512KiBEchoBytes', String(m.data).length);
        await sleep(20_000);
        t = Date.now();
        ws.send('after-20s-idle');
      } else {
        clearTimeout(timer);
        done({ ok: true, rttMs: percentiles(samples.slice(0, 10)), bigEchoMs: samples[10], afterIdleMs: samples[11], idleSurvived: String(m.data) === 'after-20s-idle' });
      }
    };
  });

  // SSE: does the ingress stream or buffer a response?
  {
    const t0 = Date.now();
    const r = await fetch(`${url}/sse`, { cache: 'no-store' });
    const arrivals: number[] = [];
    const rd = r.body!.getReader();
    for (;;) {
      const { done } = await rd.read();
      if (done) break;
      arrivals.push(Date.now() - t0);
    }
    log('port.sseChunkArrivalMs', arrivals);
  }
  // A streamed request body: does the echo of chunk i arrive before the body ends?
  {
    let sent = 0;
    const t0 = Date.now();
    const sentAt: number[] = [];
    const body = new ReadableStream({
      async pull(ctl) {
        if (sent >= 5) {
          await sleep(300);
          return ctl.close();
        }
        await sleep(400);
        sentAt.push(Date.now() - t0);
        ctl.enqueue(new TextEncoder().encode(`chunk-${sent++};`));
      },
    });
    const r = await attempt('port.duplex.request', async () => {
      const res = await fetch(`${url}/duplex`, { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/octet-stream' } } as RequestInit);
      const headersAt = Date.now() - t0;
      const rd = res.body!.getReader();
      const got: number[] = [];
      for (;;) {
        const { done } = await rd.read();
        if (done) break;
        got.push(Date.now() - t0);
      }
      return { status: res.status, headersAt, got };
    });
    if (r.ok) log('port.duplex', { ...r.value, sentAt });
  }

  // stdin: a detached `cat`, echoed through logs; a second handle; a stale one.
  {
    const cat = await timed('stdin.start', () => A.runCommand({ cmd: 'cat', stdin: true, detached: true }));
    const it = cat.logs()[Symbol.asyncIterator]();
    let buf = '';
    const until = async (s: string) => {
      while (!buf.includes(s)) {
        const { value } = await it.next();
        if (value?.stream === 'stdout') buf += value.data;
      }
    };
    const lat: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = Date.now();
      await cat.writeStdin(`line-${i}\n`);
      await until(`line-${i}\n`);
      lat.push(Date.now() - t);
    }
    log('stdin.echoMs(laptop)', percentiles(lat));
    const again = await A.getCommand(cat.cmdId);
    await again.writeStdin('from-second-handle\n');
    await until('from-second-handle\n');
    await attempt('stdin.staleHandleWrite', () => cat.writeStdin('STALE\n'));
    await again.writeStdin('after-stale\n');
    await until('after-stale\n');
    log('stdin.staleDelivered', buf.includes('STALE'));
    await again.closeStdin();
    log('stdin.closeExit', (await again.wait()).exitCode);
  }

  // Command.kill: does a SIGTERM reach the command's children?
  {
    const grp = await A.runCommand({ cmd: 'bash', args: ['-c', 'sleep 301 & sleep 302 & wait'], detached: true });
    await sleep(1000);
    await grp.kill('SIGTERM');
    await sleep(1500);
    log('kill.childrenLeftAfterSIGTERM', (await sh(A, 'pgrep -f "sleep 30[12]" | wc -l')).out);
    await sh(A, 'pkill -f "sleep 30[12]" || true');
  }
  log('sudo.whoami', (await sh(A, 'whoami', { sudo: true })).out);

  // Network policy, live, through `update` (3.7.0 deprecates updateNetworkPolicy).
  const curl = 'curl -s -o /dev/null -w "%{http_code}" --max-time 6 https://example.com; echo " exit=$?"';
  log('policy.default', (await sh(A, curl)).out);
  await timed('policy.update(deny-all)', () => A.update({ networkPolicy: 'deny-all' }));
  log('policy.denyAll', (await sh(A, curl)).out);
  await timed('policy.update(custom 403 rule)', () =>
    A.update({ networkPolicy: { allow: { 'example.com': [{ response: { statusCode: 403 } }], '*': [] } } })
  );
  log('policy.custom403', (await sh(A, curl)).out);
  log('policy.readBack', A.networkPolicy);
  await A.update({ networkPolicy: 'allow-all' });
  log('policy.allowAllAgain', (await sh(A, curl)).out);

  // The silent socket: wait out 400 s from its open, then echo once on it.
  await timed('A.extendTimeout(6m)', () => A.extendTimeout(6 * 60_000));
  while (!silent.closed && Date.now() - silent.openedAt < 400_000) await sleep(1000);
  const silentEcho = silent.closed
    ? null
    : await new Promise<boolean>((ok) => {
        silent.ws.onmessage = (m) => ok(String(m.data) === 'after-400s-silence');
        silent.ws.send('after-400s-silence');
        setTimeout(() => ok(false), 10_000);
      });
  log('port.silentSocket(laptop)', { heldS: Math.round((Date.now() - silent.openedAt) / 1000), closed: silent.closed, echoAfter400s: silentEcho });
  silent.ws.close();
  // An unsynced write right before a graceful stop.
  await sh(A, 'echo unsynced-$(date +%s) > /workspace/unsynced.txt');
  await timed('A.stop', () => A.stop());
  for (let i = 0; i < 40; i++) {
    const d = await Drive.get({ name: DRIVE });
    if (!d.currentSandboxName) {
      log('drive.detachedAfterStopS', i);
      break;
    }
    await sleep(1000);
  }
  const B = await timed('B.create(sameDrive)', () => Sandbox.create({ ...BASE, name: NAME_B, mounts: { '/workspace': drive } }));
  log('B.read', await sh(B, 'cd /workspace && cat a.txt deep/dir/n.txt unsynced.txt && ./x.sh && readlink link && sha256sum blob.bin | cut -c1-16 && stat -c "%U %a %n" a.txt x.sh'));
});
