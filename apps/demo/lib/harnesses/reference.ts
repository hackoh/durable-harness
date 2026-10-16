import type { DemoHarness } from './types';

/**
 * The reference process harness (harness-world-process/reference): a
 * scripted fake CLI child with its own session file, driven the way the
 * real ports drive theirs. Local only (`HARNESS_REFERENCE=1`): it is there to
 * try the shared core and this registry, not as a harness.
 *
 * Try `call write_file {"path":"a.txt","content":"hi"}`, then arm a crash at
 * the next tool and send `call unsafe_make_payment {"to":"acme","amount_usd":5,"memo":"x"}`.
 */
const reference: DemoHarness = {
  value: 'reference',
  label: 'Reference CLI',
  title: 'The reference process harness: a scripted fake CLI in its own process, its session file mirrored into the log, the workspace tools as its only tools. Type `call <tool> <json args>`.',
  modes: ['server'],
  // Its fake CLI types its replies itself here (no model behind a proxy): no model step to crash in.
  crashes: ['tool', 'any'],
  enabled: () => process.env.HARNESS_REFERENCE === '1',
  async load() {
    const [{ referenceHarness }, hands] = await Promise.all([import('harness-world-process/reference'), import('harness-world-hands')]);
    // FAKE_CLI_TYPE_MS slows the fake model down, to watch its text stream.
    return referenceHarness({ tools: hands.workspaceTools(), env: { ...(process.env.FAKE_CLI_TYPE_MS ? { FAKE_CLI_TYPE_MS: process.env.FAKE_CLI_TYPE_MS } : {}) } });
  },
};

export default reference;
