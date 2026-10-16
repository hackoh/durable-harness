// P0.14: does the custom network mode with `'*': []` pass non-HTTP traffic
// (git over ssh, raw TCP, DNS) while response rules force 403s for named
// hosts? The same battery under the string modes 'allow-all' and 'deny-all'
// for comparison. Plain HTTP to the forced-403 hosts too, with where it is
// redirected: a response rule may cover HTTPS only. One VM, deleted at the
// end.
import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { BASE, log, probe, probeName, sh, timed, track } from './lib.ts';

const NAME = track('sandbox', probeName('egress'));

/** The sandbox tier's default with forced 403s (docs/workspaces.md §5.7, Egress). */
const CUSTOM: NetworkPolicy = {
  allow: {
    'ai-gateway.vercel.sh': [{ response: { statusCode: 403 } }],
    'api.vercel.com': [{ response: { statusCode: 403 } }],
    '*': [],
  },
};

const battery = `
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$1"; }
loc() { curl -s -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 8 "$1"; }
tcp() { timeout 6 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null && echo open || echo closed; }
echo "https.example=$(code https://example.com)"
echo "http.example=$(code http://example.com)"
echo "https.github=$(code https://github.com)"
echo "https.apiVercel=$(code https://api.vercel.com/)"
echo "https.gateway=$(code https://ai-gateway.vercel.sh/v1/models)"
echo "http.apiVercel=$(loc http://api.vercel.com/)"
echo "http.gateway=$(loc http://ai-gateway.vercel.sh/v1/models)"
echo "dns.getent=$(getent hosts github.com | awk '{print $1; exit}')"
echo "dns.udp8888=$(timeout 6 dig +short +time=3 +tries=1 @8.8.8.8 github.com 2>&1 | head -1)"
echo "tcp.github22=$(tcp github.com 22)"
echo "tcp.portquiz8080=$(tcp portquiz.net 8080)"
echo "tcp.tcpbin4242.echo=$(printf 'dh-probe\\n' | timeout 8 nc -q 2 tcpbin.com 4242 2>&1 | head -1)"
echo "ssh.github=$(timeout 15 ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 git@github.com 2>&1 | tail -1)"
echo "git.lsRemote.https=$(timeout 20 git ls-remote https://github.com/vercel/sandbox HEAD 2>&1 | cut -c1-12)"
echo "git.lsRemote.ssh=$(timeout 20 env GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8' git ls-remote git@github.com:vercel/sandbox HEAD 2>&1 | tail -1 | cut -c1-80)"
`;

await probe(async () => {
  const sb = await timed('create', () => Sandbox.create({ ...BASE, name: NAME }));
  log('tools', (await sh(sb, 'for t in ssh nc dig git; do printf "$t=%s " "$(command -v $t || echo missing)"; done')).out);
  log('tools.install', (await sh(sb, 'command -v nc >/dev/null && command -v dig >/dev/null && command -v ssh >/dev/null || (DEBIAN_FRONTEND=noninteractive timeout 150 apt-get install -y -q netcat-openbsd dnsutils openssh-client >/dev/null 2>&1 || (timeout 120 apt-get update -q >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive timeout 150 apt-get install -y -q netcat-openbsd dnsutils openssh-client >/dev/null 2>&1)); for t in ssh nc dig; do printf "$t=%s " "$(command -v $t || echo missing)"; done', { sudo: true })).out);

  for (const [label, policy] of [
    ['allowAll', 'allow-all'],
    ['custom', CUSTOM],
    ['denyAll', 'deny-all'],
  ] as const) {
    await timed(`policy.${label}.update`, () => sb.update({ networkPolicy: policy }));
    log(`policy.${label}`, (await sh(sb, battery, { tail: 4000 })).out);
  }
});
