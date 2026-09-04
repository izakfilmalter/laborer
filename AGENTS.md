# Laborer Monorepo

Laborer is a Bun and Turborepo monorepo whose Slack, desktop, and web surfaces are converging into one connected experience.

## Layout and Boundaries

- `apps/bot/` contains the Slack bridge, daemon, and macOS companion.
- `apps/desktop/` contains the Electron shell for mission control.
- `apps/web/` contains the React mission-control interface.
- `packages/` contains shared services and contracts. Put code here only when more than one app owns the same concept; keep app-specific adapters and UI in their app.

Use the nearest `AGENTS.md`. App guidance adds local constraints to this file; shared rules have one canonical home here. Keep changes within the issue's app or package boundary unless the behavior itself crosses that boundary. Preserve explicit RPC and adapter boundaries rather than importing another app's internals.

Default product work to `apps/bot/`. Change mission control (`apps/desktop/`, `apps/web/`, and its supporting packages) only when the issue explicitly concerns it; the merged repository does not erase those ownership boundaries.

## Commands

Run workspace-wide commands from the repository root:

- Check formatting: `bun run format`
- Fix formatting: `bun run format:fix`
- Typecheck: `bun run typecheck`
- Test: `bun run test`
- Run all required checks: `bun run check`

During development, run the narrowest package script first, for example `bun run --cwd apps/web test`. Root `check` applies formatting fixes and may modify files.

## Code and Test Standards

`biome.json` and Ultracite are the formatting and linting source of truth. Let `format:fix` handle mechanical style; review behavior, boundaries, failure modes, accessibility, and tests.

- Define shared domain types and RPC contracts in the owning package instead of duplicating boundary models.
- Decode untrusted, persisted, and process-boundary data with `Schema`. Represent expected failures with `Schema.TaggedError` classes.
- Keep resource lifecycles scoped, configuration injected and redacted, and service contracts narrow.
- Add regression coverage beside the affected package. Use `@effect/vitest` for Effect-heavy tests and the package's existing runner elsewhere.
- Keep automated tests deterministic and offline. Use fakes for network services, model providers, and external processes.

## Effect 4

All workspaces consume the exact Effect 4 beta versions in the root catalog. This lockstep pin is load-bearing because multiple apps access shared durable state; never bump an `effect` or `@effect/*` package independently.

Before writing or reviewing Effect code:

1. Run `effect-solutions list`.
2. Read relevant guides with `effect-solutions show <topic>...`.
3. Verify examples against the root catalog, installed types, and existing repository usage because guides may lag beta APIs.
4. Search the `@effect` reference for implementations and tests, then reconcile them with the installed version.

Prefer narrow named `Context.Service` contracts, explicit `Layer` composition, scoped acquisition and finalization, and established `effect/unstable/*` imports.

## Logs and Runtime State

Backend processes log to these locations on macOS (`$XDG_STATE_HOME` defaults to `~/.local/state`):

- `~/Library/Application Support/Laborer/logs/laborer-mcp.log` — task MCP runtime (`packages/server/src/task-mcp-runtime.ts`).
- `~/.local/state/laborer/slack-daemon.log` — Slack daemon stdout/stderr (`packages/server/src/services/slack-daemon-process-control.ts`).
- `~/.local/state/laborer/` — runtime state, not logs: `daemon.json` (daemon registration and port), `pty-host/pty-host.json` and `pty-host.sock`, `laborer.sqlite`, `chat.sqlite` (Chat SDK subscriptions and locks only, no transcripts), `workspaces/`.
- `~/.local/state/laborer/workspaces/<TeamId>/` — per-Slack-workspace bot state (`apps/bot/src/slack/runtime-paths.ts`). To see what a Slack turn actually sent to the agent, read `application-state.json`: each `conversations[].prompts[].fingerprint` holds the normalized messages (history with `classification: "context"` plus the activation) and `agentSessionBinding.sessionId` is the OpenCode session. `runtime.sqlite` holds Executions and conversation events. The fully rendered prompt is not persisted by Laborer; it lives only in OpenCode's store under `~/.local/share/opencode/`.

The daemon (`daemon-main.mjs`) and the PTY host are spawned detached with `stdio: 'ignore'`, so in packaged builds their stdout/stderr are discarded; during development `bun dev` shows their output in the terminal. Older builds wrote `backend.log` and `utility-processes/*.log` under `~/Library/Application Support/Laborer/logs/`; current code no longer writes them, so treat those files as stale.

## Domain and Decisions

Before changing behavior, read the relevant parts of root `CONTEXT.md` and applicable ADRs in `docs/adr/`. Use their canonical terms and surface conflicts with recorded decisions.

Issues and PRDs live in GitHub Issues for `izakfilmalter/laborer`. Tracker conventions are in `docs/agents/issue-tracker.md`; triage labels are in `docs/agents/triage-labels.md`.

## Project References

OpenCode-managed references are readable under `~/.local/share/opencode/repos/`:

- `@effect` — `github.com/Effect-TS/effect`
- `@opencode` — `github.com/anomalyco/opencode`
- `@openclaw` — `github.com/openclaw/openclaw`
- `@hermes-agent` — `github.com/NousResearch/hermes-agent`
- `@herdr` — `github.com/herdrdev/herdr`
- `@agent-client-protocol` — `github.com/agentclientprotocol/agent-client-protocol`
- `@chat` — `github.com/vercel/chat`
- `@t3code` — `github.com/pingdotgg/t3code`
- `@vscode` — `github.com/microsoft/vscode`
- `@github-desktop` — `github.com/desktop/desktop`
- `@xterm` — `github.com/xtermjs/xterm.js`
- `@tanstack-db` — `github.com/TanStack/db`
- `@web-haptics` — `github.com/lochie/web-haptics`
- `@collab-public` — `github.com/collabs-inc/collab-public`

Use them for specifications, implementation patterns, tests, and examples. Prefer this repository's installed dependency versions when APIs differ.
