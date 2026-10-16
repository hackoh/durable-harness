/**
 * A Next.js app's pi-durable setup (test/pi-durable-next.test.ts): Pi's own
 * models, registry and opener, registered with `resumeWith`. The faux model
 * answers from the transcript (a tool call first, then the answer once the
 * tool's result is in), so a restarted process can finish the turn; the tool
 * hangs in the first process (FIXTURE_HANG=1), which the test kills.
 */
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, type Storage } from '@earendil-works/pi-durable';
import { resumeWith } from 'durable-harness/pi-durable';

const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...line })}\n`);

const faux = fauxProvider();
const answer = (context: { messages: { role: string }[] }) =>
  context.messages.some((m) => m.role === 'toolResult')
    ? fauxAssistantMessage([fauxText('Order 1234 has shipped.')])
    : fauxAssistantMessage([fauxToolCall('lookup_order', { id: '1234' })], { stopReason: 'toolUse' });
faux.setResponses(Array.from({ length: 20 }, () => answer as never));
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'orders',
    tools: [
      defineTool({
        name: 'lookup_order',
        description: 'Look up an order.',
        parameters: Type.Object({ id: Type.String() }),
        replay: 'safe',
        execute: async () => {
          say({ tool: 'lookup_order' });
          if (process.env.FIXTURE_HANG === '1') await new Promise(() => setInterval(() => {}, 60_000));
          return { content: [{ type: 'text', text: 'order 1234: shipped' }] };
        },
      }),
    ],
  })
);

export { ctx };
export const agent = { model: { provider: model.provider, modelId: model.id }, instructions: 'Use the tools.' };
export const open: (storage: Storage) => Promise<Harness> = resumeWith((storage: Storage) => Harness.open(storage, { models, registry }, ctx));
