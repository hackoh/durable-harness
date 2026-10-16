import { defineAgent } from 'eve';
import { MODEL } from '../lib/prompt';

/**
 * eve as a `/compare` and `/bench` column: eve's own harness on Vercel
 * Workflow (`"use workflow"`), with the model, instructions and tools the
 * Pi and fx lanes use.
 *
 * The system prompt is not byte-identical: eve wraps the instructions as
 * `Instructions (instructions)\n<text>` and, whenever an agent has tools,
 * appends a block it has no option to turn off:
 *
 *     Tool execution
 *     Tool calls in one response run in parallel, so batch only calls that don't depend on each other.
 *
 * (eve 0.69.0, `runtime/prompt/compose.ts`). Pi and fx do not send it. It
 * could change how many model → tool → model hops a turn takes, so the
 * bench's tool scenarios report `modelCalls` for every cell: compare the
 * hop counts before the times.
 *
 * - `reasoning: 'none'`: Pi runs with thinking off.
 * - `defaultTools: false`, `tool: false`: only the tools in `tools/`, the
 *   same seven the other lanes advertise (no eve built-ins, no `agent` tool).
 * - `modelCallsPerStep` stays at eve's default (1): one model call and its
 *   tool calls per Workflow step. It is a build-time setting, so batching
 *   would take a second agent; not exposed.
 */
export default defineAgent({
  model: MODEL,
  reasoning: 'none',
  defaultTools: false,
  tool: false,
});
