# durable-harness

Durable coding-agent harnesses on a [Workflow SDK](https://useworkflow.dev)
World. Claude Code, Codex, OpenCode and Pi each run as an agent whose
**session** lives in the World's event log: a session is a workflow run, its
conversation, the turn in flight and every model and tool call are in the
run's log, and a crash anywhere (the process, the Function, the machine)
resumes the turn from the log on another machine.

> **Experimental.** [`durable-harness`](packages/durable-harness) is on
> `0.0.x`, patch releases only, and its API may change between them.

**Docs:** [Agent harnesses on Vercel](https://vercel.com/docs/agent-harnesses):
[Claude Code](https://vercel.com/docs/agent-harnesses/claude-code),
[Codex](https://vercel.com/docs/agent-harnesses/codex),
[OpenCode](https://vercel.com/docs/agent-harnesses/opencode),
[Pi](https://vercel.com/docs/agent-harnesses/pi),
[fx](https://vercel.com/docs/agent-harnesses/fx), and
[tools](https://vercel.com/docs/agent-harnesses/tools). The
[package README](packages/durable-harness/README.md) has the full API.

## Quick start (Next.js)

```bash
pnpm add durable-harness @anthropic-ai/claude-agent-sdk@0.3.296 @vercel/sandbox
```

```ts
// lib/agent.ts
import { claudeCode } from 'durable-harness/claude-code'

export const agent = claudeCode({ model: 'anthropic/claude-sonnet-4.5' })
```

```ts
// app/api/chat/route.ts
import { agent } from '@/lib/agent'

// Open under `next dev`. In production it refuses every request until you
// pass `authorize` (a function; 'public' also needs allowPublicSandbox: true
// and a session budget, since each session boots a Vercel Sandbox).
export const { GET, POST } = agent.chatRoute()
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'

export default withDurableHarness({})
```

```bash
curl -N localhost:3000/api/chat -H 'content-type: application/json' -d '{"text":"What is 6 times 7?"}'
```

No queue route of your own, no `vercel.json`: `withDurableHarness` writes the
route the World's queue delivers to, and the World (Vercel's on Vercel,
world-local elsewhere) starts by itself. Models are
[AI Gateway](https://vercel.com/ai-gateway) ids; the credential is
`AI_GATEWAY_API_KEY`, or the project's Vercel OIDC token. Claude Code and
Codex run in each session's own Vercel Sandbox, which needs the project's
Vercel credentials: a deployment's own, or locally `vercel link` and the
Vercel CLI's login.

The other harnesses differ in `lib/agent.ts` only: `codex()` from
`durable-harness/codex`, `opencode()` from `durable-harness/opencode`, and
`pi()` from `durable-harness/pi` (Pi's agent loop on durable-harness's
kernel). `withDurableHarness` also serves
[libfx](https://github.com/vercel-labs/fx)'s own durable agents
(`createFxAgent`); see [apps/durable-fx](apps/durable-fx).

If you already have [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
code (Pi 1.0's own durable `Harness`), keep it and change where its storage
comes from. `durable-harness/pi-durable` adds to your code instead of
replacing it:

```ts
// lib/pi.ts
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable'
import { gatewayModels, openWorldStorage, resumeWith } from 'durable-harness/pi-durable'

const models = gatewayModels() // or your own pi-ai models
const registry = createRegistry()

// The one line of glue: how a session a dead process left is reopened.
export const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry }, ctx))

// Where you opened SQLite, JSONL or memory storage before:
const harness = await open(await openWorldStorage(sessionId))
```

Everything after that is Pi's own API. Each Pi commit is an event in the
session's log, and the storage stands behind its own commits: if the process
dies mid-turn, a wake reopens the session with your opener and Pi finishes
the turn, background work included. A chat route
(`chatRoute({ open, agent, authorize })`), one shared Harness per session
(`acquireHarness`) and a read-only follower (`openWorldReader`) are optional
helpers. See
[Pi with pi-durable](packages/durable-harness/README.md#pi-with-pi-durable-your-pi-durable-code-a-world-backed-storage).

## What is durable

- **The session.** Each model call and tool call is a step in the log:
  its intent before it runs, its outcome after. A crash leaves the log where
  it was; the World's queue redelivers the turn, and a new process resumes it
  from the log.
- **Tool calls, by their replay rule.** A `replay: 'safe'` call reruns after a
  crash (Claude Code, Codex and OpenCode run their own loop, so there the
  model is told it is safe to repeat); any other call comes back to the
  model as interrupted ("it may or may not have taken effect"), and is never
  run twice by the harness.
- **One driver at a time.** Where the World offers an in-band writer fence
  (world-local, world-postgres and world-vercel do), a stale driver's next
  write is refused, so it stops and writes nothing more.
- **Files, where the tools keep them.** Every harness is tool-less by
  default, and one line per harness adds its own tools on a virtual
  workspace (`virtual()`): Pi's `createCodingTools`, OpenCode's `workspace`,
  pi-durable's `CodingTools` with `virtualEnv()`, libfx's `fxTools`. Its
  files are in the log, each call's changes committed with its outcome, so
  they follow the session to any machine, and its commands can't reach the
  Function's files, processes or environment. Claude Code and Codex run in
  the session's own Vercel Sandbox (`sandbox()`), and their own tools
  (`builtins: true`) work on its Drive at `/workspace`: files that outlive a
  VM, but not in the log, so a command a crash cut off may have half-run.

## Repository layout

| Path | What |
| --- | --- |
| [`packages/durable-harness`](packages/durable-harness) | The published package: one factory per harness (`claudeCode`, `codex`, `opencode`, `pi`), a World-backed Pi `Storage` for your own pi-durable code (`durable-harness/pi-durable`), `withDurableHarness` for `next.config`, `durable-harness/vercel` for other frameworks, tracing for Vercel Agent Runs, and the kernel's session API. The workspace packages below are bundled into its `dist`. |
| [`packages/harness-world`](packages/harness-world) | The kernel: the session log and its fold, the effect sandwich (intent, run, outcome), the queue driver, chaos for crash drills, documents. Depends only on `@workflow/world`. |
| [`packages/harness-process`](packages/harness-process) | The shared core of process harnesses (an agent loop in a child process): the native journal mirrored into the log, the process host, the tool bridge, the recovery note. |
| [`packages/harness-claude-code`](packages/harness-claude-code), [`harness-codex`](packages/harness-codex), [`harness-opencode`](packages/harness-opencode) | Claude Code, Codex and OpenCode on the kernel. |
| [`packages/harness-pi`](packages/harness-pi), [`pi-world`](packages/pi-world) | Pi on the kernel, and Pi's own durable harness (`@earendil-works/pi-durable`) on a World-backed Pi `Storage`. |
| [`packages/harness-hands`](packages/harness-hands) | The virtual workspace (just-bash in a worker thread leased to each session, its files in the log or in memory for a turn) and the tools on it: Pi's and fx's own, and a generic example set (bash, read, write, edit, list); also document tools and two deliberately unsafe tools for crash drills. |
| [`packages/harness-fx`](packages/harness-fx) | fx (libfx's engine) on the kernel, for the demo's tab, Hybrid and Sandbox lanes. Apps use libfx's own durable agent. |
| [`apps/durable-ai-sdk`](apps/durable-ai-sdk) | The AI SDK's `ToolLoopAgent` on the kernel, as an example of bringing your own harness. |
| [`apps/durable-fx`](apps/durable-fx) | The smallest durable fx app: libfx's `createFxAgent` with `withDurableHarness`. |
| [`apps/demo`](apps/demo), [`apps/browser`](apps/browser), [`packages/demo-ui`](packages/demo-ui) | The demo app (see below): a Next.js host, its single-page UI and the UI's components. |
| [`packages/bench`](packages/bench) | The latency benchmark behind the demo's `/bench` page and `scripts/bench.mjs`. |
| [`packages/cli-check`](packages/cli-check) | Every harness, driven with a scripted model on a real World and inspected with the stock Workflow CLI, in CI. |
| [`packages/world-browser`](packages/world-browser), [`world-remote`](packages/world-remote), [`hybrid`](packages/hybrid), [`sandbox-host`](packages/sandbox-host) | Experimental lanes the demo uses: a World in a browser tab's IndexedDB, a World over HTTP, sessions that move between the tab, a Function and a Vercel Sandbox, and the daemon that drives a session inside its Sandbox VM. |
| [`apps/cloudflare`](apps/cloudflare) | Experimental: the kernel harnesses on a Cloudflare Durable Objects World. |

Every workspace package except `durable-harness` is private.

## The demo

[`apps/demo`](apps/demo) is an example app and a test bench: pick a harness
and a durability mode, arm a crash, and watch the turn come back from the log.
Its `/compare` page measures what durability costs a harness against the same
harness without it, round by round.

```bash
pnpm install
cd apps/demo
echo 'AI_GATEWAY_API_KEY=…' > .env.local   # or `vercel env pull` in a linked Vercel project (its OIDC token)
pnpm run build:browser                 # the page, into public/browser
HARNESS_WORLD=local pnpm dev -p 3100   # world-local; the page is at http://localhost:3100/
```

To iterate on the page with hot reload, run `pnpm dev` in `apps/browser` (it
proxies `/api` to the Next app on port 3100; `HARNESS_API_ORIGIN` for
another). For world-postgres, start a database with `docker compose up -d`
and see [packages/cli-check](packages/cli-check#harness-world-cli-check) for
its migrations. `HARNESS_CHAOS=0` turns crash drills off on a server.

To measure what durability costs a harness, see
[docs/benchmarking.md](docs/benchmarking.md): a deployment with crash drills
off, one ladder per harness, and how to read `/compare`'s table.

## Develop

```bash
pnpm install
pnpm test        # every package, on world-local and fake-indexeddb, no API key needed
pnpm typecheck
pnpm cli-check   # every harness through the Workflow CLI, on world-local
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for changesets and the checks a pull
request runs, and [docs/releasing.md](docs/releasing.md) for how
`durable-harness` is published.

## License

[Apache-2.0](LICENSE.md)
