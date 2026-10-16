import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { workspaceTools } from 'harness-world-hands';
import { sessionName } from 'harness-world-sandbox';
import type { FakeSandboxApi } from 'harness-world-sandbox/testing/fake-api';
import { afterEach, describe, expect, it } from 'vitest';
import { durableEnv, nativeModelId } from '../src/env.ts';
import { CLAUDE_BUILTINS, CLAUDE_BUILTINS_OFF, claudeCodeHarness } from '../src/harness.ts';
import { childEnv, mapMirrorPath, resumeFiles, rewriteMirror } from '../src/spawn.ts';
import { standIn } from './stand-in.ts';

const apis: FakeSandboxApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.dispose();
});

const VM = { home: '/var/lib/dh/s/home', configDir: '/var/lib/dh/s/config', tmpDir: '/var/lib/dh/s/tmp', cacheDir: '/var/lib/dh/s/cache', baseUrl: 'http://127.0.0.1:4100', token: 'dhm-fake-attach-key' };

describe('durableEnv (the CLI in the VM)', () => {
  it("is explicit: the VM's cache dirs, the VM's PATH, the model port with the attach's key, the projects key fixed, the unmirrored state off", () => {
    const env = durableEnv({ ...VM, model: 'claude-haiku-4-5' });
    expect(env).toMatchObject({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: VM.home,
      TMPDIR: VM.tmpDir,
      CLAUDE_CONFIG_DIR: VM.configDir,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'session',
      XDG_CACHE_HOME: VM.cacheDir,
      XDG_CONFIG_HOME: `${VM.home}/.config`,
      ANTHROPIC_BASE_URL: VM.baseUrl,
      ANTHROPIC_AUTH_TOKEN: VM.token,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      // No git of the CLI's own in /workspace (a planted .git/config would run outside Claude's sandbox).
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    });
    // Nothing of the Function: not its PATH, not a key it holds.
    expect(env.PATH).not.toBe(process.env.PATH);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("the app's sandbox({ env }) goes under everything the harness sets: it can't move the model port, the key, a path or a durability flag", () => {
    const env = durableEnv({ ...VM, model: 'm', extra: { FOO: '1', ANTHROPIC_BASE_URL: 'http://elsewhere', HOME: '/root', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } });
    expect(env).toMatchObject({ FOO: '1', ANTHROPIC_BASE_URL: VM.baseUrl, HOME: VM.home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('a command timeout caps Bash (and its default, when lower)', () => {
    expect(durableEnv({ ...VM, model: 'm', bashTimeoutMs: 600_000 })).toMatchObject({ BASH_MAX_TIMEOUT_MS: '600000', BASH_DEFAULT_TIMEOUT_MS: '120000' });
    expect(durableEnv({ ...VM, model: 'm', bashTimeoutMs: 30_000 })).toMatchObject({ BASH_MAX_TIMEOUT_MS: '30000', BASH_DEFAULT_TIMEOUT_MS: '30000' });
  });

  it('nativeModelId turns a Gateway id into the native one', () => {
    expect(nativeModelId('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(nativeModelId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(nativeModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(nativeModelId('openai/gpt-5')).toBe('openai/gpt-5');
  });
});

describe("sandboxSpawn's checks (the SDK's spawn, before anything reaches the VM)", () => {
  const given: Record<string, string> = { ...durableEnv({ ...VM, model: 'm' }), CLAUDE_CONFIG_DIR: '/fn/config' };
  const sdk: Record<string, string> = { ...given, CLAUDE_AGENT_SDK_VERSION: '0.3.296', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' };

  it("the child gets the harness's env, the SDK's markers, and the VM's config dir in place of the Function's", () => {
    const env = childEnv(given, sdk, VM.configDir);
    expect(env).toEqual({ ...sdk, CLAUDE_CONFIG_DIR: VM.configDir });
  });

  it('refuses a missing env (the SDK would pass the Function\'s), a variable the harness never set, a changed or dropped one, and a config dir it did not give', () => {
    expect(() => childEnv(given, undefined, VM.configDir)).toThrow(/passed no env/);
    expect(() => childEnv(given, { ...sdk, AI_GATEWAY_API_KEY: 'x' }, VM.configDir)).toThrow(/added "AI_GATEWAY_API_KEY"/);
    expect(() => childEnv(given, { ...sdk, ANTHROPIC_BASE_URL: 'http://evil' }, VM.configDir)).toThrow(/changed the spawn env "ANTHROPIC_BASE_URL"/);
    const { HOME: _home, ...dropped } = sdk;
    expect(() => childEnv(given, dropped, VM.configDir)).toThrow(/dropped "HOME"/);
    expect(() => childEnv(given, { ...sdk, CLAUDE_CONFIG_DIR: '/etc' }, VM.configDir)).toThrow(/config dir the harness did not give it/);
    expect(() => childEnv(given, { ...sdk, CLAUDE_CODE_ENTRYPOINT: 'a b;c' }, VM.configDir)).toThrow(/unexpected value/);
    // The SDK's resume dir under the Function's tmpdir is the one other config dir it may choose.
    expect(childEnv(given, { ...sdk, CLAUDE_CONFIG_DIR: join(tmpdir(), 'claude-resume-1234') }, VM.configDir).CLAUDE_CONFIG_DIR).toBe(VM.configDir);
  });

  it("the mirror's path is mapped to the Function's projects dir, and stays there", () => {
    expect(mapMirrorPath(`${VM.configDir}/projects/session/abc.jsonl`, VM.configDir, '/fn/config')).toEqual({ path: '/fn/config/projects/session/abc.jsonl' });
    expect(mapMirrorPath(`${VM.configDir}/projects/session/subagents/agent-1.jsonl`, VM.configDir, '/fn/config')).toEqual({ path: '/fn/config/projects/session/subagents/agent-1.jsonl' });
    for (const bad of [`${VM.configDir}/settings.json`, `${VM.configDir}/projects/../.credentials.json`, `${VM.configDir}/projects/session/../../x`, `${VM.configDir}/projects//x`, '/etc/passwd', `${VM.configDir}/projects/`, 42, `${VM.configDir}/projects/a\\..\\b`])
      expect(mapMirrorPath(bad, VM.configDir, '/fn/config')).toHaveProperty('why');
  });

  it('a transcript_mirror line is rewritten; any other line is not touched; one that does not map is reported, not passed on', () => {
    const line = JSON.stringify({ type: 'transcript_mirror', filePath: `${VM.configDir}/projects/session/abc.jsonl`, entries: [{ type: 'user', uuid: 'u' }] });
    expect(JSON.parse(rewriteMirror(line, VM.configDir, '/fn/config') as string)).toEqual({ type: 'transcript_mirror', filePath: '/fn/config/projects/session/abc.jsonl', entries: [{ type: 'user', uuid: 'u' }] });
    expect(rewriteMirror('{"type":"assistant"}', VM.configDir, '/fn/config')).toBeUndefined();
    expect(rewriteMirror(JSON.stringify({ type: 'transcript_mirror', filePath: '/etc/x' }), VM.configDir, '/fn/config')).toHaveProperty('why');
    expect(rewriteMirror('{"type":"transcript_mirror",', VM.configDir, '/fn/config')).toHaveProperty('why');
  });

  it('a mirror frame is told by what the SDK parses, not by its bytes: keys in another order, whitespace, an escaped type are frames too, and are checked', () => {
    const outside = { filePath: '/etc/elsewhere/abc.jsonl', entries: [{ type: 'user', uuid: 'u' }] };
    const inside = { filePath: `${VM.configDir}/projects/session/abc.jsonl`, entries: [{ type: 'user', uuid: 'u' }] };
    const variants = (frame: Record<string, unknown>) => [
      JSON.stringify({ ...frame, type: 'transcript_mirror' }),
      `  ${JSON.stringify({ type: 'transcript_mirror', ...frame })}`,
      JSON.stringify({ type: 'transcript_mirror', ...frame }, null, 1).replace(/\n/g, ' '),
      JSON.stringify({ ...frame, type: 'transcript_mirror' }).replace('"transcript_mirror"', '"transcript\\u005fmirror"'),
    ];
    for (const line of variants(outside)) expect(rewriteMirror(line, VM.configDir, '/fn/config'), line).toHaveProperty('why');
    for (const line of variants(inside)) {
      const out = rewriteMirror(line, VM.configDir, '/fn/config');
      expect(typeof out, line).toBe('string');
      expect(JSON.parse(out as string)).toMatchObject({ type: 'transcript_mirror', filePath: '/fn/config/projects/session/abc.jsonl' });
    }
    // Text that only mentions the word is no frame.
    expect(rewriteMirror(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a "transcript_mirror" frame' }] } }), VM.configDir, '/fn/config')).toBeUndefined();
    expect(rewriteMirror(JSON.stringify({ type: 'stream_event', transcript_mirror: 1 }), VM.configDir, '/fn/config')).toBeUndefined();
  });

  it('resume files: only projects/** leaves the Function, regular files only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-resume-'));
    await mkdir(join(dir, 'projects', 'session', 'subagents'), { recursive: true });
    await writeFile(join(dir, 'projects', 'session', 'abc.jsonl'), '{"type":"user"}\n');
    await writeFile(join(dir, 'projects', 'session', 'subagents', 'agent-1.jsonl'), '{}\n');
    expect((await resumeFiles(dir)).map((f) => f.path).sort()).toEqual(['projects/session/abc.jsonl', 'projects/session/subagents/agent-1.jsonl']);
    await writeFile(join(dir, '.credentials.json'), '{}');
    await expect(resumeFiles(dir)).rejects.toThrow(/holds "\.credentials\.json": only projects/);
    const other = await mkdtemp(join(tmpdir(), 'claude-resume-'));
    await mkdir(join(other, 'projects'));
    await symlink('/etc/hosts', join(other, 'projects', 'link'));
    await expect(resumeFiles(other)).rejects.toThrow(/not a regular file/);
  });
});

describe('the spawn on the stand-in VM (the real Agent SDK, a stand-in claude binary)', () => {
  /** A stand-in for the `claude` binary: it records what it was started with in the VM, and exits. */
  const fakeClaude = async () => {
    const fake = join(await mkdtemp(join(tmpdir(), 'hwcc-fake-claude-')), 'claude');
    await writeFile(
      fake,
      `#!${process.execPath}
require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'child.json'), JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(1);
`
    );
    await chmod(fake, 0o755);
    return fake;
  };

  const run = async (builtins: boolean) => {
    const fake = await fakeClaude();
    const { api, sandbox } = standIn();
    apis.push(api);
    const saved = { ...process.env };
    Object.assign(process.env, { AI_GATEWAY_API_KEY: 'fake-parent-gateway-key', VERCEL_OIDC_TOKEN: 'fake-parent-oidc-token', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'fake-parent-anthropic-key' });
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwcc-env-')), recoverActiveRuns: false });
    try {
      const sessions = durableSessions({
        world,
        harness: claudeCodeHarness({ tools: workspaceTools(), builtins, sandbox, executable: fake, model: 'anthropic/claude-haiku-4.5', credential: async () => 'fake-never-reaches-the-vm', unsandboxedCommands: true }),
      });
      world.registerHandler(QUEUE_PREFIX, sessions.handler);
      await world.start?.();
      const { sessionId } = await sessions.start();
      await sessions.send(sessionId, 'hello');
      const name = sessionName('prj_stand_in', sessionId);
      const home = () => api.relayOf(name)?.config.cacheRoot;
      let file = '';
      for (let i = 0; i < 400; i++) {
        const root = home();
        if (root && existsSync(join(root, 'home', 'child.json'))) {
          file = join(root, 'home', 'child.json');
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const child = JSON.parse(readFileSync(file, 'utf8')) as { env: Record<string, string>; argv: string[]; cwd: string };
      return { child, cache: home()!, drive: api.driveDir(name) };
    } finally {
      await world.close?.();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it("no builtins line: the VM's durable env and the built-ins-off flags, nothing of the Function: no key, no token, no parent Claude Code session", async () => {
    const { child, cache, drive } = await run(false);
    expect(child.env).toMatchObject({ HOME: join(cache, 'home'), TMPDIR: join(cache, 'tmp'), CLAUDE_CONFIG_DIR: join(cache, 'config'), ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-haiku-4-5', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
    // Its key is the attach's model key; its base URL the VM's model port.
    expect(child.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^dhm-/);
    expect(child.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    for (const secret of ['fake-parent-gateway-key', 'fake-parent-oidc-token', 'fake-parent-anthropic-key', 'fake-never-reaches-the-vm']) expect(Object.values(child.env)).not.toContain(secret);
    expect(child.env.CLAUDECODE).toBeUndefined();
    expect(child.env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(child.cwd.replace(/^\/private/, '')).toBe(drive.replace(/^\/private/, ''));
    // Built-ins off (the default), no settings files, only the bridged tools allowed, the native model id.
    const at = (flag: string) => child.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? child.argv[child.argv.indexOf(flag) + 1];
    expect(at('--tools')).toBe('');
    expect(child.argv).toContain('--setting-sources=');
    expect(child.argv).toContain('--strict-mcp-config');
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--model')).toBe('claude-haiku-4-5');
    expect(at('--allowedTools')!.split(',')).toEqual(workspaceTools().map((t) => `mcp__hands__${t.name}`));
    expect(at('--disallowedTools')!.split(',')).toEqual([...CLAUDE_BUILTINS_OFF, 'WebSearch']);
    expect(child.argv.some((a) => a.startsWith('--resume'))).toBe(false);
  }, 30_000);

  it("builtins: true: the pinned allowlist, and the stateful ones off", async () => {
    const { child } = await run(true);
    const at = (flag: string) => child.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? child.argv[child.argv.indexOf(flag) + 1];
    expect(at('--tools')!.split(',')).toEqual([...CLAUDE_BUILTINS]);
    expect(at('--disallowedTools')!.split(',')).toEqual([...CLAUDE_BUILTINS_OFF, 'WebSearch']);
    expect(at('--permission-mode')).toBe('dontAsk');
  }, 30_000);
});
