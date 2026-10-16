/**
 * The CLIs the base snapshot pins (docs/workspaces.md §5.2): where each is
 * unpacked and the tarball it comes from, checked against the lockfile's
 * integrity (`test/base.test.ts`). A leaf, so a CLI harness that needs only
 * where its binary is (`harness-world-sandbox/cli`) loads nothing of the
 * base's build or the relay bundle's.
 */

/** A pinned npm tarball and what to run from it. */
export interface PinnedCli {
  /** The version the arm reply reports (`cliVersions`, §5.2). */
  version: string;
  /** The tarball's URL on the npm registry. */
  url: string;
  /** Its `sha512-<base64>` integrity, as `pnpm-lock.yaml` pins it. */
  integrity: string;
  /** Where it is unpacked (`/opt/dh/<name>/<version>`). */
  dir: string;
  /** The executable, relative to `dir`. */
  bin: string;
}

/** Claude Code 2.1.296 (`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.296`, glibc): the binary of the Agent SDK harness-claude-code pins. */
export const CLAUDE_CLI: PinnedCli = Object.freeze({
  version: '2.1.296',
  url: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.296.tgz',
  integrity: 'sha512-TStCnbg2iBtWJBQeMdO7Xwpx5IYWICmdcf7J9eXhIi4JbahWD+VLRaH5sxB+LLZjdBXekp8piKv6Ne2+arag0w==',
  dir: '/opt/dh/claude/2.1.296',
  bin: 'claude',
});

/** Codex 0.160.0 (`@openai/codex@0.160.0-linux-x64`, musl), with its `rg`. */
export const CODEX_CLI: PinnedCli = Object.freeze({
  version: '0.160.0',
  url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.160.0-linux-x64.tgz',
  integrity: 'sha512-KI/73OqGrHmR18s7ya7E1NqV6rT0y3lxr0s8S1qR2m6zU6QRF/HlR529jALLh5vjdUnsRT4Ahoxt0axb4kY99g==',
  dir: '/opt/dh/codex/0.160.0',
  bin: 'vendor/x86_64-unknown-linux-musl/bin/codex',
});

/** Where a pinned CLI's executable is in the base image. */
export const cliPath = (cli: PinnedCli): string => `${cli.dir}/${cli.bin}`;
