import { ExternalIcon } from './bits.tsx';
import type { Mode } from './view.ts';

/**
 * The "Pi (pi-durable)" harness choice: Pi 1.0's own durable Harness
 * (`@earendil-works/pi-durable`) on this server's World through pi-world,
 * next to "Pi" (pi-agent-core's Agent on the durable-harness kernel).
 */

/** How the two differ, in the package README. */
export const PI_DURABLE_README = 'https://github.com/vercel-labs/durable-harness/blob/main/packages/durable-harness/README.md#pi-with-pi-durable-and-without';

export const PI_DURABLE_TIP = "Pi's own durable Harness (pi-durable) on this server's World: Pi decides what is durable, and every commit is awaited. Server only.";
export const PI_DURABLE_STRICT = 'Strict only: Pi owns durability, and awaits every commit. For Native, pick Pi.';
export const PI_DURABLE_OFF = 'Strict only: Pi owns durability. For Native, pick Pi.';
export const PI_DURABLE_NATIVE = 'Strict only: Pi owns durability. For Native, pick Pi.';
export const PI_DURABLE_SERVER_ONLY: Record<Mode, string> = {
  server: '',
  tab: 'pi-durable runs on the server only, for now.',
  hybrid: 'Hybrid moves a session between lanes; pi-durable has one owner process at a time and no lane handoff.',
};

/** The empty state's line for it: what it is, and where the difference is written down. */
export function PiDurablePanel() {
  return (
    <p className="own-note">
      Pi’s own durable Harness (pi-durable) on this server’s World: Pi decides what is durable, every commit is awaited. No documents.{' '}
      <a href={PI_DURABLE_README} target="_blank" rel="noreferrer">
        How It Differs <ExternalIcon />
      </a>
    </p>
  );
}
