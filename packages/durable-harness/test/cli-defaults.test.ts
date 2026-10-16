import { describe, expect, it } from 'vitest';
import { workspaceTools } from '../src/tools.ts';

/**
 * `claudeCode()`'s checks, at construction (the harness's own defaults, tool-less
 * with no builtins line, are harness-world-claude-code's tests, on the stand-in
 * VM): Claude Code runs only in the session's sandbox.
 */
describe('claudeCode() and claudeCodeHarness(): only in the session\'s sandbox', () => {
  it('defaults workspace to sandbox(), and touches nothing until a session drives (the factory loads on the first attach)', async () => {
    const { claudeCode, claudeCodeHarness } = await import('../src/claude-code.ts');
    expect(() => claudeCode({ name: 'cli-defaults-cc-default', model: 'anthropic/claude-haiku-4.5' })).not.toThrow();
    expect(claudeCodeHarness({ model: 'anthropic/claude-haiku-4.5' }).name).toBe('claude-code');
  });

  it('a virtual() workspace, a copy of a descriptor, or anything else is a TypeError', async () => {
    const { claudeCode, claudeCodeHarness } = await import('../src/claude-code.ts');
    const { sandbox, virtual } = await import('../src/workspace.ts');
    expect(() => claudeCode({ model: 'm', workspace: virtual() as never })).toThrow(/only in a Vercel Sandbox: pass workspace: sandbox\(\)/);
    expect(() => claudeCodeHarness({ workspace: virtual() as never })).toThrow(TypeError);
    expect(() => claudeCode({ model: 'm', workspace: { ...sandbox() } as never })).toThrow(/copy of a descriptor/);
    expect(() => claudeCode({ model: 'm', workspace: 'sandbox' as never })).toThrow(TypeError);
  });

  it('the workspace tool sets are refused, naming builtins: true; the app\'s own tools pass', async () => {
    const { claudeCode } = await import('../src/claude-code.ts');
    const { docTools, unsafeTools } = await import('../src/tools.ts');
    expect(() => claudeCode({ model: 'm', tools: workspaceTools() })).toThrow(/pass builtins: true/);
    expect(() => claudeCode({ model: 'm', tools: [...unsafeTools(), ...docTools([])] })).not.toThrow();
  });

  it('the removed options are TypeErrors naming what replaces them', async () => {
    const { claudeCode } = await import('../src/claude-code.ts');
    expect(() => claudeCode({ model: 'm', host: {} } as never)).toThrow(/host\b.*was removed: .*workspace: sandbox\(\)/);
    expect(() => claudeCode({ model: 'm', cwd: '/tmp' } as never)).toThrow(/cwd.*was removed/);
    expect(() => claudeCode({ model: 'm', executable: '/bin/claude' } as never)).toThrow(/executable.*base image/);
    expect(() => claudeCode({ model: 'm', unsandboxedCommands: true } as never)).toThrow(/unsandboxedCommands.*own sandbox/);
    // A caller's Agent SDK could start the CLI on the host: refused on both, the wrapper and the harness.
    const { claudeCodeHarness } = await import('../src/claude-code.ts');
    expect(() => claudeCode({ model: 'm', sdk: {} } as never)).toThrow(/sdk \}\) isn't taken/);
    expect(() => claudeCodeHarness({ sdk: {} } as never)).toThrow(/sdk \}\) isn't taken/);
    expect(() => claudeCode({ model: 'm', env: { A: 'b' } } as never)).toThrow(/sandbox\(\{ env \}\)/);
    expect(() => claudeCode({ model: 'm', workspaceNote: 'x' } as never)).toThrow(/workspaceNote.*was removed/);
    // The kernel harness's own sandbox binding is internal: only workspace: sandbox() reaches the session factory.
    expect(() => claudeCode({ model: 'm', sandbox: { attach: async () => ({}), acknowledge: async () => {} } } as never)).toThrow(/sandbox \}\) is internal: pass workspace: sandbox\(\)/);
  });
});
