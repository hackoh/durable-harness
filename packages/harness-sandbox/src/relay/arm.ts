/**
 * The `arm` command (docs/workspaces.md §5.4 step 2): make sure the relay is
 * running, hand it the armed capability (`sha256(T)`, the fence token, the
 * session), and print what the driver needs to connect (`R`, `bootId`,
 * versions, the tier). In a real VM the driver calls this through
 * `sandbox.runCommand(sudo)`; the stand-in (`localMachine`) talks to the
 * control socket directly (`requestArm`).
 *
 * Idempotent, and safe to race: there is no lock file. Two `arm`s that find no
 * relay both start one; the relay binds its two TCP ports before it touches the
 * control socket, so the second fails to bind and exits, and both `arm`s then
 * talk to the one that won.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ArmReply, ArmRequest } from './protocol.ts';
import type { RelayConfig } from './relay.ts';
import { readConfig } from './relay.ts';

/** Send one arm request to a relay already listening on its control socket (undefined if it is not up). */
export function requestArm(stateDir: string, req: ArmRequest, timeoutMs = 5_000): Promise<ArmReply | undefined> {
  return new Promise((resolve) => {
    const sock = connect(join(stateDir, 'control.sock'));
    let settled = false;
    const done = (reply: ArmReply | undefined) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(reply);
    };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on('error', () => done(undefined));
    sock.on('close', () => done(undefined));
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    const rl = createInterface({ input: sock });
    rl.on('error', () => {});
    rl.once('line', (line) => {
      try {
        done(JSON.parse(line) as ArmReply);
      } catch {
        done(undefined);
      }
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Arm the relay named by `configPath`, starting it (detached) if it is not up.
 * `entryPath` is the relay entry to start it with: the bundle itself (the
 * entry passes its own path) or, in dev, `entry.ts`.
 */
export async function runArm(configPath: string, req: ArmRequest, options: { entryPath: string; node?: string; startTimeoutMs?: number }): Promise<ArmReply> {
  const config = readConfig(configPath);
  const first = await requestArm(config.stateDir, req);
  if (first) return first;
  const child = spawn(options.node ?? process.execPath, [options.entryPath, 'serve', configPath], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  const until = Date.now() + (options.startTimeoutMs ?? 10_000);
  while (Date.now() < until) {
    await sleep(50);
    const reply = await requestArm(config.stateDir, req, 1_000);
    if (reply) return reply;
  }
  throw new Error(`harness-sandbox: relay did not come up for ${configPath}`);
}

export { armArgs, armRequest } from './protocol.ts';

/** Read the config to find the session, for a CLI invocation. */
export function configFor(configPath: string): RelayConfig {
  return readConfig(configPath);
}
