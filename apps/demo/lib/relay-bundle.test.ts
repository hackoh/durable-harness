import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The demo's `next build` ships the relay bundle a `sandbox()` session's
 * base installs (next.config.ts `relayBundleRule`): durable-harness from
 * source ships none, and a deployed Function refuses to build one. The
 * module the build swaps in for durable-harness's `src/relay-bundle.ts`
 * must be what a published build ships: the bundle, under its marker, its
 * version the sha256 of its bytes, and the same bundle a laptop builds.
 */
describe("the relay bundle the demo's build ships", () => {
  it('is the module a published build fills in, with the bundle a dev build of the relay makes', { timeout: 60_000 }, async () => {
    const script = fileURLToPath(new URL('../scripts/relay-bundle.mjs', import.meta.url));
    const code = execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    // The module imports nothing: load it as it is, from a data: URL.
    const shipped = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
      RELAY_MARKER: string;
      SHIPPED_RELAY?: { marker: string; version: string; gzip: string };
    };
    expect(shipped.RELAY_MARKER).toBe('dh-shipped-relay-bundle/v1');
    expect(shipped.SHIPPED_RELAY?.marker).toBe(shipped.RELAY_MARKER);
    expect(Object.isFrozen(shipped.SHIPPED_RELAY)).toBe(true);
    const bytes = gunzipSync(Buffer.from(shipped.SHIPPED_RELAY!.gzip, 'base64'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(shipped.SHIPPED_RELAY!.version);
    // The bundle itself: an ES module with ws inlined, for plain `node` in the VM.
    expect(bytes.toString('utf8')).toContain("import { createRequire as __cr } from 'node:module'");
    const { devRelayArtifact } = await import('harness-world-sandbox');
    expect((await devRelayArtifact()).version).toBe(shipped.SHIPPED_RELAY!.version);
  });
});
