import { tool } from 'ai';
import { aiSdkHarness, type DurableTool } from 'durable-ai-sdk';
import { scriptedModel, text, toolCall } from 'durable-ai-sdk/scripted';
import { durableSessions, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { z } from 'zod';
import { KERNEL_EFFECTS, kernelSession, type Scenario, settled } from '../src/scenario.ts';

/** The AI SDK's ToolLoopAgent made durable (apps/durable-ai-sdk): turn, model, tool and checkpoint effects. */

function shout(ms = 0): DurableTool {
  return {
    ...tool({
      description: 'Uppercase some text.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        if (ms) await new Promise((r) => setTimeout(r, ms));
        return text.toUpperCase();
      },
    }),
    replay: 'never',
  };
}

const vocabulary = new RegExp(`^(turn|model|tool\\..+|checkpoint|${KERNEL_EFFECTS})$`);
const checkpointed = (n: number) => (s: SessionState) => s.effects.get(`checkpoint:${n}`)?.status === 'completed';

export const aiSdk: Scenario = {
  name: 'ai-sdk',
  title: 'AI SDK ToolLoopAgent (apps/durable-ai-sdk)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const open = await storage.open();
        const model = scriptedModel([toolCall('shout', { text: 'hi' }, 'call_1'), text('I shouted HI.'), text('Still loud.')]);
        const sessions = durableSessions({ world: open.world, harness: aiSdkHarness({ model, instructions: 'Be loud.', tools: { shout: shout() } }) });
        await open.serve(QUEUE_PREFIX, sessions.handler);
        const { sessionId } = await sessions.start({ prompt: 'shout hi' });
        await settled(open.world, sessions, sessionId, checkpointed(0), { what: 'turn 0' });
        await sessions.send(sessionId, 'and now?');
        await settled(open.world, sessions, sessionId, checkpointed(1), { what: 'turn 1' });
        return {
          session: kernelSession(() => open.world, () => sessions, sessionId, {
            harness: 'ai-sdk',
            submissions: 2,
            calls: ['model', 'tool.shout', 'model', 'model'],
            callsMatch: 'exact',
            vocabulary,
          }),
          dispose: () => open.close(),
        };
      },
    },
    {
      label: 'recovered',
      async run(storage) {
        const a = await storage.open();
        let crashed!: () => void;
        const died = new Promise<void>((r) => (crashed = r));
        const sessionsA = durableSessions({
          world: a.world,
          chaos: true,
          crash: () => crashed(),
          harness: aiSdkHarness({ model: scriptedModel([toolCall('shout', { text: 'hi' }, 'call_1')]), tools: { shout: shout(2000) } }),
        });
        await a.serve(QUEUE_PREFIX, sessionsA.handler);
        const { sessionId } = await sessionsA.start();
        await sessionsA.chaos(sessionId, { at: 'tool', afterMs: 200 });
        await sessionsA.send(sessionId, 'shout hi');
        await died;
        await a.close();

        const open = await storage.open({ recover: true });
        const sessions = durableSessions({
          world: open.world,
          chaos: true,
          crash: () => {},
          harness: aiSdkHarness({ model: scriptedModel([text('The shout may not have happened.'), text('Quiet now.')]), tools: { shout: shout() } }),
        });
        await open.serve(QUEUE_PREFIX, sessions.handler);
        await settled(open.world, sessions, sessionId, checkpointed(0), { what: 'recovery' });
        await sessions.send(sessionId, 'and now?');
        await settled(open.world, sessions, sessionId, checkpointed(1), { what: 'the turn after recovery', drain: () => open.drained() });
        return {
          session: kernelSession(() => open.world, () => sessions, sessionId, {
            harness: 'ai-sdk',
            submissions: 3,
            calls: ['model', 'tool.shout', 'model', 'model'],
            callsMatch: 'exact',
            vocabulary,
            failedSteps: /interrupted/i,
          }),
          dispose: () => open.close(),
        };
      },
    },
  ],
};
