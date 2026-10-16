import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREFIX, SWEEP_PREFIX, exitCode, percentiles, probeName } from '../probes/lib.ts';

const pkg = join(import.meta.dirname, '..');
const root = join(pkg, 'probes');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Credential shapes that must never be checked in with a probe. */
const SECRETS: [string, RegExp][] = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ['vercel-token', /\bvc[a-z]?_[A-Za-z0-9]{20,}/],
  ['github-token', /\b(ghp_|github_pat_)[A-Za-z0-9_]{20,}/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['sha256-literal', /\b[0-9a-f]{64}\b/],
  ['bypass-or-oidc-value', /(VERCEL_OIDC_TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET|AI_GATEWAY_API_KEY)\s*[=:]\s*['"]?[A-Za-z0-9._-]{16,}/],
  ['vercel-ids', /\b(team|prj|dpl)_[A-Za-z0-9]{24,}\b/],
];

describe('probes', () => {
  it('carry no credential, token hash or account id', () => {
    for (const f of files(root)) {
      const text = readFileSync(f, 'utf8');
      for (const [rule, re] of SECRETS) expect(re.test(text), `${relative(root, f)}: ${rule}`).toBe(false);
    }
  });

  it('every laptop probe that creates something runs inside probe(), and tracks each name before creating it', () => {
    const creators = readdirSync(root).filter((f) => f.endsWith('.ts') && f !== 'lib.ts');
    for (const f of creators) {
      const text = readFileSync(join(root, f), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const calls = [...code.matchAll(/\.(create|getOrCreate)\(\{([^}]*)/g)];
      if (!calls.length) continue;
      expect(text, f).toMatch(/await probe\(async \(\) =>/);
      // Names go through track(), never straight into the sets after a create.
      expect(text, f).not.toMatch(/created\.(sandboxes|drives)\.add\(/);
      for (const call of calls) {
        const name = /\bname(?::\s*([A-Za-z_]\w*))?\s*(?:,|$)/.exec(call[2]!);
        expect(name, `${f}: a create without a name variable`).not.toBeNull();
        const id = name![1] ?? 'name';
        const tracked = new RegExp(`const ${id} = track\\(|track\\('(sandbox|drive)', ${id}\\)`).exec(code);
        expect(tracked && tracked.index < call.index!, `${f}: ${id} is tracked before ${call[0]}`).toBe(true);
      }
    }
  });

  it('exits 1 when the body threw or cleanup left something of its own', () => {
    expect(exitCode(false, [])).toBe(0);
    expect(exitCode(true, [])).toBe(1);
    expect(exitCode(false, ['dh-probe-a-1'])).toBe(1);
    expect(exitCode(false, undefined)).toBe(1);
  });

  it('sweeps by a prefix no session name can have', () => {
    expect(SWEEP_PREFIX).toBe(`${PREFIX}-`);
    // A session is dh-<base32>; base32 has no hyphen.
    expect('dh-probexyz2'.startsWith(SWEEP_PREFIX)).toBe(false);
    expect(probeName('a', 'abc123').startsWith(SWEEP_PREFIX)).toBe(true);
  });

  it('never ship: no export, bin or build entry of the package resolves under probes/', () => {
    const manifest = readFileSync(join(pkg, 'package.json'), 'utf8');
    const { exports, main, module, bin, types, files } = JSON.parse(manifest) as Record<string, unknown>;
    expect(JSON.stringify({ exports, main, module, bin, types, files }) ?? '', 'package.json').not.toMatch(/probes/);
    for (const f of readdirSync(pkg).filter((e) => /^(tsup|tsdown|rollup|vite)\.config\./.test(e))) {
      expect(readFileSync(join(pkg, f), 'utf8'), f).not.toMatch(/probes/);
    }
  });

  it('names every resource under the sweepable prefix, as a valid sandbox name', () => {
    expect(probeName('a', 'abc123')).toBe(`${PREFIX}-a-abc123`);
    expect(() => probeName('Bad_Name')).toThrow(TypeError);
    expect(() => probeName('x'.repeat(60))).toThrow(TypeError);
  });

  it('reports p50, p95 and max', () => {
    expect(percentiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 100])).toEqual({ n: 10, p50: 5, p95: 100, max: 100 });
  });
});
