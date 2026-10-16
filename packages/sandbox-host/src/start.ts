import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostFact } from 'harness-world';
import type { SandboxProvider } from 'harness-world-hybrid';
import { DAEMON_PATTERN, HEALTH_JS, hasImageFor, HOST_DIR, IMAGE_DIR } from './image.ts';
import { pushToken } from './token.ts';

/** The daemon's secret for one boot, derived from a server-only key: any function can compute it from the `host` fact; the VM is only told its own. */
export function hostSecret(key: string, vm: string, bootId: string): string {
  return createHmac('sha256', key).update(`host:${vm}:${bootId}`).digest('hex');
}

/** A built daemon bundle (`scripts/build.mjs`): its content-addressed version and files. */
export interface HostBundle {
  version: string;
  files: { path: string; content: Buffer }[];
}

/** Read a bundle directory written by `scripts/build.mjs`. */
export function readBundle(dir: string): HostBundle {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version: string; files: string[] };
  return { version: manifest.version, files: manifest.files.map((path) => ({ path, content: readFileSync(join(dir, path)) })) };
}

/** Whether a bundle directory exists. */
export function hasBundle(dir: string): boolean {
  try {
    return readdirSync(dir).includes('manifest.json');
  } catch {
    return false;
  }
}

/** The bits of `@vercel/sandbox`'s `Sandbox` this needs. */
interface RawSandbox {
  name: string;
  /** The port's public URL, scheme included (`https://sb-….vercel.run`, as `@vercel/sandbox` 3.x returns it). */
  domain(port: number): string;
  currentSession(): { sessionId: string };
  /** Set at create; `hostImage` names the bundle version its VCR image holds (P6). */
  tags?: Record<string, string>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
    detached?: boolean;
    env?: Record<string, string>;
  }): Promise<{ exitCode: number | null; stdout(): Promise<string>; stderr(): Promise<string> }>;
}

export interface StartHostOptions {
  bundle: HostBundle;
  /** Everything the daemon reads from `host.env` except its identity: token, deployment, project, team, `APP_ORIGIN`, `HOST_ENVIRONMENT`, model. */
  env: Record<string, string>;
  /** Server-only key the boot's secret is derived from (`hostSecret`). */
  secretKey: string;
  port?: number;
  healthTimeoutMs?: number;
  fetch?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface HostStart {
  fact: HostFact;
  secret: string;
  sandboxSessionId: string;
  reused: boolean;
  /** Started from the VCR image's preinstalled bundle: no `writeFiles` (P6). */
  image?: boolean;
  ms: { open: number; install?: number; health: number; total: number };
}

const RUN_AS = 'harness-run';

/**
 * Start (or find) the sandbox lane's daemon in the session's VM:
 * open the VM, install the bundle unless this version is already
 * there (a persistent VM keeps `/opt/harness` across resumes), write
 * `host.env` (root, 0600), create the unprivileged user commands run as, run
 * the daemon as root, detached, and wait for `/health`. A daemon already up
 * on this VM session and version is reused.
 */
export async function startHost(provider: SandboxProvider, runId: string, options: StartHostOptions): Promise<HostStart> {
  const t0 = Date.now();
  const say = options.log ?? (() => {});
  const doFetch = options.fetch ?? fetch;
  const port = options.port ?? 3000;
  const handle = (await provider.open(runId)) as unknown as { raw?: RawSandbox };
  const sb = handle.raw;
  if (!sb) throw new Error('startHost needs a Vercel Sandbox handle');
  const openMs = Date.now() - t0;
  const url = hostUrl(sb.domain(port));
  const sandboxSessionId = sb.currentSession().sessionId;
  const health = async (timeoutMs: number) => {
    try {
      const res = await doFetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      return res.ok ? ((await res.json()) as { bootId: string; version: string; sessionId: string; vm: string }) : undefined;
    } catch {
      return undefined;
    }
  };
  const fact = (bootId: string): HostFact => ({
    lane: 'sandbox',
    url,
    vm: sb.name,
    bootId,
    version: options.bundle.version,
    ...(options.env.HOST_ENVIRONMENT ? { environment: options.env.HOST_ENVIRONMENT } : {}),
    at: Date.now(),
  });

  const refreshToken = async (bootId: string) => {
    // A reused daemon keeps whatever token it was started with: hand it this
    // invocation's (fresh) one so a re-attach also refreshes it.
    const token = options.env.VERCEL_OIDC_TOKEN;
    if (!token) return;
    await pushToken(url, hostSecret(options.secretKey, sb.name, bootId), token, doFetch).catch((err) =>
      say('host: token push failed', { vm: sb.name, bootId, error: String(err) })
    );
  };
  const reuse = async (bootId: string): Promise<HostStart> => {
    await refreshToken(bootId);
    return {
      fact: fact(bootId),
      secret: hostSecret(options.secretKey, sb.name, bootId),
      sandboxSessionId,
      reused: true,
      ms: { open: openMs, health: Date.now() - t0 - openMs, total: Date.now() - t0 },
    };
  };
  const ours = (h: { version: string; sessionId: string } | undefined) =>
    !!h && h.version === options.bundle.version && h.sessionId === sandboxSessionId;

  const t1 = Date.now();
  const bootId = `boot_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const secret = hostSecret(options.secretKey, sb.name, bootId);
  const env: Record<string, string> = {
    ...options.env,
    HOST_VM: sb.name,
    HOST_SANDBOX_SESSION: sandboxSessionId,
    HOST_BOOT_ID: bootId,
    HOST_VERSION: options.bundle.version,
    HOST_SECRET: secret,
    HOST_RUN_AS: RUN_AS,
    HOST_PORT: String(port),
  };
  const image = hasImageFor(sb.tags, options.bundle.version);
  // From this version's VCR image (P6) the launch is one command and
  // idempotent (the baked launcher exits "reuse" when a daemon of this
  // version already serves this VM session, before touching host.env), so it
  // goes out at once, and the health poll below doubles as the liveness
  // probe (it takes a running daemon of this version too). The classic
  // path probes first: a fresh VM's probe can take its whole timeout.
  let launched: Promise<unknown> | undefined;
  let launchError: unknown;
  if (image) {
    const clean = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\n/g, '')]));
    launched = sb.runCommand({
      cmd: 'bash',
      args: [`${IMAGE_DIR}/launch.sh`],
      sudo: true,
      detached: true,
      env: { ...clean, HOST_ENV_KEYS: Object.keys(clean).join(' ') },
    });
    launched.catch((err) => {
      launchError = err;
    });
  } else {
    const running = await health(1500);
    if (ours(running)) {
      say('host: reusing the running daemon', { vm: sb.name, bootId: running!.bootId });
      return reuse(running!.bootId);
    }
  }

  let need = false;
  if (!launched) {
    const staging = `/tmp/harness-host-${bootId}`;
    const installed = await sb
      .runCommand({ cmd: 'bash', args: ['-c', `cat ${HOST_DIR}/manifest.json 2>/dev/null | grep -o '"version": *"[^"]*"' || true`] })
      .then((c) => c.stdout())
      .catch(() => '');
    need = !installed.includes(options.bundle.version);
    const envText = `${Object.entries(env)
      .map(([k, v]) => `${k}=${v.replace(/\n/g, '')}`)
      .join('\n')}\n`;
    const script = launchScript({ dir: HOST_DIR, staging, port, version: options.bundle.version, sandboxSession: sandboxSessionId, runAs: RUN_AS });
    await sb.writeFiles([
      ...(need
        ? [
            ...options.bundle.files.map((f) => ({ path: `${staging}/${f.path}`, content: f.content })),
            // What the next start's installed-version check reads.
            { path: `${staging}/manifest.json`, content: Buffer.from(JSON.stringify({ version: options.bundle.version })) },
          ]
        : []),
      { path: `${staging}/host.env`, content: Buffer.from(envText) },
      { path: `${staging}/launch.sh`, content: Buffer.from(script) },
    ]);
    // The launcher serializes starts per VM (flock, held by the daemon until it
    // listens) and reuses a healthy daemon of this version instead of killing it.
    await sb.runCommand({ cmd: 'bash', args: [`${staging}/launch.sh`], sudo: true, detached: true });
  }
  const installMs = Date.now() - t1;
  const t2 = Date.now();
  const deadline = Date.now() + (options.healthTimeoutMs ?? 20_000);
  for (;;) {
    if (launchError) throw launchError;
    const h = await health(2000);
    if (h?.bootId === bootId) break;
    // Another starter (a concurrent attach on another instance) won the VM's
    // start lock: its daemon is this version on this VM session, so use it.
    if (h && ours(h)) {
      say(image ? 'host: reusing the running daemon' : 'host: another start won, reusing its daemon', { vm: sb.name, bootId: h.bootId, ours: bootId });
      return reuse(h.bootId);
    }
    if (Date.now() > deadline) {
      const tail = await sb
        .runCommand({ cmd: 'bash', args: ['-c', `tail -c 2000 ${HOST_DIR}/daemon.log`], sudo: true })
        .then((c) => c.stdout())
        .catch(() => '');
      throw new Error(`host daemon did not answer /health within ${options.healthTimeoutMs ?? 20_000} ms: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  say('host: daemon started', { vm: sb.name, bootId, image, installed: need, installMs, healthMs: Date.now() - t2 });
  return {
    fact: fact(bootId),
    secret,
    sandboxSessionId,
    reused: false,
    image,
    ms: { open: openMs, install: installMs, health: Date.now() - t2, total: Date.now() - t0 },
  };
}

/** `@vercel/sandbox`'s `domain()` returns a URL (scheme included); accept a bare host too. */
export function hostUrl(domain: string): string {
  return /^https?:\/\//.test(domain) ? domain.replace(/\/+$/, '') : `https://${domain}`;
}

export interface LaunchScriptOptions {
  /** `/opt/harness`. */
  dir: string;
  /** The staged bundle, `host.env` and this script. */
  staging: string;
  port: number;
  version: string;
  sandboxSession: string;
  /** The unprivileged user commands run as (created when run as root). */
  runAs: string;
  /** `node` (tests point it elsewhere). */
  node?: string;
}

/**
 * The in-VM launcher (`bash <staging>/launch.sh`, as root, detached). Starts
 * are serialized per VM: it takes `<dir>/.start.lock` (flock) and hands the
 * lock to the daemon it execs (`HOST_LOCK_FD`), which releases it once it
 * listens; so a second starter waits, then finds a healthy daemon of this
 * version on this VM session and leaves it alone. Only then does it install
 * and replace an older daemon (by pidfile, then by a pattern that cannot
 * match this script's own argv: a plain `pkill -f <dir>/daemon.mjs` inside
 * `bash -c` killed its own shell).
 */
export function launchScript(o: LaunchScriptOptions): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const node = o.node ?? 'node';
  // `[/]opt/harness(-image)?/daemon[.]mjs`: matches a daemon, never this pkill's own argv.
  // Also matches the VCR image's daemon (`<dir>-image/daemon.mjs`), so either path replaces the other's.
  const pattern = o.dir === HOST_DIR ? DAEMON_PATTERN : `[${o.dir[0]}]${o.dir.slice(1)}(-image)?/daemon[.]mjs`;
  const healthJs = HEALTH_JS;
  return [
    '#!/bin/bash',
    'set -e',
    `HD=${q(o.dir)}; ST=${q(o.staging)}; PORT=${o.port}; V=${q(o.version)}; S=${q(o.sandboxSession)}; RUN_AS=${q(o.runAs)}; NODE=${q(node)}`,
    'mkdir -p "$HD"',
    'exec 9>"$HD/.start.lock"',
    'if command -v flock >/dev/null 2>&1; then flock -w 60 9; fi',
    // A daemon of this version already serves this VM session: keep it.
    `if "$NODE" -e ${q(healthJs)} "$PORT" "$V" "$S"; then rm -rf "$ST"; echo "reuse"; exit 0; fi`,
    'if ! grep -q "\"version\": *\"$V\"" "$HD/manifest.json" 2>/dev/null && [ -f "$ST/manifest.json" ]; then rm -rf "$HD/node_modules"; fi',
    'if [ -f "$ST/manifest.json" ]; then cp -r "$ST/." "$HD/"; rm -f "$HD/launch.sh"; else mv "$ST/host.env" "$HD/host.env"; fi',
    'chmod 600 "$HD/host.env"',
    'rm -rf "$ST"',
    'if [ "$(id -u)" = 0 ]; then',
    '  chown root:root "$HD/host.env"',
    // Model-run commands: an unprivileged user with no sudo.
    '  id -u "$RUN_AS" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUN_AS"',
    '  mkdir -p /workspace /tmp/harness && chown -R "$RUN_AS:$RUN_AS" /workspace && chmod 755 /tmp/harness',
    'fi',
    // One daemon per VM: replace an older one.
    'if [ -f "$HD/daemon.pid" ]; then kill "$(cat "$HD/daemon.pid")" >/dev/null 2>&1 || true; fi',
    `pkill -f ${q(pattern)} >/dev/null 2>&1 || true`,
    'echo $$ > "$HD/daemon.pid"',
    'cd "$HD"',
    'export HOST_LOCK_FD=9',
    'exec "$NODE" "$HD/daemon.mjs" --env "$HD/host.env" >> "$HD/daemon.log" 2>&1',
    '',
  ].join('\n');
}
