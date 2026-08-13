# Laborer bot

`apps/bot/` is Laborer's Slack bridge and local runtime, published in the
monorepo as `@laborer/bot`. Vercel Chat SDK (`chat` + `@chat-adapter/slack`) is the
entire Slack plane: Socket Mode ingestion, normalization, routing, activation,
subscription, delivery, streaming, and Block Kit permission UI. One Slack
adapter serves every configured workspace through an `installationProvider`
that resolves local per-team bot tokens; Laborer runs no OAuth server or
installation store.

Chat is isolated behind a narrow, scoped Effect service. The surviving core is
ACP/OpenCode 2 process supervision, durable Agent sessions and context (Soul,
Workspace memory, and User profiles), registered Actions and durable
Executions, and the public/private output gate. Substantive current-prompt
Conversation output streams directly to Slack; `NO_REPLY`, diagnostics, and
implementation-agent output remain private.

Conversational turns are at-most-once. If the daemon or a turn fails, Laborer
posts a sanitized best-effort notice when possible and a participant recovers by
mentioning Laborer again. Messages received during a running turn are coalesced
into the next turn through `context.skipped`. Streaming and permission clicks
are best effort and at-most-once; a truncated stream is not resumed and a lost
permission click is clicked again. There is no conversational replay scheduler
or durable Slack outbox. Action/Execution durability is independent of those
messaging semantics.

The app also contains a macOS companion that observes and controls the
launchd-owned daemon through a versioned local protocol. The companion is a
client: closing it does not stop ongoing work.

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
All daemon runtime state has one root. Workspace state is isolated under
`$XDG_STATE_HOME/laborer/workspaces/<team-id>/` (defaulting to
`~/.local/state/laborer/workspaces/<team-id>/`). The custom SQLite Chat SDK
`StateAdapter` stores subscriptions, deduplication, locks, queues, and lists in
`$XDG_STATE_HOME/laborer/chat.sqlite`; each workspace's durable
Action/Execution runtime uses its partition's `runtime.sqlite`. Pre-Chat runtime
state is deleted at cutover, not imported or archived; affected Slack threads
activate again by mention.

## Stable installed identities

The source package is `@laborer/bot`, but already installed external
identities do not follow package naming. The launchd service label remains
`com.laborer.daemon` and the companion bundle identifier remains
`com.laborer.companion`. The daemon/companion operator protocol is an explicit
versioned local boundary (version 6 after the Chat cutover): peers reject a
mismatched version, and schema changes must deliberately bump it. These are the
forward-stable identities; pre-Chat runtime records have no compatibility
identity and are deleted.

## Run

From the repository root, start the daemon with the root alias:

```sh
bun run start:bot
```

For development, use plain Node watch restart:

```sh
bun run dev:bot
```

A restart does not drain or replay in-flight conversational work. Changes to
dependencies, environment, package metadata, or Node itself require restarting
the command.

The dedicated manual canaries remain available under isolated credentials.
`start:acp-canary` exercises the production Chat/ACP/OpenCode composition;
`start:chat-canary` isolates the Chat boundary with a placeholder responder:

```sh
bun run --cwd apps/bot start:chat-canary
bun run --cwd apps/bot start:acp-canary
```

Do not run canaries against production app credentials.

Registered Actions are the extension seam for user-owned operations. The
Conversation agent chooses when to invoke them; Actions and implementation
agents never publish directly to Slack. `laborer.json` selects the registered
application and may configure its Action-facing implementation agent, but it
does not select an alternate conversational runtime.

## Verify

Automated checks are deterministic and offline:

```sh
bun run --cwd apps/bot check
```

`Emulate` is the Chat SDK's deterministic offline test harness, never a daemon
or supported receiver. The suite drives the narrow Chat Effect boundary with
fakes and covers the SQLite StateAdapter, ACP process supervision and output
authority, registered Actions and Executions, and the configuration cutover.
Live Slack and ACP verification is a separate manual canary gate.

The supported ACP/OpenCode versions and deployment policy are documented in
[`docs/acp-runtime-matrix.md`](docs/acp-runtime-matrix.md) and
[`docs/acp-production-cutover.md`](docs/acp-production-cutover.md).
