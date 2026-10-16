/**
 * The gated live relay test (docs/workspaces.md §11.4 A2), in a real Vercel
 * Sandbox VM, driven from this machine through the port ingress:
 *
 * - a non-root listener on the relay's port keeps `arm` from starting it;
 * - `arm` alone starts the relay from the bundle (no hand-started `serve`),
 *   as root, in the privileged tier with the cgroup leaf;
 * - commands run as `agent` with only the relay's env; `agent` owns its cache
 *   dirs after `WIPE` and `FILES`; a symlink to `/opt/dh` gets EACCES; a tail
 *   of a symlink is refused;
 * - an abrupt drop (the TCP socket destroyed, no close frame) cgroup-kills a
 *   setsid'd grandchild, and a same-fence re-arm is admitted after it;
 * - a link that goes silent (its socket stops reading) is killed by the
 *   relay's heartbeat within the 15 s window.
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * scratch project, like the probes (`probes/lib.ts`): the sandbox is named
 * `dh-probe-a2relay-*` and tagged, so `probes/sweep.ts` finds it if this run is
 * killed; it is deleted in `afterAll`. No secret is printed or committed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { Sandbox } from '@vercel/sandbox';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import type { CacheDir } from 'harness-world-process';
import type { WsRequestHandler } from 'harness-world-remote/ws';
import { buildRelayBundle } from '../src/relay/bundle.ts';
import { armArgs, armRequest } from '../src/relay/arm.ts';
import { dialRelay, type RelayLink, type RelaySocket } from '../src/relay/dial.ts';
import { tokenHash } from '../src/relay/protocol.ts';
import type { ArmReply, RelayConfig } from '../src/relay/relay.ts';
import { sessionMachine } from '../src/machine.ts';
import { BASE, cleanup, probeName, track } from '../probes/lib.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const PORT = 2010;
const SESSION = 'live';
let sandbox: Sandbox | undefined;

afterAll(async () => {
  if (LIVE) await cleanup();
});

describe.runIf(LIVE)('live relay in a Vercel Sandbox VM', () => {
  it(
    'arm starts the relay as root, commands run as agent, and a lost link (abrupt or silent) cgroup-kills the session',
    async () => {
      const bundle = await buildRelayBundle();
      const name = track('sandbox', probeName('a2relay'));
      sandbox = await Sandbox.create({ ...BASE, name, timeout: 8 * 60_000, ports: [PORT] });
      const sb = sandbox;
      const sh = async (script: string, sudo = true) => {
        const c = await sb.runCommand({ cmd: 'bash', args: ['-c', script], sudo });
        return { exit: c.exitCode, out: (await c.stdout()).trim() };
      };

      const config: RelayConfig = {
        port: PORT,
        modelPort: 4100,
        stateDir: '/run/dh',
        workspace: '/workspace',
        cacheRoot: '/var/lib/dh/s',
        runAs: 'agent',
        cgroup: true,
        relayVersion: bundle.version.slice(0, 16),
        cliVersions: {},
      };
      await sb.writeFiles([
        { path: '/tmp/relay.mjs', content: readFileSync(bundle.path) },
        { path: '/tmp/relay.json', content: Buffer.from(JSON.stringify(config)) },
      ]);
      // Install root-owned under /opt/dh (A3's recipe does this in the base image); /workspace is the agent's (A3's first-mount chown).
      const setup = await sh(
        'id -u agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent; ' +
          'install -d -m 0755 -o root -g root /opt/dh && install -m 0644 -o root -g root /tmp/relay.mjs /opt/dh/relay.mjs && install -m 0644 -o root -g root /tmp/relay.json /opt/dh/relay.json; ' +
          'mkdir -p /workspace && chown agent:agent /workspace; echo ok'
      );
      expect(setup.out).toContain('ok');

      const arm = async (token: string): Promise<ArmReply | undefined> => {
        const c = await sb.runCommand({ cmd: 'node', args: ['/opt/dh/relay.mjs', 'arm', '/opt/dh/relay.json', ...armArgs(armRequest(tokenHash(token), SESSION, { count: 1, fenced: true }))], sudo: true });
        const out = (await c.stdout()).trim().split('\n').at(-1);
        if (out?.startsWith('{')) return JSON.parse(out) as ArmReply;
        // Say why: the arm's error, and what `serve` prints when started by hand.
        const why = await sh('timeout 3 node /opt/dh/relay.mjs serve /opt/dh/relay.json 2>&1 | tail -5; ss -ltnp | grep -E ":(2010|4100) " || true');
        throw new Error(`arm printed no reply: ${(await c.stderr()).slice(0, 400)} | ${why.out.slice(0, 800)}`);
      };

      // 1. A model-run listener holding PORT while the relay is down: arm can't start a relay, and says so.
      await sb.runCommand({ cmd: 'bash', args: ['-c', `setpriv --reuid agent --regid agent --clear-groups --inh-caps=-all --no-new-privs node -e "require('net').createServer().listen(${PORT})"`], sudo: true, detached: true });
      await new Promise((r) => setTimeout(r, 1500));
      const blocked = await sb.runCommand({ cmd: 'node', args: ['/opt/dh/relay.mjs', 'arm', '/opt/dh/relay.json', ...armArgs(armRequest(tokenHash(randomBytes(32).toString('base64url')), SESSION, { count: 1, fenced: true }))], sudo: true });
      expect(blocked.exitCode).not.toBe(0);
      expect(await blocked.stderr()).toContain('did not come up');
      await sh('pkill -9 -u agent || true');
      await new Promise((r) => setTimeout(r, 500));

      // 2. arm alone starts the relay from the bundle.
      const token = randomBytes(32).toString('base64url');
      const reply = await arm(token);
      if (!reply?.ok) throw new Error(`arm failed: ${JSON.stringify(reply)}`);
      expect(reply).toMatchObject({ tier: 'privileged', cgroup: true, sessionId: SESSION });
      expect(reply.platformGuard).toBeTypeOf('boolean');
      expect((await sh('stat -c %U:%a /run/dh /run/dh/control.sock /run/dh/fence.json')).out.split('\n')).toEqual(['root:700', 'root:600', 'root:600']);
      expect((await sh('cat /proc/$(pgrep -f "relay[.]mjs serve" | head -1)/oom_score_adj')).out).toBe('-1000');

      const wssBase = sb.domain(PORT).replace(/^http/, 'ws').replace(/\/+$/, '');
      const model: WsRequestHandler = async (req) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: oneChunk(`model:${req.path}`) });
      const sockets: WebSocket[] = [];
      const dial = (t: string, R: string): Promise<RelayLink> =>
        dialRelay({
          ctlUrl: `${wssBase}/ctl`,
          modelUrl: `${wssBase}/model`,
          token: t,
          nonce: R,
          model,
          openSocket: (url, bearer) => {
            const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` }, maxPayload: 1 << 20, perMessageDeflate: false });
            sockets.push(ws);
            return ws as unknown as RelaySocket;
          },
        });
      const link = await dial(token, reply.R);
      const dirs = Object.fromEntries((['home', 'config', 'codex-home', 'tmp', 'cache'] as const).map((d) => [d, `/var/lib/dh/s/${d}`])) as Record<CacheDir, string>;
      const machine = sessionMachine({ link, sessionId: SESSION, fence: { count: 1, fenced: true }, root: '/workspace', dirs, modelUrl: 'http://127.0.0.1:4100', modelKey: 'dhm-live-test-model-key-0001' });
      const run = async (script: string) => {
        const p = await machine.spawn({ command: 'bash', args: ['-c', script] });
        let out = '';
        for await (const l of p.lines()) out += `${l}\n`;
        await p.exited;
        return out.trim();
      };

      // 3. As agent, with only the relay's env; the model port answers through the tunnel.
      expect(await run('id -un')).toBe('agent');
      const allowed = new Set(['HOME', 'PATH', 'PWD', 'SHLVL', 'TMPDIR', '_']);
      const names = (await run('env | cut -d= -f1')).split('\n');
      expect(names.filter((n) => !allowed.has(n))).toEqual([]);
      expect(await run(`node -e "fetch('http://127.0.0.1:4100/v1/messages',{method:'POST',body:'x'}).then(r=>r.text()).then(t=>console.log(t))"`)).toBe('model:/v1/messages');

      // 4. The agent owns its cache dirs after WIPE and after FILES; /opt/dh stays root's; a tail of a symlink is refused.
      await machine.files.wipe();
      await machine.files.upload('config', [{ path: 'projects/a.jsonl', bytes: new TextEncoder().encode('{}\n') }]);
      expect(await run('stat -c %U:%a /var/lib/dh/s/home /var/lib/dh/s/config /var/lib/dh/s/config/projects/a.jsonl; touch /var/lib/dh/s/home/w /var/lib/dh/s/tmp/w && echo wrote')).toBe('agent:700\nagent:700\nagent:600\nwrote');
      expect(await run('ln -s /opt/dh/relay.mjs /workspace/x; echo pwn >> /workspace/x 2>&1 || echo refused')).toContain('refused');
      expect(await run('ln -s /etc/shadow /var/lib/dh/s/codex-home/rollout.jsonl && echo linked')).toBe('linked');
      const t = await machine.tail('codex-home', 'rollout.jsonl');
      await expect(t.sync()).rejects.toThrow(/symlink/);

      // 5. An abrupt drop: destroy the TCP sockets (no close frame). The relay cgroup-kills a setsid'd grandchild.
      const gp = await machine.spawn({ command: 'bash', args: ['-c', 'setsid sleep 300 >/dev/null 2>&1 & echo $!; sleep 300'] });
      const grandchild = Number((await gp.lines()[Symbol.asyncIterator]().next()).value);
      expect(grandchild).toBeGreaterThan(0);
      for (const ws of sockets.splice(0)) (ws as unknown as { _socket: Socket })._socket.destroy();
      expect(await gone(sh, grandchild, 25)).toBe(true);
      expect(link.isLost()).toBe(true);

      // 6. Same fence after the loss: admitted. Then a silent link (its sockets stop reading): the relay's heartbeat kills the session.
      const token2 = randomBytes(32).toString('base64url');
      const again = await arm(token2);
      if (!again?.ok) throw new Error(`re-arm failed: ${JSON.stringify(again)}`);
      const link2 = await dial(token2, again.R);
      const m2 = sessionMachine({ link: link2, sessionId: SESSION, fence: { count: 1, fenced: true }, root: '/workspace', dirs, modelUrl: 'http://127.0.0.1:4100', modelKey: 'dhm-live-test-model-key-0001' });
      const sleeper = await m2.spawn({ command: 'bash', args: ['-c', 'echo $$; sleep 300'] });
      const pid = Number((await sleeper.lines()[Symbol.asyncIterator]().next()).value);
      for (const ws of sockets.splice(0)) (ws as unknown as { _socket: Socket })._socket.pause();
      const t0 = Date.now();
      expect(await gone(sh, pid, 30)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(30_000);
      link2.close();
    },
    8 * 60_000
  );
});

/** Poll as root until `pid` is gone (true) or `seconds` pass (false). */
async function gone(sh: (s: string) => Promise<{ out: string }>, pid: number, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).out.includes('gone')) return true;
  }
  return false;
}

function oneChunk(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  };
}
