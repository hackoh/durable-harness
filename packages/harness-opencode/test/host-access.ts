import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * What this process does to its machine while a test runs: every path a
 * `node:fs` call is given (callbacks, sync and promises) and every process a
 * `node:child_process` call starts. The patched functions are the module
 * objects' own, synced into their ES module bindings, so named imports
 * (`import { readdir } from 'fs/promises'`) are traced too.
 */

export interface HostAccess {
  method: string;
  path: string;
  /** The caller's frames, for a test's failure message. */
  stack: string;
}

export interface HostTrace {
  paths: HostAccess[];
  spawns: { method: string; command: string; stack: string }[];
  /** Stop tracing (restores every function). */
  stop(): void;
}

const FS = [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createReadStream', 'createWriteStream', 'exists', 'existsSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'open', 'openSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync', 'readFile', 'readFileSync', 'readlink', 'readlinkSync',
  'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'stat', 'statSync', 'statfs', 'statfsSync',
  'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync', 'watch', 'watchFile',
  'writeFile', 'writeFileSync',
];
const PROMISES = [
  'access', 'appendFile', 'chmod', 'copyFile', 'cp', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readFile', 'readlink',
  'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'writeFile',
];
const TWO_PATHS = new Set(['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'symlink', 'symlinkSync']);
const SPAWN = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

const pathOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : v instanceof URL ? (v.protocol === 'file:' ? fileURLToPath(v) : undefined) : Buffer.isBuffer(v) ? v.toString() : undefined;

const frames = () =>
  (new Error().stack ?? '')
    .split('\n')
    .slice(3)
    .filter((l) => !l.includes('host-access.ts'))
    .slice(0, 8)
    .map((l) => l.trim())
    .join(' <- ');

export function traceHost(): HostTrace {
  const trace: HostTrace = { paths: [], spawns: [], stop: () => {} };
  const restore: (() => void)[] = [];
  const patch = (obj: Record<string, any>, name: string, record: (args: unknown[]) => void) => {
    const original = obj[name];
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      record(args);
      return original.apply(this, args);
    };
    for (const key of Object.keys(original)) (wrapped as any)[key] = original[key];
    if (typeof original.native === 'function') {
      const native = original.native;
      (wrapped as any).native = function (this: unknown, ...args: unknown[]) {
        record(args);
        return native.apply(this, args);
      };
    }
    obj[name] = wrapped;
    restore.push(() => (obj[name] = original));
  };
  const fsRecord = (method: string) => (args: unknown[]) => {
    for (const a of TWO_PATHS.has(method) ? args.slice(0, 2) : args.slice(0, 1)) {
      const path = pathOf(a);
      if (path !== undefined) trace.paths.push({ method, path, stack: frames() });
    }
  };
  for (const m of FS) patch(fs as any, m, fsRecord(m));
  for (const m of PROMISES) patch(fs.promises as any, m, fsRecord(`promises.${m}`));
  for (const m of SPAWN) patch(cp as any, m, (args) => trace.spawns.push({ method: m, command: String(args[0]), stack: frames() }));
  syncBuiltinESMExports();
  trace.stop = () => {
    for (const r of restore.splice(0).reverse()) r();
    syncBuiltinESMExports();
  };
  return trace;
}
