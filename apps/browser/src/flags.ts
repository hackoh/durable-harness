/**
 * Page flags for A/B benchmarks (`/bench?drive=queue`, `/?hints=0`, ...).
 * Each returns undefined when unset, so the client's default applies.
 */
const NAMES = ['drive', 'hints', 'prewarm', 'relay'] as const;
const KEY = 'how:flags';

/**
 * Read once, when this module loads (main.tsx imports it first, before the
 * page rewrites its URL), and kept in sessionStorage so a reload keeps them.
 * `?<flag>=auto` clears one.
 */
const flags: Record<string, string> = (() => {
  if (typeof location === 'undefined') return {};
  let kept: Record<string, string> = {};
  try {
    kept = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
  } catch {}
  const search = new URLSearchParams(location.search);
  for (const name of NAMES) {
    const v = search.get(name);
    if (v === 'auto') delete kept[name];
    else if (v !== null) kept[name] = v;
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify(kept));
  } catch {}
  return kept;
})();

const param = (name: (typeof NAMES)[number]): string | null => flags[name] ?? null;

/** `?drive=http|queue`: how the server drives a turn the tab hands it (see apps/demo lib/drive.ts). */
export function driveFlag(): 'http' | 'queue' | undefined {
  const v = param('drive');
  return v === 'http' || v === 'queue' ? v : undefined;
}

/** `?hints=0`: poll instead of tailing live hints. */
export function hintsFlag(): boolean | undefined {
  const v = param('hints');
  return v === null ? undefined : v !== '0';
}

/**
 * `?prewarm=0`: no pre-created sessions. Off by default on `/bench`, which
 * opens its sessions before it starts a clock (a spare being made in the
 * background would only add noise to the samples).
 */
export function prewarmFlag(): boolean {
  const v = param('prewarm');
  if (v !== null) return v !== '0';
  return typeof location === 'undefined' || !location.pathname.startsWith('/bench');
}

/** `?relay=ws`: the tab's World over one WebSocket to `/api/session-host` instead of HTTP `/api/world`. */
export function relayFlag(): 'http' | 'ws' | undefined {
  const v = param('relay');
  return v === 'http' || v === 'ws' ? v : undefined;
}
