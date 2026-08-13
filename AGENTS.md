# Laborer Repository

This repository contains two implementations with different architectures and dependencies:

- `apps/bot/` is the primary Slack-native Laborer and supersedes the legacy app.
- `apps/desktop/` is the legacy desktop mission-control app.

Use the nearest `AGENTS.md` for implementation-specific guidance. Default new product work to `apps/bot/`; change `apps/desktop/` only when the task explicitly concerns the legacy app. Keep changes inside the target implementation unless the task explicitly crosses that boundary.

## Domain and Decisions

Before changing behavior, read the relevant parts of root `CONTEXT.md` and any applicable ADRs in `docs/adr/`. Use their canonical terms and surface conflicts with recorded decisions.

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

Use them for specifications, implementation patterns, tests, and examples. Prefer the target implementation's installed dependency versions when APIs differ.
