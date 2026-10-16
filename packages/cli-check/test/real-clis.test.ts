import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { codexBinary } from 'harness-world-codex/binary';
import { describe, it } from 'vitest';

/**
 * The process harnesses' real CLIs. The check drives their scripted
 * stand-ins (scenarios/claude-code.ts, codex.ts, opencode.ts), which write
 * the log the same way; a real CLI's turn needs a model it can talk to
 * without a credential. Listed here so the gap shows in every run: a todo
 * where the binary is installed, a skip (with why) where it is not. Claude
 * Code's real CLI is harness-world-claude-code's `sandbox-restart.test.ts`
 * (the pinned binary on the stand-in VM, a Messages API fake).
 */

const require = createRequire(import.meta.url);
/** Whether `pkg` is installed next to workspace package `from` (its exports may hide a resolvable entry). */
const installed = (pkg: string, from: string) => existsSync(join(dirname(require.resolve(from)), '..', 'node_modules', pkg, 'package.json'));

const clis = [
  {
    name: 'codex (codex app-server)',
    present: () => !!codexBinary(),
    needs: 'an OpenAI Responses API fake behind the drive gateway proxy',
  },
  {
    name: 'OpenCode 2.0.22 (in-process host)',
    present: () => installed('@opencode/server', 'harness-world-opencode'),
    needs: 'an AI Gateway v3 stream fake (src/host.test.ts already runs OpenCode offline with no model call)',
  },
];

describe('real CLIs behind the process harnesses', () => {
  for (const cli of clis) {
    if (cli.present()) it.todo(`${cli.name} is installed; a credential-free turn needs ${cli.needs}`);
    else it.skip(`${cli.name}: not installed on ${process.platform}-${process.arch}`, () => {});
  }
});
