import { virtual } from 'durable-harness';
import { fxTools } from 'durable-harness/fx';
import { createFxAgent } from 'libfx';
import { tools } from './tools';

/**
 * The agent: create it once per server and open a session per conversation.
 * libfx picks where sessions live: on Vercel, Vercel's World (the store and
 * queue behind Workflow), with each turn run by a queue delivery to the wake
 * route withDurableHarness generates (next.config.ts), which mounts this
 * export's wakeHandler(); elsewhere, files in $FX_SESSIONS_DIR or
 * $TMPDIR/libfx/sessions.
 * Every process that creates this agent can continue any of its sessions.
 *
 * `fxTools(virtual())` adds libfx's kernel tools (read_file, glob_files,
 * grep_files, edit_file, write_file, shell) on a virtual workspace: never
 * this server's own files, processes or environment. Each call's file
 * changes are kept with the session, so they survive a crash too.
 */
export const agent = createFxAgent({
  model: process.env.FX_MODEL ?? 'anthropic/claude-opus-5.5-fast',
  instructions: 'You are a helpful agent. Keep answers short. Your files are in /workspace.',
  tools: [...fxTools(virtual()), ...tools],
});
