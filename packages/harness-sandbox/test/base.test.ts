/**
 * The base recipe (docs/workspaces.md §5.2, §5.7), without a VM: what it
 * installs, that its pins are the lockfile's, and that its hash names every
 * input. The live suite (`live-session.test.ts`) builds it and boots from it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseName, baseRecipe, CLAUDE_CLI, CODEX_CLI } from '../src/base.ts';
import { RELAY_COMMAND, RELAY_CONFIG } from '../src/vm.ts';

const relay = { bytes: new TextEncoder().encode('// relay'), version: 'a'.repeat(64) };
const hex = (integrity: string) => Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');

describe('the base recipe', () => {
  it('pins the CLIs to the integrity pnpm-lock.yaml pins, and checks it before unpacking', () => {
    const lock = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    for (const [pkg, cli] of [
      ['@anthropic-ai/claude-agent-sdk-linux-x64@0.3.296', CLAUDE_CLI],
      ['@openai/codex@0.160.0-linux-x64', CODEX_CLI],
    ] as const) {
      const entry = new RegExp(`'${pkg.replace(/[/.@]/g, (c) => `\\${c}`)}':\\n\\s+resolution: \\{integrity: (sha512-[^}]+)\\}`).exec(lock);
      expect(entry?.[1], pkg).toBe(cli.integrity);
    }
    const { script } = baseRecipe(relay);
    for (const cli of [CLAUDE_CLI, CODEX_CLI]) {
      const fetchAt = script.indexOf(`fetch ${cli.url} ${hex(cli.integrity)}`);
      expect(fetchAt).toBeGreaterThan(-1);
      expect(script.indexOf(`-C ${cli.dir}`)).toBeGreaterThan(fetchAt);
    }
    expect(script).toContain('sha512sum -c');
  });

  it('installs the relay and its config root-owned under /opt/dh, and an agent user with no sudo', () => {
    const { script, files } = baseRecipe(relay);
    expect(script).toContain(`install -m 0644 -o root -g root relay.mjs /opt/dh/relay-${relay.version.slice(0, 16)}.mjs`);
    expect(script).toContain(`install -m 0644 -o root -g root relay.json ${RELAY_CONFIG}`);
    expect(script).toContain(`chown root:root ${RELAY_COMMAND} && chmod 0755 ${RELAY_COMMAND}`);
    expect(script).toContain('useradd -m -u 1001 -s /bin/bash agent');
    expect(script).toContain('rm -f /etc/sudoers.d/agent');
    expect(script).toContain('chown -R root:root /opt/dh && chmod -R go-w /opt/dh');
    // Codex's binary execute-only (app-server not dumpable: its environ, fds and socket out of the agent's reach); Claude's reads itself.
    expect(script).toContain(`chmod 0711 ${CODEX_CLI.dir}/${CODEX_CLI.bin}`);
    expect(script).toContain(`chmod 0755 ${CLAUDE_CLI.dir}/${CLAUDE_CLI.bin}`);
    expect(script).toContain('apt-get install -y -q bubblewrap socat');
    expect(script.trim().endsWith('echo DH_BASE_OK')).toBe(true);
    const config = JSON.parse(new TextDecoder().decode(files.find((f) => f.path.endsWith('relay.json'))!.content));
    expect(config).toMatchObject({ runAs: 'agent', cgroup: true, workspace: '/workspace', cacheRoot: '/var/lib/dh/s', stateDir: '/run/dh', cliVersions: { claude: '2.1.296', codex: '0.160.0' } });
  });

  it('is named by a hash over every input: another relay or another CLI set is another base', () => {
    const a = baseRecipe(relay);
    expect(baseRecipe(relay).hash).toBe(a.hash);
    expect(baseRecipe({ ...relay, version: 'b'.repeat(64) }).hash).not.toBe(a.hash);
    expect(baseRecipe(relay, { clis: [CLAUDE_CLI] }).hash).not.toBe(a.hash);
    expect(baseName(a, 'iad1')).toMatch(/^dh-base-iad1-[0-9a-f]{16}$/);
    expect(baseName(a, 'iad1').startsWith('dh-probe-')).toBe(false);
  });
});
