import { ExternalIcon } from './bits.tsx';
import type { Mode } from './view.ts';

/**
 * The "fx (libfx durable)" harness choice: libfx's own durable sessions
 * (`createFxAgent`) on this server's World, next to "fx" (libfx's engine on
 * the durable-harness kernel).
 */

/** How libfx's own durability is served, in the package README. */
export const FX_DURABLE_README = 'https://github.com/vercel-labs/durable-harness/blob/main/packages/durable-harness/README.md#fx-agents-libfx';

export const FX_DURABLE_TIP =
  "libfx's own durable sessions on this server's World: libfx waits for the prompt and for each unsafe tool, and the rest trails (Durable). Server only.";
export const FX_DURABLE_ASYNC = 'Durable only: libfx owns durability, and waits only for the prompt and for each unsafe tool. For Native, pick fx.';
export const FX_DURABLE_OFF = 'Durable only: libfx owns durability. For Native, pick fx.';
export const FX_DURABLE_NATIVE = 'Durable only: libfx owns durability. For Native, pick fx.';
export const FX_DURABLE_SERVER_ONLY: Record<Mode, string> = {
  server: '',
  tab: 'libfx durable sessions run on the server only.',
  hybrid: 'Hybrid moves a session between lanes; a libfx durable session has one worker at a time and no lane handoff.',
};

/** The empty state's line for it: what it is, and where the difference is written down. */
export function FxDurablePanel() {
  return (
    <p className="own-note">
      libfx’s own durable sessions on this server’s World: libfx waits for the prompt and for each unsafe tool, and the rest trails. No documents.{' '}
      <a href={FX_DURABLE_README} target="_blank" rel="noreferrer">
        How It Differs <ExternalIcon />
      </a>
    </p>
  );
}
