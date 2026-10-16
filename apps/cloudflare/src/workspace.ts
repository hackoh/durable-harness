/**
 * A harness with no model, for the virtual workspace checks
 * (test/workspace.cf.test.ts): each prompt is a JSON list of calls on the
 * generic workspace tools (harness-world-hands, files in this session's
 * log), run one after another, plus `where`: where the shell runs. workerd
 * has no worker threads, so just-bash runs in the Durable Object's own
 * isolate (the no-worker path, with the hardened limits).
 */
import { type DriveContext, EffectFailure, type Harness, type HostTool, hostToolIO } from 'harness-world';
import { docWorkspaceTools, machineIsolation } from 'harness-world-hands/tools';

interface Call {
  tool: string;
  input?: Record<string, unknown>;
}

const where: HostTool = {
  name: 'where',
  description: 'Where the workspace shell runs.',
  inputSchema: {},
  replay: 'safe',
  execute: () => machineIsolation(),
};

export function workspaceHarness(): Harness {
  const tools = [...docWorkspaceTools(), where];
  return {
    name: 'workspace',
    async drive(ctx: DriveContext) {
      for (const sub of ctx.state().submissions) {
        if (sub.kind !== 'prompt' || !sub.text || ctx.state().withdrawn.has(sub.id)) continue;
        const calls = JSON.parse(sub.text) as Call[];
        for (const [i, call] of calls.entries()) {
          const tool = tools.find((t) => t.name === call.tool);
          if (!tool) throw new Error(`no tool ${call.tool}`);
          const input = call.input ?? {};
          try {
            await ctx.effect(`tool:${sub.id}:${i}`, { name: `tool.${tool.name}`, replay: tool.replay, input, placed: [sub.id] }, (io) => tool.execute(input, hostToolIO(io, ctx)));
          } catch (err) {
            if (!(err instanceof EffectFailure)) throw err;
          }
        }
      }
    },
  };
}
