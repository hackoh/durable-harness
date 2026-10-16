# Contributing

Thanks for helping. durable-harness is experimental, so open an issue first
for anything larger than a fix, to agree on the shape before you build it.

## Setup

Node 24 and pnpm (the version in `package.json`'s `packageManager`; `corepack
enable` picks it up).

```bash
pnpm install
pnpm typecheck
pnpm test        # every package, on world-local and fake-indexeddb, no API key needed
pnpm cli-check   # every harness through the stock Workflow CLI, on world-local
```

Tests that need a model (an AI Gateway credential: `AI_GATEWAY_API_KEY`) or a
Vercel Sandbox skip themselves without one. For world-postgres,
`docker compose up -d` starts a database; [packages/cli-check](packages/cli-check)
has the migrations and the commands. The [README](README.md) describes the
layout and how to run the demo.

## Pull requests

- Keep a change focused, with a test for the behaviour it changes. A change
  to recovery needs a test that crashes where it matters (the kernel's tests
  and `packages/cli-check` have the patterns).
- Every pull request that changes what `durable-harness` ships (its own
  `src`, or a workspace package it bundles: `harness-world`, `harness-world-*`,
  `pi-world`) adds a changeset: `pnpm changeset`, a **patch** for
  `durable-harness` only, with a one-line summary for the changelog
  ([docs/releasing.md](docs/releasing.md)). `pnpm check:changesets` checks it.
- Describe behaviour in words, not measurements: docs, READMEs and changesets
  say what happens ("the queue redelivers the turn and it resumes from the
  log"), not how long it took on one machine.
- The pull request's title and body become the squashed commit's message.

## Public hygiene

Every pull request and every push to `main` runs the `public-hygiene` CI job:

- [gitleaks](https://github.com/gitleaks/gitleaks) over the tree and the
  commits being added, for credentials;
- [`scripts/check-public.mjs`](scripts/check-public.mjs) over every tracked
  file and the pull request's title and body (or, on a push, the pushed
  commits' messages), for things a public repository must not contain:
  chat and wiki links, private keys, platform ids, and a list of
  organisation-specific patterns.

The organisation-specific patterns are not in the repository: CI reads them
from the Actions secret `PUBLIC_DENYLIST` (one regular expression per line),
which pull requests from forks do not receive, so their run checks the
generic patterns and the push to `main` checks the rest. Maintainers can run
the full check locally with the same list in a gitignored `.public-denylist`
file at the repository root:

```bash
node scripts/check-public.mjs                              # tracked files
PR_TITLE='…' PR_BODY='…' node scripts/check-public.mjs     # and a pull request's text
```

Findings print as `file:line: rule`, never the matching text.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE.md).
