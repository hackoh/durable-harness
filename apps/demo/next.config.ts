import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withEve } from 'eve/next';
import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * `next dev` after a crash drill: the drill kills the dev server and its eve
 * sidecar with it (SIGKILL, so neither cleans up), and the sidecar's marker
 * in `.eve/` still names the dead process. Remove a marker (and its lock)
 * whose process is gone, so the restarted dev server starts eve again.
 */
function clearDeadEveMarkers(): void {
  if (!process.argv.includes('dev')) return;
  const dir = join(process.cwd(), '.eve');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('-dev-server.json')) continue;
    try {
      const { pid } = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { pid?: unknown };
      if (typeof pid !== 'number' || alive(pid)) continue;
      rmSync(join(dir, name), { force: true });
      rmSync(join(dir, name.replace(/\.json$/, '.lock')), { force: true });
    } catch {}
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

clearDeadEveMarkers();

const config: NextConfig = {
  agentRules: false,
  // The page is a static SPA built from apps/browser (pnpm run build:browser)
  // into public/browser; Next serves it at `/` and hosts the API routes.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', destination: '/browser/index.html' },
        // The benchmark page is the same SPA (apps/browser/src/bench).
        { source: '/bench', destination: '/browser/index.html' },
        { source: '/compare', destination: '/browser/index.html' },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // Vite hashes every asset name, so they never change in place. The fonts
  // keep fixed names but only ever change with a deploy.
  async headers() {
    const immutable = [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }];
    return [
      { source: '/browser/assets/:path*', headers: immutable },
      { source: '/browser/fonts/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
    ];
  },
  async redirects() {
    return [
      { source: '/browser', destination: '/?mode=tab', permanent: false },
      { source: '/browser/hybrid', destination: '/?mode=hybrid', permanent: false },
    ];
  },
  // Lets one checkout run a dev server per World side by side.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The harness packages ship TypeScript source.
  transpilePackages: [
    'durable-harness',
    'harness-world',
    'harness-world-pi',
    'harness-world-fx',
    'harness-world-hands',
    'harness-world-process',
    'harness-world-codex',
    'harness-world-opencode',
    'harness-world-demo-ui',
    'harness-world-hybrid',
    'harness-world-remote',
    'harness-world-bench',
    'harness-world-claude-code',
    'harness-world-sandbox',
    'pi-world',
    'durable-ai-sdk',
  ],
  // No CLI binary is traced: Claude Code and Codex run in the session's
  // Vercel Sandbox, from the binaries its base image carries, and the base
  // installs the relay bundle the build ships (relayBundleRule, below).
  // Keep these as runtime node_modules: native addons, wasm, and Worlds
  // that must be one module instance per process.
  serverExternalPackages: [
    'libfx',
    'just-bash',
    '@vercel/sandbox',
    '@workflow/world-local',
    '@workflow/world-postgres',
    '@workflow/world-vercel',
    // The session host's WebSocket upgrade (experimental_upgradeWebSocket).
    'ws',
    // harness-world-sandbox builds its relay bundle with esbuild (never in a
    // deployed Function); bundled, Turbopack tries to parse esbuild's binary.
    'esbuild',
    // OpenCode v2 (harness-world-opencode): native prebuilds, migrations and
    // assets it reads from its own package directories.
    '@opencode/client',
    '@opencode/core',
    '@opencode/plugin',
    '@opencode/schema',
    '@opencode/server',
    '@vercel/functions',
    // Claude Code's Agent SDK: it reads its own package files (its CLI runs in the session's Vercel Sandbox).
    '@anthropic-ai/claude-agent-sdk',
    // Pi's model layer, under every Pi harness here. When it loads, it imports
    // node:fs, node:os and node:path through a variable specifier (so browser
    // bundlers skip them) and catches nothing. Bundled, Turbopack turns that
    // import into a stub that rejects ("Cannot find module as expression is
    // too dynamic"), and Vercel's runtime exits the instance on the unhandled
    // rejection, so the next request on it pays a cold start. As a runtime
    // package, Node resolves those imports itself.
    '@earendil-works/pi-ai',
  ],
};

/**
 * `next build` only: durable-harness's `src/relay-bundle.ts` replaced with the
 * relay bundle built now from this checkout (scripts/relay-bundle.mjs), as a
 * published build ships it, so a `sandbox()` session's base installs it and a
 * deployed Function never builds one (it refuses to: `relayArtifact`).
 */
function relayBundleRule(): NonNullable<NextConfig['turbopack']>['rules'] {
  const code = execFileSync(process.execPath, [join(process.cwd(), 'scripts/relay-bundle.mjs')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return {
    '*relay-bundle.ts': {
      condition: { path: /packages\/durable-harness\/src\/relay-bundle\.ts$/ },
      loaders: [{ loader: join(process.cwd(), 'scripts/relay-loader.cjs'), options: { code } }],
      as: '*.ts',
    },
  };
}

// The eve agent (agent/): `/eve/v1/*`. On Vercel, eve builds as its own service in
// this project (Build Output services) with its own Workflow queue namespace;
// under `next dev`, Next starts eve's dev server and proxies to it.
export default withEve((phase) => (phase === PHASE_PRODUCTION_BUILD ? { ...config, turbopack: { rules: relayBundleRule() } } : config));
