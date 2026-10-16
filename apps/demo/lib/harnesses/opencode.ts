import { BUILTIN_INSTRUCTIONS, demoTools, UNSAFE_NOTE } from './builtins';
import type { DemoHarness } from './types';
import { MODEL } from '../prompt';

/**
 * OpenCode v2 (`durable-harness/opencode`): OpenCode's embedded server in the
 * Function's process, rebuilt from the log on every drive. Its committed
 * events are mirrored into the log, and every model request waits until the
 * log has them. Next to its hands, the demo's example side-effect tools and
 * the todo document's. Its hands:
 *
 * - None: tool-less (no `workspace`), the app's tools only;
 * - Virtual (the default): its own tools (shell, read, write, edit, glob,
 *   grep) on `virtual()`, whose files are in the log (the Files panel),
 *   never on the Function's disk;
 * - Virtual (not saved): the same on `virtual({ durable: false })`;
 * - Virtual + machine: `virtual()` and `run_on_machine` (lib/machine.ts);
 * - Sandbox: `opencode({ workspace: sandbox() })`, off until its
 *   `sandbox()` support lands (`handsDisabled`).
 *
 * The model is the app's (`HARNESS_MODEL`; `OPENCODE_MODEL` overrides it),
 * through OpenCode's own AI Gateway provider. `HARNESS_OPENCODE=0` leaves it out.
 */
const opencode: DemoHarness = {
  value: 'opencode',
  label: 'OpenCode',
  title:
    'OpenCode (@opencode/sdk 2.0.22) in the Function, rebuilt from the log on every drive: its committed events mirrored into the log, every model request held until the log has them, its own tools on the hands you pick (a virtual workspace whose files are in the log, in memory, or with a machine), each call recorded before it runs. A crash resumes the turn with OpenCode’s own restart sweep and a note of what the log knows.',
  modes: ['server'],
  hands: ['none', 'virtual', 'ephemeral', 'machine', 'sandbox'],
  defaultHands: 'virtual',
  handsDisabled: {
    sandbox: "Coming with opencode({ workspace: sandbox() }): OpenCode's tools on this session's Vercel Sandbox VM aren't wired up yet. Its brain would stay in the Function.",
  },
  model: process.env.OPENCODE_MODEL ?? MODEL,
  enabled: () => process.env.HARNESS_OPENCODE !== '0',
  async load(hands) {
    const [{ opencodeHarness }, { virtual }, tools, { gatewayKey, instructionsFor, MODEL }, { machineTools }, { demoSandbox }] = await Promise.all([
      import('durable-harness/opencode'),
      import('durable-harness'),
      // The side-effect tools and the todo document's, next to OpenCode's own.
      demoTools(),
      import('../model'),
      import('../machine'),
      import('../hands'),
    ]);
    const workspace =
      hands === 'none' ? undefined : hands === 'sandbox' ? await demoSandbox() : virtual(hands === 'ephemeral' ? { durable: false } : {});
    return opencodeHarness({
      ...(workspace ? { workspace } : {}),
      tools: [...tools, ...(hands === 'machine' ? await machineTools() : [])],
      model: process.env.OPENCODE_MODEL ?? MODEL,
      credential: gatewayKey,
      instructions: hands === 'none' ? `${instructionsFor('none')}\n${UNSAFE_NOTE}` : hands === 'machine' ? `${BUILTIN_INSTRUCTIONS}\nFor a real Linux machine (node, npm, python, git, network), use run_on_machine: the workspace files are copied to it and back.` : BUILTIN_INSTRUCTIONS,
      title: 'durable-harness demo',
    });
  },
};

export default opencode;
