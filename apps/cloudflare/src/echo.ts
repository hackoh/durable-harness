/**
 * A harness with no model, for the kernel checks (test/kernel.cf.test.ts):
 * the echo harness of packages/harness-world/src/kernel.test.ts. Each
 * submission is one `model` effect that "decides" to call a tool, then one
 * tool effect that upper-cases the text.
 *
 * The text steers the tool: `slow:<ms> ...` makes it wait that long (a window
 * to kill the process in), and `safe ...` uses `tool.echo_safe`
 * (`replay: 'safe'`) instead of `tool.echo` (`replay: 'never'`).
 */
import { type DriveContext, EffectFailure, type Harness } from 'harness-world';

export function echoHarness(): Harness {
  return {
    name: 'echo',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      // Resume an unfinished turn first: its model step is memoized.
      const last = ctx.state().effectOrder.findLast((e) => e.name === 'model');
      if (last && !ctx.isMemoized(`tool:${last.key}`)) await runTurn(ctx, last.key, [], String(last.input));
      for (const submission of ctx.pending()) {
        await runTurn(ctx, `model:${turn++}`, [submission.id], submission.text ?? '');
      }
    },
  };
}

async function runTurn(ctx: DriveContext, key: string, placed: string[], text: string) {
  const decision = await ctx.effect(key, { name: 'model', replay: 'safe', input: text, placed }, async () => ({
    tool: text.startsWith('safe') ? 'echo_safe' : 'echo',
    args: text.toUpperCase(),
  }));
  const slow = /^(?:safe )?slow:(\d+)/.exec(text);
  try {
    await ctx.effect(
      `tool:${key}`,
      { name: `tool.${decision.tool}`, replay: decision.tool === 'echo_safe' ? 'safe' : 'never', input: decision.args },
      async (io) => {
        io.progress({ started: decision.args });
        if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
        return decision.args;
      }
    );
  } catch (err) {
    if (!(err instanceof EffectFailure)) throw err;
  }
  ctx.live({ type: 'turn_end', key });
}
