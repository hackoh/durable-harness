/**
 * The gated live run of `RemoteMachine` (docs/workspaces.md §11.4 A4), in a
 * real Vercel Sandbox VM, driven from this machine through the port ingress:
 *
 * - the shared `WorkspaceMachine` cases (`machine-cases.ts`), the same ones the
 *   in-memory machine and the stand-in pass, on the VM's `/workspace` through
 *   the relay's helper;
 * - the helper and its commands run as `agent`, in the session cgroup's `env`
 *   leaf, with only the relay's allowlist as their environment, and don't see
 *   the CLIs' state dirs (`codex-home`, `config`);
 * - a cancelled command is dead when its call settles, and a helper killed
 *   outright takes its commands with it (its leaf) before the call's `EINTR`;
 * - uid separation is the guard on paths: a model-made symlink to the relay
 *   under `/opt/dh` is followed, and the write gets `EACCES`;
 * - `FSYNC` (`sync -f /workspace`) answers, and a lost link cgroup-kills a
 *   command the helper started.
 *
 * Gated behind `DH_LIVE_SANDBOX=1`. Run it from a directory linked to the
 * scratch project, like the probes (`probes/lib.ts`): the sandbox is named
 * `dh-probe-a4env-*` and tagged, so `probes/sweep.ts` finds it if this run is
 * killed; it is deleted in `afterAll`. It makes no Drive (`/workspace` is a
 * directory of the VM's own disk). No secret is printed or committed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CacheDir, SessionMachine } from 'harness-world-process';
import { buildRelayBundle } from '../src/relay/bundle.ts';
import { armArgs, armRequest } from '../src/relay/arm.ts';
import { dialRelay, type RelayLink, type RelaySocket } from '../src/relay/dial.ts';
import { tokenHash } from '../src/relay/protocol.ts';
import type { ArmReply, RelayConfig } from '../src/relay/relay.ts';
import { sessionMachine } from '../src/machine.ts';
import { BASE, cleanup, probeName, track } from '../probes/lib.ts';
import { codeOf, machineCases } from './machine-cases.ts';

const LIVE = process.env.DH_LIVE_SANDBOX === '1';
const PORT = 2010;
const SESSION = 'live-env';

let sandbox: Sandbox | undefined;
let link: RelayLink | undefined;
let machine: Omit<SessionMachine, 'brand'> | undefined;

/** As root in the VM. */
async function sh(script: string): Promise<{ exit: number | null; out: string }> {
  const c = await sandbox!.runCommand({ cmd: 'bash', args: ['-c', script], sudo: true });
  return { exit: c.exitCode, out: (await c.stdout()).trim() };
}

async function arm(token: string, fence = 1): Promise<ArmReply> {
  const c = await sandbox!.runCommand({ cmd: 'node', args: ['/opt/dh/relay.mjs', 'arm', '/opt/dh/relay.json', ...armArgs(armRequest(tokenHash(token), SESSION, { count: fence, fenced: true }))], sudo: true });
  const out = (await c.stdout()).trim().split('\n').at(-1);
  if (!out?.startsWith('{')) throw new Error(`arm printed no reply: ${(await c.stderr()).slice(0, 400)}`);
  return JSON.parse(out) as ArmReply;
}

const sockets: WebSocket[] = [];
async function attach(fence: number): Promise<{ link: RelayLink; machine: Omit<SessionMachine, 'brand'> }> {
  const token = randomBytes(32).toString('base64url');
  const reply = await arm(token, fence);
  if (!reply.ok) throw new Error(`arm failed: ${JSON.stringify(reply)}`);
  expect(reply).toMatchObject({ tier: 'privileged', cgroup: true });
  const wssBase = sandbox!.domain(PORT).replace(/^http/, 'ws').replace(/\/+$/, '');
  const l = await dialRelay({
    ctlUrl: `${wssBase}/ctl`,
    modelUrl: `${wssBase}/model`,
    token,
    nonce: reply.R,
    openSocket: (url, bearer) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` }, maxPayload: 1 << 20, perMessageDeflate: false });
      sockets.push(ws);
      return ws as unknown as RelaySocket;
    },
  });
  const dirs = Object.fromEntries((['home', 'config', 'codex-home', 'tmp', 'cache'] as const).map((d) => [d, `/var/lib/dh/s/${d}`])) as Record<CacheDir, string>;
  return { link: l, machine: sessionMachine({ link: l, sessionId: SESSION, fence: { count: fence, fenced: true }, root: '/workspace', dirs, modelUrl: 'http://127.0.0.1:4100', modelKey: 'dhm-live-test-model-key-0001' }) };
}

describe.runIf(LIVE)('RemoteMachine in a Vercel Sandbox VM', () => {
  beforeAll(async () => {
    const bundle = await buildRelayBundle();
    const name = track('sandbox', probeName('a4env'));
    sandbox = await Sandbox.create({ ...BASE, name, timeout: 10 * 60_000, ports: [PORT] });
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
    await sandbox.writeFiles([
      { path: '/tmp/relay.mjs', content: readFileSync(bundle.path) },
      { path: '/tmp/relay.json', content: Buffer.from(JSON.stringify(config)) },
    ]);
    // As A3's recipe will: the relay root-owned under /opt/dh, an `agent` user, /workspace the agent's (the first-mount chown).
    const setup = await sh(
      'id -u agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent; ' +
        'install -d -m 0755 -o root -g root /opt/dh && install -m 0644 -o root -g root /tmp/relay.mjs /opt/dh/relay.mjs && install -m 0644 -o root -g root /tmp/relay.json /opt/dh/relay.json; ' +
        'mkdir -p /workspace && chown agent:agent /workspace && chmod 0755 /workspace; echo ok'
    );
    expect(setup.out).toContain('ok');
    ({ link, machine } = await attach(1));
  }, 5 * 60_000);

  afterAll(async () => {
    try {
      link?.close();
    } catch {}
    await cleanup();
  }, 3 * 60_000);

  // Each case starts on an empty /workspace (the same machine, emptied by the agent itself).
  machineCases(
    'RemoteMachine, live',
    async () => {
      const ws = machine!.workspace;
      const r = await ws.exec('find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +');
      expect(r.exitCode).toBe(0);
      return { machine: ws, dispose: async () => {} };
    },
    { timeout: 120_000 }
  );

  it('the helper and its commands run as agent, in the session cgroup, with only the relay allowlist as their env', async () => {
    const ws = machine!.workspace;
    expect((await ws.exec('id -un')).stdout.trim()).toBe('agent');
    expect((await ws.exec('cat /proc/self/cgroup')).stdout).toContain('dh-session');
    const names = (await ws.exec('env | cut -d= -f1 | sort')).stdout.trim().split('\n');
    expect(names.filter((n) => !['HOME', 'OLDPWD', 'PATH', 'PWD', 'SHLVL', 'TMPDIR', '_'].includes(n))).toEqual([]);
    // The helper itself: the agent's, with no capabilities and no_new_privs.
    const status = (await ws.exec('cat /proc/$PPID/status')).stdout;
    expect(status).toMatch(/^CapEff:\s+0+$/m);
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
  }, 120_000);

  it('uid separation guards paths: a symlink to the root-owned relay is followed, and the write gets EACCES', async () => {
    const ws = machine!.workspace;
    await ws.symlink('/opt/dh/relay.mjs', '/workspace/x');
    expect(await ws.realpath('/workspace/x')).toBe('/opt/dh/relay.mjs');
    expect(await codeOf(ws.writeFile('/workspace/x', 'pwn'))).toBe('EACCES');
    expect(await codeOf(ws.chmod('/workspace/x', 0o777))).toBe('EPERM');
    expect(await codeOf(ws.writeFile('/opt/dh/new.mjs', 'pwn'))).toBe('EACCES');
    expect((await sh('stat -c %U:%a /opt/dh/relay.mjs; ls /opt/dh')).out).toBe('root:644\nrelay.json\nrelay.mjs');
  }, 120_000);

  it("the helper's commands are in its own leaf (dh-session/env), and the CLIs' state dirs are hidden from them", async () => {
    const ws = machine!.workspace;
    expect((await ws.exec('cat /proc/self/cgroup')).stdout).toContain('dh-session/env');
    expect((await sh('echo real > /var/lib/dh/s/codex-home/rollout.jsonl && chown agent:agent /var/lib/dh/s/codex-home/rollout.jsonl && echo ok')).out).toBe('ok');
    expect((await ws.exec('ls -A /var/lib/dh/s/codex-home /var/lib/dh/s/config')).stdout.trim().split('\n').filter((l) => l && !l.endsWith(':'))).toEqual([]);
    expect(await codeOf(ws.readFile('/var/lib/dh/s/codex-home/rollout.jsonl'))).toBe('ENOENT');
    expect(['EROFS', 'EACCES']).toContain(await codeOf(ws.writeFile('/var/lib/dh/s/codex-home/rollout.jsonl', 'forged', { append: true })));
    expect((await ws.exec('echo forged >> /var/lib/dh/s/codex-home/rollout.jsonl')).exitCode).not.toBe(0);
    expect((await sh('cat /var/lib/dh/s/codex-home/rollout.jsonl')).out).toBe('real');
    // HOME and TMPDIR stay the agent's to write.
    expect((await ws.exec('touch "$HOME/h" "$TMPDIR/t" && echo yes')).stdout.trim()).toBe('yes');
  }, 120_000);

  it("a cancelled command is dead when its call settles; a helper killed outright takes its commands with it before the call's EINTR", async () => {
    const ws = machine!.workspace;
    const controller = new AbortController();
    const cancelled = ws.exec('echo $$ > /workspace/cpid; exec sleep 300', { signal: controller.signal });
    let cpid = '';
    for (let i = 0; i < 50 && !cpid; i++) {
      await new Promise((r) => setTimeout(r, 200));
      cpid = (await sh('cat /workspace/cpid 2>/dev/null || true')).out;
    }
    controller.abort();
    expect(await codeOf(cancelled)).toBe('EINTR');
    expect((await sh(`kill -0 ${cpid} 2>/dev/null && echo alive || echo gone`)).out).toBe('gone');

    const run = ws.exec('echo $PPID > /workspace/helper; echo $$ > /workspace/pid; exec sleep 300');
    let pid = '';
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 200));
      pid = (await sh('cat /workspace/pid 2>/dev/null || true')).out;
    }
    expect((await sh('kill -9 "$(cat /workspace/helper)" && echo killed')).out).toBe('killed');
    const err = await run.catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: 'EINTR' });
    expect((err as Error).message).toMatch(/commands it started were killed/);
    expect((await sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).out).toBe('gone');
    expect((await ws.exec('echo again')).stdout).toBe('again\n');
  }, 180_000);

  it('FSYNC answers; a lost link cgroup-kills a command the helper started', async () => {
    const ws = machine!.workspace;
    await ws.writeFile('/workspace/flushed.txt', 'on the disk');
    await machine!.fsync();
    const run = ws.exec('echo $$ > /workspace/pid; exec sleep 300');
    let pid = '';
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 200));
      pid = (await sh('cat /workspace/pid 2>/dev/null || true')).out;
    }
    expect(pid).toMatch(/^\d+$/);
    link!.close();
    expect(await codeOf(run)).toBe('EINTR');
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 500));
      gone = (await sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).out === 'gone';
    }
    expect(gone).toBe(true);
    // The next attach (the old sockets are dead) gets a new helper.
    ({ link, machine } = await attach(1));
    expect((await machine.workspace.exec('cat /workspace/flushed.txt')).stdout).toBe('on the disk');
  }, 180_000);
});
