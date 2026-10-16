// P0.10 and P0.16 for Claude Code (docs/workspaces.md §5.5, §11.2): in a VM
// booted from the base, the pinned `claude` runs as `agent` under its own
// sandbox (the Agent SDK's `sandbox` settings, here through `--settings`),
// against a scripted model inside the VM (`vm-model.mjs`) whose replies are
// Bash commands. What each command saw comes back as its tool result, which
// the model writes to a file only root reads; the probe prints only counts
// and short excerpts, never a value. The CLI's key is a placeholder made up
// for the probe.
//
// Variants: the sandbox with the credentials deny and the read carve-outs
// (what A5 ships), and no sandbox (the fallback when the self-test fails).
//
//   node sandbox-in-vm.ts            (from a directory linked to the project, probes/lib.ts)
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { readFileSync } from 'node:fs';
import { CLAUDE_CLI, devRelayArtifact, prepareBase } from '../../src/base.ts';
import { BASE, created, log, probe, probeName, sh, sleep, TAGS, timed, track } from '../lib.ts';

const P = 'dhm_PLACEHOLDERPROBE0123456789';
const S = '/var/lib/dh/s';
const COMMANDS = [
  `id -un; echo "env-has-P=$(env | grep -c PLACEHOLDERPROBE)"; echo "pid=$$ ppid=$PPID"; echo "proxy=[$HTTP_PROXY] [$HTTPS_PROXY]"`,
  `c=0; for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -q PLACEHOLDERPROBE && c=$((c+1)); done; echo "procs-with-P=$c"; echo "procs-visible=$(ls /proc | grep -c '^[0-9]')"`,
  `ls ${S}/config 2>&1 | head -3; echo "config-read=$(cat ${S}/config/.claude.json 2>/dev/null | wc -c)"`,
  `echo w > /workspace/w.txt && echo "ws=$(cat /workspace/w.txt)"; echo t > "$TMPDIR/t.txt" && echo "tmp=$(cat "$TMPDIR/t.txt")"; echo h > "$HOME/h.txt" && echo "home=$(cat "$HOME/h.txt")"; echo x > /opt/x 2>&1 | head -1`,
  `curl -s -m 5 -o /dev/null -w 'model-port=%{http_code}\\n' -X POST -d '{}' http://127.0.0.1:4200/v1/messages; curl -s -m 5 -o /dev/null -w 'model-port-noproxy=%{http_code}\\n' --noproxy '*' -X POST -d '{}' http://127.0.0.1:4200/v1/messages; curl -s -m 8 -o /dev/null -w 'example=%{http_code}\\n' https://example.com; curl -s -m 8 -o /dev/null -w 'npm=%{http_code}\\n' https://registry.npmjs.org/`,
  `ps -eo pid,user,comm 2>&1 | head -12; echo "pid1=$(cat /proc/1/comm)"`,
  `echo done`,
];

const settings = (sandbox: Record<string, unknown> | undefined) => JSON.stringify(sandbox ? { sandbox } : {});
const SANDBOX = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  filesystem: { allowWrite: ['/workspace', `${S}/tmp`, `${S}/home`, `${S}/cache`], denyRead: [S], allowRead: [`${S}/tmp`, `${S}/home`, `${S}/cache`] },
  credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] },
  network: { allowedDomains: ['*'], deniedDomains: ['localhost', '127.0.0.1', '::1'] },
};

await probe(async () => {
  const relay = await devRelayArtifact();
  const builder = track('sandbox', probeName('a5base'));
  const base = await timed('base', () => prepareBase({ region: 'iad1', relay, name: builder, tags: TAGS }));
  created.snapshots.add(base.snapshotId);
  log('base.report', base.report ?? '');
  const sb = await timed('create', () => Sandbox.create({ ...BASE, name: track('sandbox', probeName('a5cc')), source: { type: 'snapshot', snapshotId: base.snapshotId } }));
  const root = (s: string) => sh(sb, s, { sudo: true, tail: 6000 });
  log('deps', (await root('for b in bwrap socat rg node curl; do printf "%s=%s " $b "$(command -v $b || echo missing)"; done; echo; bwrap --version')).out);
  // The platform masks /proc/kcore and /proc/keys with /dev/null, which keeps an unprivileged bwrap from mounting a fresh /proc; the relay unmasks them at start (both root-only or per-user anyway).
  log('unmask', (await root("for m in /proc/kcore /proc/keys; do awk -v m=$m '$5 == m && $4 == \"/null\"' /proc/self/mountinfo | grep -q . && umount $m && echo unmasked $m; done")).out);
  await sb.writeFiles([{ path: '/tmp/probe/vm-model.mjs', content: readFileSync(new URL('./vm-model.mjs', import.meta.url)) }]);
  for (const [label, sandbox] of [['sandboxed', SANDBOX], ['plain', undefined]] as const) {
    await sb.writeFiles([{ path: `/tmp/probe/settings-${label}.json`, content: Buffer.from(settings(sandbox)) }]);
    log(`${label}.setup`, (await root(`set -e; rm -rf ${S} /workspace; install -d -m 0755 -o root -g root ${S}; for d in home config tmp cache; do install -d -m 0700 -o agent -g agent ${S}/$d; done; install -d -m 0755 -o agent -g agent /workspace; rm -f /root/results-${label}.jsonl; echo ok`)).out);
    const port = label === 'sandboxed' ? 4200 : 4201;
    const commands = COMMANDS.map((c) => c.replaceAll('4200', String(port)));
    await sb.runCommand({ cmd: 'node', args: ['/tmp/probe/vm-model.mjs'], env: { PORT: String(port), RESULTS: `/root/results-${label}.jsonl`, COMMANDS: JSON.stringify(commands) }, sudo: true, detached: true });
    await sleep(800);
    const env = [`PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=${S}/home`, `TMPDIR=${S}/tmp`, `CLAUDE_CONFIG_DIR=${S}/config`, `XDG_CACHE_HOME=${S}/cache`, `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`, `ANTHROPIC_AUTH_TOKEN=${P}`, 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'];
    const cli = `${CLAUDE_CLI.dir}/${CLAUDE_CLI.bin}`;
    const run = await root(
      `cd /workspace && timeout 120 setpriv --reuid agent --regid agent --clear-groups --inh-caps=-all --no-new-privs env -i ${env.join(' ')} ${cli} -p go --output-format stream-json --verbose --model claude-sonnet-4-5 --permission-mode dontAsk --allowedTools Bash --settings /tmp/probe/settings-${label}.json > /tmp/probe/cli-${label}.out 2> /tmp/probe/cli-${label}.err; echo "exit=$?"; tail -c 600 /tmp/probe/cli-${label}.err; grep -o '"subtype":"[a-z_]*"' /tmp/probe/cli-${label}.out | sort | uniq -c`
    );
    log(`${label}.cli`, run.out);
    const results = (await root(`cat /root/results-${label}.jsonl 2>/dev/null`)).out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; content?: string; url?: string });
    log(`${label}.requests`, results.filter((r) => r.kind === 'request').map((r) => r.url));
    for (const [i, r] of results.filter((r) => r.kind === 'result').entries()) log(`${label}.result.${i + 1}`, String(r.content).replaceAll(P, '<P>').replace(/<system-reminder>[^]*$/, '').slice(0, 700));
  }
  void Snapshot;
});
