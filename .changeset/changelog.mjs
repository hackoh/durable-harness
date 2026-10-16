// Changelog generator: `@changesets/changelog-github`, with an offline fallback.
//
// Adapted from vercel/workflow's .changeset/changelog.mjs, without its backport
// attribution (this repo has no backport workflow). What is kept:
//
// 1. Every entry goes through the upstream GitHub-backed generator, which
//    links the commit and PR and thanks the author.
// 2. If that throws (no GITHUB_TOKEN, a GitHub outage, a truncated GraphQL
//    response), the entry falls back to a network-free line with the commit
//    link built from the SHA. A flaky network call must never break
//    `pnpm changeset version`, here or in the Release workflow. Locally,
//    `GITHUB_TOKEN=$(gh auth token) pnpm changeset version` gets the full
//    upstream lines.
// 3. At most UPSTREAM_CONCURRENCY entries resolve at once, so the upstream
//    DataLoader (`@changesets/get-github-info`, no `maxBatchSize`) splits a
//    large backlog into several small GraphQL queries instead of one that
//    GitHub will not serve.
//
// Loaded by `@changesets/apply-release-plan` through a synchronous `require()`
// (Node 22.12+ can require ESM with static imports): no dynamic import or
// top-level await here.

import changelogGithub from '@changesets/changelog-github';

const upstream = changelogGithub.default ?? changelogGithub;

const UPSTREAM_CONCURRENCY = 25;

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    if (queue.length > 0) queue.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

const limitUpstream = createLimiter(UPSTREAM_CONCURRENCY);

function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}

function offlineCommitLink(repo, commit) {
  if (!commit) return '';
  const short = commit.slice(0, 7);
  return repo ? ` [\`${short}\`](https://github.com/${repo}/commit/${commit})` : ` \`${short}\``;
}

function offlineReleaseLine(changeset, options) {
  const [firstLine, ...futureLines] = (changeset.summary ?? '').split('\n').map((l) => l.trimEnd());
  const prefix = offlineCommitLink(options?.repo, changeset.commit);
  return `\n\n-${prefix ? `${prefix} -` : ''} ${firstLine}\n${futureLines.map((l) => `  ${l}`).join('\n')}`;
}

function offlineDependencyReleaseLine(changesets, dependenciesUpdated, options) {
  if (dependenciesUpdated.length === 0) return '';
  const links = changesets
    .map((cs) => offlineCommitLink(options?.repo, cs.commit).trim())
    .filter(Boolean)
    .join(', ');
  const changesetLink = `- Updated dependencies${links ? ` [${links}]` : ''}:`;
  const updated = dependenciesUpdated.map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`);
  return [changesetLink, ...updated].join('\n');
}

export async function getDependencyReleaseLine(changesets, dependenciesUpdated, options) {
  try {
    return await limitUpstream(() => upstream.getDependencyReleaseLine(changesets, dependenciesUpdated, options));
  } catch (err) {
    console.warn(`[changelog] upstream getDependencyReleaseLine failed, using offline fallback: ${formatError(err)}`);
    return offlineDependencyReleaseLine(changesets, dependenciesUpdated, options);
  }
}

export async function getReleaseLine(changeset, type, options) {
  try {
    return await limitUpstream(() => upstream.getReleaseLine(changeset, type, options));
  } catch (err) {
    console.warn(`[changelog] upstream getReleaseLine failed, using offline fallback: ${formatError(err)}`);
    return offlineReleaseLine(changeset, options);
  }
}
