#!/usr/bin/env node
/**
 * Public hygiene: fails when a tracked file, or the text that will become a
 * commit message, carries something a public repository must not have.
 *
 *   node scripts/check-public.mjs                      # every tracked file
 *   PR_TITLE=… PR_BODY=… node scripts/check-public.mjs # and a pull request's title and body
 *   node scripts/check-public.mjs --commits A..B       # and these commits' messages
 *
 * Two kinds of patterns:
 *
 * - Generic ones, below: chat and wiki links, private keys, platform ids.
 * - Organisation-specific ones (internal hostnames, repository names, people),
 *   which must not appear in a public file themselves, so they are never
 *   checked in. They are regular expressions, one per line (blank lines and
 *   lines starting with `#` are skipped), read from the PUBLIC_DENYLIST
 *   environment variable (a GitHub Actions secret in CI) and from the
 *   gitignored file `.public-denylist` at the repository root. Each is
 *   matched case-insensitively. Findings name the pattern by its line number
 *   only, so a log never prints the list.
 *
 * Findings print as `file:line: rule`, never the matching text.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    commits: { type: 'string' },
    'no-files': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

/** Generic patterns: safe to publish, since they name no organisation. */
const GENERIC = [
  ['slack-link', /\b[a-z0-9-]+\.slack\.com\/(archives|client|team|files)\b/i],
  ['slack-link', /\bapp\.slack\.com\//i],
  ['slack-link', /\bslack:\/\/(channel|user|app)\b/i],
  ['notion-link', /\b(www\.)?notion\.(so|site)\//i],
  ['notion-link', /\b[a-z0-9-]+\.notion\.site\b/i],
  ['task-tracker-link', /\btaskmaster\b/i],
  ['task-tracker-link', /\blinear\.app\/[a-z0-9-]+\/issue\//i],
  ['private-key', /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----/],
  ['vercel-team-id', /\bteam_[A-Za-z0-9]{24}\b/],
  ['vercel-project-id', /\bprj_[A-Za-z0-9]{28}\b/],
  ['vercel-deployment-id', /\bdpl_[A-Za-z0-9]{28}\b/],
  ['vercel-integration-id', /\b(icfg|oac)_[A-Za-z0-9]{24}\b/],
  ['local-home-path', /(?<![\w.-])\/(Users|home)\/(?!me\/|you\/|user\/|runner\/|vercel-sandbox\b|<)[a-z][a-z0-9._-]*\//],
];

function loadDenylist() {
  const sources = [];
  if (process.env.PUBLIC_DENYLIST) sources.push(['PUBLIC_DENYLIST', process.env.PUBLIC_DENYLIST]);
  const file = join(root, '.public-denylist');
  if (existsSync(file)) sources.push(['.public-denylist', readFileSync(file, 'utf8')]);
  const patterns = [];
  for (const [source, text] of sources) {
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      try {
        patterns.push([`${source} line ${index + 1}`, new RegExp(line, 'i')]);
      } catch (error) {
        console.error(`check-public: ${source} line ${index + 1} is not a valid regular expression (${error.message})`);
        process.exitCode = 2;
      }
    });
  }
  return { patterns, sources: sources.map(([s]) => s) };
}

const { patterns: denylist, sources } = loadDenylist();
const rules = [...GENERIC, ...denylist];
const findings = [];

function scan(label, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [rule, re] of rules) {
      if (re.test(lines[i])) findings.push(`${label}:${i + 1}: ${rule}`);
    }
  }
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

let scanned = 0;
if (!args['no-files']) {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue; // deleted in the working tree
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue; // binary
    scan(file, bytes.toString('utf8'));
    scanned++;
  }
}

// A pull request's title and body: a squash merge makes them the commit message.
for (const [name, label] of [
  ['PR_TITLE', 'pull request title'],
  ['PR_BODY', 'pull request body'],
]) {
  if (process.env[name]) scan(label, process.env[name]);
}

// `A..B`; with A all zeros (a branch's first push) or unknown here, only B.
if (args.commits) {
  const [from, to] = args.commits.includes('..') ? args.commits.split(/\.{2,3}/) : ['', args.commits];
  const known = (rev) => {
    try {
      git('cat-file', '-e', `${rev}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  const range = from && !/^0+$/.test(from) && known(from) ? [`${from}..${to}`] : ['-1', to];
  const shas = git('rev-list', ...range).split('\n').filter(Boolean);
  for (const sha of shas) scan(`commit ${sha.slice(0, 12)} message`, git('log', '-1', '--format=%B', sha));
}

if (!args.quiet) {
  const org = denylist.length
    ? `${denylist.length} organisation pattern(s) from ${sources.join(' and ')}`
    : 'no organisation patterns (set PUBLIC_DENYLIST, or write .public-denylist)';
  console.log(`check-public: ${scanned} files, ${GENERIC.length} generic patterns, ${org}.`);
}
if (!denylist.length && process.env.GITHUB_ACTIONS) {
  if (process.env.PUBLIC_DENYLIST_REQUIRED === '1') {
    console.error('::error::check-public: the PUBLIC_DENYLIST secret is empty, and this run requires it.');
    process.exitCode = 1;
  } else {
    console.log('::warning::check-public: no PUBLIC_DENYLIST (a pull request from a fork, or the secret is unset): generic patterns only.');
  }
}
if (findings.length) {
  console.error(`check-public: ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exitCode = 1;
} else if (!args.quiet) {
  console.log('check-public: no findings.');
}
