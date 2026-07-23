# Live conversation/execution canary (throwaway issue #217)

This canary answers one question: can a live Slack conversation launch a deliberately slow real OpenCode action, remain responsive to a status question, then let the resumed conversation agent author the terminal Slack reply?

## Run

With the same `.env.local` and `laborer.json` used by `start:slack`:

```sh
bun run start:conversation-execution-canary
```

This starts one Node root process. It creates a restart-safe SQLite database and Unix RPC socket under `.laborer-runtime`, authenticates the Slack bot, and then connects Socket Mode. It does not change `start:slack`.

## Manual acceptance

1. In a channel containing the bot, post a new top-level mention asking it to start the slow canary action.
2. Confirm the conversation agent quickly replies that the action was queued.
3. In that same thread, before 45 seconds elapse, ask for status.
4. Confirm the resumed conversation agent reports a grounded `queued` or `running` snapshot while the action continues.
5. Wait for the terminal reply. Confirm it is useful prose authored by the same resumed conversation session, not raw execution output.
6. Confirm Slack never receives JSONL, diagnostics, session IDs, or execution IDs.

The action waits about 45 seconds, then opens a separate real OpenCode session with all tools denied and asks it for a harmless one-sentence completion. Only terminal state enters the durable outbox. The conversation runtime consumes that event and resumes its thread's explicit OpenCode session before the conversation-owned publisher calls Slack.

## Deliberate canary limitations

- Conversation turns are globally serialized.
- Retry policy is intentionally minimal; failed OpenCode turns stay failed for operator inspection/manual intervention.
- SQLite makes intent durable, but a process crash between Slack accepting a message and recording its timestamp can duplicate a publication after restart.
- Killing the root during a child process may leave an operating-system child briefly alive.
- This is a narrow canary, not a production migration or compatibility promise.
