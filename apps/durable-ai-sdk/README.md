# durable-ai-sdk example

The AI SDK's `ToolLoopAgent` (ai 7.0.127), made durable on a Workflow World.
The agent loop is the AI SDK's own: nothing is reimplemented. Two seams make it
durable:

- **The model** goes through a language model middleware (`wrapLanguageModel`)
  whose `wrapGenerate` runs each call as an effect `model:<turn>:<step>` with
  `replay: 'safe'`.
- **Each tool's `execute`** runs as an effect `tool:<toolCallId>` with the
  tool's own `replay` (`'safe'` reruns after a crash, `'never'`, the default,
  comes back as an interrupted error the model sees).

A turn starts with a `turn` step that places its prompts and ends with a
`checkpoint` step holding every message the turn generated
(`generate()`'s `responseMessages`). When a model call fails for good, the
checkpoint holds the messages of the steps that finished before it, so a tool
call that ran stays in the conversation. Each drive folds the finished turns
back into `ModelMessage[]` (`transcript()`), and runs `agent.generate()` again
for the unfinished turn: every model or tool call the log already has returns
its recorded result without running, and the rest run for real.

The AI SDK turns anything a tool's `execute` throws into an error result for
the model. A committed failure, an interrupted call included, should reach the
model that way. A kernel stop should not: when another driver holds the session
(`Yield('contended')`), the log moved (`Restart`), or a write was refused, the
tool wrapper halts the drive (`ctx.halt`) and no further model call is made, so
the stop is never recorded as a tool result. Out of time (`Yield('budget')`),
it makes no further model call either, but lets the calls already running
finish.

The whole harness is [`src/harness.ts`](src/harness.ts). In a Next.js app it
is an agent like any other of `durable-harness`'s (`durableAgent` takes a
harness of your own), with the same three files as the
[quick start](../../packages/durable-harness/README.md):

```ts
// lib/agent.ts
import { durableAgent, virtual } from 'durable-harness'
import { createCodingTools } from 'durable-harness/pi'
import { aiSdkHarness } from 'durable-ai-sdk'
import { fromHostTools } from 'durable-ai-sdk/tools'

export const agent = durableAgent({
  harness: aiSdkHarness({
    model: 'anthropic/claude-haiku-4.5', // any AI Gateway model id, or a model instance
    instructions: 'You are a coding agent. Keep answers short.',
    tools: fromHostTools(createCodingTools(virtual())), // read, bash, edit, write on a virtual workspace
  }),
})
```

```ts
// app/api/chat/route.ts
import { agent } from '@/lib/agent'
// Open under `next dev`; production refuses every request until you pass
// `authorize` (a function, or 'public'): see durable-harness's README.
export const { GET, POST } = agent.chatRoute()
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next'
export default withDurableHarness({})
```

Outside Next, the advanced API is the same kernel (`src/cli.ts`):

```ts
import { durableSessions, QUEUE_PREFIX, virtual } from 'durable-harness'
import { createCodingTools } from 'durable-harness/pi'

const sessions = durableSessions({
  world,                                   // world-local here
  harness: aiSdkHarness({
    model: 'anthropic/claude-haiku-4.5',
    tools: { ...fromHostTools(createCodingTools(virtual())), make_payment: makePayment('.ledger.jsonl') },
  }),
})
world.registerHandler(QUEUE_PREFIX, sessions.handler) // the queue, in this process
const { sessionId } = await sessions.start({ prompt: 'Write a haiku to haiku.txt' })
```

Tools are ordinary AI SDK tools plus a `replay` field. `fromHostTool()` turns
the repo's harness-neutral `HostTool`s into AI SDK tools: here
`createCodingTools(virtual())` from `durable-harness/pi`, Pi's `read`, `bash`,
`edit` and `write` on a virtual workspace whose files live in the log (its
commands never reach the machine's files, processes or environment; install
`just-bash`). `makePayment()` is a tool that is not safe to rerun, with a
ledger file to count its side effects.

## Run it

From the repo root: `pnpm install`. You need an AI Gateway credential,
`AI_GATEWAY_API_KEY` or the project's `VERCEL_OIDC_TOKEN` (`vercel env pull`).

```bash
cd apps/durable-ai-sdk
pnpm cli "Write a haiku about event logs to haiku.txt, then read it back."
pnpm cli <sessionId> "Now make it rhyme."          # the next turn, from the folded log

# The crash drill: kill -9 while the payment waits for its "bank" (3 s).
pnpm cli "Pay \$7 to bob@example.com with memo 'coffee', then tell me the payment id."
pnpm cli <sessionId>     # reattach: the payment is not repeated; the model hears it was interrupted
cat .ledger.jsonl        # one line
```

Nothing is waited out after a kill: the next run's `start()` redelivers the
session, and its open steps' anchor names a process that is gone (its pid),
so they are resolved at once. Nothing beats a heartbeat.

## Tests

```bash
pnpm test        # scripted model, no credential: 9 tests, each under Strict and Durable On (run-ahead)
                 # live tests (real model) run too when a credential is in the environment
pnpm typecheck
```

- `src/harness.test.ts` (scripted model): a tool turn recorded as
  `turn, model, tool, model, checkpoint` and folded back into exactly the
  messages the live loop sent; a new World and harness on the same log (in
  the same process) replaying recorded calls instead of making them; a model
  call that fails for good ending the turn; one that fails after a tool step,
  with the call and its result still in the next turn's request; a second
  driver on the same session that loses a payment call to the live driver
  stopping without a model call or a checkpoint (one ledger line); a
  retryable provider error retried inside the step; a crash mid-call (in
  process, the kernel's chaos) rerunning a `safe` tool; a replay with a
  different conversation failing the session (`Fatal`); and the SIGKILL drill
  below.
- `src/live.test.ts` (real model, skipped without a credential): the
  workspace tools for real, and a second turn answered from the fold; the
  SIGKILL drill with the real model.
- The SIGKILL drill (`src/crash.ts`, `src/crash-child.ts`), with two child
  processes: the first starts a session asking for a payment; once the
  payment tool has written its ledger line (and is waiting for confirmation),
  the test SIGKILLs it. A second process, which never drove the session,
  opens the same World with recovery on; its `start()` redelivers the
  session, the open `never` step's anchor names the killed pid, so the kernel
  resolves it as interrupted at once. The test checks the ledger has exactly
  one record (written by the killed process), the tool step is `failed` with
  `interrupted: true`, the step that asked for the tool was not asked again,
  and the model's next request carries the interrupted error as the tool
  result.

## What it does not do

- `generate()` only: the middleware wraps `doGenerate`, not `doStream`, so the
  live stream gets each step's text when the step ends, not token by token.
- Steering: a prompt sent while a turn runs becomes the next turn; it does not
  land mid-turn.
- A turn's agent callbacks (`onStepEnd`, `prepareStep`, `stopWhen`) run again
  when a turn replays, so they must be deterministic in the messages.
- Tools need an `execute` that returns a value (no client-side tools, no
  streaming `AsyncIterable` outputs, no approvals).
- The divergence check is cheap (the message count of each replayed request),
  not a content hash.
- Tool effects are keyed by the tool call id alone (`tool:<toolCallId>`), so
  the provider must give every call its own id. One that reuses ids across
  steps or turns would get the earlier call's recorded result.
