import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxProvider } from 'harness-world-hybrid';
import { afterEach, describe, expect, it } from 'vitest';
import { hostSecret, hostUrl, launchScript, startHost } from './start.ts';

describe('hostUrl', () => {
  it('keeps the scheme @vercel/sandbox domain() already returns (no https://https://)', () => {
    expect(hostUrl('https://sb-54d52gywkqqf.vercel.run')).toBe('https://sb-54d52gywkqqf.vercel.run');
    expect(hostUrl('https://sb-x.vercel.run/')).toBe('https://sb-x.vercel.run');
    expect(hostUrl('sb-x.vercel.run')).toBe('https://sb-x.vercel.run');
    expect(hostUrl('http://localhost:4199')).toBe('http://localhost:4199');
  });
});

// A stand-in daemon: answers /health from the host.env it was launched with.
const FAKE_DAEMON = `
import { closeSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const env = Object.fromEntries(readFileSync(process.argv[3], 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ bootId: env.HOST_BOOT_ID, version: env.HOST_VERSION, sessionId: env.HOST_SANDBOX_SESSION, vm: 'vm', pid: process.pid }));
}).listen(Number(env.HOST_PORT), '127.0.0.1', () => {
  // As daemon.ts does: let go of the launcher's start lock once listening.
  if (process.env.HOST_LOCK_FD) closeSync(Number(process.env.HOST_LOCK_FD));
});
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function health(port: number): Promise<{ bootId: string; pid: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return (await res.json()) as { bootId: string; pid: number };
  } catch {
    return undefined;
  }
}

async function waitHealth(port: number, bootId: string): Promise<{ bootId: string; pid: number }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const h = await health(port);
    if (h?.bootId === bootId) return h;
    if (Date.now() > deadline) throw new Error(`no daemon ${bootId} on ${port} (last: ${JSON.stringify(h)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const pids: number[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('launchScript (run through a real bash)', () => {
  async function stage(root: string, o: { bootId: string; version: string; session: string; port: number; bundle: boolean }) {
    const staging = join(root, `staging-${o.bootId}`);
    await mkdir(staging, { recursive: true });
    if (o.bundle) {
      await writeFile(join(staging, 'daemon.mjs'), FAKE_DAEMON);
      await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: o.version }));
    }
    await writeFile(
      join(staging, 'host.env'),
      `HOST_BOOT_ID=${o.bootId}\nHOST_VERSION=${o.version}\nHOST_SANDBOX_SESSION=${o.session}\nHOST_PORT=${o.port}\n`
    );
    const dir = join(root, 'opt-harness');
    const script = launchScript({ dir, staging, port: o.port, version: o.version, sandboxSession: o.session, runAs: 'nobody', node: process.execPath });
    await writeFile(join(staging, 'launch.sh'), script);
    return { staging, dir };
  }

  function launch(staging: string) {
    const child = spawn('bash', [join(staging, 'launch.sh')], { detached: true, stdio: 'ignore' });
    if (child.pid) pids.push(child.pid);
    return child;
  }

  it('starts the daemon instead of killing its own shell (the pkill -f self-match, exit 143)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hw-launch-'));
    dirs.push(root);
    const port = await freePort();
    const { staging } = await stage(root, { bootId: 'boot_a', version: 'v1', session: 's1', port, bundle: true });
    launch(staging);
    const h = await waitHealth(port, 'boot_a');
    // exec: the daemon is the launcher's pid, recorded in the pidfile.
    expect(Number(await readFile(join(root, 'opt-harness', 'daemon.pid'), 'utf8'))).toBe(h.pid);
  });

  it('the pkill pattern does not match the generated script inside bash -c either', () => {
    const script = launchScript({ dir: '/opt/harness', staging: '/tmp/st', port: 1, version: 'v', sandboxSession: 's', runAs: 'u' });
    const line = script.split('\n').find((l) => l.startsWith('pkill'))!;
    expect(line).toContain("'[/]opt/harness(-image)?/daemon[.]mjs'");
    // Run just that line the way the old installer did (`bash -c <script>`): it must survive.
    const r = spawnSync('bash', ['-c', `set -e; echo before; ${line}; echo after`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('before\nafter\n');
  });

  it('a second start of the same version on the same VM session reuses the running daemon, not pkill it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hw-launch-'));
    dirs.push(root);
    const port = await freePort();
    const a = await stage(root, { bootId: 'boot_a', version: 'v1', session: 's1', port, bundle: true });
    launch(a.staging);
    const first = await waitHealth(port, 'boot_a');
    pids.push(first.pid);
    const b = await stage(root, { bootId: 'boot_b', version: 'v1', session: 's1', port, bundle: false });
    const r = spawnSync('bash', [join(b.staging, 'launch.sh')], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reuse');
    expect((await health(port))?.bootId).toBe('boot_a');
  });

  it('a new version replaces the older daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hw-launch-'));
    dirs.push(root);
    const port = await freePort();
    const a = await stage(root, { bootId: 'boot_a', version: 'v1', session: 's1', port, bundle: true });
    launch(a.staging);
    const first = await waitHealth(port, 'boot_a');
    const b = await stage(root, { bootId: 'boot_b', version: 'v2', session: 's1', port, bundle: true });
    launch(b.staging);
    const second = await waitHealth(port, 'boot_b');
    pids.push(second.pid);
    expect(second.pid).not.toBe(first.pid);
    expect(() => process.kill(first.pid, 0)).toThrow();
  });
});

describe('startHost', () => {
  function fakeProvider(domain: string, commands: string[]) {
    const raw = {
      name: 'vm1',
      domain: () => domain,
      currentSession: () => ({ sessionId: 'sess1' }),
      writeFiles: async () => {},
      runCommand: async (p: { cmd: string; args?: string[] }) => {
        commands.push([p.cmd, ...(p.args ?? [])].join(' '));
        return { exitCode: 0, stdout: async () => '', stderr: async () => '' };
      },
    };
    return { kind: 'fake', open: async () => ({ raw }) } as unknown as SandboxProvider;
  }

  it('reuses a running daemon at the URL domain() returns, and pushes it a fresh token', async () => {
    const seen: string[] = [];
    const commands: string[] = [];
    const doFetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/health')) return Response.json({ bootId: 'boot_live', version: 'v1', sessionId: 'sess1', vm: 'vm1' });
      if (url.endsWith('/token')) {
        expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${hostSecret('k', 'vm1', 'boot_live')}`);
        expect(JSON.parse(String(init?.body))).toEqual({ token: 'fresh' });
        return Response.json({ tokenExp: 123 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const started = await startHost(fakeProvider('https://sb-abc.vercel.run', commands), 'wrun_1', {
      bundle: { version: 'v1', files: [] },
      env: { VERCEL_OIDC_TOKEN: 'fresh' },
      secretKey: 'k',
      fetch: doFetch,
    });
    expect(started.reused).toBe(true);
    expect(started.fact.url).toBe('https://sb-abc.vercel.run');
    expect(started.fact.url.match(/https?:\/\//g)).toHaveLength(1);
    expect(started.fact.bootId).toBe('boot_live');
    expect(seen).toEqual(['GET https://sb-abc.vercel.run/health', 'POST https://sb-abc.vercel.run/token']);
    expect(commands).toEqual([]);
  });

  it('when a concurrent starter wins the VM lock, uses its daemon instead of failing', async () => {
    const commands: string[] = [];
    let launched = false;
    const provider = fakeProvider('https://sb-abc.vercel.run', commands);
    const doFetch = (async (url: string) => {
      if (url.endsWith('/health')) {
        if (!launched) throw new Error('ECONNREFUSED');
        return Response.json({ bootId: 'boot_other', version: 'v1', sessionId: 'sess1', vm: 'vm1' });
      }
      return Response.json({});
    }) as typeof fetch;
    const raw = ((await provider.open('x')) as unknown as { raw: { runCommand: (p: { cmd: string; args?: string[] }) => Promise<unknown> } }).raw;
    const run = raw.runCommand;
    raw.runCommand = async (p) => {
      if (p.args?.[0]?.endsWith('launch.sh')) launched = true;
      return run(p);
    };
    const started = await startHost(provider, 'wrun_1', {
      bundle: { version: 'v1', files: [] },
      env: {},
      secretKey: 'k',
      fetch: doFetch,
      healthTimeoutMs: 2000,
    });
    expect(started).toMatchObject({ reused: true, fact: { bootId: 'boot_other', url: 'https://sb-abc.vercel.run' } });
    expect(commands.some((c) => /^bash \/tmp\/harness-host-boot_\w+\/launch\.sh$/.test(c))).toBe(true);
    expect(commands.some((c) => c.includes('pkill'))).toBe(false);
  });
});
