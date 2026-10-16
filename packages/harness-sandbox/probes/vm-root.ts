// P0.19: what root can do in a Sandbox VM, for the relay's privilege split
// (docs/workspaces.md §5.4). cgroup v2 mounted and writable; a session cgroup
// whose `cgroup.kill` reaches a setsid'd grandchild, an `unshare` pid
// namespace and a bwrap one; which controllers a session cgroup can have,
// first with every process in the root cgroup, then with them moved into a
// leaf (`init`) so the root holds none; `setpriv` dropping to an `agent`
// user with no capabilities; `net.ipv4.ip_unprivileged_port_start`
// settable, and a port below it refused to `agent` and served through the
// ingress for root; `oom_score_adj=-1000`. One VM, deleted at the end.
//
// Every variant puts the root's `cgroup.subtree_control` back as it found
// it, so each starts from the VM's own state. The move into `init` runs in a
// second, fresh VM (it can't be undone, and a threaded child the variants
// leave behind would break it), followed by checks that the platform
// (runCommand, its agent on 23456, the port ingress) still works.
import { Sandbox } from '@vercel/sandbox';
import { BASE, log, probe, probeName, sh, sleep, startEchoServer, timed, track } from './lib.ts';

const NAME = track('sandbox', probeName('root'));
/** A second, fresh VM for the move into `init`, so no earlier variant's state carries over. */
const NAME_LEAF = track('sandbox', probeName('leaf'));
const CG = '/sys/fs/cgroup';

await probe(async () => {
  const sb = await timed('create', () => Sandbox.create({ ...BASE, name: NAME, ports: [1024] }));
  const root = (script: string) => sh(sb, script, { sudo: true });

  log('os', (await sh(sb, '. /etc/os-release; echo "$PRETTY_NAME"; uname -r; id -un')).out);
  // The default user's capabilities: runCommand's processes are not plain users.
  log('defaultUser.caps', (await sh(sb, 'grep -E "^Cap(Eff|Amb)" /proc/self/status | tr "\\t\\n" " ;"')).out);
  // The VM's own state, read before anything writes: the root's type (a
  // `cgroup.type` file means /sys/fs/cgroup is not the kernel's real root,
  // which has none), how many processes it holds, and what it enables.
  log(
    'cgroup.mount',
    await root(
      `stat -fc %T ${CG}; grep cgroup /proc/self/mounts; echo "type: $(cat ${CG}/cgroup.type 2>&1)"; echo "procs: $(wc -l < ${CG}/cgroup.procs)"; echo "threads: $(wc -l < ${CG}/cgroup.threads)"; echo "controllers: $(cat ${CG}/cgroup.controllers)"; echo "subtree: $(cat ${CG}/cgroup.subtree_control)"; echo "self: $(cat /proc/self/cgroup)"; echo "pid1: $(cat /proc/1/cgroup) $(cat /proc/1/comm)"; echo "children: $(find ${CG} -mindepth 1 -maxdepth 1 -type d | tr "\\n" " ")"`
    )
  );

  // bwrap: in the image, or installable?
  const installBwrap = 'command -v bwrap >/dev/null || (DEBIAN_FRONTEND=noninteractive timeout 120 apt-get install -y -q bubblewrap >/dev/null 2>&1 || (timeout 120 apt-get update -q >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive timeout 120 apt-get install -y -q bubblewrap >/dev/null 2>&1) || timeout 120 dnf install -y -q bubblewrap >/dev/null 2>&1); command -v bwrap && bwrap --version';
  log('bwrap.before', (await root('command -v bwrap || echo missing; bwrap --version 2>&1 | head -1')).out);
  log('bwrap.install', await root(installBwrap));

  // A session cgroup holding a tree that `Command.kill` misses: a setsid'd
  // grandchild, an unshare pid namespace, a bwrap pid namespace. `enable` is
  // what the parent's subtree_control gets first (and loses again after,
  // unless `keep`); `limits` are written into the session cgroup.
  const variant = async (vm: Sandbox, label: string, opts: { enable?: string; parent?: string; type?: string; limits?: Record<string, string>; keep?: boolean } = {}) => {
    const { enable = '', parent = CG, type = '', limits = {}, keep = false } = opts;
    const root = (script: string) => sh(vm, script, { sudo: true });
    const cg = `${parent}/dh-probe-${label}`;
    const setLimits = Object.entries(limits)
      .map(([f, v]) => `echo "${v}" > ${cg}/${f} 2>/tmp/err && echo "${f}=$(cat ${cg}/${f})" || echo "${f}: $(cat /tmp/err)"`)
      .join('\n');
    log(
      `cgroup.${label}.create`,
      await root(`mkdir -p ${parent}; echo "rootTypeBefore: $(cat ${CG}/cgroup.type)"
for c in ${enable}; do echo "+$c" > ${parent}/cgroup.subtree_control 2>/tmp/err && echo "+$c ok" || echo "+$c: $(cat /tmp/err)"; done
echo "rootTypeAfterEnable: $(cat ${CG}/cgroup.type)"
mkdir ${cg}${type ? ` && echo ${type} > ${cg}/cgroup.type` : ''} && echo "type: $(cat ${cg}/cgroup.type); controllers: $(cat ${cg}/cgroup.controllers)"
${setLimits}`)
    );
    await vm.runCommand({
      cmd: 'bash',
      args: [
        '-c',
        `echo $$ > ${cg}/cgroup.procs 2>/tmp/move-${label}.err || exit 3
setsid -f bash -c 'sleep 611 & sleep 612 & wait' </dev/null >/dev/null 2>&1
setsid -f unshare --pid --fork --mount-proc sleep 613 </dev/null >/dev/null 2>&1
command -v bwrap >/dev/null && setsid -f bwrap --unshare-pid --dev-bind / / sleep 614 </dev/null >/dev/null 2>&1
sleep 615`,
      ],
      sudo: true,
      detached: true,
    });
    await sleep(2000);
    log(
      `cgroup.${label}.before`,
      await root(`echo "moveError: $(cat /tmp/move-${label}.err 2>/dev/null)"; echo "procs: $(wc -l < ${cg}/cgroup.procs 2>&1)"; pgrep -a -f "sleep 61[1-5]" | sed "s/^[0-9]* //" | grep -v "^sudo\\|^bash -c echo" | sort | uniq -c | tr "\\n" ";"`)
    );
    log(
      `cgroup.${label}.kill`,
      await root(`t=$(date +%s%N); echo 1 > ${cg}/cgroup.kill 2>/tmp/err || echo "killError: $(cat /tmp/err)"; for i in $(seq 50); do [ "$(pgrep -f "sleep 61[1-5]" | wc -l)" = 0 ] && break; sleep 0.02; done; echo "goneAfterMs: $(( ($(date +%s%N) - t) / 1000000 ))"; echo "left: $(pgrep -f "sleep 61[1-5]" | wc -l)"; pkill -9 -f "sleep 61[1-5]"; for i in $(seq 50); do rmdir ${cg} 2>/dev/null && { echo rmdir-ok; break; }; sleep 0.1; done
${keep ? '' : `for c in ${enable}; do echo "-$c" > ${parent}/cgroup.subtree_control 2>/dev/null; done`}
echo "rootTypeAfter: $(cat ${CG}/cgroup.type); subtree: $(cat ${CG}/cgroup.subtree_control)"`)
    );
  };
  await variant(sb, 'plain');
  // Domain controllers, with every process still in the root cgroup.
  await variant(sb, 'memio', { enable: 'memory io' });
  await variant(sb, 'pids', { enable: 'pids', limits: { 'pids.max': '64' } });
  await variant(sb, 'pidscpu', { enable: 'pids cpu' });
  await variant(sb, 'threaded', { enable: 'pids cpu', type: 'threaded', limits: { 'pids.max': '64', 'cpu.max': '50000 100000' } });
  log('cgroup.rootAfterVariants', (await root(`echo "type: $(cat ${CG}/cgroup.type); subtree: $(cat ${CG}/cgroup.subtree_control); procs: $(wc -l < ${CG}/cgroup.procs)"`)).out);

  // setpriv to an unprivileged user.
  log('agent.create', await root('useradd -m -s /bin/bash agent && id agent; sudo -l -U agent 2>&1 | tail -2'));
  log('setpriv.version', (await root('setpriv --version')).out);
  log(
    'setpriv.drop',
    await root(
      'setpriv --reuid agent --regid agent --clear-groups --inh-caps=-all --no-new-privs -- bash -c \'id; grep -E "^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs)" /proc/self/status | tr "\\t\\n" " ;"; echo; sudo -n true 2>&1 | head -1; touch /opt/x 2>&1 | head -1\''
    )
  );

  // ip_unprivileged_port_start, and a port below it.
  log('sysctl.before', (await root('sysctl -n net.ipv4.ip_unprivileged_port_start')).out);
  log('sysctl.set', await root('sysctl -w net.ipv4.ip_unprivileged_port_start=1025 && sysctl -n net.ipv4.ip_unprivileged_port_start'));
  const bind = `python3 -c "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('0.0.0.0', 1024)); print('bound 1024')" 2>&1 | tail -1`;
  log('bind1024.asAgent', (await root(`setpriv --reuid agent --regid agent --clear-groups --inh-caps=-all --no-new-privs -- ${bind}`)).out);
  log('bind1024.asDefaultUser', (await sh(sb, bind)).out);
  log('bind1024.asRoot', (await root(bind)).out);
  // Root serves 1024; is it reachable through the port ingress?
  const { readFileSync } = await import('node:fs');
  await sb.writeFiles([{ path: '/tmp/echo-server.js', content: readFileSync(new URL('./vm/echo-server.js', import.meta.url)) }]);
  await sb.runCommand({ cmd: 'bun', args: ['/tmp/echo-server.js'], env: { PORT: '1024' }, sudo: true, detached: true });
  const url = sb.domain(1024).replace(/\/+$/, '');
  let status = 0;
  for (let i = 0; i < 40 && status !== 200; i++) {
    status = await fetch(`${url}/health`, { cache: 'no-store' }).then((r) => r.status, () => 0);
    if (status !== 200) await sleep(250);
  }
  log('ingress.port1024.servedByRoot', { status });
  log('ingress.port1024.listenerUid', (await root("awk 'NR>1 && $2 ~ /:0400$/ && $4 == \"0A\" {print \"uid=\" $8}' /proc/net/tcp /proc/net/tcp6 | sort -u")).out);

  // oom_score_adj for the relay.
  log('oom_score_adj', (await root('echo -1000 > /proc/self/oom_score_adj && cat /proc/self/oom_score_adj')).out);
  // The usual way out of the no-internal-processes rule, in a fresh VM:
  // move every process out of the root into a leaf, then enable the
  // controllers at the root, where no process is left.
  const leaf = await timed('leaf.create', () => Sandbox.create({ ...BASE, name: NAME_LEAF, ports: [3000] }));
  const leafRoot = (script: string) => sh(leaf, script, { sudo: true });
  log('leaf.cgroup', (await leafRoot(`echo "type: $(cat ${CG}/cgroup.type); procs: $(wc -l < ${CG}/cgroup.procs); subtree: $(cat ${CG}/cgroup.subtree_control)"`)).out);
  log('leaf.bwrap', (await leafRoot(installBwrap)).out);
  // A listener started before the move, to check the ingress after it.
  const leafUrl = await startEchoServer(leaf, 3000);
  log(
    'cgroup.evacuate',
    await leafRoot(`mkdir -p ${CG}/init
for i in $(seq 30); do
  for p in $(cat ${CG}/cgroup.procs); do echo $p > ${CG}/init/cgroup.procs 2>/dev/null; done
  [ -z "$(cat ${CG}/cgroup.procs)" ] && break
  sleep 0.1
done
left=$(cat ${CG}/cgroup.procs)
echo "leftInRoot: $(echo -n "$left" | grep -c .) $(for p in $left; do printf "%s " "$(cat /proc/$p/comm 2>/dev/null)"; done)"
echo "inInit: $(wc -l < ${CG}/init/cgroup.procs) ($(cat /proc/1/comm) is $(cat /proc/1/cgroup))"
for c in memory pids cpu io; do echo "+$c" > ${CG}/cgroup.subtree_control 2>/tmp/err && echo "+$c ok" || echo "+$c: $(cat /tmp/err)"; done
echo "rootType: $(cat ${CG}/cgroup.type); subtree: $(cat ${CG}/cgroup.subtree_control); initType: $(cat ${CG}/init/cgroup.type)"`)
  );
  await variant(leaf, 'session', { limits: { 'memory.max': '256M', 'pids.max': '64' }, keep: true });
  // The limits bite: a fork bomb stops at pids.max, an allocation past
  // memory.max is OOM-killed inside the cgroup and nowhere else.
  log(
    'cgroup.session.limits',
    await leafRoot(`cg=${CG}/dh-probe-limits; mkdir $cg && echo 32 > $cg/pids.max && echo 128M > $cg/memory.max && echo 0 > $cg/memory.swap.max 2>/dev/null
echo "type: $(cat $cg/cgroup.type); controllers: $(cat $cg/cgroup.controllers); pids.max=$(cat $cg/pids.max); memory.max=$(cat $cg/memory.max)"
bash -c "echo \\$\\$ > $cg/cgroup.procs; for i in \\$(seq 100); do sleep 30 & done 2>/dev/null; echo forked=\\$(jobs -p | wc -l)"; echo "pids.events: $(cat $cg/pids.events | tr "\\n" " ")"; pkill -f "^sleep 30$"; sleep 0.5
bash -c "echo \\$\\$ > $cg/cgroup.procs; exec python3 -c 'b = bytearray(300 * 1024 * 1024); print(len(b))'" 2>&1 | tail -1
echo "memory.events: $(grep oom $cg/memory.events | tr "\\n" " ")"; echo "initOomKill: $(grep oom_kill ${CG}/init/memory.events 2>/dev/null)"
rmdir $cg && echo rmdir-ok`)
  );
  // The platform after the move: a new command and where it lands, its
  // agent, the port ingress to the listener started before, and a new one.
  log('afterEvacuate.runCommand', await sh(leaf, 'echo ok; cat /proc/self/cgroup'));
  log('afterEvacuate.sudoRunCommand', (await leafRoot('cat /proc/self/cgroup')).out);
  log('afterEvacuate.agent23456', (await leafRoot('curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:23456/')).out);
  log('afterEvacuate.ingressOldListener', { status: await fetch(`${leafUrl}/health`, { cache: 'no-store' }).then((r) => r.status, () => 0) });
  await leafRoot('pkill -f "bun /tmp/echo-server.js"; true');
  log('afterEvacuate.ingressNewListener', { url: (await startEchoServer(leaf, 3000).then(() => 'served', (err) => String(err.message))) });
});
