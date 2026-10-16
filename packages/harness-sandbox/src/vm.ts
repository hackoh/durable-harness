/**
 * Where things are in a session VM (docs/workspaces.md §5.2): the layout the
 * base recipe (`base.ts`) installs and the session factory (`session.ts`)
 * arms and dials. One place, so the two can't disagree.
 */
import type { CacheDir } from 'harness-world-process';
import type { RelayConfig } from './relay/relay.ts';

/** The relay's port, exposed through the ingress (the only one the sandbox exposes). */
export const RELAY_PORT = 2010;
/** The model port, on loopback only. */
export const MODEL_PORT = 4100;
/** A root-owned wrapper that runs the content-addressed bundle (`/opt/dh/relay-<hash>.mjs`) with the image's node. */
export const RELAY_COMMAND = '/opt/dh/relay';
/** The relay's config, root-owned. */
export const RELAY_CONFIG = '/opt/dh/relay.json';
export const WORKSPACE = '/workspace';
export const CACHE_ROOT = '/var/lib/dh/s';
export const STATE_DIR = '/run/dh';
/** The unprivileged user (uid 1001). */
export const AGENT = 'agent';

const CACHE_DIRS: readonly CacheDir[] = ['home', 'config', 'codex-home', 'tmp', 'cache'];

/** The cache directories, as paths in the VM. */
export function vmDirs(root = CACHE_ROOT): Readonly<Record<CacheDir, string>> {
  return Object.freeze(Object.fromEntries(CACHE_DIRS.map((d) => [d, `${root}/${d}`])) as Record<CacheDir, string>);
}

/** The relay config the base installs (privileged tier, cgroup leaf on). */
export function relayConfig(o: { relayVersion: string; cliVersions: Record<string, string> }): RelayConfig {
  return { port: RELAY_PORT, modelPort: MODEL_PORT, stateDir: STATE_DIR, workspace: WORKSPACE, cacheRoot: CACHE_ROOT, runAs: AGENT, cgroup: true, relayVersion: o.relayVersion, cliVersions: o.cliVersions };
}
