---
status: accepted
---

# The Slack plane is the Vercel Chat SDK, and conversational delivery is at-most-once

Native specification: [#330 — Chat SDK becomes the Slack plane; Laborer focuses on conversation, Actions, and Executions](https://github.com/izakfilmalter/laborer/issues/330).

Laborer `apps/bot/` adopts the Vercel Chat SDK (`chat` + `@chat-adapter/slack`, Socket Mode) as its entire Slack plane: ingestion, normalization, routing, delivery, streaming, and interactive UI (Block Kit, permission buttons). The bespoke durable conversational machinery it replaces is deleted rather than rebuilt on top: durable-acceptance-before-ACK, the per-thread turn FIFO and replayable turn attempts, the durable outbox with delivery-gated turn settlement, the crash-resumable Slack stream projection, and the blue/green development daemon generations. Chat SDK is wrapped in a narrow Effect service; multi-workspace uses one Slack adapter with an `installationProvider` backed by local per-workspace tokens; Chat SDK state lives in a custom SQLite `StateAdapter`; runtime state collapses from per-root ownership to a single state root partitioned by Slack workspace.

What survives, unchanged in ownership: ACP/OpenCode child-process supervision, the Action/Execution durable runtime (SQLite + Effect Cluster) and its private Execution event path, the public/private output gate (`NO_REPLY`, current-prompt-only publication, implementation agents never publish), and Agent context (Soul, Workspace memory, User profiles).

## Why

The product is a good Slack bot for dev work that manages Action execution — not a durable messaging substrate. The bespoke Slack plane had grown into the most intricate part of the system (stream projections with unresolved-outcome certainty tracking, turn replay ambiguity classes, atomic snapshot stores) while the differentiating parts — conversation quality, Actions, Executions — are elsewhere. Chat SDK's Slack adapter is mature and first-class (Socket Mode, native streaming with post-and-edit fallback, Block Kit, modals, multi-workspace token resolution), and sitting on it lets the team spend effort where the product differentiates.

The at-most-once concession is forced, not incidental: Chat SDK's Socket Mode adapter ACKs `events_api` envelopes before validation or handler dispatch with no deferral hook, writes dedupe markers before handler completion, and logs (rather than redelivers) handler failures. A hybrid that kept durable acceptance under Chat SDK's transport was investigated and is not possible without forking the adapter. The failure mode accepted in exchange — a crashed or failed turn produces no reply and the user mentions the bot again — is honest, visible, and normal for Slack bots.

Overlapping messages in one thread are coalesced, not queued: Chat SDK's `queue` strategy invokes the handler once with the latest message plus the full backlog as `context.skipped`. For an agent reading a conversation, this is treated as equivalent-or-better to strict per-message turns.

## Consequences

- A daemon crash or handler failure loses the in-flight message; nothing replays. Recovery is the human re-mentioning the bot.
- A crash mid-stream leaves a visibly truncated Slack message; no stream is resumed or reconciled.
- Permission button clicks are at-most-once; a lost click is re-clicked. One-shot permission *authority* (only the current prompt may be granted) remains enforced in the handler.
- Development reload is a plain restart; in-flight work during a dev restart is an accepted loss. The generation supervisor, drain protocol, and generation IPC are deleted.
- The Runner's snapshot store (`runner-state.json`), turn/attempt/outbox schema, and stream projection are deleted; `CONTEXT.md` terms tied to them are retired or redefined.
- Multi-root ownership (root sharing, root locks, root quarantine) is deleted; one state root, workspace-partitioned. Repositories and worktrees remain handler-owned configuration.
- Chat SDK's dispatch (dedupe, locks, queue strategies) is authoritative for conversational ordering; Laborer must not build a second scheduler above it.
- The Action/Execution runtime keeps its own durability guarantees; at-most-once applies to conversation, not to accepted Executions.
- Upgrades of `chat`/`@chat-adapter/slack` become a tracked runtime-matrix concern alongside ACP and OpenCode versions.
- Node remains the daemon runtime (Chat SDK targets Node ≥20; Socket Mode still depends on Node behavior).
