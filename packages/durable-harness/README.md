<div align="center">
  <h1>durable-harness</h1>

<a href="https://vercel.com"><img alt="Vercel logo" src="https://img.shields.io/badge/MADE%20BY%20Vercel-000000.svg?style=for-the-badge&logo=Vercel&labelColor=000"></a>
<a href="https://www.npmjs.com/package/durable-harness"><img alt="npm version" src="https://img.shields.io/npm/v/durable-harness?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel-labs/durable-harness/blob/main/LICENSE.md"><img alt="License" src="https://img.shields.io/npm/l/durable-harness.svg?style=for-the-badge&labelColor=000000"></a>

</div>

durable-harness runs coding-agent harnesses (Pi, OpenCode, libfx's fx,
Claude Code and Codex) as durable agents on a
[Workflow SDK](https://workflow-sdk.dev) World. Each session is a workflow
run: its conversation, the turn in flight and every model and tool call are
in the run's event log, so a crash anywhere resumes the turn from the log on
another machine, and a tool call that isn't safe to repeat is never run twice.

> [!NOTE]
> durable-harness is experimental: it's on `0.0.x`, and its API may change
> between releases.

## Quick start

Install it with a harness, here Pi, in a Next.js app:

```bash
npm install durable-harness @earendil-works/pi-agent-core @earendil-works/pi-ai just-bash
```

Define an agent. Agents are tool-less by default; one line gives Pi its own
coding tools on a virtual workspace, whose files live in the session's log:

```ts
// lib/agent.ts
import { virtual } from 'durable-harness';
import { createCodingTools, pi } from 'durable-harness/pi';

export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: createCodingTools(virtual()) });
```

Serve it from a chat route, and configure the integration:

```ts
// app/api/chat/route.ts
import { agent } from '@/lib/agent';

export const { GET, POST } = agent.chatRoute({ authorize: async (request) => { /* your auth */ } });
```

```ts
// next.config.ts
import { withDurableHarness } from 'durable-harness/next';

export default withDurableHarness({});
```

Choose your harness and framework in the
[agent harnesses docs](https://vercel.com/docs/agent-harnesses).

## Harnesses

- [Pi](https://vercel.com/docs/agent-harnesses/pi): `durable-harness/pi`, and
  `durable-harness/pi-durable` for apps built on Pi's own durable `Harness`.
- [OpenCode](https://vercel.com/docs/agent-harnesses/opencode):
  `durable-harness/opencode`.
- [fx](https://vercel.com/docs/agent-harnesses/fx): `durable-harness/fx`,
  libfx's kernel tools for its own durable agents.
- [Claude Code](https://vercel.com/docs/agent-harnesses/claude-code) and
  [Codex](https://vercel.com/docs/agent-harnesses/codex):
  `durable-harness/claude-code` and `durable-harness/codex`. They run only in
  the session's own Vercel Sandbox, never in a shared Function
  ([why](https://vercel.com/docs/agent-harnesses/security)).

Model-chosen commands and files run on a virtual workspace (`virtual()`) or
in the session's own Vercel Sandbox (`sandbox()`), never on the machine that
drives the session. See [tools](https://vercel.com/docs/agent-harnesses/tools)
and [security](https://vercel.com/docs/agent-harnesses/security).

## Run anywhere

Local development uses the Workflow SDK's local World with no configuration.
Deploy to Vercel for managed storage, queuing and scaling, with sessions in
[Agent Runs](https://vercel.com/docs/agent-harnesses/observability). To
self-host, use the Postgres World or any other
[World](https://workflow-sdk.dev/docs/deploying): see
[self-hosting](https://vercel.com/docs/agent-harnesses/self-hosting).

## Contributing

Contributions are welcome. Use
[issues](https://github.com/vercel-labs/durable-harness/issues) to collaborate
with the team, and read
[CONTRIBUTING.md](https://github.com/vercel-labs/durable-harness/blob/main/CONTRIBUTING.md)
before opening a pull request.

## Security

If you find a security vulnerability in durable-harness, **_disclose it responsibly instead of opening a public issue_**.

To participate in our Open Source Software Bug Bounty program, please email
[responsible.disclosure@vercel.com](mailto:responsible.disclosure@vercel.com).
We will add you to the program and provide further instructions for submitting
your report.
