# ACP production composition

`bun run start:slack` is the only authoritative production receiver. The
Vercel Chat SDK owns Slack Socket Mode ingestion, normalization, subscriptions,
coalesced queue dispatch, best-effort `thread.post` streaming, attachment
delivery, and permission block actions. Conversation turns are at-most-once and
are not routed through a durable conversational scheduler.

`src/acp-runtime/` owns stable-v1 ACP session creation/resume, OpenCode 2
adaptation, child-process supervision, prompt-epoch protection, Memory MCP,
Action MCP, participant context, and the `NO_REPLY` public/private output gate.
The Action/Execution runtime remains durable; Slack publication does not.

Permission cards and clicks are best effort. The durable ACP authority
repository and permission broker still decide each current-prompt capability at
most once. There is no permission UI outbox or recovery projection in the Chat
composition.

## Manual canary

`bun run start:acp-canary` uses the same Chat Effect service and promoted ACP
runtime with the dedicated ACP-canary credentials. Configuration rejects reuse
of production or Chat-canary credentials. Chat state and workspace runtime state
use canary-only namespaces. Never run this credentialed gate in automated
acceptance.

## Recovery

A failed or interrupted conversational turn is not replayed; a participant
mentions Laborer again. A partial stream remains partial. Accepted Executions
retain their durable lifecycle and private event path.
