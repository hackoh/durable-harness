import type { UnavailableInfo } from 'harness-world';

/** The packages each harness runs from: what to install, or include in a Function. */
const PACKAGES: Record<string, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk and @vercel/sandbox (the Agent SDK runs in the Function; the claude CLI in the session\'s Vercel Sandbox, from its base image)',
  codex: '@vercel/sandbox (Codex runs in the session\'s Vercel Sandbox VM, whose base image carries the codex binary)',
  opencode: '@opencode/client, @opencode/core, @opencode/schema, @opencode/server and effect (and the tree-sitter grammars @opencode/core loads)',
};

/** The harnesses whose CLI runs in the session's Vercel Sandbox: a missing binary is the VM image's, never the Function's. */
const IN_SANDBOX = new Set(['claude-code', 'codex']);

/**
 * What to do about a harness that cannot run here (the live `error` event's
 * `hint`, see harness-world's unavailable.ts), in durable-harness's terms:
 * on Vercel, the Function that drove the turn is missing the harness's
 * run-time files (OpenCode's grammars); elsewhere, a package is not
 * installed. For Claude Code and Codex a binary is the sandbox image's.
 */
export function unavailableHint(info: UnavailableInfo, harness: string): string | undefined {
  if (info.code !== 'binary_missing' && info.code !== 'module_missing' && info.code !== 'binary_unusable') return undefined;
  const packages = PACKAGES[harness] ?? `${harness}'s packages`;
  // A package's entry that does not resolve is a package not installed (the
  // file tracer finds an installed one); a file inside one (a grammar's
  // .wasm, a binary) is one the Function does not include.
  const missing = info.code === 'module_missing' ? /\bCannot find (?:module|package) '([^']+)'/.exec(info.message)?.[1] : undefined;
  if (missing && isPackageEntry(missing)) {
    return `${missing} is not installed: durable-harness takes ${harness}'s packages as optional peers, so the app installs them: ${packages}.`;
  }
  if (IN_SANDBOX.has(harness)) {
    return `${harness}'s CLI runs in the session's Vercel Sandbox, from the binary its base image carries, never in the Function: rebuild the base (npx durable-harness sandbox prepare), or check the image sandbox({ image }) names.`;
  }
  if (process.env.VERCEL) {
    if (info.code === 'binary_unusable') return `This Function has ${harness}'s files for another machine: build on Vercel (not a prebuilt build from another OS), so the linux-x64 packages are installed.`;
    return `This Function does not include ${harness}'s run-time files. Every Function that drives sessions needs them: with Next.js, withDurableHarness (durable-harness/next) adds them; otherwise give the flow function and each chat function harnessFunctions() from durable-harness/vercel in vercel.ts (or npx durable-harness vercel-json).`;
  }
  if (info.code === 'binary_unusable') return `${harness}'s files here are not ones this machine can run: reinstall ${packages} on this machine.`;
  return `Install ${packages}, at the versions durable-harness pins.`;
}

/** `pkg` or `@scope/pkg`, or a subpath without a file extension (`pkg/sub`): not a file such as `pkg/x.wasm` or `/abs/path.js`. */
function isPackageEntry(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) return false;
  const rest = spec.split('/').slice(spec.startsWith('@') ? 2 : 1);
  return rest.length === 0 || !/\.[A-Za-z0-9]+$/.test(rest[rest.length - 1]!);
}
