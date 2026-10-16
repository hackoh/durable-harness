import { defineState } from 'eve/context';
import { defineTool } from 'eve/tools';
import { TOOL_SPECS } from 'harness-world-hands/specs';
import { NativeWorkspace, nativeTools } from 'harness-world-hands/workspace';

/**
 * The eve agent's tools: the native baseline's own tool code
 * (`harness-world-hands/workspace`: just-bash on an in-memory filesystem)
 * with the same specs, so the model sees byte-identical tool definitions in
 * every column and each tool does the same work.
 *
 * The workspace lives in eve's durable session state, the way the native
 * baseline's page carries it from turn to turn: each call rebuilds the
 * filesystem from the state, runs, and stores the files back. Calls of one
 * session run one at a time (each reads and writes the whole workspace, and
 * Pi and fx run tools sequentially too); other sessions in the same process
 * are not held up by them.
 */

export type ToolName = keyof typeof TOOL_SPECS;

const files = defineState<Record<string, string>>('harness.workspace', () => ({}));

/** The tail of each session's queue of tool calls in this process. */
const queues = new Map<string, Promise<unknown>>();
const serial = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
  const run = (queues.get(sessionId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(sessionId, tail);
  // Forget a session's queue once its last call settles.
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
};

export function workspaceTool(name: ToolName) {
  const spec = TOOL_SPECS[name];
  return defineTool({
    description: spec.description,
    // A plain JSON Schema object (TypeBox's, cloned): eve sends it to the model as written.
    inputSchema: JSON.parse(JSON.stringify(spec.inputSchema)),
    execute: (input: Record<string, unknown>, ctx: { abortSignal?: AbortSignal; session: { id: string } }) =>
      serial(ctx.session.id, async () => {
        const ws = await NativeWorkspace.from(files.get());
        const tool = nativeTools(ws).find((t) => t.name === name);
        if (!tool) throw new Error(`no tool ${name}`);
        try {
          return await tool.execute(input, ctx.abortSignal);
        } finally {
          const next = await ws.files();
          files.update(() => next);
        }
      }),
  });
}
