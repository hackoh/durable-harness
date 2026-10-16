import type { DemoHarness } from './types';
import { MODEL } from '../prompt';

/**
 * The AI SDK's ToolLoopAgent (`durable-ai-sdk`, apps/durable-ai-sdk): ai 7's
 * own agent loop, with every model call and tool call a step in the log, the
 * finished turns folded back into its messages on every drive, and an
 * unfinished turn replayed against the log. The app's model, workspace
 * tools and todo document tools (`docTools`, lib/docs.ts). `HARNESS_AI_SDK=0` leaves it out.
 */
const aiSdk: DemoHarness = {
  value: 'ai-sdk',
  label: 'AI SDK',
  title:
    "The AI SDK's ToolLoopAgent (ai 7) on the kernel: its model calls and tool calls are steps in the log, finished turns fold back into its messages, an unfinished turn replays against the log.",
  modes: ['server'],
  model: MODEL,
  enabled: () => process.env.HARNESS_AI_SDK !== '0',
  async load() {
    const [{ aiSdkHarness }, { fromHostTools }, hands, { INSTRUCTIONS, MODEL }, { Todos }] = await Promise.all([
      import('durable-ai-sdk'),
      import('durable-ai-sdk/tools'),
      import('harness-world-hands'),
      import('../model'),
      import('../docs'),
    ]);
    // The AI Gateway provider finds the credential itself: AI_GATEWAY_API_KEY, else the project's OIDC token.
    return aiSdkHarness({ model: MODEL, instructions: INSTRUCTIONS, tools: fromHostTools([...hands.workspaceTools(), ...hands.docTools([Todos])]) });
  },
};

export default aiSdk;
