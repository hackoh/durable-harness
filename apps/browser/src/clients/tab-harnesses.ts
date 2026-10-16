import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import type { Harness, HostTool } from 'harness-world';
import type { Hands } from 'harness-world-demo-ui';
import { fxHarness } from 'harness-world-fx';
import { unsafeTools, workspaceTools } from 'harness-world-hands';
import { withFetch } from 'harness-world-hybrid';
import { piHarness } from 'harness-world-pi';
import type { FxEngineOptions } from 'libfx/browser';
import { tabGateway } from '../direct.ts';
import { MODEL } from '../model.ts';

/**
 * The Pi and fx harnesses that run in this tab: the same ones with durability
 * on (This Tab, on IndexedDB) and off (no World at all), so the raw baseline
 * measures exactly the code the durable lane runs. Their hands (the Hands
 * axis) are a tab's: none, a virtual workspace whose files are in the log
 * (IndexedDB here), or the same in memory for the turn. A tab can't reach
 * a Vercel Sandbox VM, and no Function can run a call for a log in
 * IndexedDB: the machine is Hybrid's.
 */

const DURABLE = 'Keep answers short. Your session is durable: it can be interrupted and resumed at any point.';

/** The system prompt for a tab session's hands. */
export function tabInstructions(hands: TabHands): string {
  if (hands === 'none') return `You are an assistant running entirely inside a browser tab, with no workspace: no files and no shell.\n${DURABLE}`;
  const files = hands === 'ephemeral' ? "files kept in this tab's memory, cleared at the end of every turn" : "the session's files";
  return `You are a coding agent running entirely inside a browser tab, working in a virtual workspace at /workspace: an emulated shell over ${files}, not a real machine.
Use the tools to inspect and change files, and run commands with bash. ${DURABLE}`;
}

/** The prompt of a Virtual session in this tab (and of the native baseline here, whose tools are the same workspace's). */
export const INSTRUCTIONS = tabInstructions('virtual');

/** The hands a tab's brain takes. */
export type TabHands = Extract<Hands, 'none' | 'virtual' | 'ephemeral'>;

/** A session's hands as its run_created recorded them (`config.hands`): Virtual for one from before the hands axis. */
export function tabHandsOf(config: unknown): TabHands {
  const hands = (config as { hands?: unknown } | undefined)?.hands;
  return hands === 'none' || hands === 'ephemeral' ? hands : 'virtual';
}

/** The tab's tools for these hands: the workspace tools (durable, or in memory) and the example side-effect tools, or those alone. */
function toolsFor(hands: TabHands): HostTool[] {
  if (hands === 'none') return unsafeTools();
  return workspaceTools(hands === 'ephemeral' ? { workspace: { kind: 'virtual', durable: false } } : {});
}

export const hasJspi = () => typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly;

/** One harness per hands, built on a session's first drive with them, each drive going to its session's. */
function byHands(name: string, build: (hands: TabHands) => Harness): Harness {
  const built = new Map<TabHands, Harness>();
  return {
    name,
    drive(ctx) {
      const hands = tabHandsOf(ctx.config);
      let harness = built.get(hands);
      if (!harness) built.set(hands, (harness = build(hands)));
      return harness.drive(ctx);
    },
  };
}

export function tabHarnesses() {
  const models = createModels();
  models.setProvider(vercelAIGatewayProvider());
  // Model calls are the one thing that leaves the tab: through the demo's
  // AI Gateway proxy (see direct.ts).
  const gateway = tabGateway();
  const pi = byHands('pi', (hands) =>
    piHarness({
      model: models.getModel('vercel-ai-gateway', MODEL)!,
      streamFn: withFetch(models.streamSimple.bind(models), gateway),
      // The proxy sets the real credential.
      getApiKey: () => 'gateway',
      systemPrompt: tabInstructions(hands),
      tools: toolsFor(hands),
    })
  );
  const fx = byHands('fx', (hands) =>
    fxHarness({
      // libfx (JS + wasm) loads only when an fx session actually drives here.
      createFxEngine: (async (options: FxEngineOptions) => (await import('libfx/browser')).createFxEngine(options)) as never,
      apiKey: 'gateway',
      model: MODEL,
      instructions: tabInstructions(hands),
      tools: toolsFor(hands),
      fetch: gateway,
      agentOptions: { backend: 'wasm' },
    })
  );
  return [pi, fx];
}
