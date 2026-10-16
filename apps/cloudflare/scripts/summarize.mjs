// Print a drill report (scripts/drill.mjs) in one screen.
import { readFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${r.harness} (${r.durability}) ${r.sessionId} on ${r.where}: ${r.ok ? 'ok' : `FAILED ${String(r.error).split('\n')[0].slice(0, 160)}`}`);
  for (const [step, v] of Object.entries(r.steps)) {
    const { effects, text, ...rest } = v;
    console.log(`  ${step.padEnd(7)} ${JSON.stringify(rest)}`);
    if (text) console.log(`          "${text.replace(/\s+/g, ' ').slice(0, 150)}"`);
  }
  if (r.object) console.log(`  object  ${JSON.stringify(r.object.value ?? r.object)} (events: ${r.events})`);
}
