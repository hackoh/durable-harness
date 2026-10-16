// Credentials work and nothing is left over: lists this project's probe
// sandboxes and Drives. Creates nothing.
import { leftovers, log } from './lib.ts';

const t = Date.now();
const left = await leftovers();
log('auth.ok.ms', Date.now() - t);
log('leftovers', left);
