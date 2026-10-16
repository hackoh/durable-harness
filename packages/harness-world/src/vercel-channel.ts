/**
 * world-vercel's per-run WebSocket events channel, for drivers that run
 * outside a queue delivery (a drive route, a daemon in a sandbox).
 *
 * world-vercel writes a run's events over its WebSocket only while that run's
 * channel is open (the transport is its default since 5.1.0; it was opt-in
 * with `WORKFLOW_EVENTS_TRANSPORT=ws` in 5.0.x, see `enableVercelWebSockets`).
 * Its queue handler opens one per delivery; anything else opens it with
 * `openEventsChannel`.
 *
 * `linger` keeps a channel open for a while after its last user releases it:
 * a reopen costs a 90-140 ms handshake, and a session's writes come in bursts
 * (a turn, then the next prompt).
 */
type OpenWsChannel = (runId: string) => (() => void) | undefined;

interface ChannelState {
  holders: number;
  release?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const KEY = Symbol.for('harness-world.vercel-channel');

function state(): { open?: OpenWsChannel | null; loading?: Promise<OpenWsChannel | null>; channels: Map<string, ChannelState> } {
  const g = globalThis as { [KEY]?: ReturnType<typeof state> };
  g[KEY] ??= { channels: new Map() };
  return g[KEY];
}

/** Tests: replace the opener (null disables). */
export function setVercelChannelOpenerForTest(open: OpenWsChannel | null): void {
  setVercelChannelOpener(open);
  state().channels.clear();
}

/**
 * Use `open` as this process's opener: world-vercel's `openEventsChannel`,
 * imported by code that can resolve world-vercel (the app), for code that
 * cannot import it itself (a package that must not depend on world-vercel).
 */
export function setVercelChannelOpener(open: OpenWsChannel | null): void {
  const s = state();
  s.open = open;
  s.loading = Promise.resolve(open);
}

/**
 * Opt this process into world-vercel's WebSocket events transport. It is the
 * default since 5.1.0 (5.0.x was HTTP unless `WORKFLOW_EVENTS_TRANSPORT=ws`),
 * so this only matters on 5.0.x, and for `HARNESS_EVENTS=http`, which pins
 * HTTP on either. An explicit `WORKFLOW_EVENTS_TRANSPORT` always wins. Call
 * before the first event write; the gate is read per write.
 */
export function enableVercelWebSockets(): void {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  if (env) env.WORKFLOW_EVENTS_TRANSPORT ??= env.HARNESS_EVENTS === 'http' ? 'http' : 'ws';
}

/** Resolve world-vercel's opener, or null when the package or its internals are not there. */
export async function loadVercelChannelOpener(): Promise<OpenWsChannel | null> {
  const s = state();
  if (s.open !== undefined) return s.open;
  s.loading ??= (async () => {
    try {
      // A specifier the bundler cannot follow: an app on another World has no
      // world-vercel to resolve, and this is only called where there is one.
      const specifier = ['@workflow', 'world-vercel'].join('/');
      const pkg = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier)) as { openEventsChannel?: OpenWsChannel };
      return typeof pkg.openEventsChannel === 'function' ? pkg.openEventsChannel : null;
    } catch {
      return null;
    }
  })();
  s.open = await s.loading;
  return s.open;
}

/**
 * A `DriverOptions.openChannel` for world-vercel. Synchronous, as the driver
 * needs: call `loadVercelChannelOpener()` once at startup first; before it
 * resolves (or where it resolved to null) this returns undefined and writes
 * stay on HTTP.
 */
export function vercelChannel(options: { lingerMs?: number } = {}) {
  const lingerMs = options.lingerMs ?? 30_000;
  return (runId: string): (() => void) | undefined => {
    const s = state();
    if (!s.open) return undefined;
    let ch = s.channels.get(runId);
    if (!ch) {
      const release = s.open(runId);
      if (!release) return undefined;
      ch = { holders: 0, release };
      s.channels.set(runId, ch);
    }
    if (ch.timer) {
      clearTimeout(ch.timer);
      ch.timer = undefined;
    }
    ch.holders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const c = s.channels.get(runId);
      if (!c) return;
      c.holders -= 1;
      if (c.holders > 0) return;
      c.timer = setTimeout(() => {
        if (c.holders > 0) return;
        s.channels.delete(runId);
        c.release?.();
      }, lingerMs);
      (c.timer as { unref?: () => void }).unref?.();
    };
  };
}
