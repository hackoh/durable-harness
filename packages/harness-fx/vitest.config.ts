import { defineConfig } from 'vitest/config';
// test/sandbox.test.ts runs on harness-sandbox's stand-in (DH_TEST_LOCAL_SANDBOX=1). The flag is set
// here, before any test file loads libfx: a variable set after libfx's native code read the
// environment can crash it.
export default defineConfig({ test: { testTimeout: 30_000, env: { DH_TEST_LOCAL_SANDBOX: '1' } } });
