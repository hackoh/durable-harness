#!/usr/bin/env node
/**
 * The host runs only code the app wrote (docs/workspaces.md §6.3): a Vercel
 * Function serves many sessions on one instance, so nothing that can run in
 * one may start a process, run a pi-coding-agent tool or hand the model the
 * machine's own disk. This fails when a tracked source file does, outside
 * the allowlist below, where each entry says why it may.
 *
 *   node scripts/lint-host-spawn.mjs           # every tracked source file
 *   node scripts/lint-host-spawn.mjs --list    # and which files each allowlist entry covers
 *
 * The rules, over each file's syntax tree (TypeScript's parser, so comments,
 * prose in strings and regular expressions never count):
 *
 * - `child-process`: the module `node:child_process` (or `child_process`),
 *   however it is named (import, `import()`, `require`, `getBuiltinModule`):
 *   a string that is exactly its name.
 * - `node-execution-env`: pi's `NodeExecutionEnv` as a value, which gives the
 *   model the real disk and processes of the machine it runs on.
 * - `pi-coding-agent`: a value import of `pi-coding-agent` (its tools read,
 *   write and run commands on that machine); `import type` is fine.
 * - `process-host`: `ProcessHost` (harness-world-process' host for the
 *   reference harness and tests) as a value outside harness-world-process.
 * - `machine-brand`: the brand's minter (the `harness-world-process/machine-brand`
 *   entry, `machineBrand`) anywhere but the sandbox tier's session factory
 *   and the entry's own module and test (§6.1): a branded machine is what
 *   lets Claude Code and Codex run, so only the factory that builds one in a
 *   Vercel Sandbox may brand.
 *
 * Tests, build and dev scripts (`scripts/`) and config files are not scanned,
 * except for `machine-brand`, which covers every file: none of them is in a
 * Function. Findings print as `file:line: rule`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Path prefix → the rules it may break, and why. Keep each reason true: a new entry needs one, and one that covers nothing fails the lint. */
export const ALLOW = [
  ['packages/harness-process/src/host.ts', ['child-process'], 'ProcessHost: the host of the reference harness and of tests, on the machine that runs them; no factory reaches it (process-host)'],
  ['packages/harness-sandbox/src/relay/', ['child-process'], "the relay and its helper run in the session's Vercel Sandbox VM, never in a Function"],
  ['packages/harness-sandbox/probes/', ['child-process'], 'dev-run probes of the Sandbox platform; harness-sandbox/test/probes.test.ts checks that no export or build entry reaches them'],
  ['packages/harness-world/src/anchor.ts', ['child-process'], "`ps -o stat=,etime= -p <pid>`, a fixed command, for world-local's dead-pid proof (processGone); no model input reaches it"],
  ['packages/cli-check/', ['child-process', 'process-host'], 'a CI tool that drives every harness (the process ones on ProcessHost) and the stock Workflow CLI against each World; private, never bundled'],
  ['packages/sandbox-host/', ['child-process'], "the demo's brain-in-VM lane (its daemon runs in a VM; local-sandbox.ts is its dev stand-in): hard-wired off, and deleted after launch (docs/workspaces.md §8)"],
  ['apps/durable-ai-sdk/src/crash.ts', ['child-process'], 'the crash drill: a CLI that kills and restarts a child process; not an export'],
];

/** The only files that may name the brand's minter (rule `machine-brand`). */
const BRAND_ALLOWED = new Set(['packages/harness-sandbox/src/session.ts', 'packages/harness-process/src/machine-brand.ts', 'packages/harness-process/src/environment.test.ts']);

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SCANNED = /^(?:packages|apps)\/[^/]+\//;
const SKIPPED = [/(?:^|\/)(?:test|tests|__tests__|e2e|fixtures|scripts|dist|node_modules|\.next)\//, /\.(?:test|spec)\.[cm]?[jt]sx?$/, /(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/, /\.d\.ts$/];

/** Whether a file is Function-tier code, which every rule covers. */
export const scanned = (path) => SCANNED.test(path) && !SKIPPED.some((re) => re.test(path));

const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);
const isString = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const brandEntry = (path, specifier) =>
  specifier === 'harness-world-process/machine-brand' ||
  // Inside harness-world-process the index may re-export the entry's check (isBrandedMachine), never its minter.
  (!path.startsWith('packages/harness-process/') && /^\.{1,2}\/(?:.*\/)?machine-brand(?:\.[cm]?[jt]s)?$/.test(specifier));

/** Whether `node` names a value: not in a type, and not in an `import type` / `export type` (whole or per name). */
function valuePosition(node) {
  for (let n = node; n; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return false;
    if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n) || ts.isImportClause(n) || ts.isExportDeclaration(n)) && n.isTypeOnly) return false;
  }
  return true;
}

/** Whether an import declaration loads any value (a side-effect import, a default, a namespace, or a name not marked `type`). */
function importsValue(decl) {
  const clause = decl.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.length === 0 || bindings.elements.some((e) => !e.isTypeOnly);
}

/** The module a call names, when it is `import(x)`, `require(x)` or `….getBuiltinModule(x)` with a string `x`. */
function calledModule(call) {
  const [arg] = call.arguments;
  if (!arg || !isString(arg)) return undefined;
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return arg.text;
  if (ts.isIdentifier(callee) && callee.text === 'require') return arg.text;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule') return arg.text;
  return undefined;
}

/** The rules a file breaks: `[line, rule][]`. */
export function findings(path, source) {
  const kind = /\.[cm]?tsx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : /\.[cm]?jsx$/.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const fn = scanned(path);
  const brand = !BRAND_ALLOWED.has(path);
  const found = [];
  const report = (node, rule) => found.push([file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, rule]);
  const visit = (node) => {
    // A module, named where modules are named.
    let specifier;
    let loadsValue = true;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isString(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
      loadsValue = ts.isImportDeclaration(node) ? importsValue(node) : !node.isTypeOnly;
    } else if (ts.isCallExpression(node)) {
      specifier = calledModule(node);
    }
    if (specifier !== undefined) {
      if (brand && brandEntry(path, specifier)) report(node, 'machine-brand');
      if (fn && loadsValue && /(?:^|\/)pi-coding-agent(?:\/|$)/.test(specifier)) report(node, 'pi-coding-agent');
    }
    if (fn && isString(node) && CHILD_PROCESS.has(node.text)) report(node, 'child-process');
    if (ts.isIdentifier(node)) {
      if (brand && node.text === 'machineBrand') report(node, 'machine-brand');
      if (fn && node.text === 'NodeExecutionEnv' && valuePosition(node)) report(node, 'node-execution-env');
      if (fn && node.text === 'ProcessHost' && !path.startsWith('packages/harness-process/') && valuePosition(node)) report(node, 'process-host');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const allows = (path, rule) => ALLOW.filter(([prefix, rules]) => path.startsWith(prefix) && rules.includes(rule)).map(([prefix]) => prefix);

function main() {
  const { values: args } = parseArgs({ options: { list: { type: 'boolean', default: false } } });
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    // A file deleted from the worktree but not yet from the index has nothing to read.
    .filter((p) => p && SOURCE.test(p) && existsSync(resolve(root, p)));
  const bad = [];
  const used = new Map(ALLOW.map(([prefix]) => [prefix, new Set()]));
  for (const path of files) {
    for (const [line, rule] of findings(path, readFileSync(resolve(root, path), 'utf8'))) {
      const by = allows(path, rule);
      if (by.length) for (const prefix of by) used.get(prefix).add(path);
      else bad.push(`${path}:${line}: ${rule}`);
    }
  }
  if (args.list) for (const [prefix, paths] of used) console.log(`${prefix}: ${[...paths].join(', ') || '(nothing)'}`);
  // An entry that allows nothing any more is a hole waiting for new code: remove it.
  for (const [prefix, paths] of used) if (paths.size === 0) bad.push(`scripts/lint-host-spawn.mjs: the allowlist entry ${prefix} covers nothing: remove it`);
  if (bad.length) {
    console.error(bad.join('\n'));
    console.error(
      `lint-host-spawn: ${bad.length} finding(s). The host runs only code the app wrote (docs/workspaces.md §6.3): run model-chosen commands and files in virtual() or sandbox(), or add an allowlist entry in scripts/lint-host-spawn.mjs saying why this file never runs in a Function.`
    );
    process.exit(1);
  }
  console.log(`lint-host-spawn: ${files.filter(scanned).length} Function-tier files and ${files.length} source files in all, no findings.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
