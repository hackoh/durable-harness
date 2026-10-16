import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVercelWorldTarget, resolveWorkflowTargetWorld } from '@workflow/utils';
import type { NextConfig } from 'next';

const LOCAL_WORLD = '@workflow/world-local';

/**
 * A build on Vercel for Vercel's World ships no world-local: `getWorld()`
 * imports only the World it runs on (world.ts), world-vercel there, but
 * Next's trace follows both of its imports, so world-local (1.2 MB) would be
 * in every route's Function. Excluded from every route, unless the app
 * depends on world-local itself. Anywhere else (a local build, a
 * self-hosted one, another World) the trace keeps it.
 */
export function excludeLocalWorld(config: NextConfig, projectDir: string, from: string = import.meta.url): NextConfig {
  if (!process.env.VERCEL || !isVercelWorldTarget(resolveWorkflowTargetWorld()) || dependsOn(projectDir, LOCAL_WORLD)) return config;
  // The package's links in any node_modules, and its real directory (pnpm's store may be above the app).
  const globs = [`**/node_modules/${LOCAL_WORLD}/**`];
  const real = installedDir(LOCAL_WORLD, from);
  if (real) globs.push(`${relative(projectDir, real).split(sep).join('/')}/**`);
  const excludes = { ...config.outputFileTracingExcludes };
  excludes['/**'] = [...new Set([...(excludes['/**'] ?? []), ...globs])];
  config.outputFileTracingExcludes = excludes;
  return config;
}

/** Whether the app's package.json depends on `name`. */
function dependsOn(projectDir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => pkg[field]?.[name] !== undefined);
  } catch {
    return false;
  }
}

/** The real directory of the `name` an import from `from` finds (the first `node_modules/<name>` up from it). */
function installedDir(name: string, from: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(from));
  } catch {
    return undefined;
  }
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}
