import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { piHarness } from 'harness-world-pi';
import { Type } from 'typebox';
import { KERNEL_EFFECTS, kernelSession, type Scenario, settled } from '../src/scenario.ts';

/** Pi variant B (harness-world-pi): each model call and tool call is a kernel effect. */

type Responses = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0];

function fauxModel(responses: Responses) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}

/** `replay: 'never'`: a crash inside it must not run it again. Reports progress, then answers. */
function shout(ms = 0): AgentTool<any> {
  return {
    name: 'shout',
    label: 'Shout',
    description: 'Uppercase some text.',
    parameters: Type.Object({ text: Type.String() }),
    replay: 'never',
    async execute(_id, params: any, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: 'text', text: 'working' }], details: undefined });
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: 'text', text: params.text.toUpperCase() }], details: undefined };
    },
  };
}

const vocabulary = new RegExp(`^(model|tool\\..+|${KERNEL_EFFECTS})$`);
const modelDone = (n: number) => (s: { effectOrder: { name: string; status: string }[] }) =>
  s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length >= n;

export const pi: Scenario = {
  name: 'pi',
  title: 'Pi (harness-world-pi)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const open = await storage.open();
        const sessions = durableSessions({
          world: open.world,
          harness: piHarness({
            ...fauxModel([
              fauxAssistantMessage(fauxToolCall('shout', { text: 'hi' }), { stopReason: 'toolUse' }),
              fauxAssistantMessage(fauxText('I shouted HI.')),
              fauxAssistantMessage(fauxText('Still loud.')),
            ]),
            systemPrompt: 'Be loud.',
            tools: [shout()],
          }),
        });
        await open.serve(QUEUE_PREFIX, sessions.handler);
        const { sessionId } = await sessions.start({ prompt: 'shout hi' });
        await settled(open.world, sessions, sessionId, modelDone(2), { what: 'the first turn' });
        await sessions.send(sessionId, 'and now?');
        await settled(open.world, sessions, sessionId, modelDone(3), { what: 'the second turn' });
        return {
          session: kernelSession(() => open.world, () => sessions, sessionId, {
            harness: 'pi',
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
        // Process A: the tool call is killed 200 ms in (the kernel's chaos: a `chaos` step, then the drive dies).
        const a = await storage.open();
        let crashed!: () => void;
        const died = new Promise<void>((r) => (crashed = r));
        const sessionsA = durableSessions({
          world: a.world,
          chaos: true,
          crash: () => crashed(),
          harness: piHarness({
            ...fauxModel([fauxAssistantMessage(fauxToolCall('shout', { text: 'hi' }), { stopReason: 'toolUse' })]),
            tools: [shout(2000)],
          }),
        });
        await a.serve(QUEUE_PREFIX, sessionsA.handler);
        const { sessionId } = await sessionsA.start();
        await sessionsA.chaos(sessionId, { at: 'tool', afterMs: 200 });
        await sessionsA.send(sessionId, 'shout hi');
        await died;
        await a.close();

        // Process B: a new World instance on the same storage recovers the session, then takes one more prompt.
        const open = await storage.open({ recover: true });
        const sessions = durableSessions({
          world: open.world,
          chaos: true,
          crash: () => {},
          harness: piHarness({
            ...fauxModel([fauxAssistantMessage(fauxText('The shout may not have happened.')), fauxAssistantMessage(fauxText('Quiet now.'))]),
            tools: [shout()],
          }),
        });
        await open.serve(QUEUE_PREFIX, sessions.handler);
        await settled(open.world, sessions, sessionId, modelDone(2), { what: 'recovery' });
        await sessions.send(sessionId, 'and now?');
        await settled(open.world, sessions, sessionId, modelDone(3), { what: 'the turn after recovery', drain: () => open.drained() });
        return {
          session: kernelSession(() => open.world, () => sessions, sessionId, {
            harness: 'pi',
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
