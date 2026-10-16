/**
 * The relay bundle a published build ships (docs/workspaces.md §5.7, As
 * built (A7)): the in-VM relay and helper, one `.mjs` with `ws` inlined, that
 * the base snapshot installs at `/opt/dh/relay-<hash>.mjs`. Gzipped and
 * base64'd here, so it rides in the JavaScript itself and every bundler and
 * file tracer carries it (no file next to the module to trace).
 *
 * In this repo's source there is none: `relayArtifact` (environments.ts)
 * builds it with esbuild. The build (`tsup.config.ts`) replaces this module
 * with the bundle it built at that moment, so a deployed Function never
 * builds it. `marker` lets the release gate (`scripts/check-dist.mjs`) find
 * it in `dist`.
 */
export interface ShippedRelay {
  /** `RELAY_MARKER`. */
  readonly marker: string;
  /** sha256 of the bundle's bytes (before gzip), hex. */
  readonly version: string;
  /** The bundle, gzipped, base64. */
  readonly gzip: string;
}

/** What the release gate looks for. */
export const RELAY_MARKER = 'dh-shipped-relay-bundle/v1';

export const SHIPPED_RELAY: ShippedRelay | undefined = undefined;
