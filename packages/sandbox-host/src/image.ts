import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The sandbox lane's VCR image (P6): a Vercel Container Registry
 * image with Node 24, the daemon bundle and its compile cache preinstalled
 * under `/opt/harness-image`, tagged with the bundle's content-addressed
 * version. A VM created from it starts its daemon with one detached command:
 * no `writeFiles` of the 5+ MB bundle, no installed-version check.
 *
 * `/opt/harness-image` is never written at runtime, so a VM whose `hostImage`
 * tag names a version is guaranteed to hold that version's bundle there (the
 * classic path installs into `/opt/harness` instead, and both launchers share
 * that directory's pidfile, lock and log, so either replaces the other's
 * daemon).
 */

/** Where the image keeps the bundle (read-only at runtime). */
export const IMAGE_DIR = '/opt/harness-image';
/** The runtime directory both launch paths share: `host.env`, pidfile, lock, log. */
export const HOST_DIR = '/opt/harness';
/** The VM tag recording which bundle version its image holds. */
export const IMAGE_TAG_KEY = 'hostImage';
/** The VCR repository the image is pushed to (in the demo's project). */
export const DEFAULT_IMAGE_REPO = 'harness-host';

/** The bundle version a bundle directory holds (its `manifest.json`), if any. */
export function bundleVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * The provider options for the image (`HARNESS_SANDBOX_IMAGE`: a VCR
 * repository in the project, `1` for `harness-host`; unset or `0` is off):
 * `<repo>:<version>` plus the `hostImage` tag. Empty without a version.
 */
export function imageOptions(
  setting: string | undefined,
  version: string | undefined
): { image?: string; imageTags?: Record<string, string>; imagePrefetch?: string[] } {
  if (!setting || setting === '0' || !version) return {};
  const repo = setting === '1' ? DEFAULT_IMAGE_REPO : setting;
  // A fresh VM reads the image's blocks lazily: the daemon's first start
  // read its bundle cold (~0.8 s vs ~0.4 s warm), so connect warms them.
  return { image: imageRef(repo, version), imageTags: { [IMAGE_TAG_KEY]: imageTag(version) }, imagePrefetch: [IMAGE_DIR, '/usr/local/bin/node'] };
}

let recipe: string | undefined;
/**
 * The image's tag for a bundle version: `<version>-<recipe hash>`. The
 * launcher and the Dockerfile are baked into the image but are not part of
 * the bundle's version, so a change to either names a new image.
 */
export function imageTag(version: string): string {
  recipe ??= createHash('sha256').update(imageLaunchScript()).update(dockerfile()).digest('hex').slice(0, 8);
  return `${version}-${recipe}`;
}

/** `repo:<imageTag>`: the image of one bundle version. */
export function imageRef(repo: string, version: string): string {
  return `${repo}:${imageTag(version)}`;
}

/** Whether a VM's tags say it was created from the image of this bundle version (and this launcher). */
export function hasImageFor(tags: Record<string, string> | undefined, version: string): boolean {
  return tags?.[IMAGE_TAG_KEY] === imageTag(version);
}

/** `[/]opt/harness(-image)?/daemon[.]mjs`: matches either path's daemon, never a pkill's own argv. */
export const DAEMON_PATTERN = '[/]opt/harness(-image)?/daemon[.]mjs';

/** The health check a launcher runs before replacing a daemon: exit 0 if one of this version serves this VM session. */
export const HEALTH_JS =
  "fetch('http://127.0.0.1:'+process.argv[1]+'/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(h=>process.exit(h.version===process.argv[2]&&h.sessionId===process.argv[3]?0:1),()=>process.exit(1))";

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export interface ImageLaunchOptions {
  /** `/opt/harness-image` (tests point it elsewhere). */
  image?: string;
  /** `/opt/harness`. */
  dir?: string;
  /** `node`. */
  node?: string;
  /** Skip the root-only steps (tests run it unprivileged). */
  unprivileged?: boolean;
}

/**
 * The image's launcher, baked in at `<image>/launch.sh` and run as root,
 * detached, with everything in its environment (`runCommand({ env })`):
 * `HOST_PORT`, `HOST_VERSION`, `HOST_SANDBOX_SESSION`, `HOST_RUN_AS` and,
 * named by `HOST_ENV_KEYS`, every key the daemon's `host.env` gets. It
 * writes `host.env` (root, 0600) from those, then runs the daemon with
 * those keys removed from its environment, so the secrets live only in the
 * file the daemon deletes once read. Same per-VM start lock and reuse rule as the
 * classic launcher (`launchScript`).
 */
export function imageLaunchScript(o: ImageLaunchOptions = {}): string {
  const img = o.image ?? IMAGE_DIR;
  const dir = o.dir ?? HOST_DIR;
  const node = o.node ?? 'node';
  return [
    '#!/bin/bash',
    'set -e',
    `HD=${q(dir)}; IMG=${q(img)}; NODE=${q(node)}`,
    'PORT="${HOST_PORT:-3000}"; V="${HOST_VERSION:?HOST_VERSION is required}"; S="${HOST_SANDBOX_SESSION:?HOST_SANDBOX_SESSION is required}"; RUN_AS="${HOST_RUN_AS:-harness-run}"',
    'mkdir -p "$HD"',
    'exec 9>"$HD/.start.lock"',
    'if command -v flock >/dev/null 2>&1; then flock -w 60 9; fi',
    `if "$NODE" -e ${q(HEALTH_JS)} "$PORT" "$V" "$S"; then echo "reuse"; exit 0; fi`,
    // The tag said this version; refuse anything else rather than run it.
    'if ! grep -q "\\"version\\": *\\"$V\\"" "$IMG/manifest.json" 2>/dev/null; then echo "image holds another bundle than $V" >> "$HD/daemon.log"; exit 3; fi',
    '( umask 077; : > "$HD/host.env"; for k in ${HOST_ENV_KEYS:-}; do printf \'%s=%s\\n\' "$k" "${!k//$\'\\n\'/}" >> "$HD/host.env"; done )',
    'chmod 600 "$HD/host.env"',
    ...(o.unprivileged
      ? []
      : [
          'if [ "$(id -u)" = 0 ]; then',
          '  chown root:root "$HD/host.env"',
          '  id -u "$RUN_AS" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUN_AS"',
          '  mkdir -p /workspace /tmp/harness && chown -R "$RUN_AS:$RUN_AS" /workspace && chmod 755 /tmp/harness',
          'fi',
        ]),
    'if [ -f "$HD/daemon.pid" ]; then kill "$(cat "$HD/daemon.pid")" >/dev/null 2>&1 || true; fi',
    `pkill -f ${q(DAEMON_PATTERN)} >/dev/null 2>&1 || true`,
    'echo $$ > "$HD/daemon.pid"',
    'cd "$IMG"',
    // Drop what went into host.env (the secrets live only in the file the
    // daemon deletes once read); keep the rest of the command's environment:
    // the sandbox sets NODE_USE_SYSTEM_CA / NODE_EXTRA_CA_CERTS there, which
    // the daemon needs to trust the egress proxy on intercepted hosts.
    'for k in ${HOST_ENV_KEYS:-}; do unset "$k"; done; unset HOST_ENV_KEYS',
    'export HOST_LOCK_FD=9 NODE_COMPILE_CACHE="$IMG/.compile-cache"',
    'exec "$NODE" "$IMG/daemon.mjs" --env "$HD/host.env" >> "$HD/daemon.log" 2>&1',
    '',
  ].join('\n');
}

/**
 * The image's Dockerfile, built `linux/amd64` with the bundle and
 * `launch.sh` in the context. The managed `vercel/sandbox/*` images are not
 * pullable from VCR, so this rebuilds their open-source base
 * (github.com/vercel/sandbox `images/ubuntu` + `images/node`): Ubuntu 26.04,
 * the `ubuntu` user with passwordless sudo, `HOME=/vercel`, Node 24
 * (`node/` in the context: the official linux-x64 tarball) and git,
 * plus what the launcher and the bash tool need (procps, python3, curl, jq,
 * ripgrep). Then it warms Node's compile cache by loading every module the
 * daemon would (`HOST_WARM=1`).
 */
export function dockerfile(): string {
  return `# syntax=docker/dockerfile:1
FROM ubuntu:26.04 AS base
ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \\
    apt-get install -y --no-install-recommends ca-certificates sudo git libatomic1 procps curl jq ripgrep python3 python-is-python3 && \\
    rm -rf /var/lib/apt/lists/*
RUN printf '%s\\n' 'Defaults always_set_home' 'Defaults !env_reset' 'Defaults !fqdn' 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sandbox && \\
    chmod 0440 /etc/sudoers.d/sandbox && \\
    install -d -o ubuntu -g ubuntu /vercel && usermod --home /vercel ubuntu

FROM base
# Node's linux-x64 tarball, unpacked by scripts/image.mjs on the build host
# (tar under amd64 emulation fails on some hosts).
COPY node/ /usr/local/
COPY bundle/ ${IMAGE_DIR}/
COPY launch.sh ${IMAGE_DIR}/launch.sh
RUN chmod 755 ${IMAGE_DIR}/launch.sh && \\
    useradd -m -s /bin/bash harness-run && \\
    mkdir -p ${HOST_DIR} /workspace && chown harness-run:harness-run /workspace && \\
    cd ${IMAGE_DIR} && HOST_WARM=1 NODE_COMPILE_CACHE=${IMAGE_DIR}/.compile-cache node daemon.mjs && \\
    node --version
ENV HOME=/vercel
ENV SHELL=/bin/bash
USER ubuntu
WORKDIR /vercel
`;
}
