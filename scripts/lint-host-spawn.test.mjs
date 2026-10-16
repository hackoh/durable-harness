// node --test scripts/lint-host-spawn.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findings } from './lint-host-spawn.mjs';

const FN = 'packages/durable-harness/src/x.ts';
const rules = (path, source) => findings(path, source).map(([line, rule]) => `${line}:${rule}`);
// Spelled in two parts, so this file never names the entry itself.
const BRAND_ENTRY = 'harness-world-process/' + 'machine-brand';

test('child_process, however a Function-tier file loads it', () => {
  assert.deepEqual(rules(FN, "import { spawn } from 'node:child_process';"), ['1:child-process']);
  assert.deepEqual(rules(FN, "const cp = await import('child_process');"), ['1:child-process']);
  assert.deepEqual(rules(FN, "x\nconst cp = process.getBuiltinModule(`node:child_process`);"), ['2:child-process']);
  assert.deepEqual(rules(FN, "const { spawn } = require('child_process');"), ['1:child-process']);
  // Named in a comment, or in prose inside a string, is fine.
  assert.deepEqual(rules(FN, "// import { spawn } from 'node:child_process'\n/* 'child_process' */ const s = 'no child_process here';"), []);
});

test('NodeExecutionEnv as code, not in a message', () => {
  assert.deepEqual(rules(FN, "import { NodeExecutionEnv } from 'pi';\nconst e = new NodeExecutionEnv();"), ['1:node-execution-env', '2:node-execution-env']);
  assert.deepEqual(rules(FN, "throw new Error('NodeExecutionEnv runs on this disk');"), []);
});

test("pi-coding-agent's values, not its types", () => {
  assert.deepEqual(rules(FN, "import { createCodingTools } from '@earendil-works/pi-coding-agent';"), ['1:pi-coding-agent']);
  assert.deepEqual(rules(FN, "export { bashTool } from '@earendil-works/pi-coding-agent/tools';"), ['1:pi-coding-agent']);
  assert.deepEqual(rules(FN, "const m = await import('@earendil-works/pi-coding-agent');"), ['1:pi-coding-agent']);
  assert.deepEqual(rules(FN, "import type { AgentTool } from '@earendil-works/pi-coding-agent';"), []);
});

test('ProcessHost only inside harness-world-process; its types anywhere', () => {
  assert.deepEqual(rules(FN, "import { ProcessHost } from 'harness-world-process';"), ['1:process-host']);
  assert.deepEqual(rules(FN, "import type { ProcessHostLike, ProcessHostOptions } from 'harness-world-process';"), []);
  assert.deepEqual(rules('packages/harness-process/src/index.ts', "export { ProcessHost } from './host.ts';"), []);
});

test("the brand's minter: only the session factory, in any file, scanned or not", () => {
  assert.deepEqual(rules('packages/harness-sandbox/src/session.ts', `import { machineBrand } from '${BRAND_ENTRY}';`), []);
  assert.deepEqual(rules('packages/harness-sandbox/src/other.ts', `import { machineBrand } from '${BRAND_ENTRY}';`), ['1:machine-brand', '1:machine-brand']);
  assert.deepEqual(rules('packages/harness-claude-code/test/x.test.ts', `const { machineBrand: m } = await import('${BRAND_ENTRY}');`), ['1:machine-brand', '1:machine-brand']);
  assert.deepEqual(rules('packages/harness-codex/src/x.ts', "import { brand } from '../../harness-process/src/machine-brand.ts';"), ['1:machine-brand']);
  // The index re-exports the check, never the minter.
  assert.deepEqual(rules('packages/harness-process/src/index.ts', "export { isBrandedMachine } from './machine-brand.ts';"), []);
  assert.deepEqual(rules('packages/harness-process/src/index.ts', "export { isBrandedMachine, machineBrand } from './machine-brand.ts';"), ['1:machine-brand']);
});

test('tests, scripts and config files are not Function-tier', () => {
  const spawn = "import { spawn } from 'node:child_process';";
  for (const path of ['packages/durable-harness/test/a.test.ts', 'packages/durable-harness/src/a.test.ts', 'packages/durable-harness/scripts/build.mjs', 'apps/demo/next.config.ts', 'apps/demo/e2e/a.spec.ts', 'scripts/x.mjs']) {
    assert.deepEqual(rules(path, spawn), [], path);
  }
  assert.deepEqual(rules('apps/demo/app/api/x/route.ts', spawn), ['1:child-process']);
});

test('comments, prose and regular expressions never count; a quote inside a regular expression hides nothing', () => {
  assert.deepEqual(rules(FN, "const q = /['\"`]/;\nconst m = 'x';\nimport { spawn } from 'node:child_process';"), ['3:child-process']);
  assert.deepEqual(rules(FN, "const re = /machineBrand|NodeExecutionEnv|ProcessHost/; // new NodeExecutionEnv()"), []);
  assert.deepEqual(rules(FN, "const e = `uses ${'NodeExecutionEnv'}`;"), []);
});

test('types are not values', () => {
  assert.deepEqual(rules(FN, "import { type NodeExecutionEnv } from 'pi';\nlet e: NodeExecutionEnv | undefined;\ntype T = typeof ProcessHost;"), []);
});
