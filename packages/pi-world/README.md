# pi-world

Pi 1.0's durable harness (`Harness` from `@earendil-works/pi-durable`) on a
Workflow World. Nothing in Pi is wrapped: this package is a Pi `Storage` and a
queue route. A private workspace package: apps install
[`durable-harness`](../durable-harness), which bundles it as
`durable-harness/pi-durable`.

```ts
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { worldStorage } from 'pi-world'

const openAgent = async (sessionId: string) => Harness.open(await worldStorage(world, sessionId), { models, registry }, ctx)

const sessionId = await worldStorage.create(world) // or any id: worldStorage creates the run on first open
const harness = await openAgent(sessionId)
const root = await harness.root(ctx, { agent: { model: { provider: 'openai', modelId: 'gpt-6-sol' } } })
const s = await root.submit({ type: 'input', content: 'Explain closures in two sentences.', requestId }, ctx)
await s.wait(ctx)
await harness.close(ctx)

// The queue route (flow route) that finishes work a dead process left behind:
export const POST = worldStorage.wakeHandler(world, openAgent) // opens, harness.resume(), waits for idle, closes
```

## How it works

Pi 1.0 already does the durable part. Every model turn and tool call is a
task that commits a checkpoint at each step, a tool's intent is committed
before `execute()`, and reopening a storage continues unfinished tasks. Tools
declared `replay: 'safe'` rerun after a crash; any other tool gives the model
an `interrupted` error result. All Pi needs is a `Storage`.

- **The session is a workflow run.** `worldStorage(world, sessionId)` opens
  the run (creating it, with a journal hook, when the World has never seen
  the id). The journal hook's id is `hook_` and the run's ULID
  (`journalHookId`); readers find it by its token, `pi:<run>:journal`.
- **Each Pi commit is one World event**: a `hook_received` on the journal
  hook carrying the commit's writes and Pi sequence as JSON text, wrapped as
  one string in the kernel's `devl` payload codec (`encodeJournalEntry`), so
  the payload is bytes, as world-vercel requires, in the wire shape the
  Workflow runtime's own tools decode. Logs written before 2026-10-07 (journal hook `hook_journal_<ULID>`,
  bare JSON text payloads, accepted by world-local, world-postgres and
  world-browser but refused by world-vercel) still open, read and continue:
  `decodeJournalPayload` reads both shapes. On open the
  journal is replayed into Pi's own `MemoryStorage`, which serves every read,
  so sequences and IDs come out the same in every process. `mintId()` is
  `MemoryStorage`'s; replay moves it past every ID the log uses, so a
  reopened storage never mints one already used.
- **Durable before visible.** A commit is validated by `MemoryStorage`
  (`prepareCommit`), written to the log, and only then applied. Every commit
  is awaited (Durable Strict).
- **One owner, enforced.** Each write tells the World how many events this
  process has seen (bump and report). If another process committed in
  between, the commit rejects with `StorageFenced` and nothing of it is
  applied, here or by any later reader: a journal entry counts only when it
  was written on top of the newest entry that counted. Pi's Session poisons
  itself on the error, so the fenced process stops; reopen to continue.
- **The queue is the backstop; nothing beats.** Every commit records the
  *anchor* it was written under (harness-world's `Anchor`): the queue message
  of the delivery holding the session (`worldStorage(world, id, { anchor })`,
  and `storage.setAnchor()` for a delivery that shares a storage already open
  in its process), or a deadline for a drive that holds no message. A storage
  that closes with tasks still live writes one close entry (never a commit,
  so it fences nobody). `wakeHandler` runs each delivery under its own
  message: no unfinished task is `idle`; otherwise it judges the newest
  commit's anchor once, with no clock and no probe. A writer that closed, the
  delivery's own message (a redelivery: whoever held it lost the queue's
  lease), a continuation's grant, a passed deadline or the World's own proof
  (a dead pid on world-local, a free Web Lock, any other message on
  Cloudflare's one-delivery-per-run object) means open it with your
  `openAgent(id, anchor)`, `resume()`, wait until no task it can run is left
  (`untilSettled`: background work too, which Pi's `waitForIdle()` leaves
  out; a task whose definition is not installed here, or one waiting only on
  such a task, is not waited for), `close()`. Anything
  else is `covered`: ack, since its holder takes the work if it lives and its
  message comes back if it died. A wake that stops with runnable work left
  (its drive budget, `maxDriveMs`) sends a continuation that takes its anchor
  over. A delivery's commits queue nothing. `worldStorage.wake(world, id)`
  queues a wake now.
- **A writer with no queue message is its own backstop** (`backstop`, what
  `durable-harness/pi-durable`'s `openWorldStorage` and an anchorless
  `durability.storage(id)` open). Before a commit that may leave work
  unfinished, the storage writes it under a deadline anchor of its own
  (`anchors.direct(now + recoverAfterMs)`), queued behind by a wake delayed
  past that deadline where the queue outlives the process (Vercel), and held
  in this process (`holdAnchor`) so a wake here acks while it lives. Pi's own
  commits renew it once less than half the window is left; nothing is written
  for liveness. A refused commit, `abandon()` or close lets go of the hold;
  closing with work left writes the close entry and queues a continuation.
  While a delivery shares the open storage (`setAnchor`), its message is the
  backstop instead. `keepAlive` is handed one promise per period with work
  unfinished (a request's `waitUntil`), settled once no task is live, or at
  the storage's own deadline if no commit renewed it by then.

## Also here

- `pi-world/reader`: `JournalReader`, a read-only follower of a session's
  journal (incremental `refresh()`, then `snapshot()`: root entries, `pi.live`,
  tasks with the processes that ran them, one row per commit). It never
  writes, so a viewer never fences the owner. The demo's
  transcript, inspector and live stream are built on it.
- `pi-world/agent`: `piDurableAgent()`, the demo's agent (AI Gateway model
  through pi-ai 1.0, a fresh credential per request, and workspace tools on
  just-bash whose results record the workspace, so a reopened session
  rebuilds it and a crashed `bash` reruns against its starting files).
- `pi-world/workspace`, `pi-world/env`, `pi-world/files`: the virtual
  workspace behind durable-harness's `virtualEnv()`. `MachineEnv` is
  pi-durable's `ExecutionEnv` over harness-world-hands' `WorkspaceMachine`
  (just-bash in a worker leased to the session, or a Sandbox's `/workspace`);
  it passes pi-durable's own env conformance suite. pi-durable builds an
  environment for each tool call, and its `EnvTarget` names the
  conversation, not the call (and the context a storage's commit gets is
  derived from the call's, its abort signal replaced), so the call is bound
  by the tool: `CodingTools` are pi-durable's own, each wrapped (`bindTool`)
  to run on a checkpoint of the committed files and put what it changed in
  its result's `details` (`hw.workspace`: the `hw.workspace` manifest's
  entries, `null` for a removed file, files over 4 KB in the session's blob
  stream), which lands in the result's own commit. `WorldStorage.files` is the
  fold of those changes, rebuilt when a storage opens. A Harness's storage is
  found from its `DocumentReader` (`STORAGE_PROBE`: a read of a document
  nobody writes reaches the storage with the reader's context).
- `pi-world/sandbox`: the session's Vercel Sandbox behind durable-harness's
  `sandboxEnv()` (`sandboxEnvBuilder(acquire)`): one attach per open storage,
  at the first call that reaches the workspace, through the sandbox tier's
  `acquireMachine` with the storage's own fence (`writerFence`: the in-band
  count its first accepted write was checked against, the same for the rest
  of the storage, higher for every later owner, no longer `fenced` once a
  write had an unknown outcome, the World refused one or the storage let go;
  `claim()` makes sure there is one), its `signal` (aborted when it closes,
  is abandoned or fenced) and the session's sandbox record in its journal
  (`writeSandbox`: an in-band entry with `after: -1`, never a commit, replayed
  as `WorldStorage.sandbox`). A failed or contended attach answers the call
  `NOT_RUN`; with `CodingTools`, the files-lost note is shown once and its
  result's `details` (`hw.sandbox`, `told`) acknowledge it in the record.
- Each journal entry carries its writer (`by`, one id per open storage) and
  its anchor, so a reader tells a rerun in another process from the first run.
- `abandon()` simulates a crash: every later commit hangs (nothing waiting on
  it moves on) and no close entry is written.

## Tests

`pnpm test`, no network or API key:
- Pi's storage conformance suite (`registerStorageConformance`) against
  `worldStorage` on world-local, twice: as is, and with every case's final
  state compared against a fresh replay of the log (46 cases).
- A real `Harness` run with Pi's faux provider answering an input, read back
  by a fresh process; a retried `requestId` finds the same submission.
- A crash: process A dies inside a `replay: 'safe'` tool and a non-safe tool;
  process B's `wakeHandler` resumes and completes the run. The safe tool
  reruns, the other comes back `interrupted`.
- Fencing: two processes commit; the second is rejected with `StorageFenced`,
  its event is ignored on replay, and the winner keeps committing. A
  storage's token (`writerFence`) is the same for the rest of it and higher
  for the next owner; refused, it is no longer fenced and its signal aborts;
  the sandbox record is replayed and never counts as a commit
  (`src/fence.test.ts`).
- The backstop (`src/backstop.test.ts`): the wake is queued before the first
  commit that may leave work and never for one that cannot; renewal at half
  the window on Pi's own commits, an old wake acks; close with work left
  queues one continuation; a refused commit lets go at once; on world-local
  nothing is queued and a wake of the same process acks while it holds the
  anchor; a delivery sharing the storage suspends renewal; a wake waits for
  background work instead of closing on it at `waitForIdle()`.
- Wakes: a storage without a backstop queues nothing on commits; a wake of
  an idle session never opens it; a wake acks (`covered`) while the holder's delivery is not proven gone, and
  takes the session once it is (its drive no longer running in this process);
  a storage that closed with work live is taken at once; a wake out of drive
  budget sends a continuation; and on harness-world's leased test queue a
  wake that dies mid-tool is redelivered and finishes under its own message.
- world-vercel's rules (`src/vercel-rules.test.ts`): a turn with a tool on
  world-local wrapped to refuse what world-vercel 5.1.0 refuses (run ids that
  are not `wrun_<ULID>`, correlation ids that are not
  `step|hook|wait|attr_<ULID>`, event payloads that are not bytes); and a
  session written in the old format (`hook_journal_<ULID>`, JSON text
  payloads) that opens, reads, continues with byte payloads on the same hook,
  and replays whole.

## Limits

- **Durable Strict only.** Every commit is a World round trip on the critical
  path (every task step, tool intent and message is a commit). A Durable On
  mode, where a remote storage runs ahead and only some commits must land
  before Pi continues, needs Pi to mark which commits those are (non-safe tool
  intents, submission admission).
- **Model retry backoff lives in the process.** A generation waiting out a
  retry delay is a live task; a wake that finds it waits through the delay
  (up to `maxDriveMs`, default 10 minutes, then closes and looks again).
- **Takeover is the queue's.** A delivery that dies is redelivered by the
  World's queue (world-vercel after its lease, Cloudflare at once, world-local
  at the next start), and that redelivery takes the session. A holder taken
  over while it lived after all (a frozen process past its lease) has its next
  commit fenced, so the work is never applied twice, but a non-safe tool it
  was running may have run.
- **Reopening replays the whole journal.** Fine for sessions of thousands of
  commits; long-lived sessions want snapshots (not built).
- Dashboards show journal commits (`hook_received`), not model and tool steps.
