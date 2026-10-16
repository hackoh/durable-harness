/**
 * Turbopack loader for durable-harness's `src/relay-bundle.ts` in the demo's
 * `next build` (next.config.ts): the module as a published build ships it,
 * built once by scripts/relay-bundle.mjs and passed in as `code`.
 */
module.exports = function relayBundleLoader() {
  return this.getOptions().code;
};
