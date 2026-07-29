# Next: Primary Slack-Native Laborer

`next/` is the primary Laborer implementation. It is an issue-driven Slack-native TypeScript application built from tracer bullets and canaries. `README.md` records what each prototype proves and its remaining scope; do not infer production guarantees beyond that evidence.

## Architectural Boundary

Laborer is a generic bridge: it accepts Slack work-thread input, invokes a user-controlled local program, and carries deliberate output back to Slack. Preserve these ownership boundaries:

- The Runner owns ingestion, durable turn ordering, process supervision, and delivery.
- Work handlers own workflow meaning, tools, agent choice, continuation state, and repository policy.
- Slack and OpenCode details stay in adapters or configured handlers rather than leaking into the generic core.
- Only explicit public output crosses back to Slack; diagnostics and process output remain private.

Keep throwaway work inside its named prototype unless the issue explicitly promotes it into a shared or live path.

## Commands

Run commands from the repository root:

- Fix formatting: `bun run --cwd next format:fix`
- Typecheck: `bun run --cwd next typecheck`
- Test: `bun run --cwd next test`
- Scan tracked files for Slack secrets: `bun run --cwd next check:secrets`
- Run the full check: `bun run --cwd next check`

`check` verifies formatting but does not fix it. Run `format:fix` before the full check.

The live Slack entry point runs on Node because the Socket Mode client depends on Node's Undici WebSocket behavior. Use the package scripts rather than invoking `src/slack/live.ts` with Bun.

## Daemon Lifecycle

- Start the live daemon from the repository root with `bun run --cwd next start:slack`.
- Stop it with Ctrl-C and wait for `Slack Laborer stopped cleanly.` before starting another instance.
- During daemon-client development, use `bun run --cwd next dev:slack`. It typechecks and prepares a fresh Daemon generation before globally draining and replacing the active Slack/ACP clients; invalid candidates leave blue Active, and failed activation gets one explicit blue reactivation attempt.
- The development watcher covers TypeScript below `src/slack`, `src/acp-conversation-prototype`, and `src/prototype`. Changes to Cluster-host code, Action registrations, dependencies, environment, package metadata, Node, or the development supervisor require restarting `dev:slack`.

## Effect 4

This implementation pins Effect 4 beta packages. Before writing Effect code:

1. Run `effect-solutions list` and read relevant guides.
2. Check the installed package version and existing `next/` usage.
3. Search `@effect` for current implementations.

Use `Schema` at untrusted and persisted boundaries, schema-tagged errors for expected failures, narrow `Context.Service` contracts, `Layer` composition, and scoped resource lifecycles.

## Durability and Security

Treat Slack payloads, handler output, persisted state, filesystem paths, and child-process data as untrusted boundaries.

- Persist accepted input and deliberate output before acknowledging or delivering side effects.
- Keep replay idempotent and preserve stable event, turn, attempt, reply, and thread identities.
- Fail closed on corrupt state, ambiguous ownership, unsafe paths, and malformed protocol records.
- Preserve bounded reads, writes, records, process output, retries, and shutdown deadlines when changing a boundary.
- Keep Slack credentials out of source, tests, logs, child environments, handler envelopes, and public replies. Secrets belong only in ignored local environment files or the documented external secret store.
- Make interruption and cleanup behavior explicit for processes, sockets, streams, locks, and files.

Automated tests must remain deterministic and offline: use fakes and Emulate rather than real Slack connections, OpenCode sessions, or model providers. Run live Slack or ACP canaries only when the user explicitly requests a manual smoke test and the dedicated credentials are available.
