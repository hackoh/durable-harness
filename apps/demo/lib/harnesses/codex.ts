import { vmOnlyHands } from 'harness-world-demo-ui/axes';
import { deployed, demoSandbox, sandboxOffReason } from '../hands';
import { BUILTIN_INSTRUCTIONS, demoTools, UNSAFE_NOTE } from './builtins';
import type { DemoHarness } from './types';

/**
 * Codex (durable-harness/codex): `codex app-server` in the session's Vercel
 * Sandbox VM, whatever its hands, its rollout mirrored into the log and
 * restored on whichever VM runs next. Next to its hands, the demo's example
 * side-effect tools and the todo document's.
 *
 * - Hands Sandbox (the default): its own shell and apply_patch in the VM
 *   (`builtins: true`), every command approved once its intent is in the
 *   log; its files are the Drive's, and the drills on the VM apply.
 * - Hands None: tool-less (`builtins: false`), still in a VM.
 *
 * On wherever Vercel Sandbox is (`sandboxOffReason`), with a per-session
 * model budget (lib/hands.ts). `HARNESS_CODEX=0` turns it off; `CODEX_MODEL`
 * picks the Gateway model (default `openai/gpt-5.4-mini`).
 */
const codex: DemoHarness = {
  value: 'codex',
  label: 'Codex',
  title:
    "Codex (codex app-server 0.160) in the session's Vercel Sandbox VM: its brain in the Function, its rollout mirrored into the log and restored on whichever VM runs next; its own shell and apply_patch in the VM (Sandbox hands), each command approved once its intent is in the log, or none (None). Its files are on the session's Drive.",
  modes: ['server'],
  hands: ['none', 'sandbox'],
  defaultHands: 'sandbox',
  handsDisabled: { virtual: vmOnlyHands('Codex'), ephemeral: vmOnlyHands('Codex'), machine: vmOnlyHands('Codex') },
  model: process.env.CODEX_MODEL ?? 'openai/gpt-5.4-mini',
  enabled: () => process.env.HARNESS_CODEX !== '0',
  disabledReason() {
    const reason = sandboxOffReason();
    if (reason) return reason;
    // A deployment has its OIDC token; a laptop needs one pulled, or a Gateway key.
    if (!deployed() && !process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) return 'No AI Gateway credential: run `vercel env pull` or set AI_GATEWAY_API_KEY';
    return undefined;
  },
  async load(hands) {
    // The app's own tools only: in its sandbox Codex uses its own shell and apply_patch, never the workspace tool sets.
    const [{ codexHarness }, tools, { instructionsFor }, workspace] = await Promise.all([import('durable-harness/codex'), demoTools(), import('../prompt'), demoSandbox()]);
    const builtins = hands === 'sandbox';
    return codexHarness({
      workspace,
      builtins,
      tools,
      instructions: builtins ? BUILTIN_INSTRUCTIONS : `${instructionsFor('none')}\n${UNSAFE_NOTE}`,
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
      log: (message, fields) => console.log(`[codex] ${message}`, fields ?? ''),
    });
  },
};

export default codex;
