/**
 * A drive process stand-in for `host.test.ts`: starts a child through a
 * `ProcessHost` with the watchdog on; the child starts a command in a
 * process group of its own the way a harness's shell tool does (a detached
 * `bash -c`, under the session's environment, so it registers its group).
 * Prints `{ pid, tool }` once the command is registered, then waits to be
 * SIGKILLed.
 *
 *   node --import tsx src/fixtures/watchdog-parent.ts <root>
 */
import { readdirSync } from 'node:fs';
import { ProcessHost } from '../host.ts';

const host = new ProcessHost({ root: process.argv[2]! });
const proc = await host.spawn('wrun_watch', {
  command: process.execPath,
  args: [
    '-e',
    `const t = require('node:child_process').spawn('bash', ['-c', 'sleep 60'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
     console.log(JSON.stringify({ tool: t.pid })); setInterval(() => {}, 1000);`,
  ],
  watchdog: true,
});
const line = (await proc.lines()[Symbol.asyncIterator]().next()).value as string;
const { tool } = JSON.parse(line) as { tool: number };
const dir = await host.dir('wrun_watch');
while (!readdirSync(dir.groups).includes(String(tool))) await new Promise((r) => setTimeout(r, 20));
process.stdout.write(`${JSON.stringify({ pid: proc.pid, tool })}\n`);
setInterval(() => {}, 1000);
