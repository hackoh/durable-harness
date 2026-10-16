import { claudeCodeHarness } from 'harness-world-claude-code';
import { fakeSdk } from 'harness-world-claude-code/testing';
import { standIn } from 'harness-world-claude-code/testing/stand-in';
import { workspaceTools } from 'harness-world-hands';
import type { Scenario } from '../src/scenario.ts';
import { processBasic } from './process.ts';

/**
 * Claude Code (harness-world-claude-code) with its scripted Agent SDK
 * stand-in (`test/fake-sdk.ts`) on the sandbox tier's stand-in VM (the real
 * session factory over a local relay, a temp dir for the Drive): the
 * harness's attach, mirror, tool bridge and journal for real, no `claude`
 * binary and no model.
 */
export const claudeCode: Scenario = {
  name: 'claude-code',
  title: 'Claude Code (harness-world-claude-code, scripted Agent SDK, stand-in VM)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const { api, sandbox } = standIn();
        // The bridged tools only: the scenario's scripted turns call them. The fake's "CLI" is node, on the stand-in VM.
        const harness = claudeCodeHarness({ builtins: false, tools: workspaceTools({ confirmMs: 3000 }), sandbox, executable: process.execPath, sdk: fakeSdk(), credential: async () => 'test-key' });
        return processBasic(storage, harness, { name: 'claude-code', dispose: () => api.dispose() });
      },
    },
  ],
};
