/**
 * A helper that never starts (`RelayConfig.testHelperEntry`, the stand-in
 * only): it leaves a line in `spawned` (its cwd is the workspace), so a test
 * can count the starts, then exits 125, as the privileged shim does when it
 * can't enter the helper's cgroup or mount namespace.
 */
import { appendFileSync } from 'node:fs';

appendFileSync('spawned', 'started\n');
process.exit(125);
