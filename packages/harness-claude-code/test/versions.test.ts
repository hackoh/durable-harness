import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Unavailable } from 'harness-world';
import { CLAUDE_CLI } from 'harness-world-sandbox';
import { describe, expect, it } from 'vitest';
import { findClaudeExecutable, platformSuffix } from '../src/binary.ts';
import { isResumeDir } from '../src/spawn.ts';
import { CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, CLAUDE_VM_EXECUTABLE, checkAgentSdkVersion, installedVersion } from '../src/versions.ts';

/** The pins (the Agent SDK, the CLI in the image), the version check, and the host binary lookup: no network, no `claude`. */

const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, Record<string, string>>;

describe('the pins', () => {
  it("the Agent SDK pin is package.json's peer and dev dependency, and durable-harness's peer and dev dependency", () => {
    const own = manifest('../package.json');
    expect(own.peerDependencies['@anthropic-ai/claude-agent-sdk']).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(own.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe(CLAUDE_AGENT_SDK_VERSION);
    const dh = manifest('../../durable-harness/package.json');
    expect(dh.peerDependencies['@anthropic-ai/claude-agent-sdk']).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(dh.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it("the CLI pin is the one the pinned SDK bundles, and the one the base image installs, at the path the harness spawns", () => {
    expect(installedVersion('@anthropic-ai/claude-agent-sdk')).toBe(CLAUDE_AGENT_SDK_VERSION);
    const sdk = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')) as { claudeCodeVersion?: string };
    expect(sdk.claudeCodeVersion).toBe(CLAUDE_CODE_VERSION);
    expect(CLAUDE_CLI.version).toBe(CLAUDE_CODE_VERSION);
    expect(`${CLAUDE_CLI.dir}/${CLAUDE_CLI.bin}`).toBe(CLAUDE_VM_EXECUTABLE);
    expect(CLAUDE_CLI.url).toContain(`claude-agent-sdk-linux-x64-${CLAUDE_AGENT_SDK_VERSION}.tgz`);
  });

  it('the installed SDK matches the pin; a mismatch is unavailable, naming both versions and the install line', () => {
    expect(checkAgentSdkVersion()).toBeUndefined();
    const err = checkAgentSdkVersion(() => '0.3.299');
    expect(err).toBeInstanceOf(Unavailable);
    expect(err!.code).toBe('unavailable');
    expect(err!.message).toBe(`harness-world-claude-code: installed @anthropic-ai/claude-agent-sdk 0.3.299 (expected ${CLAUDE_AGENT_SDK_VERSION}): Claude Code runs only with the Agent SDK this harness is built with`);
    expect(err!.hint).toBe(`Install the pinned version: ${CLAUDE_AGENT_SDK_INSTALL}`);
    expect(CLAUDE_AGENT_SDK_INSTALL).toBe(`pnpm add @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`);
    // Not installed at all: the import says so itself.
    expect(checkAgentSdkVersion(() => undefined)).toBeUndefined();
  });

  it("only a claude-resume dir directly under the Function's tmpdir is the SDK's resume dir", () => {
    expect(isResumeDir(join(tmpdir(), 'claude-resume-1'))).toBe(true);
    expect(isResumeDir(join(tmpdir(), 'x', 'claude-resume-1'))).toBe(false);
    expect(isResumeDir('/etc')).toBe(false);
    expect(isResumeDir(join(tmpdir(), 'other'))).toBe(false);
  });
});

const pkg = `claude-agent-sdk-${platformSuffix()}`;

async function binaryAt(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'claude'), '#!/bin/sh\n');
  await chmod(join(dir, 'claude'), 0o755);
  return join(dir, 'claude');
}

describe('findClaudeExecutable (the host build, for the stand-in VM)', () => {
  it('finds only the pinned version in a pnpm store, and nothing rather than another one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwcc-bin-'));
    const store = join(root, 'node_modules', '.pnpm');
    await binaryAt(join(store, `@anthropic-ai+${pkg}@0.3.1`, 'node_modules', '@anthropic-ai', pkg));
    const deep = join(root, 'apps', 'demo');
    await mkdir(deep, { recursive: true });
    expect(findClaudeExecutable(deep)).toBeUndefined();
    const pinned = await binaryAt(join(store, `@anthropic-ai+${pkg}@${CLAUDE_AGENT_SDK_VERSION}`, 'node_modules', '@anthropic-ai', pkg));
    await binaryAt(join(store, `@anthropic-ai+${pkg}@${CLAUDE_AGENT_SDK_VERSION}9`, 'node_modules', '@anthropic-ai', pkg));
    expect(findClaudeExecutable(deep)).toBe(pinned);
  });

  it('a hoisted package counts when its version is the pinned one, or when only the binary was copied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwcc-bin-'));
    const hoisted = join(root, 'node_modules', '@anthropic-ai', pkg);
    const bin = await binaryAt(hoisted);
    expect(findClaudeExecutable(root)).toBe(bin);
    await writeFile(join(hoisted, 'package.json'), JSON.stringify({ version: '0.3.1' }));
    expect(findClaudeExecutable(root)).toBeUndefined();
    await writeFile(join(hoisted, 'package.json'), JSON.stringify({ version: CLAUDE_AGENT_SDK_VERSION }));
    expect(findClaudeExecutable(root)).toBe(bin);
  });

  it('HARNESS_CLAUDE_CODE_EXECUTABLE wins', () => {
    process.env.HARNESS_CLAUDE_CODE_EXECUTABLE = '/opt/claude';
    try {
      expect(findClaudeExecutable('/')).toBe('/opt/claude');
    } finally {
      delete process.env.HARNESS_CLAUDE_CODE_EXECUTABLE;
    }
  });

  it("finds this repo's own installed binary", () => {
    expect(findClaudeExecutable()).toContain(`@anthropic-ai+${pkg}@${CLAUDE_AGENT_SDK_VERSION}`);
  });
});
