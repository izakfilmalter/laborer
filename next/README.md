# Slack-native Laborer

`next/` is Laborer's primary Slack-native daemon. Vercel Chat SDK owns the
Slack plane: Socket Mode ingestion, activation and subscription, coalesced
backlogs, attachments, Block Kit actions, and best-effort streaming. The
Effect-wrapped ACP/OpenCode runtime owns Conversation sessions, Agent context,
the public/private output gate, registered Actions, and durable Executions.

Conversational turns are at-most-once. If the daemon or a turn fails, Laborer
posts a sanitized best-effort notice when possible and a participant recovers by
mentioning Laborer again. There is no conversational replay scheduler or durable
Slack outbox. Action/Execution durability is independent of those messaging
semantics.

## Configure

Each Laborer root contains `laborer.json` with one registered application:

```json
{
  "application": {
    "environment": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    "type": "reference-coding"
  }
}
```

`application.environment` contains environment variable names, never values.
Slack and Laborer authority credentials are always excluded from ACP children.
Conversation agent and model selection come from the user's OpenCode
configuration. Optional implementation-agent selection can be provided under
`application.implementation`.

Production uses one app-level token and a local workspace registry:

```dotenv
SLACK_APP_TOKEN=
LABORER_SLACK_WORKSPACES=[{"teamId":"TFIRST","botTokenEnvironment":"SLACK_BOT_TOKEN_FIRST","root":"/existing/laborer/root"}]
SLACK_BOT_TOKEN_FIRST=
```

Every installation is authenticated and must match its configured team ID.
Workspace state is isolated under
`$XDG_STATE_HOME/laborer/workspaces/<team-id>/` (defaulting to
`~/.local/state/laborer/workspaces/<team-id>/`). Chat SDK state is stored at the
single Laborer state root. Prior Runner state is intentionally not imported or
archived; after this cutover, existing Slack threads activate again by mention.

## Run

From the repository root:

```sh
bun run --cwd next start:slack
```

For development, use plain Node watch restart:

```sh
bun run --cwd next dev:slack
```

A restart does not drain or replay in-flight conversational work. Changes to
dependencies, environment, package metadata, or Node itself require restarting
the command.

The dedicated manual canaries remain available under isolated credentials:

```sh
bun run --cwd next start:chat-canary
bun run --cwd next start:acp-canary
```

Do not run canaries against production app credentials.

## Verify

Automated checks are deterministic and offline:

```sh
bun run --cwd next check
```

The suite covers the Chat Effect boundary and SQLite StateAdapter, ACP process
supervision and output authority, registered Actions and Executions, and the
configuration cutover. Live Slack and ACP verification is a separate manual
canary gate.

The supported ACP/OpenCode versions and deployment policy are documented in
[`docs/acp-runtime-matrix.md`](docs/acp-runtime-matrix.md) and
[`docs/acp-production-cutover.md`](docs/acp-production-cutover.md).
