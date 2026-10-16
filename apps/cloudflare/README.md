# harness-cloudflare (experimental)

The kernel harnesses on a Cloudflare Durable Objects World: a Worker where
each session is one Durable Object that stores the session's log, holds its
queue messages as alarms and drives it. The World is the draft
`@workflow/world-cloudflare` from
[vercel/workflow#4682](https://github.com/vercel/workflow/pull/4682), not
published yet, so this app carries a build of it in
`vendor/world-cloudflare` (`SOURCE.json` records the commit it was built
from).

It shows the kernel runs unchanged on a World with a very different shape.
It runs on local workerd (`wrangler dev`); it has not been deployed to
Cloudflare.

## How it works

One run is one Durable Object (`RunObject`, named by the run id), so one
session is one object:

- **Log.** Every World storage call for the run lands in its object, which
  writes each committed event to its SQLite storage before the call returns.
- **Queue.** `queue()` stores the message in the run's object and arms an
  alarm. The object hands messages to the app's queue consumer one delivery
  at a time per run, and redelivers one that died with its isolate.
- **Streams.** One `StreamObject` per stream.

The queue consumer is a route the app gives the World (`createFlowRoute`),
and the kernel's `sessions.handler` is exactly that handler, so a session is
driven inside its own Durable Object.

```ts
// src/sessions.ts (simplified)
import { setupCloudflareWorld } from '@workflow/world-cloudflare'
import { durableSessions } from 'harness-world'
import { workspaceTools } from 'harness-world-hands'
import { piHarness } from 'harness-world-pi'
import { model, streamFn } from './model'

export const world = setupCloudflareWorld({
  deploymentId: 'dpl_my_agent_v1', // keep it fixed: a run is pinned to this id
  createFlowRoute: () => (request) => sessions.handler(request), // the run object drives the session here
  quickjs: { quickjs: {}, encoding: {}, headers: {}, url: {}, structuredClone: {} }, // core's VM, unused
  setWorld: () => {},
})

export const sessions = durableSessions({
  world,
  harness: piHarness({ model, streamFn, tools: workspaceTools() }),
})
```

`src/worker.ts` exports the Durable Object classes and a small JSON API.

## What runs here

| Harness | On this World |
| --- | --- |
| Pi (`harness-world-pi`) | Yes |
| The AI SDK harness (`apps/durable-ai-sdk`) | Yes |
| fx (libfx's Wasm build, on workerd's JSPI) | Yes, except steering while a tool runs (the turn hangs) |
| Pi with pi-durable (`pi-world`) | Yes: Pi's Harness opens inside the run object |
| Claude Code, Codex, OpenCode | No: they are child processes, which a Worker cannot spawn |

The tools are `harness-world-hands`' workspace tools and the two unsafe
tools for crash drills.

## Run it

```bash
pnpm install                                   # downloads workerd (allowBuilds: workerd)
pnpm --filter harness-cloudflare test:cf       # kernel checks under wrangler dev, no credential

# An AI Gateway credential for wrangler dev, in a gitignored file:
( umask 077; printf 'AI_GATEWAY_API_KEY=%s\n' "$AI_GATEWAY_API_KEY" > apps/cloudflare/.dev.vars )

cd apps/cloudflare
pnpm dev                                       # wrangler dev, state in .wrangler/state
node scripts/drill.mjs --harness pi            # or ai-sdk, fx, pi-durable; --durability run-ahead
node scripts/summarize.mjs .drill/*/report.json
node scripts/probe.mjs                         # World contract probes, no credential
```

`test/kernel.cf.test.ts` runs the kernel's scenarios against this World: a
session is a run whose steps are the transcript, concurrent submissions all
land, the live stream carries each turn, a `replay: 'never'` tool killed with
the process comes back interrupted (and a `replay: 'safe'` one reruns once)
after the run object's own alarm redelivers it, and `close` completes the run.
`scripts/drill.mjs` does the same with a real model: a tool turn, a SIGKILL of
the whole wrangler process group in the middle of `bash` and of a payment, a
second turn and a steer.

The API (`src/worker.ts`): `POST /sessions {harness}`,
`POST /sessions/:id/messages {text, kind}`, `GET /sessions/:id` (the fold),
`/events`, `/ledger`, `/files`, `/live`, `/object`; Pi with pi-durable under
`/pi-durable`.

## Limits

- Local workerd only; not run on Cloudflare itself.
- A deploy stops every session in flight: runs are pinned to the build that
  created them. Change `HARNESS_DEPLOYMENT_ID` only when that is what you want.
- No `runs.list`, so `workflow inspect` and dashboards cannot list sessions.

## Refreshing the World

With a checkout of vercel/workflow at `$WORKFLOW_REPO`:

```bash
git -C "$WORKFLOW_REPO" fetch origin pull/4682/head:pr-4682
git -C "$WORKFLOW_REPO" worktree add ../workflow--pr-4682 pr-4682
(cd "$WORKFLOW_REPO/../workflow--pr-4682" && pnpm install && pnpm turbo build --filter='@workflow/world-cloudflare^...')
cd apps/cloudflare
pnpm vendor:world "$WORKFLOW_REPO/../workflow--pr-4682"   # fails if world/errors/utils moved past the pinned versions
pnpm install && pnpm test:cf
```

Once the World is published, replace the `file:` dependency with
`@workflow/world-cloudflare` and drop `vendor/`.
