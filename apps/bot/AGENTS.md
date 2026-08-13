# Bot App

`apps/bot/` contains Laborer's Slack bridge, local daemon, ACP runtime, registered Actions, and macOS companion. `README.md` documents the supported composition and operator contract.

## Architectural Boundary

Laborer accepts Slack work-thread input, invokes a user-controlled local program, and carries deliberate output back to Slack. Preserve these ownership boundaries:

- Chat SDK owns Slack ingestion, ordering, subscription, and best-effort delivery.
- The ACP Conversation runtime owns agent sessions; registered Actions own workflow-specific execution behavior.
- Slack and OpenCode details stay behind adapters rather than leaking into the generic core.
- Only Conversation output admitted by the public/private gate crosses back to Slack; diagnostics and implementation-agent output remain private.

Keep throwaway work inside its named prototype unless an issue explicitly promotes it into a shared or live path.

## Commands

Run these commands from the repository root:

- Fix bot formatting: `bun run --cwd apps/bot format:fix`
- Typecheck the bot and companion: `bun run --cwd apps/bot typecheck`
- Run deterministic bot tests: `bun run --cwd apps/bot test`
- Scan tracked files for Slack secrets: `bun run --cwd apps/bot check:secrets`
- Run the bot check: `bun run --cwd apps/bot check`

The Slack entry point runs on Node because the Chat Slack adapter depends on Node behavior. Use package scripts instead of invoking source with Bun.

## Daemon Lifecycle

- Start the daemon with `bun run start:bot`.
- Stop it with Ctrl-C and wait for `Slack Laborer stopped cleanly.` before starting another instance.
- During daemon development, use `bun run dev:bot`. Node watch mode restarts the one Chat/ACP composition; in-flight conversational work is intentionally not drained or replayed.
- Node watch mode follows imported source files. Restart `dev:bot` after changes to dependencies, environment, package metadata, or Node.

## Durability and Security

Treat Slack payloads, handler output, persisted state, filesystem paths, and child-process data as untrusted boundaries.

- Chat conversations are at-most-once and best effort: preserve the absence of an acceptance log, replay scheduler, durable Slack outbox, and stream recovery above Chat SDK.
- Preserve stable workspace, thread, ACP session, Action, Execution, and local-protocol identities.
- Fail closed on corrupt state, ambiguous ownership, unsafe paths, and malformed protocol records.
- Preserve bounded reads, writes, records, process output, retries, and shutdown deadlines when changing a boundary.
- Keep Slack credentials out of source, tests, logs, child environments, handler envelopes, and public replies. Secrets belong only in ignored local environment files or the documented external secret store.
- Make interruption and cleanup explicit for processes, sockets, streams, locks, and files.

Use fakes and Chat SDK Emulate for automated Slack tests. Run live Slack or ACP canaries only when an issue explicitly requires a manual credentialed smoke test.
