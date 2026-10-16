import type { MachineBrand, SessionMachine } from './environment.ts';

/**
 * The session machine brand (docs/workspaces.md §6 rule 1): the minter that
 * marks a `SessionMachine` as the sandbox tier's, and `isBrandedMachine`,
 * the check Claude Code and Codex refuse anything else with.
 *
 * Its own entry (`harness-world-process/machine-brand`), which the index
 * does not re-export, so only the module that brands imports it: the sandbox
 * tier's session factory (`packages/harness-sandbox/src/session.ts`). The
 * lint in §6 rule 3 keeps every other importer out (A10), and the release
 * gate asserts the brand is claimed in the built bundle (A7). The index
 * exports `isBrandedMachine` and the types.
 */

/** Each brand the minter made, and the one machine it marks: a copied object keeps the brand and is still refused. */
const marked = new WeakMap<object, object>();
let claimed = false;

/** A machine the minter branded: frozen, so nothing that holds it can swap what it runs on. */
export type BrandedMachine<M> = Readonly<M & { readonly brand: MachineBrand }>;

/**
 * The function that brands a session machine. Handed out once per process,
 * so there is never a silent second minter:
 *
 * - The sandbox tier's session factory module claims it at load and keeps
 *   it module-private. The private stand-in VM (`localMachine()`, in the
 *   same package's test helpers, §5.8) never claims it: the factory module
 *   exports an internal `brandForTests`, guarded like the stand-in (the test
 *   flag set, not on Vercel, not in production), and the stand-in brands
 *   through that. So a process that loads both never sees a second claim.
 * - A second claim throws. In durable-harness's build the factory and this
 *   module are bundled together (harness-world-* are not external), so a
 *   reload evaluates both again; a dev server that re-evaluates only the
 *   factory (HMR of workspace sources) throws on reload, loudly: restart it.
 *
 * The minter takes the machine without its brand and returns it branded and
 * frozen, with its `files`, `dirs` and `workspace`: assigning `spawn` (or
 * `files.wipe`) on a branded machine throws in strict mode and changes
 * nothing, so a machine that passes `isBrandedMachine` runs where the
 * factory made it run. State the factory changes after (the link, its
 * signal) lives in closures or private fields, not in properties.
 */
export function machineBrand(): <M extends Omit<SessionMachine, 'brand'>>(machine: M) => BrandedMachine<M> {
  if (claimed) throw new Error('harness-world-process: the session machine brand is already claimed');
  claimed = true;
  return (machine) => {
    const brand = Object.freeze({}) as MachineBrand;
    Object.defineProperty(machine, 'brand', { value: brand, enumerable: false });
    Object.freeze(machine.files);
    Object.freeze(machine.dirs);
    Object.freeze(machine.workspace);
    Object.freeze(machine);
    marked.set(brand, machine);
    return machine as BrandedMachine<typeof machine>;
  };
}

/** Whether `value` is a machine the session factory made (its own brand, on the object it branded). */
export function isBrandedMachine(value: unknown): value is SessionMachine {
  if (typeof value !== 'object' || value === null) return false;
  const brand = (value as { brand?: unknown }).brand;
  return typeof brand === 'object' && brand !== null && marked.get(brand) === value;
}
