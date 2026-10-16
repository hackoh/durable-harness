# durable-harness

Durable coding-agent harnesses on a [Workflow SDK](https://useworkflow.dev)
World: Claude Code, Codex, OpenCode and Pi, each as an agent whose **session**
lives in a World's event log. A session is a workflow run; its conversation,
turn state and every model and tool call are in the run's log, and a crash
anywhere (the process, the Function, the machine) resumes the turn from the log
on another machine.

> Experimental: `0.0.x`, patch releases only. It depends on the npm releases
> of the Workflow SDK's Worlds (`@workflow/world` ^5.0.4,
> `@workflow/world-local` ^5.1.1, `@workflow/world-vercel` ^5.2.1, and
> `@workflow/world-postgres` ^5.0.4 if you use it).

What is durable, and what is not: the **session** (the conversation, the turn
in flight, recovery after a crash) is. An agent has only the tools you give
it, and the commands and files a model picks never belong on the machine
that drives the session: on Vercel that's a Function other sessions share,
and a recovery may land on another one. Each harness has one line that adds
the tools it is tuned for, on a virtual workspace (`virtual()`) whose
commands can't reach the Function's files, processes or environment and
whose files ride in the same log: Pi's `createCodingTools(virtual())`,
OpenCode's `workspace: virtual()`, pi-durable's `CodingTools` with
`env: virtualEnv()`, libfx's `fxTools(virtual())`. Good for demos and small
workspaces. Claude Code and Codex run only in the session's own Vercel
Sandbox (`sandbox()`, their default), with a Drive at `/workspace`: a real
machine and filesystem for real work.

## Quick start (Next.js)

Three files. Pick a harness:

```bash
pnpm add durable-harness @anthropic-ai/claude-agent-sdk@0.3.296 @vercel/sandbox   # Claude Code
pnpm add durable-harness @vercel/sandbox                                          # Codex
pnpm add durable-harness @opencode/client@2.0.22 @opencode/core@2.0.22 @opencode/schema@2.0.22 @opencode/server@2.0.22   # OpenCode
pnpm add durable-harness @earendil-works/pi-agent-core @earendil-works/pi-ai                      # Pi
pnpm add durable-harness @earendil-works/pi-durable @earendil-works/chord @earendil-works/pi-ai   # Pi with pi-durable
```

Install the Claude Code and OpenCode versions shown: they are peer
dependencies at the versions durable-harness is tested with, and
durable-harness works with each one's internals (Claude Code's transcript,
OpenCode's server), so a newer one may not work. npm picks the version by
itself for Claude Code, and refuses a newer OpenCode; pnpm installs the
latest and only warns. Claude Code's and Codex's CLIs are not installed in
your app: they are in the sandbox's image, at the versions this package
pins. A Claude Code turn on another Agent SDK version fails, naming both,
and the session stays. Don't add `effect`:
OpenCode 2.0.22's packages install the one they need (4.0.0-rc.112), and with
effect 4.0 its host cannot start, so an app that uses `effect` itself pins it
to 4.0.0-rc.112. OpenCode's agent checks
the installed versions before each turn and fails the turn with the installed
and expected versions and the install line, instead of starting OpenCode. It
checks when durable-harness runs from `node_modules`, as `withDurableHarness`
keeps it; a bundle that includes durable-harness resolved them when it was
built and isn't checked. Pi takes any 1.x from 1.0.4.

pnpm 11 stops at build scripts nobody approved (`cbor-extract`, from the
Vercel World; for OpenCode also `@parcel/watcher`, `msgpackr-extract`,
`tree-sitter-bash`, `tree-sitter-powershell`): none is needed, so set them to
`false` under `allowBuilds` in `pnpm-workspace.yaml`.

```ts
// lib/agent.ts
import { claudeCode } from 'durable-harness/claude-code'

export const agent = claudeCode({ model: 'anthropic/claude-sonnet-4.5' })
```

```ts
// app/api/chat/route.ts
import { agent } from '@/lib/agent'

// Open under `next dev`. In production it refuses every request until you
// pass `authorize` (see Auth below).
export const { GET, POST } = agent.chatRoute()
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'

export default withDurableHarness({})
```

No `vercel.json`, no queue route of your own (an app that also uses the
Workflow SDK adds one `vercel.json` entry: [With the Workflow
SDK](#with-the-workflow-sdk)).

The other harnesses differ in `lib/agent.ts` only:

```ts
import { codex } from 'durable-harness/codex'
export const agent = codex({ model: 'openai/gpt-5.4-mini' })

import { virtual } from 'durable-harness'
import { opencode } from 'durable-harness/opencode'
export const agent = opencode({ model: 'anthropic/claude-haiku-4.5', workspace: virtual() })

import { virtual } from 'durable-harness'
import { createCodingTools, pi } from 'durable-harness/pi' // Pi without pi-durable
export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: createCodingTools(virtual()) })
```

Pi and OpenCode are tool-less unless you give them tools, with one line each
for their own coding tools on a virtual workspace. For Pi,
`createCodingTools(virtual())` (see [Pi's coding tools](#pis-coding-tools));
add your own tools to the same array. For OpenCode, `workspace: virtual()`:
OpenCode's own shell, read, write, edit, patch, glob and grep, its own tool
code with its names, schemas and descriptions, on the workspace's files and
shell (`builtins: ['read', 'grep']` narrows them; your `tools` go next to
them; see [OpenCode's own tools](#opencodes-own-tools)). Install `just-bash`
for `virtual()`. `workspace: sandbox()` runs the same tools in the session's
own Vercel Sandbox (install `@vercel/sandbox`).

Pi with pi-durable is not a factory: you keep your own pi-durable code
(`Harness.open`, your models and registry, `root.submit`) and change where its
storage comes from. See [Pi with pi-durable](#pi-with-pi-durable-your-pi-durable-code-a-world-backed-storage).

Claude Code, Codex and OpenCode are tool-less by default: they have only
the tools you pass as `tools`. Claude Code and Codex are single-user CLIs
that keep state on disk, so they run only in the session's own Vercel
Sandbox (`workspace` defaults to `sandbox()`; anything else is a
`TypeError`), never in a Function other sessions share: `builtins: true`
turns their own tools on there (Claude Code's Bash, Read, Edit, Write,
NotebookEdit and WebFetch; Codex's shell and apply_patch), on the session's
Drive at `/workspace`,
and your `tools` still run in the Function. OpenCode without a
`workspace` has no tools of its own, and with one they run only on the
workspace: OpenCode starts no process and reads no file of the
machine for the model, so its core is fine in a shared Function. Each call,
theirs or yours, is in the log before it runs, and nothing reruns one after a
crash: a call a crash interrupted is reported to the model as interrupted,
either "may or may not have taken effect" or, for a tool that is safe to
repeat (yours with `replay: 'safe'`, or OpenCode's own on a durable virtual
workspace, whose changes commit only with their result), "safe to repeat",
and the model decides. For files that follow the session, use tools that ride
the log, on a virtual workspace that can't reach the Function's files,
processes or environment: a harness's own line (Pi's
`createCodingTools(virtual())`, OpenCode's `workspace: virtual()`, above), or
the generic example set:

```ts
import { virtual } from 'durable-harness'
import { pi } from 'durable-harness/pi'
import { workspaceTools } from 'durable-harness/tools' // and pnpm add just-bash
export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: workspaceTools(virtual()) })
```

Models are [AI Gateway](https://vercel.com/ai-gateway) ids (`provider/model`)
for every harness. The credential is `AI_GATEWAY_API_KEY`, else the project's
Vercel OIDC token (on Vercel, the deployment's; locally, `vercel env pull`).
Claude Code's and Codex's sandboxes also need the project's Vercel
credentials: a deployment's own, or locally `vercel link` and the Vercel
CLI's login. The model credential never reaches a VM.

Use it:

```bash
curl -N localhost:3000/api/chat -H 'content-type: application/json' -d '{"text":"What is 6 times 7?"}'
# server-sent events: id: <cursor>, data: {"type":"text","delta":…} … {"type":"idle"}, then event: end
# the x-session-id header names the session; send { "sessionId", "text" } for the next message
curl -N 'localhost:3000/api/chat?sessionId=wrun_…' -H 'last-event-id: <the last id you saw>'
```

POST `{ sessionId?, text, kind? }` (`kind`: `prompt`, `steer` or `followUp`)
sends a message, starting a session when there is none, and streams its turn
until it settles. The turn runs on the log, not in the response: if the
response ends early (a network blip, a deploy, a crash), GET
`?sessionId=…&cursor=<the last id>` (or the id as a `Last-Event-ID` header)
continues with the next event, nothing lost or repeated, from any server. An
`EventSource` opened on that URL resends its latest id by itself when its
connection drops; a GET with neither a cursor nor the header is a 400. The end
of a turn has an id ending in `;end`; a reconnect with it gets a 204.
The pi-durable `chatRoute`'s GET takes no cursor: it follows an unfinished
turn from the start of the model response in flight (204 when the session is
idle).

A turn whose harness cannot run where it is driven (its binary or a module it
loads is missing) is not retried over and over. On Vercel, when the chat
route's own Function lacks it, the turn goes to the flow function at once,
which may have it (another bundle). When that one lacks it too (or locally,
where both are one process), the turn ends with
`{"type":"error","code":"binary_missing","message":…,"hint":…}` and an
`idle`, within seconds: the log records the failed turn, and the session stays
usable (the next message starts a new turn and tries the harness again).

### Auth

Your own auth goes in the chat route:

```ts
export const { GET, POST } = agent.chatRoute({
  authorize: async (request, sessionId) => {
    // throw a Response (401, 404) to refuse; sessionId is undefined when a POST starts a session
  },
})
```

**A chat route needs `authorize` in production.** Without one it is open
under `next dev` (any `NODE_ENV` but `production`), and with
`NODE_ENV=production` (`next start`, and every Vercel deployment, previews
included) it refuses every request, GET and POST, with a 401 whose JSON body
says to pass `authorize`; the server logs the same once. To serve anyone,
say so: `agent.chatRoute({ authorize: 'public' })`. Whoever can use the route
runs the agent, and every turn spends your model credits. With a harness's
own tools on, that includes the commands the model runs: on a virtual
workspace, or in the session's Vercel Sandbox. Claude Code's and Codex's
sessions each boot a VM and create a Drive, and so do OpenCode's and Pi's
on `sandbox()`, so for them `'public'` also needs `allowPublicSandbox: true`
and a finite `sandbox({ budget: { sessionUsd } })`, checked when the route
is built and again when each session acquires its VM (a refused session's
turn fails, saying why, and no VM boots). `chatRoute` from
`durable-harness/pi-durable` takes the same `authorize` and
`allowPublicSandbox`, checked when a session acquires its VM. An fx agent's
route is libfx's own: with `fxTools(sandbox())`, authorize it yourself and
cap each session with `sandbox({ budget })`.

## What `withDurableHarness` does

- Keeps `durable-harness` and each installed harness SDK out of the server
  bundle (`serverExternalPackages`): they read their own package files, or
  must be one module instance per process.
- Traces OpenCode's tree-sitter grammars (found in your `node_modules` for
  the machine that builds) into the routes that drive sessions: the flow
  route and every route that calls `chatRoute(`. Claude Code and Codex need
  no binary in a Function: their CLIs run in the session's Vercel Sandbox,
  from its base image.
- Writes the flow route, the queue's consumer: it imports every module that
  makes an agent and mounts them all. durable-harness queues on a namespace
  of its own (`__harness_wkf_workflow_*`), never on the Workflow SDK's
  (`__wkf_workflow_*`). In an app without the Workflow SDK the route is
  `app/.well-known/workflow/v1/flow/route.js`, with its queue trigger next to
  it (`config.json`, which Vercel's Next.js builder reads: no `vercel.json`)
  and a `.gitignore` that keeps both out of git, written the way
  `@workflow/next` writes its own; it answers the Workflow tools' health
  probe (`HEAD ?__health`) too. In an app that also uses the Workflow SDK,
  which owns that path, the route is durable-harness's own: see
  [With the Workflow SDK](#with-the-workflow-sdk). Options: `agents` (the
  modules that make agents, if the scan misses one), `driveRoutes`,
  `flowRoute: false`.
- For fx agents ([libfx](https://github.com/vercel-labs/fx)'s
  `createFxAgent()`), wires libfx's queue to that same route (with the
  Workflow SDK, to a route of its own): see [fx agents](#fx-agents-libfx).
- Building on Vercel for Vercel's World, keeps `@workflow/world-local` out of
  every route's Function (1.2 MB): a Function there loads only Vercel's
  World. Not when the app depends on `@workflow/world-local` itself.

Locally there is nothing else to add: on world-local the World consumes its
queue in the server's own process and starts by itself on the first request
that reaches an agent (its chat route), re-enqueueing the sessions a killed
server left mid-turn. No `instrumentation.ts`. One directory appears in the
app: `.workflow-data` (world-local's log of every session: add it to
`.gitignore`). OpenCode keeps each drive's database (a cache of the log),
and Claude Code its side of the CLI's config directory, in a directory of
its own under the OS temp directory, removed when the drive ends; Claude
Code's and Codex's files are on the session's Drive, in its Vercel Sandbox.

### With the Workflow SDK

One app can use durable-harness and the Workflow SDK (`withWorkflow`, `'use
workflow'` functions) together: they share no route and no queue. Wrap both:

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'
import { withWorkflow } from 'workflow/next'

export default withWorkflow(withDurableHarness({}))
```

`withDurableHarness` tells that the app uses the Workflow SDK (`workflow` or
`@workflow/next` in `package.json`, either resolving from the project, or a
route at `/.well-known/workflow/v1/flow` that it did not write) and then
writes its routes at its own path, where the Workflow SDK's never are:
`app/.well-known/durable-harness/v1/flow/route.js` (and, for an fx agent,
`.../v1/fx/route.js`), with a `.gitignore`, and no `config.json`. It never
touches the Workflow SDK's files, and removes the route and `config.json` it
wrote at the Workflow SDK's path before the app used it.

On Vercel the queue delivers to such a route only when its Function
subscribes to the topic, which takes one `functions` entry per route in
`vercel.json`:

```sh
npx durable-harness vercel-json --write
```

```json
{
  "functions": {
    "app/.well-known/durable-harness/v1/flow/route.js": {
      "maxDuration": "max",
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "__harness_wkf_workflow_*", "retryAfterSeconds": 5, "initialDelaySeconds": 0 }
      ]
    }
  }
}
```

(Under `src/app` the key starts with `src/app/`; an fx agent adds
`app/.well-known/durable-harness/v1/fx/route.js` with
`{ "type": "queue/v2beta", "topic": "__libfx_wkf_workflow_session" }`.) With a
`vercel.ts`, `functions: harnessFunctions()` from `durable-harness/vercel`
gives the same entries. A build on Vercel without the entry fails, with the
entry to add in the message; `next dev` and a build elsewhere only warn
(locally the World delivers in process, so nothing is needed there).

Locally both use world-local, on one data directory (`withWorkflow` sets
`WORKFLOW_LOCAL_DATA_DIR`). When the app starts the Workflow SDK's World
itself in `instrumentation.ts` (that is when the Workflow SDK recovers its
runs), give it durable-harness's queue first, so the durable-harness sessions
its recovery re-enqueues come to durable-harness's agents:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const [{ getWorld }, { registerQueue }] = await Promise.all([import('workflow/runtime'), import('durable-harness')])
  const world = await getWorld()
  registerQueue(world)
  await world.start?.()
}
```

Without it they come back to durable-harness by themselves too: its own World
re-enqueues every session a killed server left mid-turn, and gives the
Workflow SDK's World in the same process its queue once it sees it.

The Workflow SDK's recovery sends every run that recorded no queue namespace
to its own flow route, and that route fails a run whose workflow the app does
not have (`WorkflowNotRegisteredError`). durable-harness's sessions record
theirs; libfx's sessions record none yet. So in an app with an fx agent,
starting the Workflow SDK's World on world-local fails every fx session that
was open when the server stopped.

### Several agents

Several agents in one app work, each with its own chat route (the flow route
serves them all). Two agents of the same harness need a `name` each
(`pi({ name: 'pi-french', ... })`): a session's run records its agent's name,
and keep the name stable, since sessions already started carry it.
Two agents made with one name throw when their module loads, so `next build`
fails on them. Two pi-durable setups (two registries) take a name the same
way, on both sides: `openWorldStorage(id, { name: 'support' })` and
`resumeWith(openSupport, { name: 'support' })`.

## OpenCode's own tools

```ts
import { virtual } from 'durable-harness'
import { opencode } from 'durable-harness/opencode'

export const agent = opencode({ model: 'anthropic/claude-haiku-4.5', workspace: virtual(), tools: appTools })
```

OpenCode is tool-less by default: without a `workspace` the model is offered
only your `tools`, and OpenCode starts no process and reads no file of the
machine that drives the session for the model. `workspace: virtual()` gives
it its own `shell`, `read`, `write`, `edit`, `patch`, `glob` and `grep`
(`OPENCODE_TOOLS`; OpenCode offers some models `patch` instead of `edit`):
OpenCode's own tool code, with its names, input schemas and descriptions,
on a virtual workspace at `/workspace`, reached through OpenCode's own
environment seam. `builtins: ['read', 'grep']` narrows them (without a
`workspace`, `builtins` is a `TypeError`); OpenCode's other tools (web fetch
and search, skills, questions, subagents) stay off. Install `just-bash` next
to OpenCode's packages.

- What the model sees: each tool's own description, with what doesn't hold
  on a workspace edited out (commands run on Linux using bash, not on the
  machine's platform and shell; a long output is truncated, not saved to a
  file; no background commands, so `shell` has no `background` parameter),
  and a sentence on where it runs. The system prompt names `/workspace` as
  the working directory and says what the workspace is.
- Where it runs: just-bash (a bash-compatible shell with coreutils, grep,
  sed, awk, jq and more; no network, no package installs, no real binaries
  such as node or python), in a worker thread leased to the session. A
  command's environment is a fixed list, never the Function's, and a path
  outside `/workspace` is denied.
- `virtual()`: each call is in the log before it runs and runs on the files
  as the log has them; what it changed commits with its result, so a call a
  crash cut off changed nothing: the model is told it was interrupted and is
  safe to repeat, and nothing reruns it. The files move with the session to
  any machine.
- `virtual({ durable: false })`: the same tools with their files in memory,
  cleared at the end of every turn; their descriptions say so, and a turn
  picked up again by another invocation starts with an empty workspace,
  which its first call says.
- `sandbox()`: the same tools in the session's own Vercel Sandbox (install
  `@vercel/sandbox`): OpenCode's core stays in the Function, the files are
  on the session's Drive at `/workspace` and last across turns and VMs, and
  the VM boots at the first call of a turn that runs one. A call that
  changes files or runs a command is never run twice: one a crash cut off
  may have partly run, and the model is told so.

OpenCode loads no plugin from its config and, of its own provider plugins,
only the AI Gateway's: the models are AI Gateway ids in OpenCode's bundled
catalog. It refuses to start on a machine with a real `/workspace` directory
(a container whose working directory is `/workspace`, say).

## fx agents (libfx)

`withDurableHarness` also serves an app whose agent is libfx's own durable
agent, with nothing else from durable-harness:

```sh
npm install libfx@0.0.13-dev.1432.g1df91f0b4ebf durable-harness
```

```ts
// lib/agent.ts
import { createFxAgent } from 'libfx'

export const agent = createFxAgent({ model: 'anthropic/claude-opus-5.5-fast', instructions: 'Keep answers short.' })
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'

export default withDurableHarness({})
```

libfx queues each session's turns on one topic (`__libfx_wkf_workflow_session`)
and runs them where the queue delivers them, in `agent.wakeHandler()`. Without
Next.js that is a route of your own and a `vercel.json` trigger. With
`withDurableHarness`, no wake route, and without the Workflow SDK no
`vercel.json`:

- It finds the module that makes the agent: one that imports `createFxAgent`
  (from `libfx`, or from a module of yours that re-exports or wraps it under
  that name; an `import type` does not count) and calls it. An agent made
  through a function of your own (`export const agent = makeAgent()`) is not
  found that way: list its module in `agents`, and the route looks for the
  agent among that module's exports (it imports it for durable-harness agents
  too, since the build cannot tell which kind it makes).
- The generated flow route imports that module and mounts the agent's
  `wakeHandler()`, reached through the module's exports. Export the agent at
  the module's top level (`export const agent = createFxAgent(...)`, any name,
  or `export default`); a module that does not gets a warning at build time
  saying what to export, and the route answers 500 with the same message.
- `config.json` gives the route's Function `maxDuration: 'max'` and a queue
  trigger on libfx's topic. Vercel's Next.js builder applies `config.json` to
  the flow route only, so libfx's wakes come to that route: in an app that also
  makes durable-harness agents, the Function carries both triggers and the
  route hands each delivery to its consumer by topic. An app with only fx
  agents gets a route that is the wake handler alone (no `flowHandler`).
- In an app that also uses the Workflow SDK, the wake handler is a route of
  its own instead, `app/.well-known/durable-harness/v1/fx/route.js` (a
  `vercel.json` function takes one queue trigger), with its `functions` entry
  on libfx's topic ([With the Workflow SDK](#with-the-workflow-sdk)).
- `libfx` (a native addon) stays out of the server bundle. Next's own trace
  includes its addon and its durable bundles, so nothing is added to
  `outputFileTracingIncludes` for it.
- Several fx agents need libfx 0.0.13-dev.1506 or later, which runs each
  session's turns on the agent that created it, by name. Give each agent a
  name of its own (`createFxAgent({ name: 'support', ... })`): the route then
  imports every module that exports an fx agent (or every module listed in
  `agents`) and mounts libfx's `wakeHandler()`, which hands each turn to its
  session's agent. An agent without a name is named `default`, so the build
  warns when two agents share a name. A process with no agent of a session's
  name refuses its turn (`FX_NO_AGENT`) and the queue delivers it again, so
  create every agent in each process that serves the route.
- With an earlier libfx, one fx agent per app: libfx queues every fx agent's
  wakes on that one topic, and a wake does not say whose session it is, so
  whichever agent the route mounts runs it with its own model and tools. With
  several, the build warns and the route mounts the first module that exports
  its agent (in path order), and in it the first export (by name) with a
  `wakeHandler()`; choose the module with `agents` (the first listed module
  that calls `createFxAgent(` is the one).
- An app that subscribes a wake route of its own to libfx's topic in
  `vercel.json` (or `vercel.ts`) keeps it: no libfx trigger is generated, so no
  turn is delivered twice. A route that mounts `wakeHandler()` without that
  trigger gets no deliveries: the build says so, and the generated route takes
  libfx's wakes. When the app has its own route at the fx route's path,
  nothing is written there and the build says it must mount `wakeHandler()`.

Under `next dev` libfx runs each turn in the server's own process (files under
`$FX_SESSIONS_DIR`, or the temporary directory), so the generated route is not
called; nothing else to add.

### fx's kernel tools

```ts
import { createFxAgent } from 'libfx'
import { virtual } from 'durable-harness'
import { fxTools } from 'durable-harness/fx'

export const agent = createFxAgent({ model: 'anthropic/claude-opus-5.5-fast', tools: [...fxTools(virtual()), ...appTools] })
```

An fx agent is tool-less by default: libfx sends a model only the `tools`
you give it. `fxTools(workspace)` gives it libfx's kernel tools, `read_file`,
`glob_files`, `grep_files`, `edit_file`, `write_file` and `shell`, with the
names and input schemas fx's own CLI gives a model, fx's output formats
(numbered `read_file` lines, `[glob]` and `[grep]` listings, the shell's JSON
result with its exit code) and fx's descriptions. They run on a virtual
workspace at `/workspace`, never on the disk, the processes or the
environment of the machine that runs the agent: `shell` is just-bash (a
bash-compatible shell with coreutils, grep, sed, awk, jq and more; no
network, no package installs, no real binaries such as node or python), in a
worker thread leased to the session, and a path outside `/workspace` is
refused. `pnpm add just-bash`. `fxTools()` returns an array: libfx also takes
`tools` as an object keyed by name, so either spread it into your array or
key it by `name`.

- `virtual()`: each call that may change files records what it changed and
  what it returned in the session's run, keyed by libfx's `executionId`.
  Every tool is `idempotent: true`, so libfx runs a call a crash cut off
  again: one cut off before its record runs on the files as they were
  before it, and one libfx runs again after its record returns the recorded
  output without running. A change never lands twice, and the files move
  with the session to any machine. The tools that change files are
  `writes: true`, so libfx runs them one at a time.
- The records go to the World the agent keeps its sessions in. By default
  that is the one libfx picks for an agent given no `durability`: Vercel's
  World on Vercel, libfx's local files elsewhere. An agent with a durability
  of its own passes the same World:
  `createFxAgent({ durability: world(myWorld), tools: [...fxTools(virtual(), { world: myWorld })] })`
  (`world` from `libfx/durable-world`).
- `virtual({ durable: false })`: the same tools with their files in memory
  on the server running the session; their descriptions tell the model not
  to count on them after the turn, and that they are gone if the session
  moves. An agent on libfx's `memory()` durability has no run to record in,
  so it takes this one: a durable workspace there fails each call with a
  `TypeError` saying so.
- `sandbox()` (install `@vercel/sandbox`): the same six tools in the
  session's own Vercel Sandbox, the files on the session's Drive at
  `/workspace` and the commands in its Linux VM, as an unprivileged user
  with none of the Function's environment; the agent stays in the Function.
  The VM is attached at the first call of a worker that runs one (a turn
  with no call boots none), armed with the epoch of the libfx lease that
  worker holds, which rises from worker to worker: a server that was taken
  over runs nothing more there. The Drive keeps what a call wrote even if a
  crash cut it off, so the tools are `idempotent: false`: libfx stores each
  call's intent before it runs it, and never runs a cut-off call again (it
  tells the model the call may have partly run). A call whose VM is still
  starting comes back "not run: the sandbox is starting, try again". The
  World is the agent's, as for `virtual()`; an agent on `memory()` has no
  lease to arm a VM with, so each call fails saying so.

What differs from fx on a real machine, and the descriptions say so: no
paths outside the workspace, binary files reported by size instead of
attached as images, and a shell whose every command completes in its
`shell.run` call (`shell.interact` and `shell.stop` answer that no such
shell is running). The names are the kernel's on purpose: the kernel routes
a call by the tool registered under its name, and these are host tools, so
a call never falls back to a kernel built-in, and a tool you leave out
answers that it is not registered instead of touching the machine. A
session saved under another tool set still loads (libfx reports a
`checkpoint.mismatch` event).

## Other frameworks (Vercel Functions)

Without Next.js, an `api/` directory of Vercel Functions: the agent module as
above, a chat function, the flow function (the queue's consumer), and the
functions config.

```ts
// api/chat.ts
import { agent } from '../lib/agent.js'

export const { GET, POST } = agent.chatRoute({ authorize }) // your auth: see Auth above
```

```ts
// api/flow.ts: import every module that makes an agent
import '../lib/agent.js'
import { flowHandler } from 'durable-harness'

export const POST = flowHandler()
```

```ts
// vercel.ts (and pnpm add -D @vercel/config)
import type { VercelConfig } from '@vercel/config/v1'
import { harnessFunctions } from 'durable-harness/vercel'

export const config: VercelConfig = {
  functions: harnessFunctions({ chat: 'api/chat.ts' }),
}
```

`harnessFunctions` gives `api/flow.ts` the queue trigger (on durable-harness's
topic, `__harness_wkf_workflow_*`) and `maxDuration: 'max'`, and the flow function and each chat function
OpenCode's grammars as `includeFiles` (the file tracer does not find
them), for linux-x64 in
an npm, yarn or pnpm `node_modules` (in a monorepo too: it resolves from
the app's Root Directory, where the CLI loads `vercel.ts`). `chat` defaults
to every Function under `api/` that calls `chatRoute(`; a chat function
whose imports the scan cannot follow (an alias it cannot resolve, a
workspace package) gets them anyway. With a `vercel.json` instead,
`npx durable-harness vercel-json --write` merges the same `functions` into it
(run it again after adding a harness).

With `"type": "module"`, relative imports in `api/` need the `.js` extension
(`'../lib/agent.js'`). Locally, `vercel dev` runs it on world-local, the queue
in the server's own process, as `next dev` does.

## Where sessions live

The World is chosen the way the Workflow SDK chooses it: Vercel's World in a
Vercel deployment (`VERCEL_DEPLOYMENT_ID`), world-local everywhere else
(`WORKFLOW_LOCAL_DATA_DIR`, default `.workflow-data`), and
`WORKFLOW_TARGET_WORLD` to pick one (`vercel`, `local`, or a package such as
`@workflow/world-postgres`, 5.0.4 or later: install it, run its setup for the
tables, and set `WORKFLOW_POSTGRES_URL`). Every factory takes a `world` to pass
your own; an agent with its own World is served only by its own
`agent.handler`.

On world-local and world-postgres the process that makes the World consumes
durable-harness's queue itself, in process (`registerQueue`), and re-enqueues
the sessions a killed process left mid-turn (`recoverSessions`). Every
session's run records durable-harness's queue namespace, so a World's own
restart recovery, in any process, re-enqueues it on durable-harness's prefix.
A worker runs such a job in process when it has a handler for the prefix;
else it delivers it over HTTP to the route it registered for the prefix, else
to the route the process that enqueued it registered, else to the Workflow
SDK's flow route (`/.well-known/workflow/v1/flow`). So every process that
starts a World on the app's database (or data directory) does one of two
things before `world.start()`:

- it makes your agents and consumes the queue in process: `getWorld()`, or
  `registerQueue(world)` on a World you pass to the agents;
- it makes none (a world-postgres worker of its own, the Workflow SDK's
  worker) and forwards durable-harness's queue to the app: `forwardQueue(world)`.

```ts
// worker.ts: starts the World and makes no agents
import { createWorld } from '@workflow/world-postgres'
import { forwardQueue } from 'durable-harness'

const world = createWorld() // WORKFLOW_POSTGRES_URL
forwardQueue(world)         // before start(): start() re-enqueues every open session
await world.start()
```

Next to a Next.js app without the Workflow SDK, whose flow route is at the
Workflow SDK's path, it is
`forwardQueue(world, { route: '/.well-known/workflow/v1/flow' })` (see below).

A process that starts the World and does neither sends the open sessions its
start re-enqueues to the Workflow SDK's flow route, where they are refused and
retried unless the app serves durable-harness's flow route there (a Next.js
app without the Workflow SDK); durable-harness cannot redirect them from
another process.

A forwarded job is delivered over HTTP to the app's base URL
(`WORKFLOW_LOCAL_BASE_URL`, or `PORT` on localhost), at the worker's route:
`/.well-known/durable-harness/v1/flow` (`FLOW_ROUTE`), or the path in
`DURABLE_HARNESS_FLOW_ROUTE` or `{ route }`. That must be where the app serves
durable-harness's flow route: `flowHandler()`, or `agent.handler` for an agent
made with a `world` of its own. In a Next.js app it is the route
`withDurableHarness` wrote: `/.well-known/workflow/v1/flow` when the app does
not use the Workflow SDK, `FLOW_ROUTE` when it does. On world-postgres the
worker's route also wins over the one on a job the app enqueued, so a wrong
route misroutes those as well. Protect that route as you would the Workflow
SDK's flow route, and leave `/.well-known/durable-harness/` out of a proxy or
middleware matcher, as you do `/.well-known/workflow/`.

While the app is unreachable (not up yet, or restarting), a delivery fails
and is retried: on world-local every few seconds, on world-postgres with a
backoff that grows with each failure (Graphile Worker's, from seconds to
hours), so after a long outage a session resumes at its next try, which can
be well after the app is back. A world-postgres worker whose base URL is on
localhost waits for the app's port before it takes its first job.

Give each app a data directory or database of its own, and a worker of its
own. A restart's recovery re-enqueues every open session the World lists, and
every app's durable-harness consumes the same queue namespace, so an app that
shares its World's storage with another would drive the other app's sessions
with its own agents. A job queue of its own (`WORKFLOW_POSTGRES_JOB_PREFIX`)
does not separate them: recovery lists the runs, not the jobs. The Workflow
SDK's runs need the same.

## Where a turn runs, and recovery

`chatRoute()` drives a message's turn in the invocation that received it,
right away, under a deadline (60 s; `directDriveMs`), with one queue message
delayed past that deadline behind it. If the invocation dies mid-turn, that
message resumes the turn in the flow route; if the turn finished, it finds
nothing to do. A turn longer than the deadline is handed to the flow route
too. `chatRoute({ drive: 'queue' })` sends every turn through the queue
instead.

The queue is the only backstop, so how soon a killed turn resumes depends on
how it died:

| What died | When the turn resumes |
| --- | --- |
| A crash that leaves a record (an exception, a deliberate exit) | at once: the queue redelivers the turn and it resumes from the log |
| A silent kill (OOM, instance loss) in a chat route's drive | once the drive's deadline passes and its delayed queue message is delivered |
| A silent kill inside a queue delivery (the flow route) | once the queue's visibility timeout passes and it redelivers the message |
| Pi with pi-durable, silent | once the deadline of its last commit passes (`recoverAfterMs`, renewed while Pi keeps committing); at once after a close |

On world-local a restarted server picks a killed turn up as soon as it serves
its first request.

A session has one driver at a time. When a second drive of it starts (a
redelivery while the first is still alive, a recovery racing a slow writer),
the World's in-band writer fence refuses the stale one's next write, so it
writes nothing more and stops: on world-local across processes on one data
directory and across restarts (`@workflow/world-local` 5.1.1 or later), on
world-postgres across processes and hosts, and on Vercel
(`@workflow/world-vercel` 5.2.1 or later). On a World without the fence, the
log's own rules make a stale writer's writes inert instead.

## Pi with pi-durable: your pi-durable code, a World-backed storage

If your agent is built on Pi 1.0's own durable `Harness`
([`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)),
keep it. `durable-harness/pi-durable` is a Pi `Storage` on the World: your
`Harness.open`, models, registry, extensions, tools, `root.submit`,
`requestId`, watching and forks stay as they are. Two things change: where the
storage comes from, and one line that tells durable-harness how to reopen a
session a dead process left.

```bash
pnpm add durable-harness @earendil-works/pi-durable @earendil-works/chord @earendil-works/pi-ai
```

Before (Pi's own README, on SQLite):

```ts
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const models = createModels()
models.setProvider(anthropicProvider())
const registry = createRegistry()

const harness = await Harness.open(await openNodeSqliteStorage(`./sessions/${id}.sqlite`), { models, registry }, ctx)
```

After:

```ts
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable'
import { openWorldStorage, resumeWith } from 'durable-harness/pi-durable'

// the one line: how durable-harness reopens a session a dead process left
const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry }, ctx))

const harness = await open(await openWorldStorage(id)) // no id: a new session, `storage.sessionId`
```

Everything after that is Pi's: `harness.root(ctx, { agent })`,
`root.submit({ type: 'input', content, requestId, whenBusy })`,
`submission.wait(ctx)`, `watchEvents`, `root.watch()`, compaction, documents,
subagents, `harness.close(ctx)`. Any pi-ai provider works; `gatewayModels()`
is pi-ai's models through the AI Gateway (`AI_GATEWAY_API_KEY`, else the
Vercel OIDC token), with model refs like
`{ provider: GATEWAY_PROVIDER, modelId: 'anthropic/claude-sonnet-4.5' }`.
Session ids are the World's (`wrun_` and a ULID on Vercel): keep your own
chat ids in your own store and map them.

Each Pi commit is an event in the session's run, durable before Pi goes on
(Durable Strict). The storage stands behind its own commits: before a commit
that may leave work unfinished, it makes sure a wake waits behind it (on
Vercel a queue message delayed past the commit's deadline, renewed while Pi
keeps committing; on world-local and world-postgres the next start's
recovery). If the process dies, the wake reopens the session with your
opener, `resume()`s it and Pi finishes the turn: a `replay: 'safe'` tool runs
again, any other comes back to the model as interrupted. A request that
returns while Pi still works is kept alive (`waitUntil`) until the session is
idle, and closing the Harness with work left hands the session to a wake at
once.

### Coding tools: Pi's own, on a virtual workspace

A Harness has no tools until you install them. Pi's coding tools (`read`,
`write`, `edit`, `bash`) go on an environment where the model's commands and
files can't reach your Function's disk, processes or environment:

```ts
import { CodingTools, virtualEnv } from 'durable-harness/pi-durable'

registry.install(CodingTools)
const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry, env: virtualEnv() }, ctx))
```

`CodingTools` here are pi-durable's own (`@earendil-works/pi-durable/tools`):
the same names, schemas, descriptions and code, with each call bound to the
workspace. `virtualEnv()` is just-bash on a virtual filesystem at
`/workspace`, in a worker thread leased to the session: a bash-compatible
shell, no network, no real binaries (node, python, git). Add `just-bash` to
your dependencies. The descriptions are pi-durable's, so they don't say the
shell is not real Linux: say so in your agent's system prompt
(`workspaceInstructions(virtual())` from `durable-harness/tools` says it,
and how long the files last).

- `virtualEnv()` (durable, the default): each call runs on the files as the
  log has them, and what it changed commits with its result, in the same
  event (files over 4 KB in the session's blob stream). A call a crash cut
  off changed nothing, and the files follow the session to any instance.
  Calls Pi runs side by side each commit their own changes; one doesn't see
  another's until that call's result is in. A command that runs past the
  workspace's time limit is stopped and changes nothing. Outside these `CodingTools` (pi-durable's own, or a tool of yours
  that uses `api.env`) the workspace is read-only, and a write says which
  import to use.
- `virtualEnv({ durable: false })` (or `virtualEnv(virtual({ durable: false
  }))`): the same tools on files in memory, for the turn. They are cleared
  when the next turn starts, and sooner if the session moves to another
  instance; the first tool result of each turn tells the model so
  (`MEMORY_NOTE`), and nothing of the files is in the log.
- `virtualEnv(virtual({ maxBytes, maxFileBytes, timeoutMs }))`: the
  workspace's limits (see `virtual()`).
- `sandboxEnv()` (or `sandboxEnv(sandbox({ ... }))`; install
  `@vercel/sandbox`): the same tools in the session's own Vercel Sandbox,
  on its `/workspace`, a Drive per session, as the VM's unprivileged user;
  a command gets only the variables it is given. The files last across
  turns and VMs, and nothing of them is in the log; they are not
  transactional: a command a crash cut off may have partly run (Pi reports
  it interrupted and never runs it again). The VM boots at the first call
  that reaches the workspace, armed with the storage's own fencing token
  (the count of its first write in the session's log, which rises from one
  owner to the next), so an invocation that lost the session runs nothing
  there; the session's sandbox record (its Drive, the VM time granted
  against `sandbox({ budget: { vmSeconds } })`) is in its log. A call whose
  VM could not be attached answers `NOT_RUN` ("Not run: the sandbox is
  starting, try again"), and nothing reached the VM. These `CodingTools`
  also tell the model, once, when the session's files were lost (a new,
  empty Drive); pi-durable's own `CodingTools` run on the same workspace
  without that note. Needs a World with the in-band writer fence
  (world-vercel, world-local).

Never pass `NodeExecutionEnv` (`@earendil-works/pi-durable/env/node`) in a
Function: it runs the model's commands on the Function's own disk and
processes, with its environment (your Gateway key, the OIDC token), where
every session on the instance can reach them. `CodingTools` refuses it on
Vercel. pi-durable's tools stay `replay: 'unsafe'`: a call a crash
interrupted comes back to the model as interrupted, with nothing it changed.

### Next.js

```ts
// lib/pi.ts
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable'
import { gatewayModels, GATEWAY_PROVIDER, resumeWith } from 'durable-harness/pi-durable'

const models = gatewayModels() // or your own pi-ai models
const registry = createRegistry()
// registry.install(yourExtension)

export { ctx }
export const agent = { model: { provider: GATEWAY_PROVIDER, modelId: 'anthropic/claude-sonnet-4.5' } }
export const open = resumeWith((storage: Storage) => Harness.open(storage, { models, registry }, ctx))
```

```ts
// app/api/chat/route.ts: your own route, Pi's own API
import { after } from 'next/server'
import { openWorldStorage } from 'durable-harness/pi-durable'
import { agent, ctx, open } from '@/lib/pi'

export const maxDuration = 800

export async function POST(request: Request) {
  const { sessionId, text, requestId = crypto.randomUUID() } = await request.json()
  // your auth here
  const storage = await openWorldStorage(sessionId)
  const harness = await open(storage)
  const root = await harness.root(ctx, { agent })
  const submission = await root.submit({ type: 'input', content: text, requestId }, ctx)
  after(async () => {
    try {
      await submission.wait(ctx)
    } finally {
      await harness.close(ctx) // closing with work left hands it to a wake
    }
  })
  return Response.json({ sessionId: storage.sessionId, submissionId: submission.id })
}
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'
export default withDurableHarness({})
```

`withDurableHarness` finds the module that calls `resumeWith(` and imports it
in the flow route it writes, so your opener is registered where the queue
delivers. A route that only opens storages is not imported there. A module
that opens pi-durable sessions while no module calls `resumeWith(` is a
warning (a failed build on Vercel): a session a process left would never be
finished.

### Vercel Functions

```ts
// api/flow.ts: import every module that calls resumeWith
import '../lib/pi.js'
import { flowHandler } from 'durable-harness'

export const POST = flowHandler()
```

```ts
// vercel.ts
import type { VercelConfig } from '@vercel/config/v1'
import { harnessFunctions } from 'durable-harness/vercel'

export const config: VercelConfig = { functions: { ...harnessFunctions(), 'api/chat.ts': { maxDuration: 800 } } }
```

`api/chat.ts` is the route above with `waitUntil` from `@vercel/functions`
instead of `after`.

### A server of your own

On world-local and world-postgres, the process that makes the World consumes
durable-harness's queue itself and re-enqueues the sessions a killed process
left. The World is made when the process first needs it (the first
`openWorldStorage`); call `await getWorld()` from `durable-harness` at startup
to finish a killed turn at once. Mount `flowHandler()` at
`/.well-known/durable-harness/v1/flow`, where a worker in another process
delivers durable-harness's queue over HTTP; a process that starts the World
without making agents calls `forwardQueue(world)` before `world.start()` (see
Where sessions live).

### What is different on the World

- **Opening a session takes it.** Pi's `Harness.open` turns the previous
  owner's running tasks back to pending; on the World that is enforced: the
  previous owner's next commit is refused (`StorageFenced`) and lands nowhere.
  Keep one open Harness per session per process (`acquireHarness` shares
  one), and read a session that may be running with `openWorldReader`, which
  never opens it.
- **A refused commit poisons the Harness** (Pi's rule for any storage that
  fails a commit). Drop it, open again, and resubmit with the same
  `requestId`.
- **Silence is a deadline.** A process that holds a session with work
  unfinished and commits nothing for `recoverAfterMs` (120 s by default) may
  be taken over by the wake behind its last commit. Pi commits a streaming
  model response several times a second and every step of a task, so this
  only bites a tool that runs longer than that without output, or a model
  call that streams nothing for that long: raise `recoverAfterMs` for those. A
  request is kept alive while work is unfinished, until that deadline at the
  latest, so work no deployment of yours can run (a task whose extension is
  gone) never holds a request open.
- **Background work belongs to the session, not the turn.** A compaction Pi
  starts on its own, or a task created with `background: true` (a background
  subagent), keeps no conversation busy, so `submission.wait()` and
  `waitForIdle()` do not wait for it. Closing the Harness then hands it to a
  wake, which finishes it (rerunning the step the close interrupted);
  `chatRoute` waits for it before it lets go.
- **Files belong in the workspace.** On Vercel a resumed turn may run on
  another instance, so files in a local directory do not follow the session:
  give the tools `virtualEnv()` (their changes are in the log), and keep a
  tool's other state in the log (Pi's documents) or in storage of your own.

### Optional helpers

- `acquireHarness(sessionId, open, options?)`: the session's open Harness in
  this process, shared with every route and wake of the process that drives
  it (`{ harness, storage, release }`; release it, don't close it).
- `chatRoute({ open, agent, authorize })`: a chat route on Pi's own
  submissions, with the SSE events every durable-harness chat route sends
  (`text`, `tool_start`, `tool_end`, `idle`, then `event: end`). POST
  `{ sessionId?, text, kind?, requestId? }`; `kind: 'steer'` is Pi's
  `whenBusy: 'steer'`, which lands after the current tool round (on another
  server it takes the session over). GET `?sessionId=` follows a turn under
  way from the log, without opening the session; Pi's live partial has no
  cursor, so a reconnect gets a `rewind` and the in-flight response from its
  start, and 204 when the session is idle. With `authorize: 'public'` and
  your tools in `sandboxEnv()`, pass `allowPublicSandbox: true` and a finite
  `sandbox({ budget: { sessionUsd } })`: each session it starts records the
  route, and its sandbox attach refuses a VM without both (the call fails
  with why), since the route has no harness of yours to check when it is
  made.
- `gatewayModels({ apiKey? })`: pi-ai models through the AI Gateway.
- `openWorldReader(sessionId)`: a read-only follower for UIs (`refresh()`,
  `snapshot()`: entries, Pi's live partial, tasks, `unfinished`).

Your own World: `openWorldStorage(id, { world })` and `resumeWith(open, {
world })`, and the World delivers durable-harness's queue to this process
(`registerQueue(world)`) or to a route that mounts `queueHandler(world)`.

## Pi with pi-durable, and without

| | Pi without pi-durable (`durable-harness/pi`) | Pi with pi-durable (`durable-harness/pi-durable`) |
| --- | --- | --- |
| What it is | Pi's agent loop (`pi-agent-core`'s `Agent`) on this package's durable kernel | Pi 1.0's own durable `Harness` on a World-backed Pi `Storage` |
| What you write | `pi({ model, tools })`, then its chat route | your own Pi 1.0 code on `openWorldStorage()`, plus `resumeWith(open)` |
| Who owns durability | the kernel: every model and tool call is a step, intent before and outcome after | Pi: every Pi commit is one event in the log |
| Modes | Durable On (default: writes trail the agent) or Durable Strict | Durable Strict only |
| World writes | a step per model and tool call | an event per Pi commit, streamed text included |
| Silent crash recovery | once the drive's deadline passes; at once with a crash record | once the deadline of its last commit passes (`recoverAfterMs`); at once after a close |
| Live stream | the kernel's: cursors, resumable from any server | read from Pi's journal; a reconnect resends the in-flight response from its start |
| Steer from another process | lands at the running drive's next model call | takes the session over |
| Tools | none by default; `createCodingTools(virtual())`, and Pi `AgentTool`s or `HostTool`s with a `replay` policy | none by default; your registry: tools, extensions, hooks, subagents; `CodingTools` with `env: virtualEnv()` for files and commands |
| Pick it when | by default | you have, or want, Pi 1.0 `Harness` code (extensions, compaction, documents) |

### Pi's coding tools

```ts
import { virtual } from 'durable-harness'
import { createCodingTools, pi } from 'durable-harness/pi'

export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: [...createCodingTools(virtual()), ...appTools] })
```

`createCodingTools(workspace)` gives Pi the tools pi-coding-agent's
`createCodingTools` gives it, `read`, `bash`, `edit` and `write`, with the
same names, input schemas and descriptions, the same truncation (the first
2000 lines or 50 KB of a file, the last of a command's output) and the same
result texts. They run on a workspace at `/workspace`, never on the disk,
the processes or the environment of the machine that drives the session.

- `virtual()`: a virtual workspace. `bash` is just-bash (a bash-compatible
  shell with coreutils, grep, sed, awk, jq and more; no network, no package
  installs, no real binaries such as node or python), in a worker thread
  leased to the session, and its description says so. Each call's file
  changes commit with its outcome in the session's log, so every tool is
  `replay: 'safe'`: a call a crash interrupted changed nothing and runs
  again, and the files move with the session to any machine. With
  durability off (no World), the files last the turn. `pnpm add just-bash`.
- `virtual({ durable: false })`: the same tools with their files in memory,
  cleared at the end of every turn; their descriptions tell the model.
- `sandbox()`: the session's own Vercel Sandbox. Pi stays in the Function;
  the files are on the session's Drive at `/workspace` and the commands run
  in its Linux VM, as an unprivileged user with none of the Function's
  environment. The VM is attached on the first call of a turn that runs one
  (a turn with no call boots none), with the session's own fencing token,
  before the call is recorded: a call whose VM is still starting comes back
  "not run: the sandbox is starting, try again", and never ran. The Drive
  keeps what a call wrote even when a crash cut it off, so `bash`, `edit`
  and `write` are `replay: 'never'` (an interrupted call is reported as
  such, never run again by itself) and `read` is `replay: 'safe'`. Needs a
  World with the in-band fence. `pnpm add @vercel/sandbox`.

A command that exits nonzero is an error result, as in Pi, and the files it
changed stay; a command past the workspace's time limit is stopped (on
`virtual()` its call changes nothing; on `sandbox()` what it wrote before
the cut may be there). `read` reads text files only: an image is an error
result. What else differs from pi-coding-agent: stdout and stderr come back
one after the other, not interleaved, and a truncated output's full text is
in the workspace's `/tmp` (only the latest one), which is not one of the
session's files.

`pi()` refuses pi-coding-agent's own tools (`createCodingTools(cwd)` from
`@earendil-works/pi-coding-agent`): they run on the machine that drives the
session, and its `bash` gets the process's environment, credentials
included. The same tools work in any loop that takes `HostTool`s.

## Documents

Typed JSON state per session, kept in the session's log: a todo list, a
plan, a form the agent fills in. Not files (give the agent a Sandbox for
those), and not shown to the model unless you give it tools that read them.

```ts
import { defineDoc, type HostTool } from 'durable-harness'
import { Type } from 'typebox'

const Todos = defineDoc<{ items: string[] }>({
  kind: 'app.todos', version: 1, initial: () => ({ items: [] }),
  schema: Type.Object({ items: Type.Array(Type.String()) }), // what docTools shows a model (optional)
})

// A tool: the edit commits with the call's outcome. A call that throws, or
// is cut off by a crash, changed nothing.
const addTodo: HostTool<{ item: string }> = {
  name: 'add_todo', description: 'Add a todo.', replay: 'safe',
  inputSchema: Type.Object({ item: Type.String() }),
  async execute({ item }, io) {
    const todos = io.docs!.update(Todos, (d) => { d.items.push(item) })
    return `added; ${todos.items.length} todos`
  },
}

// App code: read, and write out-of-band (a route, a webhook).
await agent.sessions.doc(sessionId, Todos)                 // { value, revision }
await agent.sessions.updateDoc(sessionId, Todos, (d) => { d.items.push('milk') }, { expectRevision: 3 })

// The browser: the chat route sends the current value first, then every change.
export const { GET, POST } = agent.chatRoute({ authorize, docs: [Todos] })
```

- A tool's `io.docs` reads a document as of the call's first touch of it and
  updates it with the outcome; under Claude Code, Codex and OpenCode only
  your `HostTool`s get it (their built-in tools never see documents).
- `updateDoc` lands only on the revision it read: it re-reads and runs your
  function again after losing a race, or with `expectRevision` throws
  `DocConflict`. A tool's edit always applies where its outcome lands,
  merged key by key with what landed meanwhile, so key collections by id
  (`{ items: { [id]: Todo } }`) when several writers edit their members.
- 64 KB (`DOC_MAX_BYTES`) per document, as `JSON.stringify`: a write that
  would grow one past it throws `DocTooLarge`. Values are strict JSON.
- `version` is the schema: bump it and give `migrate(old, fromVersion)`, which
  runs on read. A document stored at a newer version than the code's throws
  `DocVersionError`. The edit counter is `revision`.
- Each change is a `doc` event on the live stream, with the whole value and
  its `revision`; `chatRoute` forwards only the kinds you list (default none).
  Show the highest revision you have seen of each; after a `rewind` event (a
  drive running ahead of its writes started over), take the next one of each
  kind whatever its revision. A document that changes often or is large can
  publish its `revision` alone: `defineDoc({ ..., live: 'revision' })`, and
  read the value (`sessions.doc`) when the revision moves. The workspace's
  manifest (`hw.workspace`) does.

Showing a document to the model is opt-in, two ways:

```ts
import { docTools } from 'durable-harness/tools'

// Tools: read_todos returns { revision, value }; update_todos takes the whole
// new value (and expectRevision), typed by the document's `schema` (give it
// one; without it the value is sent as JSON text). The only way Claude Code,
// Codex and OpenCode see one.
export const agent = claudeCode({ model: 'anthropic/claude-sonnet-4.5', tools: docTools([Todos]) })

// Pi (and the AI SDK harness): the documents at the start of the latest user
// message of every model call, as that call sees them. Off by default.
export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: docTools([Todos]), promptDocs: [Todos] })
```

The documents go near the end of the request, not into the system prompt,
and an earlier user message keeps what it showed (the model step records
it), so each request starts with the one before it: a document that changes
costs the provider's prompt cache the latest prompt and what follows it, and
with no change the whole request is cached. A `durableAgent` of your own
builds the same text with `docsPrompt([Todos])(io.docs)` inside its model
call's effect (put it near the end too, and keep what a message showed on it
in later requests: a prefix cache such as Anthropic's misses from the first
change). Read inside the effect, so a replay never depends on a value that
changed since.

## Agent Runs on Vercel

Vercel Agent Runs, in Observability, shows each session as a run: its turns,
and in each turn every model call and tool call, with its input, output and
token usage. `durable-harness/instrumentation/otel` exports them as
OpenTelemetry spans, with OpenTelemetry's SDK: optional peer dependencies,
which nothing else in durable-harness loads. Install them next to it:

```bash
pnpm add @opentelemetry/sdk-trace-base@2.2.0 @opentelemetry/resources@2.2.0 @opentelemetry/otlp-transformer@0.208.0
```

Without them, `agentRuns()` throws with this line. Declare the integration
in `agent-runs.ts`:

```ts
import { agentRuns } from 'durable-harness/instrumentation/otel'

export default agentRuns({
  exportPolicy: {
    span: ({ audience }) =>
      audience === 'public'
        ? { emit: true }
        : { redact: true, inputs: true, outputs: true },
  },
})
```

Register it from Next.js's `instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { default: runs } = await import('./agent-runs')
  runs.register()
}
```

Without Next.js (Vercel Functions), register it at module load in the module
that makes your agents, which the chat and flow functions both import:

```ts
// lib/agent.ts
import runs from '../agent-runs.js'
import { pi } from 'durable-harness/pi'

runs.register()

export const agent = pi({ model: 'anthropic/claude-sonnet-4.5' })
```

Then turn on tracing for the environment: a sampling rule on the project's
Tracing settings page, or `vercel traces config set production 100` (Vercel CLI
62.5 or later; an earlier CLI writes a rule that always-on tracing does not
read, and `vercel traces config ls` then lists none). A sampled invocation
exports its spans through Vercel's request context. Without tracing, Agent
Runs still lists the sessions (from the tags below) but shows no trace, model
or tokens; `vercel curl --trace` traces a single request. Importing the module
makes no network requests, and it does not replace your app's global
OpenTelemetry provider. `spanProcessors` adds destinations of your own, with
the same export policy.

A session's page is
`https://vercel.com/<team>/<project>/observability/agent-runs/<sessionId>?environment=production`
(or `preview`): a session's id is its run's id.

### Who sees the content

By default the integration hides inputs, outputs, titles and error messages
for a session whose audience is `private` or `unknown`; `exportPolicy` decides
per span and per attribute. A session's audience is recorded when it starts:

- A chat route with `authorize: 'public'` records `public`; any other chat
  route `unknown`, unless the agent says otherwise
  (`claudeCode({ model, traceAudience: 'private' })`).
- `agent.sessions.start()`: the agent's `traceAudience`, else the session's
  `config.traceAudience`, else the integration's default
  (`agentRuns({ audience })`), else `unknown`.
- Pi with pi-durable: `openWorldStorage(undefined, { traceAudience })` (or
  `acquireHarness(undefined, open, { traceAudience })`) records it on the new
  session, and every later storage of the session traces with it, a wake's
  included. On a session that exists,
  `openWorldStorage(id, { traceAudience })` applies to that storage only.
  `resumeWith(open, { traceAudience })` is the audience of the turns a wake
  drives in a session that recorded none. Its `chatRoute` records `public`
  or `unknown` as the others do.

An audience of `public` shows the session's model and tool content to the
project members who can read its traces.

### What is traced

- Each turn a server drives is an `invoke_agent <agent>` root span. Every
  model call and tool call is an `agent.step` span, with a `chat <model>` or
  `execute_tool <tool>` span under it.
- A session keeps one trace across invocations: a turn that goes on in a later
  invocation (after its time budget, or a recovery) adds a root to the same
  trace, and a root that hands its turn on ends as `running`. Spans a crashed
  process had not ended are lost with it.
- Work that already happened is not traced again: memoized steps, a journal
  replayed on open and drives with nothing to do emit no spans.
- Claude Code, Codex and OpenCode: model calls come from the AI Gateway proxy
  every model request goes through (an oversized request or response body is
  cut or left out); tool calls are their own tools' and yours.
- Pi (`durable-harness/pi`), and harnesses of your own on `durableSessions`
  or `durableAgent`: a step named `model` is a model call, a step named
  `tool.<name>` a tool call.
- Pi with pi-durable: Pi's model and tool tasks, from the commits its storage
  accepts.
- Usage includes cached input where the provider reports it.
- Not traced: libfx's own durable sessions (fx agents), sessions driven in a
  browser or a detached sandbox (there is no Vercel request context there),
  and the link from a subagent to its parent.

For Agent Runs' session list and its content visibility, the integration also
writes a few tags on the session's run through the World's
`runs.experimentalSetAttributes`: the same `$eve.*` tags an eve agent's
sessions carry (`$eve.type`, `$eve.is_otel_trace_enabled`,
`$eve.is_trace_content_visible`, `$eve.trace_id`, `$eve.trigger`,
`$eve.title`). They are read from the filtered root span, so a redacted title
stays hidden, and they never carry model or tool content. A World without that
API still exports spans, but Agent Runs may not list the session or show its
content. Spans use the `eve.agent` instrumentation scope and schema version 4,
which Agent Runs reads, and name their framework `durable-harness`; some Agent
Runs views still label sessions in eve's words. In the session list a session
whose last turn is done reads Waiting (it takes the next message), with its
title and tokens; the model shows on the session's page, not in the list
(the list takes it from an eve session's turn runs, which these sessions do
not have).

## API

Every factory (`claudeCode`, `codex`, `opencode`, `pi`) returns an agent:

- `agent.chatRoute(options?)`: `{ GET, POST }` (above). `authorize` (a
  function, or `'public'`; without one, production refuses every request),
  `allowPublicSandbox` (see Auth), `drive`, `keepaliveMs`, `docs`.
- `agent.handler`: the queue consumer for this agent alone (the generated flow
  route mounts every agent's).
- `agent.sessions`: the sessions underneath. For the kernel harnesses,
  `start`, `send(id, text, kind?)`, `inspect(id)`, `live(id)` and
  `liveEntries(id, { cursor })`, `doc(id, Doc)` and `updateDoc(id, Doc, fn,
  options?)`, `withdraw`, `close`, `chaos`.

The factories take the harness's own options, passed through as they are
(`instructions`, `tools`, ...), and these: `world`, `durability`
(`'on' | 'strict'`), `traceAudience` (see Agent Runs on Vercel), `log`, and
the kernel's timing knobs (`directDriveMs`, `maxInvocationMs`, ...).

Advanced, from `durable-harness`:

- `durableSessions({ world, harness })`: the kernel's session API over any
  World and any number of harnesses (`claudeCodeHarness`, `codexHarness`,
  `opencodeHarness`, `piHarness`, exported by their subpaths), for scripts,
  other frameworks, or several harnesses on one queue consumer.
- `durableAgent({ harness })`: an agent over a harness of your own (a kernel
  `Harness`: `name` and `drive(ctx)`, its model and tool calls as
  `ctx.effect` steps; `EffectFailure`, `Yield`, `Restart`, `Fatal` are
  exported for it).
- `getWorld()`, `flowHandler()`, `liveResponse`, `chatRoute`.
- `registerQueue(world, { route? })`: make a World you hold (the Workflow SDK's,
  say) deliver durable-harness's queue to this process's agents;
  `recoverSessions(world)`: re-enqueue the sessions a dead process left
  mid-turn (`getWorld()` does both for its World).
- `forwardQueue(world, { route? })`: in a process that starts a World but
  makes no agents, send durable-harness's queue over HTTP to the app's flow
  route (call it before `world.start()`).
- `QUEUE_PREFIX` (`__harness_wkf_workflow_`), `QUEUE_TOPIC`, `FLOW_ROUTE`
  (`/.well-known/durable-harness/v1/flow`), `FX_ROUTE`.

`durable-harness/opencode`: `opencode(options)`, `opencodeHarness(options)`
(the raw harness, for `durableSessions`), `OPENCODE_TOOLS` (the names
`builtins` takes) and `DEFAULT_INSTRUCTIONS` (the system prompt's line
without a workspace). Besides `model`, `tools` and `instructions`: `workspace`
(`virtual()` or `sandbox()`, see [OpenCode's own tools](#opencodes-own-tools)), `builtins`,
`title`, `credential` and `gatewayUrl` (the AI Gateway's), and `root` (where
each drive keeps OpenCode's own files on the machine, a directory per drive
removed when it ends).

`durable-harness/pi`: `pi(options)`, `piHarness(options)` (the raw
harness, for `durableSessions`), and `createCodingTools(workspace)` (Pi's
`read`, `bash`, `edit`, `write` on a `virtual()` workspace, above).

`durable-harness/pi-durable` (Pi 1.0's own `Harness`, no factory):
`openWorldStorage(sessionId?, { world?, name?, recoverAfterMs?, traceAudience? })`,
a Pi `Storage` on the World (a new session without an id: `storage.sessionId`);
`resumeWith(open, { world?, name?, maxDriveMs?, traceAudience? })`, the opener a
wake reopens sessions with (returns `open`). Optional helpers: `acquireHarness(sessionId,
open, options?)` (`{ harness, storage, release }`, one open Harness per
session per process), `chatRoute({ open, agent?, authorize, ... })`,
`gatewayModels({ apiKey? })` and `GATEWAY_PROVIDER`, `openWorldReader(sessionId,
{ world? })` (`refresh()`, `snapshot()`), `StorageFenced`, and the types
`WorldStorage`, `Opener`, `HarnessLease`, `SessionReader`, `SessionSnapshot`.
The tools' environment: `virtualEnv(workspace?)` (a `virtual()` descriptor or
its options) and `sandboxEnv(workspace?)` (a `sandbox()` descriptor or its
options), each a `HarnessOptions.env` (`EnvBuilder`); `CodingTools`, Pi's own
coding tools bound to the workspace; `MEMORY_NOTE`, what an in-memory
workspace tells the model; `NOT_RUN`, what a call on `sandboxEnv()` answers
when its VM could not be attached.

`durable-harness/instrumentation/otel`: `agentRuns(options?)` (`register()`,
`forceFlush()`; options `exportPolicy`, `audience`, `serviceName`,
`spanProcessors`) and `filteringProcessor(processor, policy?)`, which applies
an export policy to a span processor of your own.

`durable-harness/tools`: `workspaceTools(workspace = virtual())` (`bash` on
just-bash, `read_file`, `write_file`, `edit_file`, `list_files`) on a virtual
workspace at `/workspace`: not real Linux (no network, no package installs, no
real processes) and nothing of the machine that drives the session, neither
its disk, its processes nor its environment. just-bash runs with a cap on the
workspace's bytes and on each file's, and a time limit per command, in a worker
thread leased to the session alone, with an empty environment, where one can
start: a long command holds its session's worker, not the Function serving
every other session, and one past its time limit is stopped (its call fails
and changes nothing). With `virtual()` (durable, the default) its files
are a document of the session, `hw.workspace`: files up to 4 KB inline, larger
ones in the session's blob stream, each call's change on its own outcome;
binary files are kept as bytes and a mode other than 0o644 as the file's mode,
so a gzip or a script made executable is the same file on the next machine (a
symbolic link is a copy once its call is over; `read_file` and `edit_file` work
on text and say so for a binary file); about 500 files. With
`virtual({ durable: false })` the same tools keep their files in memory for one
turn and write nothing to the log: they say so in their descriptions, and a
turn picked up again on a new drive tells the model its files are gone.
`workspaceInstructions(workspace)` says the same for a system prompt. Install
`just-bash`, loaded on the first call. Also `docTools(docs)` (`read_<name>`
and `update_<name>` per document), `unsafeTools()`, two deliberately
non-idempotent tools for crash drills, and readers for UIs:
`workspaceManifest(state)` (synchronous: path, size, inline or not, `binary`,
`mode`), `readWorkspace(world, state)` (every file: a text file as a string, a
binary file as a `Uint8Array`), `filesFromState(state)` (the text files whose
text is in the log). `virtual()` and the `Workspace` types are also exported
from `durable-harness`.

`durable-harness/sandbox`: `sandbox(options?)` (also from `durable-harness`:
`region`, `vcpus`, `network`, `env`, `idleMs`, `commandTimeoutMs`,
`driveSize`, `budget`, `image`, `credentials` for a driver outside Vercel),
`sandboxName(runId)` and `driveName(runId)` (a session's VM and Drive),
`deleteSessionSandbox(runId)` (delete both), `sandboxCleanup(options)`
(delete idle ones; opt-in, from a cron of your own) and `prepareSandboxBase()`
(build the base snapshot ahead of time, so a region's first session doesn't:
also `npx durable-harness sandbox prepare`).

`durable-harness/fx`: `fxTools(workspace, { world? })`, libfx's kernel tools
(`read_file`, `glob_files`, `grep_files`, `edit_file`, `write_file`, `shell`)
on a virtual workspace or in the session's Vercel Sandbox, for libfx's
`createFxAgent({ tools })`: see [fx's kernel tools](#fxs-kernel-tools).

## Outside Next.js

```ts
import { createWorld } from '@workflow/world-local'
import { durableSessions, QUEUE_PREFIX } from 'durable-harness'
import { claudeCodeHarness } from 'durable-harness/claude-code'

const world = createWorld({ dataDir: '.workflow-data' })
const sessions = durableSessions({ world, harness: claudeCodeHarness({ model: 'anthropic/claude-sonnet-4.5' }) })
world.registerHandler(QUEUE_PREFIX, sessions.handler) // the queue, in this process
await world.start?.()                                  // resume what a killed process left
const { sessionId } = await sessions.start({ prompt: 'What is 6 times 7?' })
```

The session's VM is made in the Vercel project this directory is linked to
(`vercel link`), or the one `workspace: sandbox({ credentials })` names.
