/**
 * Bundle the relay entry and `ws` into one `.mjs` (docs/workspaces.md §5.2,
 * §11.4 A2: "bundled into one .mjs with ws"). The stand-in (`localMachine`)
 * builds it and runs it as a local child; the real-VM install (A3) ships the
 * same file to `/opt/dh/relay-<hash>.mjs`. Content-addressed: the file name
 * carries the sha256 of its bytes, so the relay version is the bundle's hash.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the relay source entry is, for esbuild. */
export function relayEntry(): string {
  return fileURLToPath(new URL('./entry.ts', import.meta.url));
}

export interface RelayBundle {
  /** The absolute path to the built `.mjs`. */
  path: string;
  /** `sha256` of the bytes, hex; also in the file name. */
  version: string;
  /** The bytes, as built (what a base installs: never re-read from `path`). */
  bytes: Uint8Array;
}

/** The part of esbuild's API this needs (the module itself, or a plugin's `build.esbuild`). */
export interface Esbuild {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { contents: Uint8Array }[] }>;
}

/**
 * Build the bundle's bytes with `esbuild` (default: esbuild itself, a
 * devDependency, imported here; durable-harness's build passes its own, and
 * the entry's path, since its config is bundled elsewhere). It
 * inlines `ws` and the world-remote codec, so the file runs under plain
 * `node` with no `node_modules`. In memory: nothing is written.
 */
export async function buildRelayBytes(esbuild?: Esbuild, entry: string = relayEntry()): Promise<{ bytes: Uint8Array; version: string }> {
  // Not followed by an app's bundler (Next.js bundles this source in this repo's demo): esbuild is the build's, never a Function's.
  const { build } = esbuild ?? ((await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'esbuild')) as unknown as Esbuild);
  const result = await build({
    entryPoints: [entry],
    // The bundle's comments name its sources relative to here: the same bytes from any checkout.
    absWorkingDir: dirname(entry),
    write: false,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // `ws` is CommonJS; give the bundle a `require` so its internal require()s resolve.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  const out = result.outputFiles?.[0];
  if (!out || result.outputFiles!.length !== 1) throw new Error('harness-sandbox: the relay build gave no single file');
  const bytes = new Uint8Array(out.contents);
  return { bytes, version: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Build the bundle (`buildRelayBytes`) and write it to `outDir` (default a
 * fresh 0700 temp dir, so no other user of the host can plant or swap it)
 * as `relay-<version>.mjs`; returns its path, version and bytes.
 */
export async function buildRelayBundle(outDir?: string): Promise<RelayBundle> {
  if (outDir) mkdirSync(outDir, { recursive: true, mode: 0o700 });
  else outDir = mkdtempSync(join(tmpdir(), 'dh-relay-bundle-'));
  const { bytes, version } = await buildRelayBytes();
  const path = join(outDir, `relay-${version.slice(0, 16)}.mjs`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, version, bytes };
}

/** The directory a built bundle sits in, for a sibling config file. */
export function bundleDir(bundle: RelayBundle): string {
  return dirname(bundle.path);
}
