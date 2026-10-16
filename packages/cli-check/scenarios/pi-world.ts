import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { workflowNameFor } from 'harness-world/names';
import { worldStorage } from 'pi-world';
import { quiet, type Scenario, worldTruth } from '../src/scenario.ts';

/**
 * Pi variant A (pi-world): Pi's own durable Harness (`@earendil-works/pi-durable`)
 * on a Storage backed by the run's event log. Every Pi commit is one
 * `hook_received` on the run's journal hook; there are no steps.
 */

const ctx = BACKGROUND_CONTEXT;

export const piWorld: Scenario = {
  name: 'pi-world',
  title: 'Pi variant A (pi-world, pi-durable)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const open = await storage.open();
        const faux = fauxProvider();
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('lookup', { q: 'x' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage([fauxText('x is 42.')]),
          fauxAssistantMessage([fauxText('Still 42.')]),
        ]);
        const models = createModels();
        models.setProvider(faux.provider);
        const model = faux.getModel();
        const registry = createRegistry();
        registry.install(
          defineExtension({
            name: 'cli-check',
            tools: [
              defineTool({
                name: 'lookup',
                description: 'Read something.',
                parameters: Type.Object({ q: Type.String() }),
                replay: 'safe',
                execute: async () => ({ content: [{ type: 'text', text: 'x is 42' }] }),
              }),
            ],
          })
        );
        const sessionId = await worldStorage.create(open.world);
        const store = await worldStorage(open.world, sessionId);
        const harness = await Harness.open(store, { models, registry, settings: { retry: { maxRetries: 0 }, toolExecution: 'parallel' } }, ctx);
        const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
        for (const content of ['What is x?', 'And now?']) {
          const settledSubmission = await (await root.submit({ type: 'input', content }, ctx)).wait(ctx);
          if (settledSubmission.status !== 'done') throw new Error(`pi-world: the input "${content}" settled as ${settledSubmission.status}`);
        }
        await harness.close(ctx);
        await quiet(open.world, sessionId, 600);
        return {
          session: {
            runId: sessionId,
            expect: {
              workflowName: workflowNameFor('pi-harness'),
              inputHarness: 'pi-harness',
              hookToken: `pi:${sessionId}:journal`,
              hookPayload: 'any-object',
              calls: [],
              callsMatch: 'exact',
              vocabulary: /^$/,
            },
            truth: () => worldTruth(open.world, sessionId),
          },
          dispose: () => open.close(),
        };
      },
    },
  ],
};
