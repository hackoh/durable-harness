import type { Harness } from 'harness-world';

/**
 * A harness with no model and no binary: each prompt is a `model` step
 * (uppercase it) and a `tool.echo` step (report progress, return it). Cheap
 * enough to build a session longer than the CLI's 100-row pages.
 *
 * Every drive walks every prompt from the first: a step already committed
 * replays from the log, and one a contended drive released runs again.
 */
export function echoHarness(): Harness {
  return {
    name: 'cli-check-echo',
    async drive(ctx) {
      const prompts = ctx.state().submissions.filter((s) => s.kind === 'prompt' && !ctx.state().withdrawn.has(s.id));
      for (const [i, submission] of prompts.entries()) {
        const key = `model:${i}`;
        const fresh = !ctx.isMemoized(`tool:${key}`);
        const decision = await ctx.effect(key, { name: 'model', replay: 'safe', input: submission.text, placed: [submission.id] }, async () => ({
          tool: 'echo',
          args: String(submission.text).toUpperCase(),
        }));
        await ctx.effect(`tool:${key}`, { name: 'tool.echo', replay: 'never', input: decision.args }, async (io) => {
          io.progress({ started: decision.args });
          return decision.args;
        });
        if (fresh) ctx.live({ type: 'turn_end', key });
      }
    },
  };
}
