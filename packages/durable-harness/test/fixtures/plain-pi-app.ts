/**
 * A plain pi-durable program, as Pi's own README writes one, whose only
 * changes are the storage (`openWorldStorage` where it opened SQLite) and one
 * line (`resumeWith`). The test that runs it kills it with SIGKILL in the
 * middle of a tool call and starts it again.
 *
 *   node --import tsx plain-pi-app.ts run              start a session, ask, wait (killed in a tool)
 *   node --import tsx plain-pi-app.ts restart <id>     the same program started again: it finishes the session
 *
 * The World is the environment's (WORKFLOW_TARGET_WORLD=local,
 * WORKFLOW_LOCAL_DATA_DIR). The model is pi-ai's faux provider, scripted per
 * mode, so the test needs no credentials.
 */
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, type Storage } from '@earendil-works/pi-durable';
import { openWorldReader, openWorldStorage, resumeWith } from '../../src/pi-durable.ts';

const [mode = 'run', sessionArg] = process.argv.slice(2);
const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...line })}\n`);

// ---- Pi's own setup: models, registry, tools ----
const faux = fauxProvider();
faux.setResponses(
  mode === 'run'
    ? [fauxAssistantMessage([fauxToolCall('lookup_order', { id: '1234' }), fauxToolCall('refund', { id: '1234' })], { stopReason: 'toolUse' })]
    : [fauxAssistantMessage([fauxText('Order 1234 has shipped; the refund may not have gone through.')])]
);
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'orders',
    tools: [
      // Safe to run again: a crashed call reruns.
      defineTool({
        name: 'lookup_order',
        description: 'Look up an order.',
        parameters: Type.Object({ id: Type.String() }),
        replay: 'safe',
        execute: async () => {
          say({ tool: 'lookup_order' });
          // The first process is killed in here (the timer stands for the tool's own I/O, which keeps a process alive).
          if (mode === 'run') await new Promise(() => setInterval(() => {}, 60_000));
          return { content: [{ type: 'text', text: 'order 1234: shipped' }] };
        },
      }),
      // Not safe to run again: a crashed call comes back to the model as interrupted.
      defineTool({
        name: 'refund',
        description: 'Refund an order.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async () => {
          say({ tool: 'refund' });
          if (mode === 'run') await new Promise(() => {});
          return { content: [{ type: 'text', text: 'refunded' }] };
        },
      }),
    ],
  })
);

// ---- the one line: how durable-harness reopens a session a dead process left ----
const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry }, ctx));

if (mode === 'run') {
  // ---- the storage swap: was `await openNodeSqliteStorage('./session.sqlite')` ----
  const storage = await openWorldStorage();
  say({ sessionId: storage.sessionId });
  const harness = await open(storage);
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Use the tools.' } });
  const submission = await root.submit({ type: 'input', content: 'Look up order 1234 and refund it.', requestId: 'order-1234' }, ctx);
  await submission.wait(ctx);
  await harness.close(ctx);
} else {
  // The same program, started again. The World is made when the program
  // first needs it (here, to read the session); making it re-enqueues the
  // sessions a dead process left, and the wake finishes them with `open`.
  const reader = openWorldReader(sessionArg!);
  for (;;) {
    await reader.refresh();
    const snap = await reader.snapshot();
    if (!snap.unfinished && snap.entries.at(-1)?.kind === 'pi.assistant') {
      const tools = snap.tasks.filter((t) => t.kind === 'pi.tool');
      say({
        recovered: true,
        transcript: JSON.stringify(snap.entries),
        tools: tools.map((t) => ({ name: (t.input as { name?: string; toolName?: string })?.name ?? (t.input as { toolName?: string })?.toolName, starts: t.starts.map((s) => s.by) })),
      });
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
