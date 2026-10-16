/**
 * The two processes of the fx SIGKILL drill (fx.test.ts), each its own OS
 * process, on world-local at `dataDir`: libfx's own agent (`createFxAgent`)
 * with its sessions in that World (`world()` from `libfx/durable-world`) and
 * `fxTools(virtual(), { world })`, and a scripted model.
 *
 * The victim prompts a new session whose model calls `shell` once (`echo
 * once >> log.txt` then `sleep`). With `--after-record` the tool's call
 * finishes and records its outcome, then hangs before libfx hears of it (the
 * parent's SIGKILL lands between the record and libfx's own); otherwise the
 * command is killed while it sleeps, before anything is recorded. It prints
 * `{"sessionId"}`, then `{"running":true}` or `{"recorded":true}`.
 *
 * The recoverer (`--recover <sessionId>`) never ran the session: it makes the
 * same agent and continues the open turn (`session.resume()`). libfx runs the
 * cut-off call again under its `executionId` (the tools are idempotent), the
 * model answers, and it prints the turn's result and the workspace.
 *
 *   node --import tsx test/fx-sigkill-child.ts <dataDir> [--after-record] [--recover <sessionId>]
 */
import { hostname } from 'node:os';
import { createWorld } from '@workflow/world-local';
import { createFxAgent } from 'libfx';
import { world as fxWorld } from 'libfx/durable-world';
import { readFxWorkspace } from 'harness-world-hands/fx';
import { fxTools } from '../src/fx.ts';
import { virtual } from '../src/workspace.ts';

const [dataDir, ...rest] = process.argv.slice(2);
const afterRecord = rest.includes('--after-record');
const recovering = rest.includes('--recover') ? rest[rest.indexOf('--recover') + 1] : undefined;
const print = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const sse = (parts: Record<string, unknown>[]) =>
  new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
const command = 'echo once >> log.txt && sleep 4';
const script = recovering
  ? [[{ type: 'text-delta', id: 't', delta: 'logged' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]]
  : [
      [
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'shell', input: JSON.stringify({ request: { action: 'run', command } }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
      ],
    ];
const fetch = async (_url: string, init: RequestInit) => {
  if ((init.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
  const next = script.shift();
  if (!next) throw new Error('unexpected model request');
  return sse(next);
};

const w = createWorld({ dataDir: dataDir!, recoverActiveRuns: false });
const host = hostname();
const durability = fxWorld(w, {
  name: 'local',
  livenessKnown: true,
  queueDurable: false,
  pollMs: 50,
  holderInfo: () => ({ pid: process.pid, host }),
  alive(lease) {
    if (lease.host !== host || typeof lease.pid !== 'number') return null;
    try {
      process.kill(lease.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
});

const tools = fxTools(virtual(), { world: w }).map((tool) =>
  recovering || tool.name !== 'shell'
    ? tool
    : {
        ...tool,
        async execute(input: unknown, context: Parameters<typeof tool.execute>[1]) {
          if (!afterRecord) print({ running: true });
          const result = await tool.execute(input, context);
          if (afterRecord) print({ recorded: true, result });
          // The parent kills this process now: libfx never learns how the call ended.
          return new Promise(() => {});
        },
      }
);

const agent = createFxAgent({ durability, apiKey: 'test', model: 'test/model', fetch, modelCatalog: [], tools });

if (!recovering) {
  const turn = agent.session().prompt('log once');
  print({ sessionId: (await turn.accepted).sessionId, pid: process.pid });
  await turn.result;
} else {
  const turn = agent.session(recovering).resume();
  for await (const _ of turn);
  const result = await turn.result;
  const { files, records } = await readFxWorkspace(w, recovering);
  print({
    pid: process.pid,
    result,
    files: Object.fromEntries([...files].map(([path, f]) => [path, typeof f.content === 'string' ? f.content : `(${f.content.length} bytes)`])),
    records: records.map((r) => ({ executionId: r.executionId, tool: r.tool, files: Object.keys(r.files) })),
  });
  await agent.close();
  process.exit(0);
}
