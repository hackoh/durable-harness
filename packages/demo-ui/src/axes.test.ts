import { describe, expect, it } from 'vitest';
import {
  defaultHandsFor,
  drillScope,
  filesOf,
  fitCrash,
  handsChoices,
  handsReason,
  kindsAt,
  kindsFor,
  legacyHands,
  parseHands,
  parseMode,
  PI_DURABLE_HANDS,
  pickHands,
  readAxes,
  scenariosFor,
  sessionHands,
  triggersFor,
} from './axes.ts';
import { harnessDisabledReason } from './ControlBar.tsx';
import { PI_DURABLE_NO_MACHINE, TAB_NO_VM, vmOnlyHands } from './copy.ts';
import { BUILTIN_HARNESSES, type Hands, type HarnessOption } from './view.ts';

const pi = BUILTIN_HARNESSES.find((h) => h.value === 'pi')!;
const fx = BUILTIN_HARNESSES.find((h) => h.value === 'fx')!;
/** Claude Code as the demo server describes it (apps/demo lib/harnesses): Sandbox, or None, in a Function's brain only. */
const claudeCode: HarnessOption = {
  value: 'claude-code',
  label: 'Claude Code',
  title: '',
  modes: ['server'],
  hands: ['none', 'sandbox'],
  defaultHands: 'sandbox',
  handsDisabled: { virtual: vmOnlyHands('Claude Code'), ephemeral: vmOnlyHands('Claude Code'), machine: vmOnlyHands('Claude Code') },
  process: true,
};
const opencode: HarnessOption = {
  value: 'opencode',
  label: 'OpenCode',
  title: '',
  modes: ['server'],
  hands: ['none', 'virtual', 'ephemeral', 'machine', 'sandbox'],
  handsDisabled: { sandbox: 'Coming with opencode({ workspace: sandbox() })' },
  process: true,
};
const piDurable: HarnessOption = { value: 'pi-durable', label: 'Pi (pi-durable)', title: '', modes: ['server'], ...PI_DURABLE_HANDS };
/** A harness that says nothing of its hands (AI SDK, the reference CLI, fx (libfx durable)). */
const plain: HarnessOption = { value: 'ai-sdk', label: 'AI SDK', title: '', modes: ['server'], process: true };

const allowed = (option: HarnessOption, brain: 'server' | 'tab' | 'hybrid', ctx = {}) =>
  handsChoices(option, brain, ctx)
    .filter((c) => !c.reason)
    .map((c) => c.hands);

describe('the URL: ?mode= is the brain, ?hands= the hands', () => {
  it('reads the three brains, and the retired brain-in-VM mode as Server with Sandbox hands', () => {
    expect(parseMode('server')).toEqual({ brain: 'server' });
    expect(parseMode('tab')).toEqual({ brain: 'tab' });
    expect(parseMode('hybrid')).toEqual({ brain: 'hybrid' });
    expect(parseMode('sandbox')).toEqual({ brain: 'server', hands: 'sandbox' });
    expect(parseMode('vm')).toEqual({});
    expect(parseMode(null)).toEqual({});
  });

  it('reads the five hands, and nothing else', () => {
    for (const h of ['none', 'virtual', 'ephemeral', 'machine', 'sandbox']) expect(parseHands(h)).toBe(h);
    expect(parseHands('Virtual')).toBeUndefined();
    expect(parseHands('host')).toBeUndefined();
    expect(parseHands(undefined)).toBeUndefined();
  });

  it('takes ?hands= over what ?mode=sandbox implies', () => {
    expect(readAxes('?mode=hybrid&hands=machine')).toEqual({ brain: 'hybrid', hands: 'machine' });
    expect(readAxes('?mode=sandbox')).toEqual({ brain: 'server', hands: 'sandbox' });
    expect(readAxes('?mode=sandbox&hands=none')).toEqual({ brain: 'server', hands: 'none' });
    expect(readAxes('?hands=ephemeral')).toEqual({ hands: 'ephemeral' });
    expect(readAxes('?mode=nope&hands=nope')).toEqual({});
  });
});

describe("each harness's brains and hands (docs/workspaces.md §8)", () => {
  it('Claude Code and Codex: a Server brain, and Sandbox or None hands only', () => {
    expect(allowed(claudeCode, 'server')).toEqual(['none', 'sandbox']);
    expect(defaultHandsFor(claudeCode, 'server')).toBe('sandbox');
    expect(handsReason(claudeCode, 'server', 'virtual')).toBe(vmOnlyHands('Claude Code'));
    expect(harnessDisabledReason(claudeCode, 'tab')).toMatch(/runs in Server only/);
    expect(harnessDisabledReason(claudeCode, 'hybrid')).toMatch(/runs in Server only/);
    // Asked for hands it doesn't take (a link with ?hands=virtual): its default.
    expect(pickHands(claudeCode, 'server', 'virtual')).toBe('sandbox');
    expect(pickHands(claudeCode, 'server', 'none')).toBe('none');
  });

  it('OpenCode: every hands, Sandbox shown but off until its sandbox() lands', () => {
    expect(allowed(opencode, 'server')).toEqual(['none', 'virtual', 'ephemeral', 'machine']);
    expect(handsReason(opencode, 'server', 'sandbox')).toMatch(/^Coming with/);
    expect(defaultHandsFor(opencode, 'server')).toBe('virtual');
  });

  it('pi-durable: every hands but Virtual + machine, and Sandbox later', () => {
    expect(allowed(piDurable, 'server')).toEqual(['none', 'virtual', 'ephemeral']);
    expect(handsReason(piDurable, 'server', 'machine')).toBe(PI_DURABLE_NO_MACHINE);
    expect(handsReason(piDurable, 'server', 'sandbox')).toMatch(/^Coming with sandboxEnv\(\)/);
  });

  it('Pi and fx: every brain; a tab brain has no VM to reach; Hybrid defaults to a machine', () => {
    for (const option of [pi, fx]) {
      expect(option.modes).toEqual(['server', 'tab', 'hybrid']);
      expect(allowed(option, 'server')).toEqual(['none', 'virtual', 'ephemeral', 'machine']);
      expect(allowed(option, 'hybrid')).toEqual(['none', 'virtual', 'ephemeral', 'machine']);
      expect(allowed(option, 'tab')).toEqual(['none', 'virtual', 'ephemeral']);
      expect(handsReason(option, 'tab', 'machine')).toBe(TAB_NO_VM);
      expect(handsReason(option, 'server', 'sandbox')).toMatch(/^Coming with (createCodingTools|fxTools)\(sandbox\(\)\)/);
      expect(defaultHandsFor(option, 'server')).toBe('virtual');
      expect(defaultHandsFor(option, 'tab')).toBe('virtual');
      expect(defaultHandsFor(option, 'hybrid')).toBe('machine');
      // A tab's brain asked for a machine (the hands this browser last picked in Hybrid): its default.
      expect(pickHands(option, 'tab', 'machine')).toBe('virtual');
    }
  });

  it('a harness that names no hands takes Virtual only', () => {
    expect(allowed(plain, 'server')).toEqual(['virtual']);
    expect(handsReason(plain, 'server', 'none')).toBe('AI SDK doesn’t take None hands.');
  });

  it("a deployment that can't make a Vercel Sandbox VM turns the machine and sandbox hands off, with its reason", () => {
    const ctx = { sandboxOff: 'run `vercel link`' };
    expect(allowed(pi, 'server', ctx)).toEqual(['none', 'virtual', 'ephemeral']);
    expect(handsReason(pi, 'server', 'machine', ctx)).toBe('run `vercel link`');
    expect(handsReason(claudeCode, 'server', 'sandbox', ctx)).toBe('run `vercel link`');
    expect(pickHands(pi, 'hybrid', undefined, ctx)).toBe('virtual');
  });

  it("puts a session's files where its hands keep them", () => {
    const files: Record<Hands, string> = { none: 'none', virtual: 'log', ephemeral: 'ephemeral', machine: 'log', sandbox: 'drive' };
    for (const [h, source] of Object.entries(files)) expect(filesOf(h as Hands)).toBe(source);
  });

  it('a session from before the hands axis keeps the hands it had', () => {
    expect(legacyHands('claude-code')).toBe('none');
    expect(legacyHands('codex')).toBe('none');
    expect(legacyHands('hybrid')).toBe('machine');
    expect(legacyHands('hybrid-fx')).toBe('machine');
    expect(legacyHands('pi')).toBe('virtual');
    expect(sessionHands({ harness: 'codex', hands: 'sandbox' })).toBe('sandbox');
    expect(sessionHands({ harness: 'codex' })).toBe('none');
  });
});

describe('the drills follow the session (harness × hands)', () => {
  const values = (scope: ReturnType<typeof drillScope>, targets?: ('tool' | 'model' | 'any' | 'sandbox')[]) => triggersFor(targets, scope).map((t) => [t.value, t.short]);

  it("Sandbox hands: D1-D4 on the session's VM and the Kill Function (D5)", () => {
    const scope = drillScope('sandbox');
    expect(scope).toBe('sandbox');
    expect(values(scope)).toEqual([
      ['tool', 'Tool'],
      ['model', 'Model'],
      ['any', 'Any Step'],
      ['sandbox', 'Next Turn'],
    ]);
    expect(kindsAt(scope, 'tool').map((k) => k.value)).toEqual(['process', 'sandbox-vm', 'relay-drop']);
    expect(kindsAt(scope, 'model').map((k) => k.value)).toEqual(['process', 'relay-drop']);
    expect(kindsAt(scope, 'sandbox').map((k) => k.value)).toEqual(['sandbox-new-vm', 'sandbox-zombie']);
    expect(kindsFor(scope)).toEqual(['process', 'sandbox-vm', 'relay-drop', 'sandbox-new-vm', 'sandbox-zombie']);
    // A harness that fires only some targets still gets the turn's start on its VM.
    expect(values(scope, ['tool']).map(([v]) => v)).toEqual(['tool', 'sandbox']);
  });

  it("Virtual + machine: a machine command is a target, and only the Function dies there (run_on_machine fires no sandbox-vm, sandbox-command or drop-callback)", () => {
    const scope = drillScope('machine');
    expect(scope).toBe('machine');
    expect(values(scope)).toEqual([
      ['tool', 'Tool'],
      ['model', 'Model'],
      ['any', 'Any Step'],
      ['sandbox', 'Machine'],
    ]);
    for (const at of ['tool', 'model', 'any', 'sandbox'] as const) expect(kindsAt(scope, at)).toEqual([]);
    expect(kindsFor(scope)).toEqual(['process']);
  });

  it('None, Virtual and Virtual (not saved): the Kill Function at a tool, the model or any step, never a VM drill', () => {
    for (const h of ['none', 'virtual', 'ephemeral'] as const) {
      const scope = drillScope(h);
      expect(scope).toBe('plain');
      expect(values(scope).map(([v]) => v)).toEqual(['tool', 'model', 'any']);
      expect(kindsFor(scope)).toEqual(['process']);
    }
    // A session from before the hands axis: Claude Code tool-less has no VM drills either.
    expect(drillScope(legacyHands('claude-code'))).toBe('plain');
    expect(drillScope(undefined)).toBe('plain');
  });

  it("offers only the targets the harness fires", () => {
    expect(values('plain', ['tool', 'any']).map(([v]) => v)).toEqual(['tool', 'any']);
    expect(values('machine', ['tool', 'any']).map(([v]) => v)).toEqual(['tool', 'any', 'sandbox']);
  });

  it('arms only a drill that fires: a spec from another kind of session is fitted to this one', () => {
    // Sandbox hands keep their drills; a parked command's kinds (an older hybrid session's) become a kill.
    expect(fitCrash({ at: 'sandbox', kind: 'sandbox-new-vm', afterMs: 0 }, ['tool'], 'sandbox')).toEqual({ at: 'sandbox', kind: 'sandbox-new-vm', afterMs: 0 });
    expect(fitCrash({ at: 'tool', kind: 'relay-drop', afterMs: 4000 }, undefined, 'sandbox')).toEqual({ at: 'tool', kind: 'relay-drop', afterMs: 4000 });
    expect(fitCrash({ at: 'tool', kind: 'sandbox-vm', afterMs: 4000 }, undefined, 'sandbox')).toEqual({ at: 'tool', kind: 'sandbox-vm', afterMs: 4000 });
    expect(fitCrash({ at: 'model', kind: 'sandbox-vm', afterMs: 1500 }, undefined, 'sandbox')).toEqual({ at: 'model', kind: 'process', afterMs: 1500 });
    expect(fitCrash({ at: 'sandbox', kind: 'process', afterMs: 4000 }, undefined, 'sandbox')).toEqual({ at: 'sandbox', kind: 'sandbox-new-vm', afterMs: 4000 });
    // A machine: the Kill Function at its command; a VM or a parked command's drill becomes one.
    expect(fitCrash({ at: 'sandbox', kind: 'process', afterMs: 4000 }, undefined, 'machine')).toEqual({ at: 'sandbox', kind: 'process', afterMs: 4000 });
    expect(fitCrash({ at: 'sandbox', kind: 'sandbox-vm', afterMs: 4000 }, undefined, 'machine')).toEqual({ at: 'sandbox', kind: 'process', afterMs: 4000 });
    expect(fitCrash({ at: 'sandbox', kind: 'drop-callback', afterMs: 4000 }, undefined, 'machine')).toEqual({ at: 'sandbox', kind: 'process', afterMs: 4000 });
    expect(fitCrash({ at: 'sandbox', kind: 'sandbox-zombie', afterMs: 0 }, undefined, 'machine')).toEqual({ at: 'sandbox', kind: 'process', afterMs: 0 });
    // Plain: no machine command and no VM, so a tool call's Kill Function.
    expect(fitCrash({ at: 'sandbox', kind: 'sandbox-zombie', afterMs: 0 }, undefined, 'plain')).toEqual({ at: 'tool', kind: 'process', afterMs: 0 });
    expect(fitCrash({ at: 'tool', kind: 'sandbox-vm', afterMs: 4000 }, undefined, 'plain')).toEqual({ at: 'tool', kind: 'process', afterMs: 4000 });
    expect(fitCrash({ at: 'sandbox', kind: 'process', afterMs: 4000 }, undefined, 'plain')).toEqual({ at: 'tool', kind: 'process', afterMs: 4000 });
    // A target the harness doesn't fire: the next tool call.
    expect(fitCrash({ at: 'model', kind: 'process', afterMs: 1500 }, ['tool', 'any'], 'plain')).toEqual({ at: 'tool', kind: 'process', afterMs: 1500 });
    // Unchanged when it fits, kind or not.
    const spec = { at: 'model' as const, afterMs: 500 };
    expect(fitCrash(spec, undefined, 'plain')).toBe(spec);
  });

  it('the example prompts are the ones the hands can run, and the first one left leads', () => {
    const labels = (b: 'server' | 'tab' | 'hybrid', h: Hands) => scenariosFor(b, h).map((s) => s.label);
    const primary = (b: 'server' | 'tab' | 'hybrid', h: Hands) => scenariosFor(b, h).filter((s) => s.primary).map((s) => s.label);
    expect(primary('server', 'sandbox')).toEqual(['Kill the Sandbox VM']);
    expect(labels('server', 'sandbox')).toContain('Restart on a New Sandbox');
    expect(primary('server', 'virtual')).toEqual(['Crash a Command']);
    expect(labels('server', 'virtual')).not.toContain('Run on the Machine');
    expect(labels('server', 'machine')).toEqual(expect.arrayContaining(['Run on the Machine', 'Crash a Machine Command', 'Crash a Command']));
    // No hands: nothing that needs a shell.
    expect(primary('server', 'none')).toEqual(['Crash a Payment']);
    expect(labels('server', 'none')).toEqual(['Crash a Payment', 'Recall', 'Unsafe Payment']);
    expect(primary('hybrid', 'machine')).toEqual(['Crash a Machine Command']);
    expect(labels('hybrid', 'virtual')).not.toContain('Real Machine');
    expect(labels('hybrid', 'virtual')).toContain('Backend Secret');
    // The hybrid presets on a parked command are gone: run_on_machine never parks.
    for (const h of ['virtual', 'machine'] as const) expect(labels('hybrid', h)).not.toEqual(expect.arrayContaining(['Kill the Command', 'Drop the Callback']));
    // Every armed preset fits its session as it is.
    for (const b of ['server', 'tab', 'hybrid'] as const)
      for (const h of ['none', 'virtual', 'ephemeral', 'machine', 'sandbox'] as const)
        for (const s of scenariosFor(b, h)) if (s.crash) expect(fitCrash(s.crash, undefined, drillScope(h))).toBe(s.crash);
  });
});
