/**
 * The gated live lifecycle test (docs/workspaces.md §11.4 A3, decision 7), on
 * the platform through the real session factory and `@vercel/sandbox`:
 *
 * - the base recipe builds a snapshot (the relay, the pinned CLIs sha512-checked,
 *   the agent user) in a named builder sandbox;
 * - an attach creates the Drive and a VM from that snapshot, arms the relay with
 *   the fence (privileged tier, cgroup on: the factory refuses anything else),
 *   runs a command as `agent`, relays a model call through the tunnel to the
 *   Function's `gatewayHandler` (Claude's table, pointed at a local stand-in
 *   for the Gateway, which reports a cost the ledger records) from a spawn
 *   that claims isolated commands (a dumpable one that doesn't gets 403),
 *   writes a file on `/workspace` and flushes it;
 * - Codex's binary is execute-only: app-server, as the agent, is not
 *   dumpable (its environ, fds and `pidfd_getfd` refused to the agent's
 *   commands), and `codex sandbox` still confines a write;
 * - as root, through the control plane, it reads every process's environment
 *   and argv, the relay's config and the cache and temp dirs, and finds none
 *   of the Function's secrets there (only booleans are printed, never what
 *   was read);
 * - a warm attach with a higher fence reuses the VM: armed first, then its
 *   policy re-applied with the `dh-fence` watermark raised (the app's tags
 *   kept) and its timeout extended, the extension counted;
 * - the VM is deleted (the Drive stays), and a third attach boots a **new** VM
 *   on the same Drive, where the file is still there.
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * project (`probes/lib.ts`; the SDK's development token comes from `vercel
 * link`): every sandbox and Drive is named `dh-probe-a3*` and tagged, so
 * `probes/sweep.ts` finds what a killed run left, and `afterAll` deletes them
 * (the builder with its snapshot). No secret is printed or committed.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_ROUTES, gatewayCredential, gatewayHandler, type SessionMachine } from 'harness-world-process';
import { CODEX_CLI, cliPath, devRelayArtifact, prepareBase } from '../src/base.ts';
import { sandboxSession } from '../src/session.ts';
import { cleanup, created, probeName, TAGS, track } from '../probes/lib.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const SESSION = 'wrun_live_a3';

beforeAll(() => {
  // The test seam (the names) is guarded like the stand-in.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
});

// A Drive can be deleted only once it detached (6-20 s after its VM went, P0.5): the cleanup retries for longer than a hook's default.
afterAll(async () => {
  if (LIVE) expect(await cleanup()).toEqual([]);
}, 180_000);

async function run(machine: SessionMachine, script: string): Promise<string> {
  const proc = await machine.spawn({ command: 'bash', args: ['-c', script] });
  let out = '';
  for await (const l of proc.lines()) out += `${l}\n`;
  await proc.exited;
  return out.trim();
}

/** A stand-in for the AI Gateway on this machine: answers `/v1/messages` with a short stream and the Gateway's cost (P0.18). */
async function gatewayStub(): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    seen.push(`${req.method} ${req.url} ${req.headers.authorization === 'Bearer live-stub-credential-0123456789' ? 'credential' : 'no-credential'}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi-from-the-gateway"}}\n\n');
    res.end('event: message_delta\ndata: {"type":"message_delta","provider_metadata":{"gateway":{"cost":"0.001","gatewayCost":"0.00105"}}}\n\n');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))) };
}

describe.runIf(LIVE)('live: the session lifecycle on Vercel Sandbox', () => {
  it(
    'attach, run as agent, relay a model call, tear the VM down, attach again on a new VM with the same Drive: the file is still there',
    async () => {
      const t0 = Date.now();
      const relay = await devRelayArtifact();
      const builder = track('sandbox', probeName('a3base'));
      const base = await prepareBase({ region: 'iad1', relay, name: builder, tags: TAGS, log: (m, f) => console.log(`[live] ${m}`, f ?? '') });
      created.snapshots.add(base.snapshotId);
      expect(base.built).toBe(true);
      console.log('[live] base', { ms: Date.now() - t0, report: base.report });

      const name = probeName('a3vm');
      track('sandbox', name);
      track('drive', name);
      const logs: string[] = [];
      const acquire = sandboxSession({
        spec: { image: { snapshot: base.snapshotId }, vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 1024 ** 3, budget: { vmSeconds: 3600 } },
        tags: TAGS,
        log: (m) => logs.push(m),
        // The names (the model port checks the attach's key and the caller's pid: the factory requires it).
        test: { name: () => name },
      });
      const stub = await gatewayStub();
      const charges: number[] = [];
      const model = gatewayHandler({
        routes: CLAUDE_ROUTES,
        models: { model: 'anthropic/claude-haiku-4.5' },
        budget: { turnUsd: 1, sessionUsd: 1 },
        ledger: { spent: () => ({ turnUsd: 0, sessionUsd: 0 }), add: (usd) => void charges.push(usd) },
        target: stub.url,
        credential: async () => 'live-stub-credential-0123456789',
        log: () => {},
      });
      let record: Record<string, unknown> | undefined;
      const store = { read: () => record, write: (r: Record<string, unknown>) => void (record = r) };

      // 1. The first attach: a Drive, a VM from the base, the relay armed with fence 1.
      const t1 = Date.now();
      const first = new AbortController();
      const m1 = await acquire({ sessionId: SESSION, fence: () => ({ count: 1, fenced: true }), signal: first.signal, record: store, model });
      console.log('[live] first attach', { ms: Date.now() - t1 });
      expect(await run(m1, 'id -un')).toBe('agent');
      const body = JSON.stringify({ model: 'anthropic/claude-haiku-4.5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      // As the CLI does: the attach's model key as its bearer, from a process the attach spawned.
      const call = `fetch('${m1.modelUrl}/v1/messages?beta=true',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN},body:process.argv[1]}).then(r=>r.text().then(t=>console.log(r.status, /hi-from-the-gateway/.test(t))))`;
      const say = async (proc: Awaited<ReturnType<SessionMachine['spawn']>>) => {
        let said = '';
        for await (const l of proc.lines()) said += l;
        await proc.exited;
        return said;
      };
      // A process the agent can trace (node is dumpable), spawned without the claim that its commands are isolated: 403 (a command beside it could read its key or take its socket).
      expect(await say(await m1.spawn({ command: 'node', args: ['-e', call, body], env: { ANTHROPIC_AUTH_TOKEN: m1.modelKey } }))).toBe('403 false');
      // With the claim (Claude Code under its own sandbox does): through.
      expect(await say(await m1.spawn({ command: 'node', args: ['-e', call, body], env: { ANTHROPIC_AUTH_TOKEN: m1.modelKey }, isolatedCommands: true }))).toBe('200 true');
      // The same key from a process the attach didn't spawn (a root command through the control plane): 403; no key: 401.
      {
        const { Sandbox: Sdk } = await import('@vercel/sandbox');
        const probe = async (auth: string) => {
          const r = await (await Sdk.get({ name })).runCommand({ cmd: 'curl', args: ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'content-type: application/json', ...(auth ? ['-H', `authorization: Bearer ${auth}`] : []), '--data', body, `${m1.modelUrl}/v1/messages?beta=true`] });
          return (await r.stdout()).trim();
        };
        expect(await probe(m1.modelKey)).toBe('403');
        expect(await probe('')).toBe('401');
      }
      // Codex's binary is execute-only: app-server is not dumpable, so the agent's commands can't read its environ, list its fds,
      // or take its socket with pidfd_getfd (the relay's peer check holds for it without the claim). Its sandbox helper (a re-exec of
      // /proc/self/exe) still runs: a command under `codex sandbox` in workspace-write can't write outside its roots.
      {
        const codexBin = cliPath(CODEX_CLI);
        expect(await run(m1, `stat -c '%a %U' ${codexBin}; head -c1 ${codexBin} >/dev/null 2>&1 && echo readable || echo unreadable`)).toBe('711 root\nunreadable');
        const app = await m1.spawn({ command: codexBin, args: ['app-server', '--stdio'], env: { HARNESS_CODEX_GATEWAY_KEY: m1.modelKey, HOME: m1.dirs.home, CODEX_HOME: m1.dirs['codex-home'] } });
        const reach = await run(
          m1,
          [
            'sleep 1; P=$(pgrep -x codex | head -1); echo "pid=${P:+yes}"',
            // The files under /proc/<pid> are root's (the directory keeps the process's uid).
            'stat -c "owner=%u" /proc/$P/environ',
            'cat /proc/$P/environ >/dev/null 2>&1 && echo environ=read || echo environ=denied',
            'ls /proc/$P/fd >/dev/null 2>&1 && echo fd=read || echo fd=denied',
            `command -v python3 >/dev/null && python3 -c 'import os,ctypes,sys;fd=os.pidfd_open(int(sys.argv[1]));l=ctypes.CDLL(None,use_errno=True);r=l.syscall(438,fd,0,0);print("getfd=ok" if r>=0 else "getfd=denied")' $P || echo getfd=no-python`,
          ].join('; ')
        );
        console.log('[live] codex app-server reach', reach.replace(/\n/g, ' '));
        expect(reach).toMatch(/pid=yes\nowner=0\nenviron=denied\nfd=denied\ngetfd=(denied|no-python)/);
        app.kill('SIGKILL');
        await app.exited;
        // The agent may write there itself: the sandbox is what stops the command.
        expect(await run(m1, `touch ${m1.dirs.home}/dh-writable && echo writable`)).toBe('writable');
        const confined = await run(m1, `CODEX_HOME=$(mktemp -d) ${codexBin} sandbox -c sandbox_mode='"workspace-write"' -- sh -c 'echo sandboxed; touch ${m1.dirs.home}/dh-escape 2>/dev/null && echo escaped || echo confined' 2>&1 | tail -3`);
        console.log('[live] codex sandbox', confined.replace(/\n/g, ' '));
        expect(confined).toMatch(/sandboxed[\s\S]*confined/);
        expect(await run(m1, `test -e ${m1.dirs.home}/dh-escape && echo there || echo absent`)).toBe('absent');
      }
      // Through the relay, the tunnel and the handler: the table's path, the Function's credential added there (never in the VM), the cost recorded.
      expect(stub.seen).toEqual(['POST /v1/messages?beta=true credential']); // the refused calls never left the VM
      expect(charges).toEqual([0.00105]);
      await stub.close();

      // Nothing of the Function's reached the VM: every process's environment and argv, the relay's config, the cache and temp dirs.
      // The Function's own Gateway credential (AI_GATEWAY_API_KEY, else the OIDC token the Sandbox API calls use too).
      const secrets = [
        'live-stub-credential-0123456789',
        await gatewayCredential().catch(() => ''),
        ...Object.entries(process.env)
          .filter(([k, v]) => /TOKEN|KEY|SECRET|PASSWORD|OIDC/i.test(k) && typeof v === 'string' && v.length >= 16)
          .map(([, v]) => v as string),
      ].filter(Boolean);
      const { Sandbox: Sdk } = await import('@vercel/sandbox');
      const dump = await (await Sdk.get({ name })).runCommand({
        cmd: 'bash',
        args: ['-c', 'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f"; done 2>/dev/null; ps -eo args; cat /opt/dh/relay.json; ls -la /tmp /var/lib/dh /var/lib/dh/s /run/dh 2>&1; grep -rIl . /var/lib/dh/s 2>/dev/null | head -50 | xargs -r cat 2>/dev/null'],
        sudo: true,
      });
      const seenInVm = `${await dump.stdout()}${await dump.stderr()}`;
      console.log('[live] secrets checked', { count: secrets.length, dumpBytes: seenInVm.length, found: secrets.map((v) => seenInVm.includes(v)) });
      expect(seenInVm.length).toBeGreaterThan(1000);
      expect(secrets.some((v) => seenInVm.includes(v))).toBe(false);
      expect(await run(m1, 'echo "durable across VMs" > /workspace/note.txt && stat -c %U /workspace /workspace/note.txt')).toBe('agent\nagent');
      await m1.fsync();
      expect(await run(m1, '/opt/dh/claude/2.1.296/claude --version; /opt/dh/codex/0.160.0/vendor/x86_64-unknown-linux-musl/bin/codex --version; command -v rg')).toMatch(/2\.1\.296[\s\S]*0\.160\.0[\s\S]*rg/);
      expect(record).toMatchObject({ sandboxName: name, driveName: name, region: 'iad1', versions: { claude: '2.1.296', codex: '0.160.0' } });
      const driveId = record!.driveId;
      const { Sandbox } = await import('@vercel/sandbox');
      const vm1 = (await Sandbox.get({ name })).currentSession().sessionId;
      // The fence watermark the factory reads before it arms, rotates or replaces a VM: set at create, the app's tags kept.
      expect((await Sandbox.get({ name })).tags).toEqual({ ...TAGS, 'dh-fence': '1' });
      await m1.close();

      // 2. A warm attach on the same VM, a higher fence, a later deadline: armed first, then the policy re-applied with the watermark raised, and the timeout extended (and counted).
      const granted = record!.vmSeconds as number;
      const tw = Date.now();
      const warm = await acquire({ sessionId: SESSION, fence: () => ({ count: 2, fenced: true }), signal: new AbortController().signal, record: store, deadline: Date.now() + 900_000 });
      console.log('[live] warm attach', { ms: Date.now() - tw });
      const again = await Sandbox.get({ name });
      expect(again.currentSession().sessionId).toBe(vm1);
      expect(again.tags).toEqual({ ...TAGS, 'dh-fence': '2' });
      expect(record!.vmSeconds as number).toBeGreaterThan(granted);
      expect(await run(warm, 'cat /workspace/note.txt')).toBe('durable across VMs');
      await warm.close();

      // 3. Tear the VM down; the Drive stays.
      await (await Sandbox.get({ name })).delete();

      // 4. A new invocation, a higher fence: a new VM on the same Drive (retrying while it detaches), and the file is there.
      const t2 = Date.now();
      const m2 = await acquire({ sessionId: SESSION, fence: () => ({ count: 3, fenced: true }), signal: new AbortController().signal, record: store });
      console.log('[live] second attach', { ms: Date.now() - t2 });
      const vm2 = (await Sandbox.get({ name })).currentSession().sessionId;
      expect(vm2).not.toBe(vm1);
      expect((await Sandbox.get({ name })).tags).toEqual({ ...TAGS, 'dh-fence': '3' });
      expect(await run(m2, 'cat /workspace/note.txt')).toBe('durable across VMs');
      expect(m2.notes).toEqual([]);
      expect(record!.driveId).toBe(driveId);
      await m2.close();
      console.log('[live] logs', logs);
      expect([...created.sandboxes]).toContain(name);
    },
    20 * 60_000
  );
});
