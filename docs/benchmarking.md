# Benchmarking durability with the demo

The demo's `/compare` page runs the same prompt against up to four columns,
round by round, and reports what durability costs a harness against the same
harness without it. This guide is how to get numbers you can trust from it.

## 1. Use a deployment with crash drills off

A crash drill kills the process driving a turn, and on a shared deployment
someone else's drill can stall one of your rounds. For numbers you publish,
benchmark a deployment where drills are off: `HARNESS_CHAOS=0` in its
environment.

On Vercel, scope the variable to a branch so the rest of the project keeps
its drills. The branch has to exist before a variable can be scoped to it:

```bash
git push origin main:bench                     # the branch, at main
cd apps/demo
vercel env add HARNESS_CHAOS preview bench     # value: 0
```

Then build the branch with the variable. The first push built before the
variable existed, or did not build at all if it brought no commit Vercel had
not built yet, so create a deployment of `bench` once: from the project's
Deployments tab, or with the REST API (`POST /v13/deployments` with a
`gitSource` whose `ref` is `bench`). After that, every push to `bench` builds
a preview on the same project, World and region as production. On it, the
Crash control is disabled ("Crashes are off on this
server (HARNESS_CHAOS=0)"), `/api/bench/info` reports `"chaos": false`, and
`/compare` shows no crash-drill banner. Locally, start the server with
`HARNESS_CHAOS=0`.

On a deployment with drills on, run none while you measure, and ask others
not to. `/compare` says "Crash drills are on for this deployment"; rounds
that a stall, a cold start or a recovery touched are flagged and left out
(Details › "Exclude cold starts, stalls and recoveries", on by default).

## 2. One ladder per harness

Pick the harness and the columns: Native, Durable and Strict, plus
Wrapped (no World) to split the adapter's cost from the World's. Pi and fx
have a Native column; Claude Code, Codex, OpenCode and the AI SDK start at
Durable ("No native baseline yet"). From a session on the main page,
Measure on Compare opens `/compare` set up for that harness.

To compare two harnesses, run one ladder each, or put up to four columns in
one run (Edit Columns) and read each ladder with Use as Baseline on that
harness's Native column (the URL keeps the baseline as `base=`).

## 3. Pick the prompt for the question

| Prompt | Measures |
| --- | --- |
| Chat | the per-turn cost without tools |
| One File Write (default) | one tool call |
| One Command | one shell command |
| Three Tools | the cost per tool call |
| Unsafe Payment | the tool that must never run twice (Durable waits for its writes before it) |

## 4. Rounds

Run enough rounds for the interval to mean something: 10 at the least, 20
for a p90. Keep a warm-up of a round or two (left out of the results), and
start fresh sessions every few rounds so a long session's history does not
grow into the numbers.

## 5. Read the table

The baseline column shows its own overhead: the time beyond the model's own
time. Every other column shows its difference from the baseline as the
median of per-round differences, with a 90% interval, and says whether it is
clear or within noise. Check "Rounds counted" (n of N) before you quote a
number, and in Details "Tools called": columns that called different tools
did different work.

## 6. Keep the results

Copy Results gives a Markdown table with one sentence per column, ready for a
document; Download JSON keeps every round. Results survive a reload for the
same set of columns. To drive a run from a script, `window.__compare` runs
rounds (`run({ prompt, rounds })`) and returns them (`results()`,
`markdown()`).

## 7. Sanity checks

Compare against your own earlier runs of the same setup, not against a single
round. A run far from your earlier ones on the same commit usually means
noise on the deployment (a drill, a cold region, another load) before it
means a regression: run it again on the chaos-free deployment.

On a deployment with drills on, a quick smoke test per harness on the main
page: Crash a Command, Crash a Payment (look for "Charged once"), and a crash
armed for "The next model stream" (the Crash button's menu). Run one drill at
a time.
