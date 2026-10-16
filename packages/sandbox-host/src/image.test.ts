import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxProvider } from 'harness-world-hybrid';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleVersion, DAEMON_PATTERN, dockerfile, hasImageFor, IMAGE_DIR, IMAGE_TAG_KEY, imageLaunchScript, imageOptions, imageRef, imageTag } from './image.ts';
import { launchScript, startHost } from './start.ts';

// A stand-in daemon: answers /health from the host.env it was launched with
// (`--env <file>`), and says whether anything leaked into its environment.
const FAKE_DAEMON = `
import { closeSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const env = Object.fromEntries(readFileSync(process.argv[3], 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ bootId: env.HOST_BOOT_ID, version: env.HOST_VERSION, sessionId: env.HOST_SANDBOX_SESSION, vm: 'vm', pid: process.pid,
    secretInEnv: process.env.HOST_SECRET !== undefined, caInEnv: process.env.NODE_EXTRA_CA_CERTS, keysInEnv: process.env.HOST_ENV_KEYS, lockFd: process.env.HOST_LOCK_FD, cache: process.env.NODE_COMPILE_CACHE }));
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

type Health = { bootId: string; pid: number; secretInEnv: boolean; caInEnv?: string; keysInEnv?: string; lockFd?: string; cache?: string };
async function health(port: number): Promise<Health | undefined> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).json()) as Health;
  } catch {
    return undefined;
  }
}

async function waitHealth(port: number, bootId: string): Promise<Health> {
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

describe('image helpers', () => {
  it('tags name the bundle version the image holds', () => {
    // The tag also names the recipe (launcher + Dockerfile), which the bundle version does not cover.
    expect(imageTag('abc')).toMatch(/^abc-[0-9a-f]{8}$/);
    expect(imageRef('harness-host', 'abc')).toBe(`harness-host:${imageTag('abc')}`);
    expect(hasImageFor({ [IMAGE_TAG_KEY]: imageTag('abc'), app: 'x' }, 'abc')).toBe(true);
    expect(hasImageFor({ [IMAGE_TAG_KEY]: 'abc' }, 'abc')).toBe(false);
    expect(hasImageFor({ [IMAGE_TAG_KEY]: 'old' }, 'abc')).toBe(false);
    expect(hasImageFor(undefined, 'abc')).toBe(false);
  });

  it('HARNESS_SANDBOX_IMAGE picks the repo; off, or no bundle version, is no image', async () => {
    expect(imageOptions('1', 'v1')).toEqual({ image: `harness-host:${imageTag('v1')}`, imageTags: { hostImage: imageTag('v1') }, imagePrefetch: [IMAGE_DIR, '/usr/local/bin/node'] });
    expect(imageOptions('my-repo', 'v1')).toMatchObject({ image: `my-repo:${imageTag('v1')}` });
    expect(imageOptions('0', 'v1')).toEqual({});
    expect(imageOptions(undefined, 'v1')).toEqual({});
    expect(imageOptions('1', undefined)).toEqual({});
    const root = await mkdtemp(join(tmpdir(), 'hw-bundle-'));
    dirs.push(root);
    expect(bundleVersion(root)).toBeUndefined();
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 'abc', files: [] }));
    expect(bundleVersion(root)).toBe('abc');
  });

  it('the Dockerfile copies the bundle and launcher into the image dir and warms the compile cache', () => {
    const d = dockerfile();
    expect(d).toMatch(/^FROM ubuntu:26\.04/m);
    expect(d).toContain(`COPY bundle/ ${IMAGE_DIR}/`);
    expect(d).toContain(`COPY launch.sh ${IMAGE_DIR}/launch.sh`);
    expect(d).toContain('COPY node/ /usr/local/');
    expect(d).toContain(`HOST_WARM=1 NODE_COMPILE_CACHE=${IMAGE_DIR}/.compile-cache node daemon.mjs`);
    expect(d).toContain('useradd -m -s /bin/bash harness-run');
    // Back to the sandbox's default user for model-run commands.
    expect(d.trimEnd().split('\n').slice(-2)).toEqual(['USER ubuntu', 'WORKDIR /vercel']);
  });

  it('the shared pkill pattern matches both daemons and neither its own shell', () => {
    const re = new RegExp(DAEMON_PATTERN);
    expect(re.test('node /opt/harness/daemon.mjs --env x')).toBe(true);
    expect(re.test('node /opt/harness-image/daemon.mjs --env x')).toBe(true);
    expect(re.test(`pkill -f '${DAEMON_PATTERN}'`)).toBe(false);
    expect(launchScript({ dir: '/opt/harness', staging: '/tmp/s', port: 1, version: 'v', sandboxSession: 's', runAs: 'u' })).toContain(
      `pkill -f '${DAEMON_PATTERN}'`
    );
    const line = imageLaunchScript().split('\n').find((l) => l.startsWith('pkill'))!;
    const r = spawnSync('bash', ['-c', `set -e; echo before; ${line}; echo after`], { encoding: 'utf8' });
    expect(r.stdout).toBe('before\nafter\n');
  });
});

describe('imageLaunchScript (run through a real bash)', () => {
  async function setup(version = 'v1') {
    const root = await mkdtemp(join(tmpdir(), 'hw-image-'));
    dirs.push(root);
    const image = join(root, 'opt-harness-image');
    const dir = join(root, 'opt-harness');
    await mkdir(image, { recursive: true });
    await writeFile(join(image, 'daemon.mjs'), FAKE_DAEMON);
    await writeFile(join(image, 'manifest.json'), JSON.stringify({ version, files: ['daemon.mjs'] }, null, 2));
    const script = join(image, 'launch.sh');
    await writeFile(script, imageLaunchScript({ image, dir, node: process.execPath, unprivileged: true }));
    return { root, image, dir, script };
  }

  function hostEnv(o: { bootId: string; version: string; session: string; port: number }) {
    const keys = {
      HOST_BOOT_ID: o.bootId,
      HOST_VERSION: o.version,
      HOST_SANDBOX_SESSION: o.session,
      HOST_PORT: String(o.port),
      HOST_SECRET: 'sekret',
      VERCEL_OIDC_TOKEN: 'tok\nen',
    };
    return { ...process.env, NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt', ...keys, HOST_ENV_KEYS: Object.keys(keys).join(' ') };
  }

  it('writes host.env (0600) from its environment and runs the daemon without the secrets but with the rest of its environment', async () => {
    const { dir, script } = await setup();
    const port = await freePort();
    const child = spawn('bash', [script], { detached: true, stdio: 'ignore', env: hostEnv({ bootId: 'boot_a', version: 'v1', session: 's1', port }) });
    if (child.pid) pids.push(child.pid);
    const h = await waitHealth(port, 'boot_a');
    expect(h.secretInEnv).toBe(false);
    // The sandbox's own settings (its egress-proxy CA) reach the daemon.
    expect(h.caInEnv).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(h.keysInEnv).toBeUndefined();
    expect(h.lockFd).toBe('9');
    expect(h.cache).toMatch(/opt-harness-image\/\.compile-cache$/);
    const text = await readFile(join(dir, 'host.env'), 'utf8');
    expect(text).toContain('HOST_SECRET=sekret\n');
    expect(text).toContain('VERCEL_OIDC_TOKEN=token\n');
    expect((await stat(join(dir, 'host.env'))).mode & 0o777).toBe(0o600);
    expect(Number(await readFile(join(dir, 'daemon.pid'), 'utf8'))).toBe(h.pid);
  });

  it('a second launch of the same version on the same VM session reuses the running daemon', async () => {
    const { script } = await setup();
    const port = await freePort();
    const child = spawn('bash', [script], { detached: true, stdio: 'ignore', env: hostEnv({ bootId: 'boot_a', version: 'v1', session: 's1', port }) });
    if (child.pid) pids.push(child.pid);
    await waitHealth(port, 'boot_a');
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 10_000, env: hostEnv({ bootId: 'boot_b', version: 'v1', session: 's1', port }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reuse');
    expect((await health(port))?.bootId).toBe('boot_a');
  });

  it('refuses to run when the image holds another bundle version than it was asked for', async () => {
    const { dir, script } = await setup('v1');
    const port = await freePort();
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 10_000, env: hostEnv({ bootId: 'boot_a', version: 'v2', session: 's1', port }) });
    expect(r.status).toBe(3);
    expect(await readFile(join(dir, 'daemon.log'), 'utf8')).toContain('image holds another bundle than v2');
    expect(await health(port)).toBeUndefined();
  });
});

describe('startHost from the VCR image', () => {
  function fakeProvider(tags: Record<string, string> | undefined, calls: { commands: { line: string; env?: Record<string, string> }[]; writes: number }) {
    const raw = {
      name: 'vm1',
      tags,
      domain: () => 'https://sb-abc.vercel.run',
      currentSession: () => ({ sessionId: 'sess1' }),
      writeFiles: async () => {
        calls.writes++;
      },
      runCommand: async (p: { cmd: string; args?: string[]; env?: Record<string, string> }) => {
        calls.commands.push({ line: [p.cmd, ...(p.args ?? [])].join(' '), env: p.env });
        return { exitCode: 0, stdout: async () => '', stderr: async () => '' };
      },
    };
    return { kind: 'fake', open: async () => ({ raw }) } as unknown as SandboxProvider;
  }

  /** A daemon that answers once launched, with the bootId the launch's env carried. */
  function daemonAfterLaunch(calls: { commands: { line: string; env?: Record<string, string> }[] }) {
    return (async (url: string) => {
      const launch = calls.commands.find((c) => c.line.endsWith('launch.sh'));
      if (url.endsWith('/health')) {
        if (!launch) return new Response('not listening', { status: 502 });
        const bootId = launch.env?.HOST_BOOT_ID ?? /boot_\w+/.exec(launch.line)?.[0];
        return Response.json({ bootId, version: 'v1', sessionId: 'sess1', vm: 'vm1' });
      }
      return Response.json({});
    }) as typeof fetch;
  }

  it('a VM tagged with this version starts the baked launcher with one command and no upload', async () => {
    const calls = { commands: [] as { line: string; env?: Record<string, string> }[], writes: 0 };
    const started = await startHost(fakeProvider({ [IMAGE_TAG_KEY]: imageTag('v1') }, calls), 'wrun_1', {
      bundle: { version: 'v1', files: [{ path: 'daemon.mjs', content: Buffer.from('x') }] },
      env: { VERCEL_OIDC_TOKEN: 'tok\nen', HARNESS_MODEL: 'm' },
      secretKey: 'k',
      fetch: daemonAfterLaunch(calls),
      healthTimeoutMs: 2000,
    });
    expect(started).toMatchObject({ reused: false, image: true });
    expect(calls.writes).toBe(0);
    expect(calls.commands.map((c) => c.line)).toEqual([`bash ${IMAGE_DIR}/launch.sh`]);
    const env = calls.commands[0]!.env!;
    expect(env.HOST_BOOT_ID).toBe(started.fact.bootId);
    expect(env.HOST_SECRET).toBe(started.secret);
    expect(env.VERCEL_OIDC_TOKEN).toBe('token');
    expect(env.HOST_ENV_KEYS!.split(' ').sort()).toEqual(
      ['HARNESS_MODEL', 'HOST_BOOT_ID', 'HOST_PORT', 'HOST_RUN_AS', 'HOST_SANDBOX_SESSION', 'HOST_SECRET', 'HOST_VERSION', 'HOST_VM', 'VERCEL_OIDC_TOKEN'].sort()
    );
  });

  it('a daemon of this version already up: the poll reuses it (the launcher exits "reuse")', async () => {
    const calls = { commands: [] as { line: string; env?: Record<string, string> }[], writes: 0 };
    const doFetch = (async (url: string) =>
      url.endsWith('/health') ? Response.json({ bootId: 'boot_live', version: 'v1', sessionId: 'sess1', vm: 'vm1' }) : Response.json({})) as typeof fetch;
    const started = await startHost(fakeProvider({ [IMAGE_TAG_KEY]: imageTag('v1') }, calls), 'wrun_1', {
      bundle: { version: 'v1', files: [] },
      env: {},
      secretKey: 'k',
      fetch: doFetch,
    });
    expect(started).toMatchObject({ reused: true, fact: { bootId: 'boot_live' } });
    expect(calls.writes).toBe(0);
  });

  it('a VM from another version\'s image (or none) takes the classic install', async () => {
    const calls = { commands: [] as { line: string; env?: Record<string, string> }[], writes: 0 };
    const started = await startHost(fakeProvider({ [IMAGE_TAG_KEY]: imageTag('v0') }, calls), 'wrun_1', {
      bundle: { version: 'v1', files: [{ path: 'daemon.mjs', content: Buffer.from('x') }] },
      env: {},
      secretKey: 'k',
      fetch: daemonAfterLaunch(calls),
      healthTimeoutMs: 2000,
    });
    expect(started.image).toBe(false);
    expect(calls.writes).toBe(1);
    expect(calls.commands.some((c) => c.line.startsWith(`bash ${IMAGE_DIR}`))).toBe(false);
  });

  it('a failed launch command fails the start instead of waiting out the health timeout', async () => {
    const calls = { commands: [] as { line: string; env?: Record<string, string> }[], writes: 0 };
    const provider = fakeProvider({ [IMAGE_TAG_KEY]: imageTag('v1') }, calls);
    const raw = ((await provider.open('x')) as unknown as { raw: { runCommand: () => Promise<unknown> } }).raw;
    raw.runCommand = async () => {
      throw new Error('sandbox gone');
    };
    const t = Date.now();
    await expect(
      startHost(provider, 'wrun_1', {
        bundle: { version: 'v1', files: [] },
        env: {},
        secretKey: 'k',
        fetch: (async () => new Response('', { status: 502 })) as typeof fetch,
        healthTimeoutMs: 10_000,
      })
    ).rejects.toThrow('sandbox gone');
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
