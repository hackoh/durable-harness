/**
 * The two processes of the documents SIGKILL drill (docs-sigkill.test.ts),
 * each a separate OS process, on world-local at `dataDir`, with Pi and a
 * scripted model (pi-ai's faux provider).
 *
 * The victim starts a session whose model calls `tool` once; the tool does
 * its work (a document edit through `io.docs`, or a file write), prints
 * `{"worked":true}` and then hangs, so the parent's SIGKILL lands after the
 * edit was made and before the call's outcome reached the log.
 *
 * The recoverer (`--recover`) never drove the session: it makes the agent
 * and durable-harness's World (`getWorld()`, world-local on the same data
 * directory), whose start re-enqueues the session on durable-harness's
 * prefix (`recoverSessions`); the open call's anchor names a process that is
 * gone, so the kernel resolves it at once (a `safe` tool is retried, a
 * `never` one comes back interrupted). It prints what the log holds once the
 * turn is over, and exits.
 *
 *   node --import tsx test/docs-sigkill-child.ts <dataDir> <tool> [--recover <sessionId>]
 */
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld } from '@workflow/world-local';
import { defineDoc, durableAgent, durableSessions, getWorld, type HostTool, isSettled, type JsonObject, QUEUE_PREFIX, virtual } from '../src/index.ts';
import { createCodingTools, piHarness } from '../src/pi.ts';
import { docTools, readWorkspace, workspaceTools } from '../src/tools.ts';

export const Todos = defineDoc<{ items: string[] }>({
  kind: 'app.todos',
  version: 1,
  initial: () => ({ items: [] }),
  // update_todos' value is typed by the schema (without one it is JSON text).
  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
});

const addTodoNever: HostTool<{ item: string }> = {
  name: 'add_todo_never',
  description: 'Add a todo (not safe to rerun).',
  inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
  replay: 'never',
  async execute({ item }, io) {
    io.docs!.update(Todos, (d) => void d.items.push(item));
    return 'added';
  },
};

export const CALLS: Record<string, JsonObject> = {
  update_todos: { value: { items: ['milk'] } },
  add_todo_never: { item: 'milk' },
  write_file: { path: 'notes.txt', content: 'from the drill\n' },
  // Pi's own write (createCodingTools), on the same document-backed workspace.
  write: { path: 'notes.txt', content: 'from the drill\n' },
};

const [dataDir, toolName, mode, recoverId] = process.argv.slice(2);
if (!dataDir || !toolName || !CALLS[toolName] || (mode && (mode !== '--recover' || !recoverId))) {
  throw new Error('usage: docs-sigkill-child.ts <dataDir> update_todos|add_todo_never|write_file|write [--recover <sessionId>]');
}
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const tools = [...docTools([Todos]), addTodoNever, ...workspaceTools(), ...createCodingTools(virtual()).filter((t) => t.name === 'write')];

function harness(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0], hang: boolean) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const used = tools.map((t): HostTool =>
    hang && t.name === toolName
      ? {
          ...t,
          async execute(input, io) {
            const out = await t.execute(input, io);
            say({ worked: true });
            await new Promise((r) => setTimeout(r, 120_000));
            return out;
          },
        }
      : t
  );
  return piHarness({ model: faux.getModel(), streamFn: models.streamSimple.bind(models), tools: used });
}

if (mode === '--recover') {
  // durable-harness's own World, as an app gets it (getWorld()): world-local
  // with its own recovery off; durable-harness consumes its prefix in this
  // process and re-enqueues the session the victim left mid-turn.
  process.env.WORKFLOW_TARGET_WORLD = 'local';
  process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
  const agent = durableAgent({ harness: harness([fauxAssistantMessage(fauxText('done'))], false) });
  const world = await getWorld();
  const sessions = agent.sessions;
  const started = Date.now();
  for (;;) {
    const s = await sessions.inspect(recoverId!);
    if (s.status === 'failed') throw new Error(`session failed: ${s.failure?.message}`);
    const answered = s.effectOrder.filter((e) => e.name === 'model' && e.status === 'completed').length >= 2;
    if (answered && isSettled(s)) {
      say({
        pid: process.pid,
        doc: await sessions.doc(recoverId!, Todos),
        files: await readWorkspace(world, s),
        workspaceRevision: s.docs.get('hw.workspace')?.revision ?? 0,
        effects: s.effectOrder.map(({ key, name, status, retryOf, docs, error }) => ({ key, name, status, retryOf, docs, error })),
      });
      break;
    }
    if (Date.now() - started > 90_000) throw new Error('timed out waiting for the recovered turn');
    await new Promise((r) => setTimeout(r, 100));
  }
  await (world as { close?: () => Promise<void> }).close?.();
  process.exit(0);
}

const world = createWorld({ dataDir, recoverActiveRuns: false });
const sessions = durableSessions({ world, harness: harness([fauxAssistantMessage(fauxToolCall(toolName, CALLS[toolName]!), { stopReason: 'toolUse' })], true) });
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();
const { sessionId } = await sessions.start({ prompt: `call ${toolName}` });
say({ sessionId, pid: process.pid });
// Keep driving until killed.
setInterval(() => {}, 1 << 30);
