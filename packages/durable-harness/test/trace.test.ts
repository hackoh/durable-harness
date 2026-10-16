import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDurableHarness } from '../src/next.ts';
import { excludeLocalWorld } from '../src/trace.ts';

const ENV = ['VERCEL', 'VERCEL_DEPLOYMENT_ID', 'WORKFLOW_TARGET_WORLD', 'DURABLE_HARNESS_SKIP_TRIGGER_CHECK'];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
beforeEach(() => {
  for (const key of ENV) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
const onVercel = () => {
  process.env.VERCEL = '1';
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
};

function project(pkg: object = { name: 'app', private: true }, files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'durable-harness-trace-')));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
/** world-local's real directory, as durable-harness finds it. */
const localWorld = realpathSync(dirname(dirname(createRequire(import.meta.url).resolve('@workflow/world-local'))));

describe("world-local in a Vercel build's trace", () => {
  it('is excluded from every route on Vercel with its World: the links and the real directory', () => {
    onVercel();
    const dir = project();
    const globs = excludeLocalWorld({}, dir).outputFileTracingExcludes?.['/**'];
    expect(globs?.[0]).toBe('**/node_modules/@workflow/world-local/**');
    // Next joins an exclude with the project's directory.
    expect(join(dir, globs![1]!)).toBe(`${localWorld}/**`);
  });

  it('keeps the excludes the app has', () => {
    onVercel();
    const config = excludeLocalWorld({ outputFileTracingExcludes: { '/**': ['./big/**'], '/api/x': ['./y'] } }, project());
    expect(config.outputFileTracingExcludes?.['/api/x']).toEqual(['./y']);
    expect(config.outputFileTracingExcludes?.['/**']?.slice(0, 2)).toEqual(['./big/**', '**/node_modules/@workflow/world-local/**']);
  });

  it('stays anywhere else: locally, on another World, or when the app depends on world-local itself', () => {
    expect(excludeLocalWorld({}, project()).outputFileTracingExcludes).toBeUndefined();
    process.env.VERCEL = '1';
    expect(excludeLocalWorld({}, project()).outputFileTracingExcludes).toBeUndefined();
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres';
    expect(excludeLocalWorld({}, project()).outputFileTracingExcludes).toBeUndefined();
    delete process.env.WORKFLOW_TARGET_WORLD;
    expect(excludeLocalWorld({}, project({ name: 'app', dependencies: { '@workflow/world-local': '^5.1.1' } })).outputFileTracingExcludes).toBeUndefined();
  });

  it('withDurableHarness applies it to an app that makes an agent', () => {
    onVercel();
    const dir = project(undefined, {
      'lib/agent.ts': "import { claudeCode } from 'durable-harness/claude-code'\nexport const agent = claudeCode({ model: 'anthropic/claude-sonnet-4.5' })\n",
      'app/api/chat/route.ts': "import { agent } from '@/lib/agent'\nexport const { GET, POST } = agent.chatRoute()\n",
      'app/page.tsx': 'export default function Page() { return null }\n',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(applyDurableHarness({}, 'phase-production-build', dir).outputFileTracingExcludes?.['/**']).toContain('**/node_modules/@workflow/world-local/**');
    } finally {
      warn.mockRestore();
    }
  });
});
