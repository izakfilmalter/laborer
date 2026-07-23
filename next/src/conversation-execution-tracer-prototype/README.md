# Conversation-to-execution tracer prototype

> THROWAWAY PROTOTYPE for the Wayfinder ticket “Prove the co-located conversation-to-execution tracer.”

## Question

Can one Bun root process own peer conversation and execution runtimes while keeping their boundary honest: typed Effect RPC over a Unix socket, a shared Bun SQLite layer for application and Effect Cluster persistence, an idempotent durable Workflow, and an outbox that wakes the conversation only for terminal execution events?

Run the deterministic proof with:

```bash
bun run --cwd next prototype:conversation-execution
```

The command recreates a scratch database under the operating-system temporary directory, asserts every claimed invariant, prints concise evidence, and exits nonzero on failure.

## Deliberate limitation

This tracer uses a tiny explicit public-output sink rather than the existing Emulate-backed Slack fixture. That keeps the two-runtime experiment focused. Real OpenCode, live Slack/Socket Mode, restart hardening, progress wake policy, cancellation, and packaging remain deferred to the next canary. The sink accepts only `conversation.response.completed` envelopes; the demo asserts that execution IDs, snapshots, progress, and diagnostics never cross it.
