/**
 * L4's driver (`live-drills.test.ts`): one invocation in a process of its own,
 * so the test can kill it the way a platform kills a Function (SIGKILL: its
 * sockets die with it, no close frame). Takes its options as a JSON argument
 * (`LiveSessionOptions` without the callbacks, plus the prompt), starts the
 * session, prints `{"sessionId":...}` on stdout, sends the prompt, and keeps
 * driving until it is killed.
 */
import { liveSession } from './live-session.ts';

const options = JSON.parse(process.argv[2]!) as { dataDir: string; snapshot: string; name: string; gatewayUrl: string; model: string; prompt: string };
const { sessions } = await liveSession({ ...options, log: (message, fields) => console.error(`[driver] ${message} ${fields ? JSON.stringify(fields).slice(0, 200) : ''}`) });
const { sessionId } = await sessions.start();
console.log(JSON.stringify({ sessionId }));
await sessions.send(sessionId, options.prompt);
setInterval(() => {}, 60_000);
