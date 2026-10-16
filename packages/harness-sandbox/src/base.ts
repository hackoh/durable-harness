/**
 * The base snapshot a session VM boots from (docs/workspaces.md §5.2, §5.7):
 * the relay, the pinned Claude Code and Codex binaries (sha512-checked against
 * the same integrity the lockfile pins), `rg`, `bwrap`, and the unprivileged
 * `agent` user (no sudo, no capabilities; P0.19). No firewall tool: the VM's
 * kernel has neither nf_tables nor iptables' owner match, so P0.20's
 * owner-match guard can't be installed whatever the image carries
 * (`probes/platform-guard.ts`).
 *
 * One snapshot per project, region and recipe: `dh-base-<region>-<hash>`, the
 * hash over everything the recipe installs. A miss builds it once in a named
 * builder sandbox of that name (two builders converge on the name: the loser
 * waits for the winner's snapshot), with an explicit expiration (P0.3: the
 * default is 30 days from creation), and is rebuilt when it expired. An app
 * can boot from a VCR image built by the same recipe instead (`image:`), as
 * the demo does.
 *
 * The relay bundle is an input: in this repo it is built with esbuild
 * (`buildRelayBundle`, a devDependency); a published build ships the bundle
 * (A7).
 */
import { createHash } from 'node:crypto';
import { CLAUDE_CLI, CODEX_CLI, type PinnedCli } from './clis.ts';
import { RELAY_COMMAND, RELAY_CONFIG, relayConfig } from './vm.ts';

export { CLAUDE_CLI, CODEX_CLI, cliPath, type PinnedCli } from './clis.ts';

/** The relay bundle the recipe installs (`buildRelayBundle`'s output, or a published build's). */
export interface RelayArtifact {
  bytes: Uint8Array;
  /** sha256 of `bytes`, hex. */
  version: string;
}

export interface BaseRecipe {
  /** Over every input: the relay, the CLIs, the script. */
  hash: string;
  /** The files written to `/tmp/dh-base` before the script runs. */
  files: { path: string; content: Uint8Array; mode?: number }[];
  /** Run as root; prints `DH_BASE_OK` last when it succeeded. */
  script: string;
  cliVersions: Record<string, string>;
}

const hex = (integrity: string) => Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');

/**
 * The recipe for a base (pure: no network). `clis` defaults to both; a test
 * may pass `[]` for a relay-only base.
 */
export function baseRecipe(relay: RelayArtifact, options: { clis?: readonly PinnedCli[] } = {}): BaseRecipe {
  const clis = options.clis ?? [CLAUDE_CLI, CODEX_CLI];
  const cliVersions: Record<string, string> = {};
  for (const c of clis) cliVersions[c === CLAUDE_CLI ? 'claude' : c === CODEX_CLI ? 'codex' : c.dir] = c.version;
  const relayFile = `/opt/dh/relay-${relay.version.slice(0, 16)}.mjs`;
  const config = relayConfig({ relayVersion: relay.version.slice(0, 16), cliVersions });
  const lines = [
    'set -euo pipefail',
    'cd /tmp/dh-base',
    // The unprivileged user every model-reachable process runs as: no sudo entry, no capabilities (P0.19).
    'id -u agent >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash agent',
    'rm -f /etc/sudoers.d/agent',
    // The platform image's node install under /usr/local belongs to uid 1001 (the node tarball's owner), the uid agent now has: give
    // back to root everything agent would own outside its home and the temp dirs, so it can't replace what root runs (/usr/local/bin
    // is on root's PATH before /usr/bin).
    'find / -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /home -o -path /tmp -o -path /var/tmp -o -path /workspace \\) -prune -o \\( -uid "$(id -u agent)" -o -gid "$(id -g agent)" \\) -exec chown -h root:root {} +',
    'install -d -m 0755 -o root -g root /opt/dh /var/lib/dh /var/lib/dh/s',
    `install -m 0644 -o root -g root relay.mjs ${relayFile}`,
    `install -m 0644 -o root -g root relay.json ${RELAY_CONFIG}`,
    // The wrapper runs as root (sudo): the node it pins must be one only root can replace, the file and every directory above it
    // root-owned and not group- or other-writable. An image's node that isn't is copied under /opt/dh, root's.
    'NODE="$(readlink -f "$(command -v node)")"',
    'rootonly() { p="$1"; while :; do read -r u m <<<"$(stat -c \'%u %a\' "$p")" || return 1; [ "$u" = 0 ] && [ $(( 8#$m & 8#022 )) = 0 ] || return 1; [ "$p" = / ] && return 0; p="$(dirname "$p")"; done; }',
    'rootonly "$NODE" || { install -m 0755 -o root -g root "$NODE" /opt/dh/node; NODE=/opt/dh/node; }',
    `printf '#!/bin/sh\\nexec %s %s "$@"\\n' "$NODE" ${relayFile} > ${RELAY_COMMAND}`,
    `chown root:root ${RELAY_COMMAND} && chmod 0755 ${RELAY_COMMAND}`,
    // A tarball is used only if its sha512 is the pinned one.
    'fetch() { curl -fsSL --retry 3 -o "$3" "$1"; echo "$2  $3" | sha512sum -c --quiet - || { echo "integrity mismatch: $1" >&2; exit 3; }; }',
  ];
  for (const [i, c] of clis.entries()) {
    lines.push(
      `fetch ${c.url} ${hex(c.integrity)} cli${i}.tgz`,
      `install -d -m 0755 -o root -g root ${c.dir}`,
      `tar -xzf cli${i}.tgz -C ${c.dir} --strip-components=1 --no-same-owner --exclude='package/vendor/*/codex-resources/voice'`,
      // Codex's binary execute-only (root's, 0711): the agent's exec of a file it can't read leaves app-server not dumpable, so the
      // agent's commands can't read its environ (the model key), trace it or take its model socket (§5.5). Its sandbox helper re-execs
      // /proc/self/exe, which needs only execute. Claude Code's binary reads itself at start (its bundle is appended), so it stays
      // readable: its commands are kept from it by its own sandbox's pid namespace instead.
      `chmod ${c === CODEX_CLI ? '0711' : '0755'} ${c.dir}/${c.bin}`
    );
  }
  if (clis.includes(CODEX_CLI)) lines.push(`ln -sf ${CODEX_CLI.dir}/vendor/x86_64-unknown-linux-musl/codex-path/rg /usr/local/bin/rg`);
  lines.push(
    'chown -R root:root /opt/dh && chmod -R go-w /opt/dh',
    // bwrap: Codex's sandbox and Claude Code's own depend on it, and Claude Code's needs socat too (its network bridge, P0.10), so a
    // base without them is a failed build, never a silent one.
    'export DEBIAN_FRONTEND=noninteractive',
    '{ command -v bwrap && command -v socat; } >/dev/null 2>&1 || apt-get install -y -q bubblewrap socat >/tmp/dh-base/apt.log 2>&1 || { apt-get update -q >>/tmp/dh-base/apt.log 2>&1 && apt-get install -y -q bubblewrap socat >>/tmp/dh-base/apt.log 2>&1; } || dnf install -y -q bubblewrap socat >>/tmp/dh-base/apt.log 2>&1 || true',
    'for b in bwrap socat; do command -v $b >/dev/null 2>&1 || { echo "$b could not be installed:" >&2; tail -20 /tmp/dh-base/apt.log >&2; exit 4; }; done',
    'echo "bwrap=$(command -v bwrap) socat=$(command -v socat)"',
    'echo "node=$NODE"',
    ...clis.map((c) => `echo "cli=${c.version} $(${c.dir}/${c.bin} --version 2>&1 | head -1)"`),
    'rm -rf /tmp/dh-base',
    'echo DH_BASE_OK'
  );
  const script = `${lines.join('\n')}\n`;
  const files = [
    { path: '/tmp/dh-base/relay.mjs', content: relay.bytes },
    { path: '/tmp/dh-base/relay.json', content: new TextEncoder().encode(JSON.stringify(config)) },
    { path: '/tmp/dh-base/recipe.sh', content: new TextEncoder().encode(script), mode: 0o700 },
  ];
  const hash = createHash('sha256').update(relay.version).update('\0').update(script).update('\0').update(JSON.stringify(config)).digest('hex');
  return { hash, files, script, cliVersions };
}

/** The builder sandbox's name, which names the base too. */
export function baseName(recipe: BaseRecipe, region: string): string {
  return `dh-base-${region}-${recipe.hash.slice(0, 16)}`;
}

/** How long a base snapshot lives (P0.3: `snapshot({ expiration })` is honoured). */
const BASE_EXPIRATION_MS = 30 * 24 * 60 * 60_000;
/** A base this close to expiring is rebuilt rather than booted. */
const BASE_MARGIN_MS = 24 * 60 * 60_000;
/** A builder that stopped this recently may have a snapshot the listing doesn't show yet: waited for, never deleted. */
const SETTLE_MS = 5 * 60_000;

export interface PrepareBaseOptions {
  region: string;
  relay: RelayArtifact;
  clis?: readonly PinnedCli[];
  credentials?: { token: string; teamId: string; projectId: string };
  /** Override the builder's name (the live tests name theirs `dh-probe-*`, so a sweep finds them). */
  name?: string;
  tags?: Record<string, string>;
  /** How long to wait for another builder's snapshot. Default 10 min. */
  waitMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Get the base snapshot for `region`, building it if there is none (or it
 * expires within a day). Returns its id. Safe to race: one builder per name.
 */
export async function prepareBase(options: PrepareBaseOptions): Promise<{ snapshotId: string; name: string; built: boolean; expiresAt?: number; report?: string }> {
  const { Sandbox } = await import('@vercel/sandbox');
  const { apiErrorOf } = await import('./api.ts');
  const recipe = baseRecipe(options.relay, { ...(options.clis ? { clis: options.clis } : {}) });
  const name = options.name ?? baseName(recipe, options.region);
  const creds = options.credentials ?? {};
  const log = options.log ?? (() => {});
  const until = Date.now() + (options.waitMs ?? 10 * 60_000);
  for (;;) {
    let sb: InstanceType<typeof Sandbox> | undefined;
    try {
      sb = await Sandbox.get({ name, ...creds });
    } catch (err) {
      if (apiErrorOf(err).status !== 404) throw err;
    }
    if (sb) {
      const snaps = await (await sb.listSnapshots({ sortOrder: 'desc', limit: 10 })).toArray();
      const usable = snaps.find((s) => s.status === 'created' && (s.expiresAt === undefined || s.expiresAt > Date.now() + BASE_MARGIN_MS));
      if (usable) return { snapshotId: usable.id, name, built: false, ...(usable.expiresAt !== undefined ? { expiresAt: usable.expiresAt } : {}) };
      const settled = Date.now() - (sb.statusUpdatedAt?.getTime() ?? 0) > SETTLE_MS;
      if (sb.status === 'running' || sb.status === 'pending' || sb.status === 'snapshotting' || sb.status === 'stopping' || !settled) {
        // Another builder is at work, or just stopped after its snapshot (which the listing may not show yet): wait for it.
        if (Date.now() > until) throw new Error(`harness-sandbox: the base ${name} is still building`);
        await sleep(5_000);
        continue;
      }
      // Stopped a while ago with no usable snapshot (expired, failed, or a builder that failed): rebuild under the same name.
      log('rebuilding the base', { name });
      await sb.delete({ deleteOrphanSnapshots: true });
    }
    let builder: InstanceType<typeof Sandbox>;
    try {
      builder = await Sandbox.create({ name, region: options.region, persistent: false, timeout: 20 * 60_000, resources: { vcpus: 2 }, ...(options.tags ? { tags: options.tags } : {}), ...creds });
    } catch (err) {
      const e = apiErrorOf(err);
      if (e.status === 409 || (e.status === 400 && /already exists/i.test(e.message))) {
        await sleep(2_000);
        continue;
      }
      throw err;
    }
    try {
      await builder.writeFiles(recipe.files.map((f) => ({ path: f.path, content: f.content, ...(f.mode ? { mode: f.mode } : {}) })));
      const run = await builder.runCommand({ cmd: 'bash', args: ['/tmp/dh-base/recipe.sh'], sudo: true });
      const out = (await run.stdout()).trim();
      if (run.exitCode !== 0 || !out.endsWith('DH_BASE_OK')) throw new Error(`harness-sandbox: the base recipe failed (exit ${run.exitCode}): ${(await run.stderr()).slice(-600)}`);
      const snapshot = await builder.snapshot({ expiration: BASE_EXPIRATION_MS });
      log('built the base', { name, snapshotId: snapshot.snapshotId });
      return { snapshotId: snapshot.snapshotId, name, built: true, expiresAt: Date.now() + BASE_EXPIRATION_MS, report: out.split('\n').filter((l) => /^(bwrap|node|cli)=/.test(l)).join('; ') };
    } catch (err) {
      await builder.delete({ deleteOrphanSnapshots: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * The relay artifact built from this checkout's source (esbuild, a
 * devDependency): what the repo's tests, the probes and a local `sandbox()` boot
 * with. The bytes are the build's own, in memory, checked against their hash
 * (never read back from a shared temp path another user could swap); the
 * build itself writes into a fresh private directory. A published build ships
 * the bundle instead (A7); without esbuild this throws, saying so.
 */
export async function devRelayArtifact(): Promise<RelayArtifact> {
  const { buildRelayBundle } = await import('./relay/bundle.ts');
  let bundle;
  try {
    bundle = await buildRelayBundle();
  } catch (err) {
    throw new Error(`harness-sandbox: the relay bundle can't be built here (it needs esbuild, a devDependency; a published build ships it): ${(err as Error)?.message ?? err}`);
  }
  const bytes = new Uint8Array(bundle.bytes);
  // The build's private directory has served its purpose: the bytes are in memory.
  const { rmSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  rmSync(dirname(bundle.path), { recursive: true, force: true });
  if (createHash('sha256').update(bytes).digest('hex') !== bundle.version) throw new Error('harness-sandbox: the relay bundle does not match its hash');
  return { bytes, version: bundle.version };
}
