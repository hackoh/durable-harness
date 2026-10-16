import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNRELEASED } from '../src/unreleased.ts';

/**
 * The release gate (scripts/check-dist.mjs, docs/workspaces.md §6 rule 2)
 * against small built packages that break one rule each: it must fail on an
 * unbranded build (a builder that hands back a harness for a hand-written
 * machine, a drive that never checks the brand, the brand claimed twice), on
 * a published stand-in, on a stub, and on a missing relay bundle. The real
 * build passes it in the release job (`pnpm ci:publish`), where its relay's
 * `modelAuth` is checked too.
 */

const SCRIPT = join(import.meta.dirname, '../scripts/check-dist.mjs');
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { publishConfig: { exports: Record<string, string | Record<string, string>> } };

/** A relay-sized stand-in for the shipped bundle: the gate checks its hash and shape, not what it does (a real relay is armed on Linux). */
async function shippedRelayModule(): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { gzipSync } = await import('node:zlib');
  const bytes = Buffer.from(`import { createRequire as __cr } from 'node:module';\n${'// relay\n'.repeat(8000)}`);
  const version = createHash('sha256').update(bytes).digest('hex');
  return `export const SHIPPED_RELAY = Object.freeze({ marker: 'dh-shipped-relay-bundle/v1', version: ${JSON.stringify(version)}, gzip: ${JSON.stringify(gzipSync(bytes).toString('base64'))} });\n`;
}

/** The builders as the real ones behave: each refuses everything but workspace: sandbox(). */
const REFUSING = `export function claudeCodeHarness() { throw new TypeError('no'); }\nexport function claudeCode() { throw new TypeError('no'); }\nexport function codexHarness() { throw new TypeError('no'); }\nexport function codex() { throw new TypeError('no'); }\n`;

/** The drives as esbuild prints them: each refusal thrown by the drive's brand check. */
const CLAUDE_DRIVE = "import { isBrandedMachine } from './chunk-brand.js';\nfunction sandboxRequired() {\n  return new Error('Claude Code runs only in a Vercel Sandbox: pass workspace: sandbox()');\n}\nconst drive = (m) => {\n  if (!isBrandedMachine(m)) throw sandboxRequired();\n};\n";
const CODEX_DRIVE = "import { isBrandedMachine } from './chunk-brand.js';\nfunction sandboxRequired(why) {\n  return new Error(why);\n}\nconst drive = async (m) => {\n  if (!isBrandedMachine(m)) {\n    await m?.close?.().catch(() => {});\n    throw sandboxRequired(\"the machine it was given is not one the sandbox tier's session factory made.\");\n  }\n};\n";

/** A package with every published entry, the brand claimed once by the session factory, both drives checking it, and a relay bundle; `files` replaces or adds files of dist. */
async function built(files: Record<string, string> = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dh-release-gate-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'durable-harness', dependencies: {}, peerDependencies: {}, publishConfig: manifest.publishConfig }));
  const dist: Record<string, string> = {};
  for (const target of Object.values(manifest.publishConfig.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) if (path.startsWith('./dist/')) dist[path.slice('./dist/'.length)] = '';
  }
  Object.assign(dist, {
    'index.js': "export const virtual = () => ({ kind: 'virtual' });\nexport const sandbox = () => ({ kind: 'sandbox' });\n",
    'claude-code.js': `${REFUSING.split('\n').slice(0, 2).join('\n')}\n`,
    'codex.js': `${REFUSING.split('\n').slice(2).join('\n')}\n`,
    'chunk-brand.js': "function machineBrand() {\n  throw new Error('harness-world-process: the session machine brand is already claimed');\n}\nfunction isBrandedMachine(v) { return !!v; }\nexport { machineBrand, isBrandedMachine };\n",
    'chunk-session.js': "import { machineBrand } from './chunk-brand.js';\n// ../harness-sandbox/src/session.ts\nvar brandMachine = machineBrand();\n",
    'chunk-claude.js': CLAUDE_DRIVE,
    'chunk-codex.js': CODEX_DRIVE,
    'relay-bundle.js': await shippedRelayModule(),
    ...files,
  });
  for (const [path, text] of Object.entries(dist)) {
    mkdirSync(dirname(join(root, 'dist', path)), { recursive: true });
    writeFileSync(join(root, 'dist', path), text);
  }
  return root;
}

/** Run the gate on a package (never arming a relay: the fixtures' isn't one). */
function gate(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, DH_RELEASE_GATE: '' }, timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const linux = process.platform === 'linux';

describe('the release gate (check-dist.mjs)', () => {
  it.skipIf(linux)('passes a build that keeps every rule', async () => {
    const r = gate(await built());
    expect(r.out).toMatch(/Claude Code and Codex need a branded machine, and the relay bundle ships/);
    expect(r.code).toBe(0);
  });

  it('fails while claudeCodeHarness()/codexHarness() can be built for a hand-written machine', async () => {
    const r = gate(await built({ 'claude-code.js': 'export const claudeCodeHarness = (o) => ({ name: "claude-code", o });\nexport const claudeCode = () => ({});\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claudeCodeHarness\(\{ sandbox \}\) builds a harness from dist/);
    expect(r.out).toMatch(/claudeCodeHarness\(\{ workspace: virtual\(\) \}\) builds a harness from dist/);
  });

  it("fails on a drive that never checks the machine brand, and on a brand claimed outside the session factory or twice", async () => {
    const unchecked = gate(await built({ 'chunk-codex.js': "const drive = () => { throw new Error(\"the machine it was given is not one the sandbox tier's session factory made.\"); };\n" }));
    expect(unchecked.code).toBe(1);
    expect(unchecked.out).toMatch(/chunk-codex\.js has Codex's refusal, but not as the throw of a drive's brand check/);
    // The brand checked somewhere in the file, but the refusal no longer thrown by it: still a failure.
    const moved = gate(await built({ 'chunk-claude.js': CLAUDE_DRIVE.replace('if (!isBrandedMachine(m)) throw sandboxRequired();', 'isBrandedMachine(m);\n  if (!m) throw sandboxRequired();') }));
    expect(moved.code).toBe(1);
    expect(moved.out).toMatch(/chunk-claude\.js has Claude Code's refusal, but not as the throw of a drive's brand check/);
    const twice = gate(await built({ 'chunk-other.js': "import { machineBrand } from './chunk-brand.js';\nvar mine = machineBrand();\n" }));
    expect(twice.code).toBe(1);
    expect(twice.out).toMatch(/claimed 2 times at load/);
    const outside = gate(await built({ 'chunk-session.js': "import { machineBrand } from './chunk-brand.js';\n// ../harness-claude-code/src/harness.ts\nvar brandMachine = machineBrand();\n" }));
    expect(outside.code).toBe(1);
    expect(outside.out).toMatch(/claimed outside the session factory/);
    const none = gate(await built({ 'chunk-claude.js': '' }));
    expect(none.out).toMatch(/Claude Code's refusal of an unbranded machine \(sandbox_required\) is in no published file/);
  });

  it('fails on a published stand-in: a test module, brandForTests, the fake Sandbox API', async () => {
    const module = gate(await built({ 'chunk-test.js': '// ../harness-sandbox/test/local-machine.ts\nexport const x = 1;\n' }));
    expect(module.code).toBe(1);
    expect(module.out).toMatch(/chunk-test\.js carries a test module \(\.\.\/harness-sandbox\/test\/local-machine\.ts\)/);
    const brand = gate(await built({ 'chunk-x.js': 'export function brandForTests(m) { return m; }\n' }));
    expect(brand.code).toBe(1);
    expect(brand.out).toMatch(/carries brandForTests/);
    const api = gate(await built({ 'chunk-y.js': 'export class FakeSandboxApi {}\n' }));
    expect(api.out).toMatch(/carries FakeSandboxApi/);
  });

  it('fails while a stub remains, and without the relay bundle or with one that does not match its hash', async () => {
    const stub = gate(await built({ 'sandbox.js': `throw new Error(${JSON.stringify(UNRELEASED)});\n` }));
    expect(stub.code).toBe(1);
    expect(stub.out).toMatch(/sandbox\.js still holds a stub/);
    const missing = gate(await built({ 'relay-bundle.js': '' }));
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/the relay bundle is in 0 files of dist/);
    const forged = gate(await built({ 'relay-bundle.js': (await shippedRelayModule()).replace(/version: "[0-9a-f]+"/, `version: "${'0'.repeat(64)}"`) }));
    expect(forged.code).toBe(1);
    expect(forged.out).toMatch(/does not match its hash/);
  });
});
