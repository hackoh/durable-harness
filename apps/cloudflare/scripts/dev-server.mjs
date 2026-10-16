// Start and stop `wrangler dev` (local workerd) for the drills and tests, in
// its own process group so a crash can SIGKILL wrangler, workerd and every
// Durable Object instance at once, with no goodbye. Local persistence
// (`--persist-to`) keeps the run objects' storage and alarms across restarts.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(appDir, 'node_modules/.bin/wrangler');

export async function startDev({ port, persistTo, vars = {}, log = () => {} }) {
  let output = '';
  const child = spawn(wrangler, ['dev', '--port', String(port), '--inspector-port', String(port + 10000), '--persist-to', persistTo, '--show-interactive-dev-session=false', '--log-level', 'info', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (chunk) => {
    output += chunk.toString();
    log(chunk.toString());
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const deadline = Date.now() + 120_000;
  while (!output.includes('Ready on')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
  return {
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    output: () => output,
    /** SIGKILL the whole process group: wrangler, workerd, every isolate. */
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      return exited;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // node scripts/dev-server.mjs <port> <persistTo>: run until Ctrl-C.
  const server = await startDev({ port: Number(process.argv[2] ?? 8787), persistTo: process.argv[3] ?? join(appDir, '.wrangler/state'), log: (s) => process.stdout.write(s) });
  console.log(`[dev-server] ${server.url} pgid ${server.pid}`);
  process.on('SIGINT', async () => {
    await server.kill();
    process.exit(0);
  });
}
