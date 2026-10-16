/**
 * What every number and flag on /compare means, for its tooltips: a one-line
 * definition, why it matters, and pseudocode of how the page computes it.
 * One entry per term, so the summary table, the cards, the per-turn chips,
 * the flags and the legend all explain a metric the same way.
 *
 * Clocks in the pseudocode: `page.*` is when this page saw an event (its own
 * clock, so it includes delivery); `server.*` is a timestamp written by the
 * process that did the work (a mark). `offset` maps server time onto the page
 * clock: the smallest `page.at − server.t` this column has seen.
 */
export interface GlossaryEntry {
  title: string;
  what: string;
  how: string;
}

export const GLOSSARY = {
  overhead: {
    title: 'Overhead to first output',
    what: 'Headline metric 1: everything before the first output that is not the model: the hop to Vercel, the harness and durability before the model call, and delivery back to this page. Compare it with the baseline column (the bracket is the difference); a Native column has some too, the network and streaming every lane pays.',
    how: `overhead = firstOutput − model

firstOutput = page.firstText − page.sent
model       = server.model.first_token − server.model.request`,
  },
  turnOverhead: {
    title: 'Overhead per turn',
    what: "Headline metric 2: what a whole turn costs beyond the model and the tools. Every model call's own duration and every tool's run time are subtracted from the turn, so the model's variance drops out and what is left is the harness, durability and delivery for the turn. Compare it with the baseline column.",
    how: `turnOverhead = turn − Σ model − Σ tool

turn  = page.idle − page.sent
model = server.model.done − server.model.request   // each call in the turn
tool  = server.tool.end − server.tool.start          // each tool
        // (no marks: page.tool_end − page.tool_start)`,
  },
  model: {
    title: 'Model time',
    what: "The model's own time to the output this page first showed, measured by the process that called AI Gateway. Each column makes its own call, so this varies by seconds between columns; it is the provider, not the lane.",
    how: `model = server.model.first_token − server.model.request
// if the output only appeared when the response ended
// (a tool call, fx's text):
model = server.model.done − server.model.request`,
  },
  toolOverhead: {
    title: 'Overhead per tool call',
    what: "What the harness and durability add to a whole model → tool → model hop: from the model finishing the call that asked for the tool to the next output appearing, with the tool's own run time and the next model call's own time taken out. Everything in between counts, whatever the lane: recording the model's response, the tool's intent and result (Strict waits for each), a Workflow step boundary (eve), delivery. Durable should be close to Native for tools that are safe to retry.",
    how: `hopStart  = server.(model.done | previous tool.end) + offset
            // the work that ended right before this tool, on the page clock
hop       = page.nextText − hopStart
overhead  = hop − tool − nextModel
tool      = server.tool.end − server.tool.start   // the tool's own work
nextModel = server.model.first_token − server.model.request  // of the next call
// model.done and tool.end are stamped when the work ended,
// before the harness committed it

// no marks: page.nextText − page.tool_start − nextModel − tool`,
  },
  gap: {
    title: 'Tool gap',
    what: 'Raw time from this page seeing the tool start to seeing the next output: the tool, the harness around it, the next model call and delivery, all together.',
    how: `gap = page.nextText − page.tool_start`,
  },
  toolExec: {
    title: 'Tool',
    what: 'How long the tool itself ran, from its own marks.',
    how: `tool = server.tool.end − server.tool.start`,
  },
  ours: {
    title: 'durable-harness',
    what: "The harness's own time around the tool, in the process driving the turn: from the model finishing to the next model request, less the tool itself. Recording the model's response, the tool's intent and its result, and (Strict, or Durable before a tool that is not safe to retry) waiting for those writes; for eve, the Workflow step boundary.",
    how: `ours = server.model.request(next) − hopStart − tool   // same process
// hopStart: model.done, or the previous tool.end`,
  },
  ttft: {
    title: 'First output',
    what: 'Send to the first visible output (text, or the tool starting on a tool turn), as a user feels it. Includes the model, so it is noisy: one column can win just by getting a faster model response.',
    how: `firstOutput = page.firstText − page.sent`,
  },
  turn: {
    title: 'Turn',
    what: 'Send until the column was done with the turn, the same point for every lane: a durable lane\'s kernel idle mark (everything the turn wrote is durable, and the column stops showing "running"), eve\'s turn.completed, a Native column\'s idle. Durable includes durability catching up.',
    how: `turn = page.done − page.sent
// done: the kernel's idle mark (fx / Pi with a World),
//       turn.completed (eve), the harness's idle (Native)`,
  },
  harnessIdle: {
    title: 'Agent done (before its last writes)',
    what: 'Durable fx / Pi lanes only: send until the harness itself finished, before its last writes were durable. The gap to Turn is what durability still had to do; near 0 for Strict, larger for Durable, which runs ahead.',
    how: `harnessIdle = page.harnessIdle − page.sent
// harnessIdle: the harness's own idle event, before the kernel's idle mark`,
  },
  flagged: {
    title: 'Flagged rounds',
    what: 'Rounds with something that is not the lane\'s steady cost: a cold start, a reconnected or stalled stream, a slow write, a rewind, a second drive, a recovery, or different work than the baseline did. With "Exclude cold starts, stalls and recoveries" on (the default) they are left out of the table, and the caption says how many. "Model tail" and "Slow" are shown and always counted.',
    how: `counted = !warmup && finished && !(exclude && flags.any(excluding))
excluding = coldStart, reconnect, deliveryStall, slowWrite,
            rewind, doubleDrive, recovered, differentWork
deliveryStall = max(page.at − writtenAt − offset[pid]) > 1000`,
  },
  vsBase: {
    title: 'Δ vs the baseline column',
    what: 'Each round went to every column at the same instant, so the difference is taken round by round: the median of the per-round differences against the baseline, with a 90% bootstrap interval over rounds. "clear" means the interval excludes 0; "within noise" means it does not. Under 10 rounds there is no interval, under 5 no Δ worth reading.',
    how: `d[r] = value[col][r] − value[base][r]   (rounds both counted)
Δ = median(d)
[lo, hi] = 5th / 95th percentile of median(d*)
           over 1000 resamples d* of the rounds (with replacement)
clear = !(lo <= 0 <= hi)`,
  },
  delta: {
    title: 'Δ vs the baseline (this turn)',
    what: "This turn's value minus the baseline column's value for the same turn. One sample: read it against the noise floor, not on its own.",
    how: `Δ  = value[col][turn] − value[base][turn]
Δ% = Δ / value[base][turn]`,
  },
  noise: {
    title: 'Model time to first token',
    what: "The model's own time to its first token, pooled over the counted rounds of every column that reports it. It swings by seconds from round to round, which is why the table compares overhead (the model taken out) round by round.",
    how: `p50 = median(rounds.map(r => r.model))   (counted rounds)
model = server.model.first_token − server.model.request`,
  },
  ready: {
    title: 'Setup time',
    what: "How long the column took to set up before it could send: creating the session (a workflow run) for durable columns. Not part of any turn's numbers; pre-created spare sessions make it near 0.",
    how: `ready = page.sessionReady − page.columnOpened`,
  },
  notReady: {
    title: 'Session starting (not counted)',
    what: "eve only: the prompt reached a prewarmed session before its inbox was up, so eve answered 'not ready' and the page sent it again. That is the session starting, which the other columns pay while they open (their create returns once the run and its hook exist), so the turn's clock starts at the attempt eve accepted and this wait is in none of its numbers.",
    how: `notReady = page.acceptedAttemptSent − page.firstAttemptSent
// sent = page.acceptedAttemptSent for every number of this turn`,
  },
  // Flags.
  newInstance: {
    title: 'Flag: Cold start',
    what: "A request of this turn was the first of its kind on a freshly started Function instance, which spends a while loading the route's code. Not the lane's steady cost.",
    how: `flag if any mark of the turn has fresh: true
// fresh = the process's first request on that route`,
  },
  reconnect: {
    title: 'Flag: Stream reconnected',
    what: "The live stream to this page was re-opened during the turn: the World ends a live read after 2 minutes, missed a wakeup, or the browser reconnected. Events may arrive in a burst afterwards.",
    how: `flag if the turn saw { type: 'stream', name: 'resumed' }
         or a browser { type: 'reconnect' } event`,
  },
  deliveryStall: {
    title: 'Flag: Delivery stall',
    what: 'An event reached this page over 1 s later than the fastest delivery this column has seen: the server had it, the page did not.',
    how: `lag   = page.at − (server.t + offset)
flag if max(lag over the turn) > 1000 ms`,
  },
  slowWrite: {
    title: 'Flag: Slow write',
    what: 'A live-stream write took over 1 s; the writer let later writes go past it and said so in a stream.put_slow mark.',
    how: `flag if the turn saw a stream.put_slow mark (ms = its duration)`,
  },
  rewind: {
    title: 'Flag: Rewind',
    what: 'A Durable write was rejected (another writer, a fence) and the drive restarted from the durable log, discarding what it had run ahead with.',
    how: `flag if the turn saw a rewind / restart mark`,
  },
  doubleDrive: {
    title: 'Flag: Double drive',
    what: 'More than one drive placed this turn (for example a companion delivery racing the main drive).',
    how: `flag if distinct(drive ids placing the turn) > 1`,
  },
  modelTail: {
    title: 'Flag: Model tail',
    what: 'A model call took over 2.5 s to its first token. The provider was slow, not the lane. Shown, and still counted.',
    how: `flag if max(model.first_token − model.request) > 2500 ms`,
  },
  recovered: {
    title: 'Flag: Recovered',
    what: 'The turn was recovered: a drive took it over (a crash drill, a Function that ended), so its time includes a recovery, not the lane\'s steady cost.',
    how: `flag if the turn saw a recover* or release mark,
     or a drive.start more than 5 s after the send,
     or a different drive finishing it than started it`,
  },
  differentWork: {
    title: 'Flag: Different work',
    what: 'This column made a different number of tool calls (or model calls) than the baseline column in the same round, so its time is not the same work\'s time.',
    how: `flag if toolCalls[col][r] != toolCalls[base][r]
     or modelCalls[col][r] != modelCalls[base][r]   (when both mark them)`,
  },
  firstOutputTrails: {
    title: 'Flag: First output trails first token',
    what: "The model's first token was out well before this page saw any output: the lane's text does not stream (it shows once its write is durable), so its overhead includes that wait. Shown, and still counted.",
    how: `trail = page.firstOutput − (server.model.first_token + offset)
flag if trail > 1000 ms`,
  },
  slow: {
    title: 'Flag: Slow',
    what: "Overhead over 500 ms with no other flag to explain it: time our code (or durability) added. Shown, and still counted.",
    how: `flag if overhead > 500 ms && !flags.any()`,
  },
  // The round bar: three segments, one scale per round across columns.
  segModel: {
    title: 'Bar: model',
    what: "Every model call's own duration in the turn, request to done.",
    how: `model = Σ (server.model.done − server.model.request)`,
  },
  segTool: {
    title: 'Bar: tools',
    what: "Every tool's own run time in the turn.",
    how: `tools = Σ (server.tool.end − server.tool.start)   (else as the page saw it)`,
  },
  segHarness: {
    title: 'Bar: harness and durability',
    what: 'The rest of the turn: the harness, its durability and delivery to this page. The overhead per turn.',
    how: `harness = turn − model − tools`,
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryTerm = keyof typeof GLOSSARY;
