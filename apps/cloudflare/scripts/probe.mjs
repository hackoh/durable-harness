// World contract probes, on local workerd: what the Cloudflare World accepts where Worlds differ
// (src/probe.ts), its idempotency keys, and deployment pinning across a
// restart with another HARNESS_DEPLOYMENT_ID. No credential needed.
//
//   node scripts/probe.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDev } from './dev-server.mjs';

const port = 8950 + Math.floor(Math.random() * 40);
const persistTo = mkdtempSync(join(tmpdir(), 'harness-cf-probe-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let output = '';
const up = async (deploymentId) => {
  server = await startDev({ port, persistTo, vars: { HARNESS_PROBES: '1', HARNESS_DEPLOYMENT_ID: deploymentId }, log: (s) => (output += s) });
};
const call = async (path, body) => (await fetch(server.url + path, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })).json();

try {
  await up('dpl_probe_a');
  console.log('contract:', JSON.stringify(await call('/probe'), null, 2));
  console.log('idempotency:', JSON.stringify(await call('/probe/idempotency'), null, 2));

  // Pinning: a session the first build started, then a restart on another build.
  const { sessionId } = await call('/sessions', { harness: 'echo' });
  await call(`/sessions/${sessionId}/messages`, { text: 'before' });
  await sleep(2000);
  const before = await call(`/sessions/${sessionId}`);
  await server.kill();
  await up('dpl_probe_b');
  await call(`/sessions/${sessionId}/messages`, { text: 'after the deploy' });
  await sleep(15_000);
  const after = await call(`/sessions/${sessionId}`);
  const object = await call(`/sessions/${sessionId}/object`);
  console.log(
    'pinning:',
    JSON.stringify(
      {
        firstBuildTurns: before.effects.filter((e) => e.name === 'tool.echo').length,
        secondBuildPlacedTheNewMessage: after.submissions.at(-1).placed,
        heldSignals: object.value.signals,
        heldLog: output.split('\n').filter((l) => l.includes('holding')).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).slice(0, 2),
      },
      null,
      2
    )
  );
} finally {
  await server?.kill();
  rmSync(persistTo, { recursive: true, force: true });
}
