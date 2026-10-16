/**
 * The relay bundle's entry (docs/workspaces.md §5.2: `/opt/dh/relay-<hash>.mjs`).
 * `serve <config>` runs the relay; `arm <config> --sha256 H --session S
 * [--fence N --fenced true|false] [--model sha256(P)]` arms it (starting it, from this same file,
 * if needed) and prints the JSON reply on stdout; `helper` is the per-attach
 * helper the relay starts from this same file, as the unprivileged user
 * (`helper.ts`). Bundled with `ws` into one `.mjs` by `bundle.ts`.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Relay, readConfig } from './relay.ts';
import { runArm } from './arm.ts';
import { runHelper } from './helper.ts';

async function main(argv: string[]): Promise<void> {
  const [cmd, configPath, ...rest] = argv;
  if (cmd === 'helper') return runHelper();
  if (!cmd || !configPath) throw new Error('usage: relay <serve|arm> <config.json> [...] | relay helper');
  if (cmd === 'serve') {
    const relay = new Relay(readConfig(configPath), { entryPath: fileURLToPath(import.meta.url) });
    // A bind failure (another relay holds the ports) exits here, touching nothing of the other's.
    await relay.start();
    // Stay up; the process is killed by the VM's lifecycle or `stop`.
    await new Promise<never>(() => {});
    return;
  }
  if (cmd === 'arm') {
    const { values } = parseArgs({ args: rest, options: { sha256: { type: 'string' }, fence: { type: 'string' }, fenced: { type: 'string' }, session: { type: 'string' }, model: { type: 'string' } } });
    if (!values.sha256 || !values.session) throw new Error('arm needs --sha256 and --session');
    let fence: number | undefined;
    if (values.fence !== undefined) {
      if (!/^\d{1,15}$/.test(values.fence) || !Number.isSafeInteger(Number(values.fence))) throw new Error('--fence must be a non-negative integer');
      if (values.fenced !== 'true' && values.fenced !== 'false') throw new Error('--fence needs --fenced true|false');
      fence = Number(values.fence);
    }
    const reply = await runArm(
      configPath,
      { sha256: values.sha256, session: values.session, ...(fence !== undefined ? { fence, fenced: values.fenced === 'true' } : {}), ...(values.model !== undefined ? { model: values.model } : {}) },
      { entryPath: fileURLToPath(import.meta.url) }
    );
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    process.exit(reply.ok ? 0 : 1);
  }
  throw new Error(`unknown relay command ${cmd}`);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${String((err as Error)?.message ?? err)}\n`);
  process.exit(1);
});
