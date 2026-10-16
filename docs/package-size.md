# Package size

What `durable-harness` costs an app: the install, the tarball, what each
subpath loads when a cold process imports it, and the size of a Vercel
Function that serves an agent. Cold starts in Vercel Functions are what this
is for: every module a route imports is read, parsed and evaluated before its
first request, and every traced file is in the Function. The rule: no heavy
dependency, and nothing a route doesn't use. The Claude Agent SDK (with its
~200 MB platform binary) and every other harness SDK are optional peers.

## How to measure

```bash
cd packages/durable-harness
node scripts/measure-size.mjs                                # tarball, dist per file, each subpath's cold import
node scripts/measure-size.mjs --install --next --runs 9 --before 2026-10-16
```

- **Tarball**: `pnpm pack`, which is what the release publishes
  (publishConfig's exports); it builds first.
- **Install**: a fresh `npm i <tarball> --omit=peer` from npmjs.org, measured
  with `du` and counted with `npm ls --all --parseable`. `npm explain <name>`
  in such a directory says why a package is there.
- **Cold import**: the median of fresh Node processes importing one subpath of
  the built dist (`performance.now()` around the `import()`), and, with a load
  hook, how many modules and bytes it loads. It runs in the workspace, where
  every peer is installed, so a subpath that imports its harness's SDK pays
  for it as an app would.
- **Next.js**: `--next` makes the README's quick-start app (one `pi({ model })`
  agent, its chat route, `withDurableHarness`), installs the tarball with
  Next.js and Pi's SDK, runs `next build` as Vercel does (`VERCEL=1` and a
  deployment id), and sums the files in `/api/chat`'s `.nft.json`: what that
  route's Function ships.

Timings move by several milliseconds between runs on one machine (this one is
an Apple Silicon laptop on Node 24.21): compare medians from one session,
before and after, interleaved if you can.

## Before and after

Baseline: `main` before this work, whose install is the published
`0.0.1-beta.2`'s (73.5 MB, 76 packages: `npm i durable-harness@0.0.1-beta.2
--omit=peer`).

| | Before | After |
|---|---|---|
| Install (npm, `--omit=peer`) | 73.5 MB, 76 packages | 38.6 MB, 55 packages |
| Tarball | 316 KB packed, 1099 KB unpacked, 52 files | 317 KB packed, 1103 KB unpacked, 54 files |
| `/api/chat`'s Function (Next.js 16.3.6, built as on Vercel) | 1488 files, 11.17 MB | 1442 files, 9.88 MB |

Cold import, Node 24.21, median of 11 interleaved processes, and the modules
each loads:

| Subpath | Before | After |
|---|---|---|
| `durable-harness` | 60 ms, 142 | 59 ms, 143 |
| `/claude-code` | 76 ms, 142 | 76 ms, 143 |
| `/codex` | 81 ms, 142 | 79 ms, 143 |
| `/opencode` | 154 ms, 517 | 85 ms, 148 |
| `/pi` | 168 ms, 848 | 168 ms, 850 |
| `/pi-durable` | 198 ms, 928 | 198 ms, 930 |
| `/fx` | 113 ms, 514 | 63 ms, 145 |
| `/sandbox` | 131 ms, 503 | 85 ms, 134 |
| `/next` | 7 ms, 14 | 7 ms, 14 |
| `/vercel` | 4 ms, 5 | 4 ms, 5 |
| `/tools` | 108 ms, 503 | 108 ms, 504 |
| `/instrumentation/otel` (OpenTelemetry's SDK installed) | 95 ms, 346 | 43 ms, 220 |

What changed:

- **OpenTelemetry's SDK is an optional peer.** `@opentelemetry/sdk-trace-base`,
  `/resources` and `/otlp-transformer`, and what they bring (`semantic-conventions`,
  `sdk-metrics`, `sdk-logs`, `protobufjs`, `@types/node`), were 35 MB of every
  install, for `agentRuns()` alone. `/instrumentation/otel` loads them as it
  loads; without them `agentRuns()` throws with the install line.
  `@opentelemetry/api` stays a dependency (the harnesses' spans go through it,
  and the Worlds require it as a peer).
- **`/instrumentation/otel` loads no kernel.** It needs `instanceof Fatal`,
  which lived in the driver; the drive's error classes are in
  harness-world's `errors.ts` now, so the entry an app loads in every
  Function's instrumentation hook no longer loads the kernel, `@workflow/world`
  and zod.
- **OpenCode, fx and sandbox load no typebox.** typebox is 370 modules and
  ~50 ms. The workspace runtime read two constants from the module that
  builds the workspace tools' schemas, and `durable-harness`'s environments
  took the runtime from an index that also has Pi's coding tools; esbuild
  splits by file, so either import put typebox in those entries.
- **A build on Vercel ships no world-local.** `getWorld()` imports only the
  World it runs on, but Next's trace followed both imports. On Vercel with
  Vercel's World, `withDurableHarness` excludes `@workflow/world-local` from
  every route (unless the app depends on it itself).
- **harness-process's session files are not the app's.** Four calls Turbopack
  read as dynamic filesystem access (and so traced the whole project when the
  kernel is bundled from source, as in `apps/demo`) carry
  `/* turbopackIgnore: true */`.

## What stays, and why

Install, by size after the cut:

- **zod, 7.7 MB.** `@workflow/world` and both Worlds depend on it. The kernel
  imports four small helpers from `@workflow/world` (whose index loads its
  zod schemas), which is most of every entry's 60 ms; moving them would only
  move the cost, since either World loads `@workflow/world` on the first
  request anyway.
- **typebox, 5.8 MB.** `/tools` builds its workspace tools' schemas with it
  and Pi's SDK depends on it, so as a peer it would join the install line of
  every `/tools` and Pi app. It is a dependency, loaded only by `/tools`,
  `/pi` and `/pi-durable`.
- **`@vercel/cli-config` and its own zod 4.1.11 (5.7 MB), `jose`,
  `@vercel/cli-exec`.** `@workflow/world-vercel` depends on
  `@vercel/functions` ^3.8, and every release in that range depends on an
  `@vercel/oidc` (3.8 and later) that refreshes a local OIDC token through
  the Vercel CLI's config, which pins zod exactly. It loads only off Vercel,
  on a refresh. Fixable upstream (a zod range, or no zod, in cli-config).
- **`@opentelemetry/api`, 2.8 MB.** A dependency on purpose, and a peer of
  both Worlds, which npm and pnpm install anyway.
- **`@workflow/world-vercel` (2.2 MB), `undici` (2 MB), `cbor-x` (1.8 MB),
  `@workflow/world-local` (1.5 MB), `@vercel/queue`.** The Worlds and theirs.
  An app runs on world-local locally and on world-vercel on Vercel, so both
  are dependencies; each is imported only where it runs.
- **`@vercel/oidc` 3.2.0, pinned.** The Gateway credential reads it
  (imported when a model call needs a token); it has no dependencies, and
  world-vercel pins the same version, so it costs nothing extra. A 3.8+ or
  4.x would refresh tokens through the CLI's config off Vercel: a behavior
  change.
- **durable-harness itself, 1.2 MB** (774 KB of JavaScript, 248 KB of types,
  the README). Minifying whitespace and syntax cuts the JavaScript to 560 KB
  but no import gets faster, and stack traces lose their lines. No source
  maps are published.

Function size: Next.js (1.4 MB of the 9.9), world-vercel and undici are what
a Function on Vercel runs. Two more are ours to cut:

- **Every file of durable-harness (0.76 MB) is in a route that loads the
  process host**, as `/pi`, `/opencode`, `/claude-code` and `/codex` do: from
  `node_modules`, Turbopack traces a whole package when one of its modules
  makes filesystem or process calls with computed paths (harness-process's
  session directories, pid files and `spawn`). The route itself needs about
  0.4 MB. Annotating each such call, or keeping the host out of Pi's and
  OpenCode's graphs (they need only the Gateway credential from
  harness-process), would drop the rest.
- **Vercel Functions without Next.js** (`durable-harness/vercel`) still trace
  world-local; `excludeFiles` in the functions config would do what
  `withDurableHarness` does.

Cold imports:

- **`/pi` and `/pi-durable`, 170-200 ms.** Most of it is Pi's SDK
  (`@earendil-works/pi-ai`, `pi-agent-core` and their typebox, ~95 ms),
  which harness-pi and `pi-durable.ts` import at load. Imported on the first
  drive instead, a cold start that only reads a session (a chat route's GET)
  would skip it, and `/pi` would import like `/claude-code`.
- **`/tools`, 108 ms.** It builds the workspace tools' schemas, with typebox.
- **`/instrumentation/otel`, 43 ms.** `@opentelemetry/otlp-transformer`'s
  index loads its protobuf root and metrics and logs serializers (900 KB) for
  the one JSON trace serializer `agentRuns()` uses. Only its index is its
  API: a deep import of the serializer would tie the entry to its file
  layout across the peer range. Writing the OTLP JSON ourselves would drop
  the peer as well.
