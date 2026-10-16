// P0.13: can one session's VM reach another's relay port or its loopback
// model port? Two VMs in one project and region. A serves the echo server on
// 3000 (every interface, exposed: the relay's case) and on 4100 (loopback
// only: the model port's case), plus 3001 on every interface but not
// exposed. B tries A's addresses directly (TCP and HTTP), A's public port URL
// (reachable from anywhere by design: the relay's bearer check is the
// control), and the link-local metadata address. Both deleted at the end.
import { readFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { BASE, log, probe, probeName, sh, sleep, startEchoServer, timed, track } from './lib.ts';

const NAME_A = track('sandbox', probeName('xa'));
const NAME_B = track('sandbox', probeName('xb'));

await probe(async () => {
  const [A, B] = await Promise.all([
    timed('A.create', () => Sandbox.create({ ...BASE, name: NAME_A, ports: [3000] })),
    timed('B.create', () => Sandbox.create({ ...BASE, name: NAME_B, ports: [3000] })),
  ]);
  const url = await startEchoServer(A, 3000);
  await A.writeFiles([{ path: '/tmp/echo-server.js', content: readFileSync(new URL('./vm/echo-server.js', import.meta.url)) }]);
  await A.runCommand({ cmd: 'bun', args: ['/tmp/echo-server.js'], env: { PORT: '4100', HOST: '127.0.0.1' }, detached: true });
  await A.runCommand({ cmd: 'bun', args: ['/tmp/echo-server.js'], env: { PORT: '3001' }, detached: true });
  await sleep(1000);

  const net = 'hostname -I; ip -4 -o addr show | awk \'{print $2, $4}\' | tr "\\n" ";"; echo; ip route | tr "\\n" ";"';
  const a = await sh(A, net);
  const b = await sh(B, net);
  log('A.net', a.out);
  log('B.net', b.out);
  log('A.listeners', (await sh(A, "ss -ltn | awk 'NR>1 {print $4}' | sort | tr '\\n' ' '", { sudo: true })).out);
  log('A.self', (await sh(A, 'for p in 3000 3001 4100; do printf "$p=%s " "$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:$p/health)"; done')).out);

  // Every VM is alone on its own link: if both report the same address, B's
  // "A" is B itself, and the only path between them is the gateway.
  const ipA = a.out.split('\n')[0]!.trim();
  const ipB = b.out.split('\n')[0]!.trim();
  log('sameAddress', ipA === ipB);
  if (ipA !== ipB) {
    log(`B->A.${ipA}`, (await sh(B, `for p in 3000 3001 4100; do printf "tcp$p=%s " "$(timeout 4 bash -c "echo > /dev/tcp/${ipA}/$p" 2>/dev/null && echo open || echo closed)"; done`)).out);
  }
  log(
    'B->gateway',
    (await sh(B, 'gw=$(ip route | awk \'/default/ {print $3; exit}\'); echo "gw=$gw"; for p in 22 80 443 3000 3001 4100 23456; do printf "tcp$p=%s " "$(timeout 3 bash -c "echo > /dev/tcp/$gw/$p" 2>/dev/null && echo open || echo closed)"; done; echo; ip neigh | tr "\\n" ";"')).out
  );
  // The one listener the image brings (the platform's in-VM agent): who owns
  // it, and does it answer an unprivileged local process?
  log('A.platformListener', (await sh(A, "ss -ltnp | grep -v -E ':(3000|3001|4100) ' | awk 'NR>1 {print $4, $6}'", { sudo: true })).out);
  log(
    'A.platformListener.fromUnprivileged',
    (await sh(A, 'id nobody >/dev/null && setpriv --reuid nobody --regid nogroup --clear-groups --inh-caps=-all --no-new-privs -- curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:23456/ ; echo " exit=$?"', { sudo: true })).out
  );
  // A's address as the internet sees it (its egress IP): does B reach A's
  // ports through it, exposed (3000) or not (3001)?
  const egressA = (await sh(A, 'curl -s --max-time 8 https://ifconfig.me')).out.trim();
  const egressB = (await sh(B, 'curl -s --max-time 8 https://ifconfig.me')).out.trim();
  log('egress', { sameIp: egressA === egressB, aIsIPv4: /^\d+\.\d+\.\d+\.\d+$/.test(egressA) });
  if (/^[0-9a-f.:]+$/.test(egressA)) {
    log('B->A.egressIp', (await sh(B, `for p in 3000 3001; do printf "tcp$p=%s http$p=%s " "$(timeout 5 bash -c "echo > /dev/tcp/${egressA}/$p" 2>/dev/null && echo open || echo closed)" "$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://${egressA}:$p/health)"; done`)).out);
  }
  log('B.metadata', (await sh(B, 'curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://169.254.169.254/; echo " exit=$?"')).out);
  log('B->A.publicPort', (await sh(B, `curl -s -o /dev/null -w "%{http_code}" --max-time 8 ${url}/health`)).out);
});
