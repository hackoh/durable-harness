import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeReport } from '../src/report.ts';
import { outDir } from '../src/worlds.ts';

/** Start each run with an empty report, and merge the test files' fragments into report.md at the end. */
export default function setup() {
  rmSync(join(outDir(), 'report'), { recursive: true, force: true });
  return () => {
    const md = mergeReport(outDir());
    if (md) console.log(`\nWorkflow CLI check report: ${join(outDir(), 'report.md')}\n`);
  };
}
