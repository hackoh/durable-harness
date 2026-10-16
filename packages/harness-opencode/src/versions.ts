import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Unavailable } from 'harness-world';

/**
 * The OpenCode and Effect versions this harness is built and tested with.
 * The harness uses OpenCode internals that move between releases, and with
 * another `effect` OpenCode's host can fail to start with no error at all.
 * A test keeps these equal to package.json's.
 */
export const OPENCODE_PINS = {
  '@opencode/client': '2.0.22',
  '@opencode/core': '2.0.22',
  '@opencode/schema': '2.0.22',
  '@opencode/server': '2.0.22',
  effect: '4.0.0-rc.112',
} as const;

/**
 * The install line for the pinned OpenCode packages. Not `effect`: they
 * depend on it at their version themselves, so npm, pnpm and Bun install
 * that one, and a bare `effect` would get a newer one.
 */
export const OPENCODE_INSTALL = `pnpm add ${Object.entries(OPENCODE_PINS)
  .filter(([name]) => name !== 'effect')
  .map(([name, version]) => `${name}@${version}`)
  .join(' ')}`;

/** What to do when `effect` is another version: almost always the app's own `effect` dependency. */
export const EFFECT_HINT = `OpenCode ${OPENCODE_PINS['@opencode/core']}'s packages bring effect ${OPENCODE_PINS.effect} themselves: remove effect from the app's dependencies, or pin it to ${OPENCODE_PINS.effect}`;

/**
 * The version of `name` that an import from here finds: Node's lookup for a
 * package's folder (`node_modules/<name>` in this module's directory or the
 * nearest one above it). Undefined when it isn't there (the import says
 * what is missing) or this module isn't a file.
 */
export function installedVersion(name: string, from = import.meta.url): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(from));
  } catch {
    return undefined;
  }
  for (;;) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version;
      } catch {}
    }
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/**
 * The installed versions that differ from the pins, as an `Unavailable`
 * (the turn fails with it; the session stays, and a fixed install drives
 * it again), or undefined when they match. pnpm only warns when a peer
 * dependency doesn't match.
 */
export function checkOpenCodeVersions(versionOf: (name: string) => string | undefined = installedVersion): Unavailable | undefined {
  const wrong = Object.entries(OPENCODE_PINS).flatMap(([name, pinned]) => {
    const installed = versionOf(name);
    return installed !== undefined && installed !== pinned ? [{ name, text: `${name} ${installed} (expected ${pinned})` }] : [];
  });
  if (!wrong.length) return undefined;
  const hints = [
    ...(wrong.some((w) => w.name !== 'effect') ? [`Install the pinned versions: ${OPENCODE_INSTALL}`] : []),
    ...(wrong.some((w) => w.name === 'effect') ? [EFFECT_HINT] : []),
  ];
  return new Unavailable(`harness-world-opencode: installed ${wrong.map((w) => w.text).join(', ')}: OpenCode runs only at the versions this harness is built with`, {
    code: 'unavailable',
    hint: hints.join('. '),
  });
}

/**
 * Whether this module was loaded from an installed package (a path under
 * `node_modules`, as durable-harness from npm is), where Node finds OpenCode
 * and `effect` at run time the way `installedVersion` does. A bundle that
 * includes the harness resolved them when it was built, so the files on its
 * machine say nothing about what runs: it isn't checked.
 */
export function loadedFromPackage(from = import.meta.url): boolean {
  try {
    return fileURLToPath(from).split(sep).includes('node_modules');
  } catch {
    return false;
  }
}

let checked: { error: Unavailable | undefined } | undefined;
/** `checkOpenCodeVersions()`, once per process, when loaded from a package: throws its `Unavailable`. */
export function assertOpenCodeVersions(): void {
  checked ??= { error: loadedFromPackage() ? checkOpenCodeVersions() : undefined };
  if (checked.error) throw checked.error;
}
