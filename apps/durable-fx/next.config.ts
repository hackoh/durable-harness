import { withDurableHarness } from 'durable-harness/next';

// Writes the route libfx's queue delivers each turn to, and its trigger: no
// wake route of our own, no vercel.json functions entry.
export default withDurableHarness({ agentRules: false });
