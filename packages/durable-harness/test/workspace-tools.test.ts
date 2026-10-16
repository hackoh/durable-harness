import { describe, expect, it } from 'vitest';
import { sandbox, virtual } from '../src/index.ts';
import { workspaceInstructions, workspaceTools } from '../src/tools.ts';

describe('workspaceTools(workspace)', () => {
  it('defaults to a durable virtual workspace', () => {
    expect(virtual()).toMatchObject({ kind: 'virtual', durable: true });
    expect(virtual({ durable: false })).toMatchObject({ kind: 'virtual', durable: false });
    const tools = workspaceTools();
    expect(tools.map((t) => t.name)).toEqual(['bash', 'read_file', 'write_file', 'edit_file', 'list_files']);
    expect(tools.map((t) => t.description)).toEqual(workspaceTools(virtual()).map((t) => t.description));
    expect(tools.find((t) => t.name === 'bash')!.description).toContain('not real Linux: no network, no package installs, no real processes');
    for (const t of tools) expect(t.replay).toBe('safe');
  });

  it('says so when its files last one turn', () => {
    for (const t of workspaceTools(virtual({ durable: false }))) expect(t.description).toContain('Files last until the end of this turn.');
    expect(workspaceInstructions(virtual({ durable: false }))).toContain('files last until the end of this turn');
    expect(workspaceInstructions()).toContain('last across turns');
  });

  it('refuses a workspace it has no runtime for', () => {
    expect(() => workspaceTools(sandbox())).toThrow(/virtual\(\)/);
    expect(() => workspaceInstructions(sandbox())).toThrow(/virtual workspace/);
  });
});
