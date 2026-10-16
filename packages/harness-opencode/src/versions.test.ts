import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Unavailable } from 'harness-world';
import { describe, expect, it } from 'vitest';
import { checkOpenCodeVersions, EFFECT_HINT, installedVersion, loadedFromPackage, OPENCODE_INSTALL, OPENCODE_PINS } from './versions.ts';

/**
 * The pins the drive checks before it starts OpenCode: another OpenCode or
 * `effect` than the ones the harness is built with fails the turn with both
 * versions and the install line (pnpm only warns on a peer mismatch).
 * `versions-drive.test.ts` checks the drive does it first.
 */

const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, Record<string, string>>;

describe('the OpenCode pins', () => {
  it("are this package's dependencies and durable-harness's peer and dev dependencies", () => {
    const own = manifest('../package.json');
    const dh = manifest('../../durable-harness/package.json');
    for (const [name, version] of Object.entries(OPENCODE_PINS)) {
      expect(own.dependencies[name], name).toBe(version);
      expect(dh.peerDependencies[name], name).toBe(version);
      expect(dh.devDependencies[name], name).toBe(version);
    }
  });

  it('read the installed versions where the host imports them', () => {
    for (const [name, version] of Object.entries(OPENCODE_PINS)) expect(installedVersion(name), name).toBe(version);
    expect(installedVersion('@opencode/not-a-package')).toBeUndefined();
    expect(installedVersion('effect', 'data:text/javascript,')).toBeUndefined();
    expect(checkOpenCodeVersions()).toBeUndefined();
  });

  it('a mismatch is unavailable, naming both versions and the install line', () => {
    const err = checkOpenCodeVersions((name) => (name === 'effect' ? '4.0.2' : name === '@opencode/core' ? '2.0.26' : OPENCODE_PINS[name as keyof typeof OPENCODE_PINS]));
    expect(err).toBeInstanceOf(Unavailable);
    expect(err!.code).toBe('unavailable');
    expect(err!.message).toBe(
      'harness-world-opencode: installed @opencode/core 2.0.26 (expected 2.0.22), effect 4.0.2 (expected 4.0.0-rc.112): OpenCode runs only at the versions this harness is built with'
    );
    expect(err!.hint).toBe(`Install the pinned versions: ${OPENCODE_INSTALL}. ${EFFECT_HINT}`);
    // effect is not on the line: OpenCode's packages bring their own, and a bare effect would get a newer one.
    expect(OPENCODE_INSTALL).toBe('pnpm add @opencode/client@2.0.22 @opencode/core@2.0.22 @opencode/schema@2.0.22 @opencode/server@2.0.22');
  });

  it("another effect alone says to drop or pin the app's own, not to reinstall OpenCode", () => {
    const err = checkOpenCodeVersions((name) => (name === 'effect' ? '4.0.2' : OPENCODE_PINS[name as keyof typeof OPENCODE_PINS]));
    expect(err!.hint).toBe(EFFECT_HINT);
    expect(EFFECT_HINT).toBe(
      "OpenCode 2.0.22's packages bring effect 4.0.0-rc.112 themselves: remove effect from the app's dependencies, or pin it to 4.0.0-rc.112"
    );
  });

  it.each([
    ['npm', 'node_modules/durable-harness/dist', 'node_modules'],
    ['pnpm', 'node_modules/.pnpm/durable-harness@0.0.1/node_modules/durable-harness/dist', 'node_modules/.pnpm/durable-harness@0.0.1/node_modules'],
  ])("finds what an import from durable-harness's bundle finds, installed by %s", (_pm, dist, peers) => {
    const app = mkdtempSync(join(tmpdir(), 'oc-pins-app-'));
    const put = (dir: string, name: string, version: string) => {
      mkdirSync(join(app, dir, name), { recursive: true });
      writeFileSync(join(app, dir, name, 'package.json'), JSON.stringify({ name, version }));
    };
    mkdirSync(join(app, dist), { recursive: true });
    for (const [name, version] of Object.entries(OPENCODE_PINS)) put(peers, name, name === 'effect' ? '4.0.2' : version);
    // The app's own effect, which the bundle doesn't import, is not the one it checks.
    if (peers !== 'node_modules') put('node_modules', 'effect', '4.0.0-rc.112');
    const from = pathToFileURL(join(app, dist, 'opencode.js')).href;
    expect(checkOpenCodeVersions((name) => installedVersion(name, from))?.message).toBe(
      'harness-world-opencode: installed effect 4.0.2 (expected 4.0.0-rc.112): OpenCode runs only at the versions this harness is built with'
    );
  });

  it("a version it can't tell is not a mismatch (the import says what is missing)", () => {
    expect(checkOpenCodeVersions(() => undefined)).toBeUndefined();
  });

  it('are checked only where the harness was loaded from an installed package, not from a bundle or its source', () => {
    expect(loadedFromPackage(pathToFileURL(join(tmpdir(), 'app', 'node_modules', 'durable-harness', 'dist', 'opencode.js')).href)).toBe(true);
    expect(loadedFromPackage(pathToFileURL(join(tmpdir(), 'app', '.next', 'server', 'chunks', '123.js')).href)).toBe(false);
    expect(loadedFromPackage()).toBe(false); // this file, in the repo
    expect(loadedFromPackage('data:text/javascript,')).toBe(false);
  });
});
