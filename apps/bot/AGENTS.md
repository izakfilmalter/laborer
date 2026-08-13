# Next: Primary Slack-Native Laborer

`apps/bot/` is the primary Laborer implementation. It is an issue-driven Slack-native TypeScript application built from tracer bullets and canaries. `README.md` records what each prototype proves and its remaining scope; do not infer production guarantees beyond that evidence.

## Architectural Boundary

Laborer is a generic bridge: it accepts Slack work-thread input, invokes a user-controlled local program, and carries deliberate output back to Slack. Preserve these ownership boundaries:

- Chat SDK owns Slack ingestion, ordering, subscription, and best-effort delivery.
- The ACP Conversation runtime owns agent sessions; registered Actions own workflow-specific execution behavior.
- Slack and OpenCode details stay behind their adapters rather than leaking into the generic core.
- Only Conversation output admitted by the public/private gate crosses back to Slack; diagnostics and implementation-agent output remain private.

Keep throwaway work inside its named prototype unless the issue explicitly promotes it into a shared or live path.

## Commands

Run commands from the repository root:

- Fix formatting: `bun run --cwd apps/bot format:fix`
- Typecheck: `bun run --cwd apps/bot typecheck`
- Test: `bun run --cwd apps/bot test`
- Scan tracked files for Slack secrets: `bun run --cwd apps/bot check:secrets`
- Run the full check: `bun run --cwd apps/bot check`

`check` verifies formatting but does not fix it. Run `format:fix` before the full check.

The live Slack entry point runs on Node because the Chat Slack adapter depends on Node behavior. Use the package scripts rather than invoking the source entry point with Bun.

## Daemon Lifecycle

- Start the live daemon from the repository root with `bun run --cwd apps/bot start:slack`.
- Stop it with Ctrl-C and wait for `Slack Laborer stopped cleanly.` before starting another instance.
- During daemon development, use `bun run --cwd apps/bot dev:slack`. Node watch mode restarts the one Chat/ACP composition; in-flight conversational work is intentionally not drained or replayed.
- Node watch mode follows imported source files. Changes to dependencies, environment, package metadata, or Node require restarting `dev:slack`.

## Effect 4

This implementation pins Effect 4 beta packages. Before writing Effect code:

1. Run `effect-solutions list` and read relevant guides.
2. Check the installed package version and existing `apps/bot/` usage.
3. Search `@effect` for current implementations.

Use `Schema` at untrusted and persisted boundaries, schema-tagged errors for expected failures, narrow `Context.Service` contracts, `Layer` composition, and scoped resource lifecycles.

## Durability and Security

Treat Slack payloads, handler output, persisted state, filesystem paths, and child-process data as untrusted boundaries.

- Chat conversations are at-most-once and best effort: do not add an acceptance log, replay scheduler, durable Slack outbox, or stream recovery above Chat SDK.
- Preserve stable workspace, thread, ACP session, Action, Execution, and local-protocol identities.
- Fail closed on corrupt state, ambiguous ownership, unsafe paths, and malformed protocol records.
- Preserve bounded reads, writes, records, process output, retries, and shutdown deadlines when changing a boundary.
- Keep Slack credentials out of source, tests, logs, child environments, handler envelopes, and public replies. Secrets belong only in ignored local environment files or the documented external secret store.
- Make interruption and cleanup behavior explicit for processes, sockets, streams, locks, and files.

Automated tests must remain deterministic and offline: use fakes and Emulate rather than real Slack connections, OpenCode sessions, or model providers. Run live Slack or ACP canaries only when the user explicitly requests a manual smoke test and the dedicated credentials are available.
