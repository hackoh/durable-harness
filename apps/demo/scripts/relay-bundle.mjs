/**
 * The relay bundle a `sandbox()` session's VM installs, built from this
 * checkout's source for the demo's `next build` (next.config.ts): the demo
 * runs durable-harness from source, whose `src/relay-bundle.ts` ships none,
 * and a deployed Function never builds one (`relayArtifact`). This prints
 * that module as a published build fills it in (durable-harness's
 * tsup.config.ts): the bundle, gzipped and base64'd into the JavaScript,
 * under `RELAY_MARKER`, with its sha256 as its version.
 *
 * Run by next.config.ts at build time only, in a process of its own (Node
 * strips the TypeScript of the two source modules it imports).
 */
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { RELAY_MARKER } from '../../../packages/durable-harness/src/relay-bundle.ts';
import { buildRelayBytes, relayEntry } from '../../../packages/harness-sandbox/src/relay/bundle.ts';

const { bytes, version } = await buildRelayBytes(esbuild, relayEntry());
process.stdout.write(
  [
    "// The relay bundle, built by the demo's next build (apps/demo/scripts/relay-bundle.mjs): src/relay-bundle.ts in the source.",
    `export const RELAY_MARKER = ${JSON.stringify(RELAY_MARKER)};`,
    `export const SHIPPED_RELAY = Object.freeze({ marker: RELAY_MARKER, version: ${JSON.stringify(version)}, gzip: ${JSON.stringify(gzipSync(bytes, { level: 9 }).toString('base64'))} });`,
    '',
  ].join('\n')
);
