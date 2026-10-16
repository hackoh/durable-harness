import { defineConfig } from 'vitest/config';

// test/kernel.cf.test.ts starts `wrangler dev` itself (local workerd only).
export default defineConfig({
  test: {
    include: ['test/**/*.cf.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
