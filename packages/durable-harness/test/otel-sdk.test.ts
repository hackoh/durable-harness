import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// OpenTelemetry's SDK is an optional peer that only /instrumentation/otel loads.
const SDK = ['@opentelemetry/sdk-trace-base', '@opentelemetry/resources', '@opentelemetry/otlp-transformer'];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const notFound = (name: string) => Object.assign(new Error(`Cannot find package '${name}' imported from /app/node_modules/durable-harness/dist/instrumentation/otel.js`), { code: 'ERR_MODULE_NOT_FOUND' });

afterEach(() => {
  for (const name of SDK) vi.doUnmock(name);
  vi.resetModules();
});

describe("OpenTelemetry's SDK", () => {
  it('is an optional peer dependency, tested at the versions the install line names', async () => {
    for (const name of SDK) {
      expect(pkg.dependencies[name]).toBeUndefined();
      expect(pkg.peerDependencies[name]).toBeDefined();
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
    // @opentelemetry/api stays a dependency: spans go through it, and are no-ops until agentRuns() registers.
    expect(pkg.dependencies['@opentelemetry/api']).toBeDefined();
    vi.doMock('@opentelemetry/sdk-trace-base', () => {
      throw notFound('@opentelemetry/sdk-trace-base');
    });
    const { agentRuns } = await import('../src/instrumentation/otel.ts');
    let error: Error | undefined;
    try {
      agentRuns();
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('@opentelemetry/sdk-trace-base is not installed');
    expect(error?.message).toContain(`pnpm add ${SDK.map((name) => `${name}@${pkg.devDependencies[name]}`).join(' ')}`);
  });

  it('missing, the entry still loads, and agentRuns() names the install line', async () => {
    vi.doMock('@opentelemetry/otlp-transformer', () => {
      throw notFound('@opentelemetry/otlp-transformer');
    });
    const otel = await import('../src/instrumentation/otel.ts');
    expect(() => otel.agentRuns({ audience: 'public' })).toThrow(/@opentelemetry\/otlp-transformer is not installed\. Install them: pnpm add @opentelemetry\/sdk-trace-base@/);
    // An export policy for a processor of your own needs no SDK.
    const ended: unknown[] = [];
    const processor = otel.filteringProcessor({ onStart() {}, onEnd: (span) => ended.push(span), forceFlush: async () => {}, shutdown: async () => {} });
    expect(typeof processor.onEnd).toBe('function');
  });

  it('failing to load for another reason, fails the import', async () => {
    vi.doMock('@opentelemetry/resources', () => {
      throw new SyntaxError('Unexpected token in @opentelemetry/resources');
    });
    const error = await import('../src/instrumentation/otel.ts').then(() => undefined, (e: unknown) => e);
    // vitest wraps a mock factory's error: the factory's is a cause.
    const chain: string[] = [];
    for (let e = error as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) chain.push(String(e.message));
    expect(chain.join(' <- ')).toMatch(/Unexpected token in @opentelemetry\/resources/);
    expect(chain.join(' <- ')).not.toMatch(/is not installed/);
  });

  it('is imported by src/instrumentation/otel.ts alone', () => {
    const packages = fileURLToPath(new URL('../..', import.meta.url));
    const importers: string[] = [];
    for (const dir of ['durable-harness', 'harness-world', 'harness-process', 'harness-hands', 'harness-claude-code', 'harness-codex', 'harness-opencode', 'harness-pi', 'pi-world']) {
      const src = join(packages, dir, 'src');
      for (const file of readdirSync(src, { recursive: true }) as string[]) {
        if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
        // A type-only import loads nothing.
        const text = readFileSync(join(src, file), 'utf8').split('\n').filter((line) => !/^\s*import\s+type\b/.test(line)).join('\n');
        if (SDK.some((name) => new RegExp(String.raw`(?:from|import\()\s*['"]${name}['"]`).test(text))) importers.push(`${dir}/src/${file}`);
      }
    }
    expect(importers).toEqual(['durable-harness/src/instrumentation/otel.ts']);
  });
});
