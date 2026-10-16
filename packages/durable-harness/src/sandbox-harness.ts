/**
 * Which harnesses give each of their sessions a Vercel Sandbox VM and Drive
 * (docs/workspaces.md §5.7 "Abuse"): `chatRoute({ authorize: 'public' })`
 * for such an agent needs `allowPublicSandbox: true`, and a finite
 * per-session spend. Its own module, so the root entry (agent.ts) loads
 * nothing of the sandbox tier for it.
 *
 * Checked twice:
 *
 * - **When the route is built**, from the harness's mark (an own enumerable
 *   property, so `{ ...harness }` keeps it): `claudeCode()`, `codex()`,
 *   `opencode({ workspace: sandbox() })` and `pi()` given
 *   `createCodingTools(sandbox())` (whose tools carry the mark too) throw a
 *   `TypeError` there. pi-durable's `chatRoute` has no harness to mark (the
 *   app opens its own Pi `Harness`), so it has only the next check.
 * - **When a session acquires its VM**, from what the route recorded in the
 *   session's config (`publicSandboxConfig`, on its `run_created`): every
 *   acquire of a `sandbox()` workspace (environments.ts) is handed the
 *   session's recorded config by its runtime (`AcquireMachineRequest.config`:
 *   the kernel's `attachInDrive` for Claude Code, Codex, OpenCode and Pi,
 *   pi-world's sandbox attach for pi-durable) and refuses such a session
 *   (`publicSandboxUnavailable`) before the session factory loads, so no VM
 *   boots: a harness rebuilt without its mark builds a public route, but
 *   each of that route's sessions fails its turn. A request without the key
 *   is refused too (a runtime that forgot it fails closed).
 *
 * fx's `sandbox()` (`fxTools(sandbox())`) has neither check: its tools run
 * under libfx's own durable agent, whose chat route is libfx's, so there is
 * no harness of this package's to mark and no route of its to record a
 * session's audience; its attach passes `config: undefined`, on purpose. An
 * app that serves an fx agent with sandbox tools publicly authorizes that
 * route itself, and caps each session with `sandbox({ budget })`.
 */
import { Unavailable } from 'harness-world';

/** What a public route needs to know of a sandbox harness: the per-session caps its `sandbox()` workspace set. */
export interface SandboxHarnessMark {
  sessionUsd: number;
  vmSeconds: number;
}

const MARK = Symbol.for('durable-harness.sandbox-harness');
const KEY = Symbol.for('durable-harness//sandbox-harnesses');
/** The marks of harnesses that can't carry the property (frozen); on `globalThis`, so every bundled copy of this package agrees. */
const sealed: WeakMap<object, SandboxHarnessMark> = ((globalThis as Record<symbol, WeakMap<object, SandboxHarnessMark> | undefined>)[KEY] ??= new WeakMap());

/**
 * Mark a harness whose sessions each boot a Vercel Sandbox VM and create a
 * Drive (`claudeCode()`, `codex()`, or any harness given `sandbox()`), with
 * the budget of its `sandbox()` workspace: a public chat route for its
 * agent then needs `allowPublicSandbox: true` and a finite
 * `sandbox({ budget: { sessionUsd } })` (§5.7 "Abuse"). A wrapper that
 * builds its harness from a `sandbox()` workspace calls it. Returns the
 * harness.
 */
export function markSandboxHarness<H extends object>(harness: H, budget: { sessionUsd: number; vmSeconds: number }): H {
  const mark: SandboxHarnessMark = Object.freeze({ sessionUsd: budget.sessionUsd, vmSeconds: budget.vmSeconds });
  if (Object.isExtensible(harness)) Object.defineProperty(harness, MARK, { value: mark, enumerable: true });
  else sealed.set(harness, mark);
  return harness;
}

/** The mark of a harness whose sessions each get a Vercel Sandbox (`markSandboxHarness`), or undefined. */
export function sandboxHarnessMark(harness: object): SandboxHarnessMark | undefined {
  const own = (harness as Record<symbol, unknown>)[MARK];
  return isMark(own) ? own : sealed.get(harness);
}

/**
 * Mark the tools of a `sandbox()` workspace (`createCodingTools(sandbox())`)
 * the way `markSandboxHarness` marks a harness: an agent given any of them
 * boots a VM per session, so its factory marks its harness from them
 * (`sandboxToolsMark`). A spread of a tool keeps the mark. Returns the tools.
 */
export function markSandboxTools<T extends object>(tools: T[], budget: { sessionUsd: number; vmSeconds: number }): T[] {
  for (const tool of tools) markSandboxHarness(tool, budget);
  return tools;
}

/** The mark a harness built with `tools` carries: the loosest of the marks its tools carry (`markSandboxTools`), or undefined when none does. */
export function sandboxToolsMark(tools: readonly unknown[] | undefined): SandboxHarnessMark | undefined {
  let mark: SandboxHarnessMark | undefined;
  for (const tool of tools ?? []) {
    const m = typeof tool === 'object' && tool !== null ? sandboxHarnessMark(tool) : undefined;
    if (m) mark = { sessionUsd: Math.max(m.sessionUsd, mark?.sessionUsd ?? 0), vmSeconds: Math.max(m.vmSeconds, mark?.vmSeconds ?? 0) };
  }
  return mark;
}

const isMark = (v: unknown): v is SandboxHarnessMark => typeof v === 'object' && v !== null && typeof (v as SandboxHarnessMark).sessionUsd === 'number' && typeof (v as SandboxHarnessMark).vmSeconds === 'number';

/** What `chatRoute({ authorize: 'public' })` records in each session's config, for `publicSandboxRefusal`. */
export function publicSandboxConfig(allowPublicSandbox: boolean | undefined): { route: 'public'; allowPublicSandbox?: true } {
  return { route: 'public', ...(allowPublicSandbox === true ? { allowPublicSandbox: true as const } : {}) };
}

/**
 * Why a session may not attach a Vercel Sandbox with this budget, or
 * undefined: a session a public route started (`publicSandboxConfig`)
 * needs the route's `allowPublicSandbox: true` and a finite `sessionUsd`.
 * Any other session (its config says nothing of a route) may.
 */
export function publicSandboxRefusal(config: unknown, budget: { sessionUsd: number }): string | undefined {
  return refusalOf(config, budget)?.message;
}

/**
 * `publicSandboxRefusal` as the error a session's acquire throws:
 * `Unavailable`, so the turn fails at once (no redelivery repeats it) and
 * the session stays, on every runtime (each treats it as a stop, never as a
 * "not run, try again"). Its message and hint reach whoever is on the
 * route, in the turn's error event: they name the developer's fix only.
 */
export function publicSandboxUnavailable(config: unknown, budget: { sessionUsd: number }): Unavailable | undefined {
  const refusal = refusalOf(config, budget);
  return refusal && new Unavailable(refusal.message, { hint: refusal.hint });
}

function refusalOf(config: unknown, budget: { sessionUsd: number }): { message: string; hint: string } | undefined {
  const c = typeof config === 'object' && config !== null ? (config as { route?: unknown; allowPublicSandbox?: unknown }) : {};
  if (c.route !== 'public') return undefined;
  if (c.allowPublicSandbox !== true) {
    return {
      message: "durable-harness: this session was started by chatRoute({ authorize: 'public' }) without allowPublicSandbox: true, so it can't boot a Vercel Sandbox VM",
      hint: "Pass your own authorize to that chatRoute, or allowPublicSandbox: true to serve it publicly anyway, with a finite sandbox({ budget: { sessionUsd } }). Build the route from the harness the factory returned, so it is checked when the route is made.",
    };
  }
  if (!Number.isFinite(budget.sessionUsd)) {
    return {
      message: "durable-harness: this session was started by a public chat route, and its sandbox() has no finite budget.sessionUsd: anyone can open sessions on a public route, so each one's model spend must be capped",
      hint: 'Give the workspace a finite sandbox({ budget: { sessionUsd } }).',
    };
  }
  return undefined;
}
