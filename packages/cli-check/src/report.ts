import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Observed, Phase } from './invariants.ts';
import type { WorldName } from './worlds.ts';

/**
 * What each test file saw, as JSON fragments (`<out>/report/*.json`), merged
 * by the global teardown into `<out>/report.md`: a harness x World matrix
 * and, per cell, what the CLI showed and what was rough.
 */

export interface SessionReport {
  label: string;
  runId?: string;
  /** The World data the CLI read (a world-local data directory). */
  target?: string;
  phase: Phase;
  observed?: Observed;
  findings: (Finding & { known?: string })[];
  error?: string;
}

export interface CellReport {
  scenario: string;
  title: string;
  world: WorldName;
  blocking: boolean;
  skipped?: string;
  sessions: SessionReport[];
}

export function writeFragment(out: string, cell: CellReport): void {
  const dir = join(out, 'report');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cell.scenario}.${cell.world}.json`), `${JSON.stringify(cell, null, 2)}\n`);
}

function cellSummary(cell: CellReport): string {
  if (cell.skipped) return `skipped`;
  const errors = cell.sessions.filter((s) => s.error).length;
  const unexpected = cell.sessions.flatMap((s) => s.findings.filter((f) => !f.known)).length;
  const known = new Set(cell.sessions.flatMap((s) => s.findings.filter((f) => f.known).map((f) => f.known!))).size;
  if (errors) return `**error** (${errors})`;
  if (unexpected) return `**${unexpected} unexpected**${known ? `, ${known} known` : ''}`;
  return known ? `ok, ${known} known` : 'ok';
}

export function mergeReport(out: string): string | undefined {
  const dir = join(out, 'report');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  const cells = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CellReport);
  const worlds = [...new Set(cells.map((c) => c.world))].sort();
  const scenarios = [...new Map(cells.map((c) => [c.scenario, c])).values()];
  const lines: string[] = ['# Workflow CLI check', '', `| Harness | ${worlds.map((w) => `world-${w}`).join(' | ')} |`, `| --- | ${worlds.map(() => '---').join(' | ')} |`];
  for (const s of scenarios) {
    const row = worlds.map((w) => {
      const cell = cells.find((c) => c.scenario === s.scenario && c.world === w);
      return cell ? cellSummary(cell) : 'not run';
    });
    lines.push(`| ${s.title}${s.blocking ? '' : ' (non-blocking)'} | ${row.join(' | ')} |`);
  }
  lines.push('');
  for (const cell of cells.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.world.localeCompare(b.world))) {
    lines.push(`## ${cell.title} on world-${cell.world}`, '');
    if (cell.skipped) {
      lines.push(`Skipped: ${cell.skipped}`, '');
      continue;
    }
    for (const s of cell.sessions) {
      const o = s.observed;
      lines.push(`### ${s.label} session, ${s.phase}${s.runId ? ` (\`${s.runId}\`)` : ''}`, '');
      if (s.target && s.phase === 'open') lines.push(`Data: \`${s.target}\``, '');
      if (s.error) lines.push(`Error: ${s.error}`, '');
      if (o) {
        lines.push(
          `- run: \`${o.workflowName}\`, ${o.status}; ${o.events ?? '?'} events; hooks [${o.hookTokens.join(', ')}]`,
          `- steps: ${o.steps.join(' → ') || '(none)'}${o.superseded ? ` (+${o.superseded} superseded)` : ''}`,
          `- streams: ${o.streams} listed, ${o.streamsDecoded} decoded, ${o.streamsFailed} failed, ${o.streamsOpen} still open; CLI time ${Math.round(o.cliMs / 1000)}s`
        );
      }
      for (const f of s.findings) lines.push(`- ${f.known ? 'known' : '**unexpected**'} [${f.invariant}/${f.code}] ${f.message}${f.known ? ` (${f.known})` : ''}`);
      lines.push('');
    }
  }
  const md = `${lines.join('\n')}\n`;
  writeFileSync(join(out, 'report.md'), md);
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(cells, null, 2)}\n`);
  return md;
}
