import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path, { basename, dirname, join, relative, sep } from 'node:path';

/**
 * The files an installed harness needs at run time that a Function's file
 * tracer does not find by itself: the tree-sitter grammars OpenCode's shell
 * parser loads with `require.resolve` (without them: `Cannot find module
 * 'tree-sitter-bash/tree-sitter-bash.wasm'`). `withDurableHarness` (Next.js)
 * and `durable-harness/vercel` (Vercel Functions without Next.js) both put
 * these in the Functions that drive sessions. Claude Code and Codex need
 * none: their CLIs run in the session's Vercel Sandbox, from the binaries
 * its base image carries, never in a Function (docs/workspaces.md §3.4).
 *
 * Two answers, for a target machine (a Vercel Function's: linux-x64, glibc):
 *
 * - `files`: what is installed here, found the way the harness finds it at
 *   run time. On the machine that builds (Vercel builds on the machine its
 *   Functions run on), that is exact.
 * - `include`: one short glob (a Function's `includeFiles` is one pattern of
 *   at most 256 characters) in the project's `node_modules` layout (npm and
 *   yarn's hoisted one, or pnpm's `.pnpm` store).
 */

export interface Target {
  platform: string;
  arch: string;
  /** Linux only: the C library. */
  libc?: 'glibc' | 'musl';
}

/** A Vercel Function's machine. */
export const VERCEL_TARGET: Target = { platform: 'linux', arch: 'x64', libc: 'glibc' };

/** This machine. */
export function hostTarget(): Target {
  if (process.platform !== 'linux') return { platform: process.platform, arch: process.arch };
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return { platform: 'linux', arch: process.arch, libc: report?.header?.glibcVersionRuntime ? 'glibc' : 'musl' };
}

/** The harnesses with run-time files of their own in a Function. */
export type HarnessName = 'opencode';

export interface HarnessFiles {
  harness: HarnessName;
  /** Installed here for the target: absolute paths. */
  files: string[];
  /** The `node_modules` directory the harness's packages are in (absolute), and how it is laid out. */
  modules: { dir: string; layout: 'hoisted' | 'pnpm' };
  /** Patterns for the target inside `modules.dir` (pnpm: inside its `.pnpm`). */
  patterns: string[];
}

/** One package a harness needs files from. */
interface Need {
  /** The package its lookup starts from, as Node resolves a `require` there (`undefined`: the project). */
  from?: string;
  name: string;
  /** Files inside it. */
  files: string[];
}

interface Support {
  harness: HarnessName;
  /** Installed when the project has this package. */
  probe: string;
  needs(target: Target): Need[];
  /** Patterns for the target in a hoisted `node_modules` (npm, yarn). */
  hoisted(target: Target): string[];
  /** Patterns for the target in `node_modules/.pnpm`. */
  pnpm(target: Target): string[];
}

const GRAMMARS = ['web-tree-sitter', 'tree-sitter-bash', 'tree-sitter-powershell'] as const;
/** The grammars' packages, short: a Function's `includeFiles` is at most 256 characters. */
const GRAMMAR_DIRS = '{web-tree-sitter,tree-sitter-{bash,powershell}}';

const SUPPORT: Support[] = [
  {
    harness: 'opencode',
    probe: '@opencode/core',
    // Found by `require.resolve` from @opencode/core's real path, which goes through the symlink next to it in pnpm: both paths.
    needs: () => GRAMMARS.map((name) => ({ from: '@opencode/core', name, files: [name === 'web-tree-sitter' ? 'tree-sitter.wasm' : `${name}.wasm`] })),
    hoisted: () => [`${GRAMMAR_DIRS}/*.wasm`],
    // Through the links next to @opencode/core, which is how it resolves them.
    pnpm: () => [`@opencode+core@*/node_modules/${GRAMMAR_DIRS}/*.wasm`],
  },
];

/** Whether `request` resolves from `dir`. */
export function resolves(dir: string, request: string): boolean {
  try {
    createRequire(join(dir, 'package.json')).resolve(request);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `name` is as a `require` from `dir` finds it: the first
 * `node_modules/<name>` up from `dir` (`path`, a symlink in pnpm) and its
 * real path. Only the project's own `node_modules` directories count, as in
 * a Function (never `NODE_PATH` or a global folder).
 */
function lookup(dir: string, name: string): { path: string; real: string } | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (basename(d) !== 'node_modules') {
      const path = join(d, 'node_modules', ...name.split('/'));
      if (existsSync(join(path, 'package.json'))) {
        try {
          return { path, real: realpathSync(path) };
        } catch {
          return { path, real: path };
        }
      }
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The real directory of `name` as `dir` resolves it. */
export function packageDir(dir: string, name: string): string | undefined {
  return lookup(dir, name)?.real;
}

const PNPM = `${sep}node_modules${sep}.pnpm${sep}`;

/** The `node_modules` a package was found in, and its layout. */
function modulesOf(found: { path: string; real: string }, name: string): HarnessFiles['modules'] {
  const at = found.real.indexOf(PNPM);
  if (at >= 0) return { dir: found.real.slice(0, at + `${sep}node_modules`.length), layout: 'pnpm' };
  return { dir: found.path.slice(0, found.path.length - name.length - 1), layout: 'hoisted' };
}

/** The run-time files of every harness installed in `projectDir`, for `target` (default: this machine). */
export function harnessFiles(projectDir: string, target: Target = hostTarget()): HarnessFiles[] {
  const out: HarnessFiles[] = [];
  for (const support of SUPPORT) {
    const probe = lookup(projectDir, support.probe);
    if (!probe) continue;
    const modules = modulesOf(probe, support.probe);
    const files: string[] = [];
    /** The path of each the harness takes at run time (a linked one: through the link). */
    const used: string[] = [];
    for (const need of support.needs(target)) {
      const fromDir = need.from ? lookup(projectDir, need.from)?.real : undefined;
      if (need.from && !fromDir) continue;
      const found = lookup(fromDir ?? projectDir, need.name);
      if (!found) continue;
      for (const f of need.files) {
        if (!existsSync(join(found.real, f))) continue;
        const runtime = join(found.path, f);
        used.push(runtime);
        files.push(runtime, join(found.real, f));
      }
    }
    const patterns = modules.layout === 'pnpm' ? support.pnpm(target) : support.hoisted(target);
    // Installed somewhere the patterns do not reach (npm nests a package under
    // the one that needs it when versions conflict): by its own path.
    const inside = modules.layout === 'pnpm' ? join(modules.dir, '.pnpm') : modules.dir;
    for (const file of used) {
      const rel = slash(relative(inside, file));
      if (rel.startsWith('..') || !patterns.some((p) => matches(rel, p))) patterns.push(rel.startsWith('..') ? slash(relative(modules.dir, file)) : rel);
    }
    out.push({ harness: support.harness, files: unique(files), modules, patterns: unique(patterns) });
  }
  return out;
}

/**
 * One glob for the files of `harnesses` (a Function's `includeFiles`),
 * relative to `projectDir`, plus `extra` globs: `node_modules/{…}` (npm,
 * yarn) or `node_modules/.pnpm/{…}`. Undefined when there is nothing.
 */
export function includeGlob(projectDir: string, harnesses: HarnessFiles[], extra: string[] = []): string | undefined {
  const groups = new Map<string, string[]>();
  for (const h of harnesses) {
    const base = slash(relative(projectDir, h.modules.layout === 'pnpm' ? join(h.modules.dir, '.pnpm') : h.modules.dir)) || '.';
    groups.set(base, [...(groups.get(base) ?? []), ...h.patterns]);
  }
  const parts = [...groups].map(([base, patterns]) => `${base}/${braces(unique(patterns))}`);
  const all = unique([...parts, ...extra]);
  return all.length > 0 ? braces(all) : undefined;
}

/** `{a,b}`, or `a` alone. */
export const braces = (items: string[]) => (items.length === 1 ? items[0]! : `{${items.join(',')}}`);

const slash = (p: string) => p.split(sep).join('/');

/** `path.matchesGlob` (Node 22.5+); elsewhere nothing matches, so a file found here is named by its own path. */
function matches(file: string, pattern: string): boolean {
  const glob = (path as { matchesGlob?: (p: string, g: string) => boolean }).matchesGlob;
  try {
    return glob ? glob(file, pattern) : false;
  } catch {
    return false;
  }
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
