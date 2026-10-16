/**
 * Hands for any harness, with files that live in the event log.
 *
 * The workspace is an in-memory filesystem (just-bash) per drive, kept equal
 * to the session's `hw.workspace` document: a manifest keyed by path, small
 * files inline, larger ones in the session's blob stream. Each tool call's
 * change to it rides on the call's own outcome (`io.docs`), so a crash
 * mid-call leaves nothing behind and a retry sees what the first attempt saw.
 * Nothing to provision, and it works on every World, including one in a
 * browser tab. The trade-off is that the files live with the session: this
 * suits source-sized workspaces, not datasets (give an agent a Sandbox for
 * real work). The same tools also run on an in-memory workspace that lasts
 * one turn (`workspace: { kind: 'virtual', durable: false }`), and every
 * harness's own workspace tools are written on the same runtime
 * (`./runtime`). Either way just-bash runs with its hardened limits, in an
 * isolated worker thread with an empty environment where one can start
 * (isolation.ts): nothing a model runs reaches the host's disk, processes or
 * environment.
 *
 * The legacy workspace (files in `fs` steps) stays for hybrid sessions
 * (legacy.ts).
 */
export * from './tools.ts';
export { legacyWorkspaceTools, Workspace } from './legacy.ts';
/** Re-exported so packages building on the workspace share one just-bash. */
export { Bash, InMemoryFs } from 'just-bash';
