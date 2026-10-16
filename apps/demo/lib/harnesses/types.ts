import type { Harness } from 'harness-world';
import type { Hands, HarnessOption } from 'harness-world-demo-ui';

/**
 * A process harness the demo offers (Claude Code, Codex, OpenCode, Cursor),
 * built on harness-world-process: one file per harness in this directory,
 * listed in `index.ts`. The picker, the session list and the transcript
 * pick it up from there (`GET /api/sessions` sends the options to the page),
 * with its `hands` (the Hands axis; default Virtual only).
 */
export interface DemoHarness extends Omit<HarnessOption, 'disabledReason' | 'process'> {
  /** Register it on this deployment at all (an env flag). Default: yes. */
  enabled?: () => boolean;
  /** Why it cannot run here right now (a missing key or credential). Shown in the picker; read per request. */
  disabledReason?: () => string | undefined;
  /**
   * Build the kernel `Harness` for sessions with these hands (its `name`
   * must be `value`). Called on the first drive of one of its sessions with
   * those hands in this process: import the harness package and its SDK
   * inside, so a route that only lists sessions loads none of it.
   */
  load: (hands: Hands) => Promise<Harness>;
}
