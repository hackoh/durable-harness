import { defineInstructions } from 'eve/instructions';
import { INSTRUCTIONS } from '../lib/prompt';

/**
 * The instructions every lane uses (`lib/prompt.ts`). eve wraps them and adds
 * its own tool-execution block to the system prompt (see `agent.ts`).
 */
export default defineInstructions({ content: INSTRUCTIONS });
