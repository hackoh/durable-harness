import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, Type } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { createRegistry, defineExtension, defineTool, Harness as PiHarness, type Storage } from '@earendil-works/pi-durable';
import { aiSdkHarness } from 'durable-ai-sdk';
import { claudeCodeHarness } from 'durable-harness/claude-code';
import { fromHostTools } from 'durable-ai-sdk/tools';
import { GATEWAY_PROVIDER, gatewayModels, openWorldStorage, resumeWith } from 'durable-harness/pi-durable';
import type { Harness, SessionState } from 'harness-world';
import { codexBinary } from 'harness-world-codex/binary';
import { codexStandIn } from '../scenarios/codex.ts';
import { fxHarness } from 'harness-world-fx';
import { workspaceTools } from 'harness-world-hands';
import { workspaceRuntime } from 'harness-world-hands/runtime';
import { opencodeHarness } from 'harness-world-opencode';
import { piHarness } from 'harness-world-pi';
import { gatewayCredential } from 'harness-world-process';
import { createFxEngine } from 'libfx';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newHost } from '../scenarios/process.ts';
import { expectToolTurn, kernelTurn, type Tracing, tracing } from '../src/agent-runs.ts';
import { storageFor } from '../src/worlds.ts';

/**
 * Agent Runs against real models: one tool turn per server harness, each
 * with its real engine (the `claude`, `codex` and OpenCode CLIs, libfx, Pi,
 * Pi's own durable Harness, the AI SDK) and an AI Gateway model, on world-local, through
 * durable-harness's OpenTelemetry integration with an in-memory span
 * processor. Same checks as `agent-runs.test.ts`, plus what only a real
 * model gives: a model id on every model span, the prompt in the model's
 * input, and token usage. The process harnesses keep their own tools on.
 *
 * Off unless `AGENT_RUNS_LIVE=1` (it spends Gateway credit). Credential:
 * `AI_GATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` (`vercel env pull`); point
 * `AGENT_RUNS_ENV_FILE` at a dotenv file to load one.
 *
 *   AGENT_RUNS_LIVE=1 AGENT_RUNS_ENV_FILE=.env.local pnpm --filter harness-world-cli-check exec vitest run test/agent-runs-live.test.ts
 *
 * Models: `AGENT_RUNS_MODEL` (default anthropic/claude-haiku-4.5) and
 * `AGENT_RUNS_CODEX_MODEL` (default openai/gpt-5.4-mini).
 */

const LIVE = process.env.AGENT_RUNS_LIVE === '1';
if (LIVE && process.env.AGENT_RUNS_ENV_FILE) process.loadEnvFile(process.env.AGENT_RUNS_ENV_FILE);
const MODEL = process.env.AGENT_RUNS_MODEL ?? 'anthropic/claude-haiku-4.5';
const CODEX_MODEL = process.env.AGENT_RUNS_CODEX_MODEL ?? 'openai/gpt-5.4-mini';
const MARKER = `zebra-${Date.now().toString(36)}`;
const PROMPT = `Create a file named notes.txt whose entire content is exactly ${MARKER}. Use one of your tools to write it, then reply with the single word: done.`;
const INSTRUCTIONS = 'You are a coding agent. Use your tools to change files. Be brief.';
/** Any model span names a model, never `chat unknown`. */
const NAMED_MODEL = /^chat (?!unknown$)\S+$/;
const TURN_MS = 180_000;

let t: Tracing;
beforeAll(() => {
  t = tracing();
});
afterAll(() => t?.close());
const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0).reverse()) await Promise.resolve(d()).catch(() => {});
});

/** A tool ran, and nothing is pending or running (the settle check adds that); the root's end marks the turn's end. */
const toolDone = (s: SessionState) => s.effectOrder.some((e) => e.name.startsWith('tool.') && e.status === 'completed');
const turn = (name: string, harness: Harness) => kernelTurn(t, disposers, name, harness, PROMPT, toolDone, TURN_MS);
const host = async (name: string) => {
  const h = await newHost(`agent-runs-live-${name}`);
  disposers.push(() => h.killAll());
  return h;
};

describe.skipIf(!LIVE)('Agent Runs, real models: one tool turn per server harness', () => {
  it('Pi (harness-world-pi)', { timeout: TURN_MS + 60_000 }, async () => {
    const models = createModels();
    models.setProvider(vercelAIGatewayProvider());
    const model = models.getModel('vercel-ai-gateway', MODEL);
    if (!model) throw new Error(`pi-ai does not know the Gateway model ${MODEL}`);
    const harness = piHarness({ model, streamFn: models.streamSimple.bind(models), getApiKey: gatewayCredential, systemPrompt: INSTRUCTIONS, tools: workspaceTools() });
    const { sessionId, spans } = await turn('pi', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'pi', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  it('Pi with pi-durable (your own Harness on openWorldStorage)', { timeout: TURN_MS + 60_000 }, async () => {
    const files = new Map<string, string>();
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: 'files',
        tools: [
          defineTool({
            name: 'write_file',
            description: 'Write a file in the workspace.',
            parameters: Type.Object({ path: Type.String(), content: Type.String() }),
            execute: async (args: { path: string; content: string }) => {
              files.set(args.path, args.content);
              return { content: [{ type: 'text', text: `wrote ${args.content.length} bytes to ${args.path}` }] };
            },
          }),
        ],
      })
    );
    const models = gatewayModels({ apiKey: gatewayCredential });
    const open = await storageFor('local', 'agent-runs-live-pi-durable').open();
    disposers.push(() => open.close());
    const openHarness = resumeWith((storage: Storage) => PiHarness.open(storage, { models, registry }, BACKGROUND_CONTEXT), { world: open.world });
    const storage = await openWorldStorage(undefined, { world: open.world, traceAudience: 'unknown' });
    const harness = await openHarness(storage);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: GATEWAY_PROVIDER, modelId: MODEL }, instructions: INSTRUCTIONS } });
    expect((await (await root.submit({ type: 'input', content: PROMPT }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status).toBe('done');
    await harness.close(BACKGROUND_CONTEXT);
    const spans = await t.finishedTurn(storage.sessionId, 'pi-durable');
    expectToolTurn(spans, { sessionId: storage.sessionId, marker: MARKER, harness: 'pi-durable', tool: 'write_file', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  const libfxAddon = join(dirname(createRequire(import.meta.url).resolve('libfx')), `libfx.${process.platform}-${process.arch}.node`);
  it.skipIf(!existsSync(libfxAddon))('fx (harness-world-fx on libfx)', { timeout: TURN_MS + 60_000 }, async () => {
    const harness = fxHarness({ createFxEngine: createFxEngine as never, apiKey: gatewayCredential, model: MODEL, instructions: INSTRUCTIONS, tools: workspaceTools() });
    const { sessionId, spans } = await turn('fx', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'fx', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  it('AI SDK ToolLoopAgent (durable-ai-sdk)', { timeout: TURN_MS + 60_000 }, async () => {
    const harness = aiSdkHarness({ model: MODEL, instructions: INSTRUCTIONS, tools: fromHostTools(workspaceTools()) });
    const { sessionId, spans } = await turn('ai-sdk', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'ai-sdk', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  // Claude Code runs only in the session's Vercel Sandbox: these need a live sandbox (DH_LIVE_SANDBOX=1, a linked project).
  it.runIf(process.env.DH_LIVE_SANDBOX === '1')('Claude Code (the claude CLI in the session\'s sandbox, its own tools on)', { timeout: TURN_MS + 120_000 }, async () => {
    const harness = claudeCodeHarness({ builtins: true, model: MODEL, instructions: INSTRUCTIONS });
    const { sessionId, spans } = await turn('claude-code', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'claude-code', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  // Codex runs only in a session's sandbox: here the stand-in's (a local relay), with this machine's pinned binary as its CLI.
  it.skipIf(!codexBinary())('Codex (codex app-server in the stand-in sandbox, its own tools on)', { timeout: TURN_MS + 60_000 }, async () => {
    const { harness, dispose } = codexStandIn({ builtins: true, model: CODEX_MODEL, instructions: INSTRUCTIONS, command: codexBinary()! });
    disposers.push(dispose);
    const { sessionId, spans } = await turn('codex', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'codex', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  it.skipIf(!codexBinary())('Codex (codex app-server in the stand-in sandbox, tool-less: the workspace tools only)', { timeout: TURN_MS + 60_000 }, async () => {
    const { harness, dispose } = codexStandIn({ tools: workspaceTools(), model: CODEX_MODEL, instructions: INSTRUCTIONS, command: codexBinary()! });
    disposers.push(dispose);
    const { sessionId, spans } = await turn('codex', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'codex', tool: 'write_file', modelContent: true, model: NAMED_MODEL, usage: true });
  });

  it('OpenCode (its own tools, on a virtual workspace)', { timeout: TURN_MS + 60_000 }, async () => {
    const harness = opencodeHarness({ model: MODEL, instructions: INSTRUCTIONS, workspace: { kind: 'virtual', runtime: workspaceRuntime() }, root: (await host('opencode')).root });
    const { sessionId, spans } = await turn('opencode', harness);
    expectToolTurn(spans, { sessionId, marker: MARKER, harness: 'opencode', modelContent: true, model: NAMED_MODEL, usage: true });
  });
});
