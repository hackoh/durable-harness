/**
 * What a public entry's stub throws until the code behind it lands. The
 * entries exist from the start of the workspaces rework so the package's
 * manifest and build change once (docs/workspaces.md §11.1); the release
 * gate (`scripts/check-dist.mjs`, run by `pnpm ci:publish`) fails while a
 * built entry still holds `UNRELEASED`, so no release publishes a stub.
 */
export const UNRELEASED = 'durable-harness: not released yet';

/** Throw for `what` (a call, as the user wrote it), which lands with `item` (the work item in docs/workspaces.md). */
export function unreleased(what: string, item: string): never {
  throw new Error(`${what} is not available yet (${UNRELEASED}: ${item})`);
}
