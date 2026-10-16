import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Above the CLI's own call timeout (CLI_TIMEOUT_MS), so a slow call fails as itself.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // `test/` drives sessions and runs the CLI (`pnpm cli-check`); `src/` holds the unit tests (`pnpm test`).
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
  },
});
