import { vmOnlyHands } from 'harness-world-demo-ui/axes';
import { demoSandbox, sandboxOffReason } from '../hands';
import { BUILTIN_INSTRUCTIONS, demoTools, UNSAFE_NOTE } from './builtins';
import type { DemoHarness } from './types';
import { MODEL } from '../prompt';

/**
 * Claude Code (durable-harness/claude-code): the Claude Agent SDK's `query()`
 * in the drive, with the `claude` CLI in the session's Vercel Sandbox (a VM
 * per session, the session's Drive at `/workspace`), whatever its hands.
 * Its transcript is mirrored into the log; next to its hands, the demo's
 * example side-effect tools and the todo document's, over MCP.
 *
 * - Hands Sandbox (the default): its own Bash, Read, Edit, Write, ... in
 *   the VM (`builtins: true`), each call recorded through its hooks; its
 *   files are the Drive's, and the drills on the VM apply.
 * - Hands None: tool-less (`builtins: false`), still in a VM.
 *
 * On wherever Vercel Sandbox is (`sandboxOffReason`): a deployment, with its
 * OIDC token, or `next dev` with a linked project. Each session's model
 * spend is capped (`HARNESS_SANDBOX_SESSION_USD`, lib/hands.ts).
 * `HARNESS_CLAUDE_CODE=0` leaves it out.
 */
const claudeCode: DemoHarness = {
  value: 'claude-code',
  label: 'Claude Code',
  title:
    "Claude Code (the Claude Agent SDK and its claude CLI) in the session's Vercel Sandbox VM: its brain and transcript in the Function, mirrored into the log; its own tools in the VM (Sandbox hands), each call recorded before it runs, or none (None). Its files are on the session's Drive.",
  modes: ['server'],
  hands: ['none', 'sandbox'],
  defaultHands: 'sandbox',
  handsDisabled: { virtual: vmOnlyHands('Claude Code'), ephemeral: vmOnlyHands('Claude Code'), machine: vmOnlyHands('Claude Code') },
  model: process.env.HARNESS_CLAUDE_CODE_MODEL ?? MODEL,
  enabled: () => process.env.HARNESS_CLAUDE_CODE !== '0',
  disabledReason: () => sandboxOffReason(),
  async load(hands) {
    const [{ claudeCodeHarness }, tools, { gatewayKey, instructionsFor, MODEL }, workspace] = await Promise.all([
      import('durable-harness/claude-code'),
      // The app's own tools only: in its sandbox the CLI uses its own tools on /workspace, never the workspace tool sets.
      demoTools(),
      import('../model'),
      demoSandbox(),
    ]);
    const builtins = hands === 'sandbox';
    return claudeCodeHarness({
      model: process.env.HARNESS_CLAUDE_CODE_MODEL ?? MODEL,
      workspace,
      instructions: builtins ? BUILTIN_INSTRUCTIONS : `${instructionsFor('none')}\n${UNSAFE_NOTE}`,
      builtins,
      tools,
      credential: gatewayKey,
    });
  },
};

export default claudeCode;
