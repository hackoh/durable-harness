import { describe, expect, it, vi } from 'vitest';
import { codex, codexHarness } from '../src/codex.ts';
import { workspaceTools } from '../src/tools.ts';
import { sandbox, virtual } from '../src/workspace.ts';

/** What the raw harness was built with: the wrappers' `machine`, checked below (A0 deferred "the wrappers pass machine through" to A6). */
const built = vi.hoisted(() => [] as Record<string, any>[]);
const resolved = vi.hoisted(() => [] as unknown[]);
vi.mock('harness-world-codex', async (original) => {
  const m = await original<typeof import('harness-world-codex')>();
  return { ...m, codexHarness: (options: Record<string, any>) => (built.push(options), m.codexHarness(options)) };
});
vi.mock('../src/environments.ts', async (original) => {
  const m = await original<typeof import('../src/environments.ts')>();
  return { ...m, resolveEnvironment: (w: never) => ((r) => (resolved.push(r.acquire), r))(m.resolveEnvironment(w) as unknown as { acquire: unknown }) };
});

/**
 * `codex()` and `codexHarness()` (docs/workspaces.md §3.3, §3.4): Codex runs
 * only in the session's Vercel Sandbox, so the workspace is `sandbox()` by
 * default and nothing else; the removed host options throw, naming what
 * replaced them; the workspace tool sets are refused (in its VM Codex uses
 * its own tools). What a drive does on a sandbox is harness-world-codex's
 * suite, on the stand-in.
 */
describe('codex()', () => {
  it('takes sandbox() by default, and refuses virtual()', () => {
    expect(() => codex({ model: 'openai/gpt-5.4-mini' })).not.toThrow();
    expect(() => codexHarness({ workspace: sandbox({ network: 'deny-all' }) })).not.toThrow();
    expect(() => codex({ model: 'openai/gpt-5.4-mini', workspace: virtual() as never })).toThrow(/runs only in a Vercel Sandbox/);
    expect(() => codexHarness({ workspace: { ...sandbox() } as never })).toThrow(TypeError);
  });

  it('refuses the removed options with their replacement, and the internal ones', () => {
    for (const [key, value] of [['sandbox', 'workspace-write'], ['host', {}], ['cwd', '/x'], ['bin', 'codex'], ['env', {}], ['keepSessionDir', true], ['workspaceNote', false]] as const) {
      expect(() => codex({ model: 'm', [key]: value } as never)).toThrow(new RegExp(`the ${key} option is gone`));
    }
    expect(() => codexHarness({ machine: { acquire: async () => ({}) as never } } as never)).toThrow(/internal/);
    expect(() => codexHarness({ test: { command: 'node' } } as never)).toThrow(/internal/);
    expect(() => codex({ model: 'm', sandboxMode: 'workspace-write' })).toThrow(/needs builtins: true/);
    expect(() => codex({ model: 'm', builtins: true, sandboxMode: 'danger-full-access' })).not.toThrow();
  });

  it("passes the resolved sandbox() acquire and the descriptor's env, network, budget and commandTimeoutMs into the raw harness's machine", () => {
    built.length = 0;
    resolved.length = 0;
    const workspace = sandbox({ env: { NODE_ENV: 'production', GIT_AUTHOR_NAME: 'Agent' }, network: { allow: ['api.example.com'] }, budget: { turnUsd: 1, sessionUsd: 5 }, commandTimeoutMs: 60_000 });
    codex({ model: 'openai/gpt-5.4-mini', builtins: true, workspace });
    expect(built).toHaveLength(1);
    const { machine, workspace: leaked, ...rest } = built[0]!;
    expect(leaked).toBeUndefined();
    expect(rest).toMatchObject({ model: 'openai/gpt-5.4-mini', builtins: true });
    expect(machine).toEqual({ acquire: resolved[0], env: workspace.env, network: workspace.network, budget: workspace.budget, commandTimeoutMs: 60_000 });
    expect(typeof machine.acquire).toBe('function');
    // The default: sandbox(), its own acquire.
    codexHarness();
    expect(built[1]!.machine.acquire).toBe(resolved[1]);
    expect(built[1]!.machine.acquire).not.toBe(machine.acquire);
  });

  it("refuses config keys the harness sets, and the workspace tool sets (Codex's own tools are builtins: true)", () => {
    expect(() => codex({ model: 'm', config: { approval_policy: 'never' } })).toThrow(/reserved/);
    expect(() => codex({ model: 'm', tools: workspaceTools() })).toThrow(/workspace tool/);
  });
});
