# Slack-to-handler tracer bullet and classifier/worker conversation

> **THROWAWAY LOGIC PROTOTYPE for issue #204.** This is a local vertical proof,
> not the production Runner. Every file under `src/prototype/` exists only for
> this tracer.
>
> **THROWAWAY HANDLER PROTOTYPE for issue #207.** The tracked
> `laborer.json` and `src/handlers/classifier-worker-prototype.sh` prove a
> user-owned classifier-to-worker conversation through the generic process
> seam. The Runner remains unaware of OpenCode, classification, and agents.
>
> **THROWAWAY INITIALIZER PROTOTYPE for issue #205.** An optional configured
> process can select one durable working directory before a new work thread's
> first handler invocation. The tracked initializer creates a sibling Git
> worktree; Git and worktree policy remain user-owned process behavior.

## Run it

From `next`:

```sh
bun run prototype
```

The command starts a strictly-scoped Vercel Labs Emulate Slack server, uses
separate human and Laborer bot tokens through official `@slack/web-api`
`WebClient` instances, injects normalized events at the same boundary used by
the thin live Socket Mode adapter, launches one fresh fixture child process per
turn, and prints the store/process/Slack evidence. Cleanup is scope-finalized.

This is the **Emulate proof**, not a connection to Slack. It requires no Slack
app or credentials and remains the default automated integration path.

Run the adversarial proof with:

```sh
bun run check
```

## Run the live issue #207 configured-handler prototype

With an explicit workspace registry, `start:slack` initializes bindings
concurrently. Each binding reads its bound `<root>/laborer.json` before that
binding's `auth.test`, so one slow root does not delay another workspace. The
daemon uses one app-wide Socket Mode connection and one Web API client per
authenticated workspace installation. Without a workspace registry it retains
the fail-closed one-workspace startup order: resolve the root, validate
`laborer.json`, and acquire the exclusive root lock before `auth.test` or Socket
Mode. The root is `LABORER_ROOT` when that variable is set and otherwise this
`next` directory. The tracked configuration selects the throwaway issue #207
Bash handler. It requires `jq` and an authenticated `opencode` executable on
`PATH`.

`workHandler.command` is required and nonblank; `workHandler.args` is an
optional string array. `workHandler.environment` is an optional array of
environment variable **names** whose existing Runner values may cross the
handler boundary. Names must use portable shell-variable syntax, duplicates are
rejected, values cannot be placed in `laborer.json`, and all
`SLACK_APP_TOKEN*` and `SLACK_BOT_TOKEN*` names are always forbidden. The child
otherwise receives only a small runtime
allowlist (`PATH`, `HOME`, temporary-directory, locale, user, shell, and XDG
locations). Commands containing `/` resolve relative to the Laborer root and
must be executable. Bare commands are validated through inherited `PATH`.
Arguments are passed literally and no shell is used. Other `laborer.json`
fields are retained.

`workHandler.initialize` optionally configures a second command with its own
literal `args` and environment-name allowlist. It runs after first-turn context
is ready and before the first handler process. It receives the same JSON
envelope, may emit ordinary `public_reply` records, and must emit exactly one
`initialized` record containing an absolute canonical `workingDirectory`.
Laborer persists that directory and starts the first and every later handler
process there. Existing durable threads are never retroactively initialized.
An interrupted initializer is replayed and therefore must be idempotent.

The tracked initializer derives one branch from the opaque work-thread ID,
creates or reuses `<repository>.worktrees/thread-<identity>` from the source
checkout's current `HEAD`, and copies only `next/.env.local` to the same relative
location with mode `0600`. It performs no cleanup. This intentionally makes the
local values in `next/.env.local` available inside the worktree; configure a
different initializer if that trust boundary is inappropriate.

### Provision the app manually

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App**, then
   **From an app manifest**.
2. Select the development workspace, choose YAML, and paste the complete
   contents of [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Review and
   create the app. The manifest enables Socket Mode, creates the Laborer bot,
   subscribes only to `app_mention`, `message.channels`, and `message.groups`,
   and requests only `app_mentions:read`, `channels:history`, `groups:history`,
   `chat:write`, and `reactions:write` bot scopes.
3. In **OAuth & Permissions**, choose **Install to Workspace** (or reinstall
   after a manifest change), approve it, and copy the **Bot User OAuth Token**.
4. In **Basic Information → App-Level Tokens**, choose **Generate Token and
   Scopes**. Give it a local-development name, grant only
   `connections:write`, generate it, and copy the app-level token.
5. In `next`, copy `.env.example` to the ignored `.env.local` and enter the two
   token values locally:

   ```sh
   cp .env.example .env.local
   ```

   Do not paste tokens into the manifest, source, tests, README, shell history,
   or any tracked file. `SLACK_APP_TOKEN` is the app-level token and
   `SLACK_BOT_TOKEN` is the installed bot token. Laborer validates their token
   kinds while keeping them redacted. No app, bot, user, or workspace ID is
   configured manually: startup calls `auth.test` to derive the bot user, bot,
   and team identifiers.

   To serve several ordinary workspace installations, set
   `LABORER_SLACK_WORKSPACES` to a one-line JSON array. Each entry contains the
   expected `teamId`, an existing Laborer `root` (omit it deliberately to leave
   that authenticated installation setup-incomplete), and the name of a
   dedicated bot-token environment variable in `botTokenEnvironment`. The
   token values remain separate environment secrets; they are never embedded
   in the registry or passed to configured handlers. For example:

   ```dotenv
   LABORER_SLACK_WORKSPACES=[{"teamId":"TFIRST","botTokenEnvironment":"SLACK_BOT_TOKEN_FIRST","root":"/existing/laborer/root"},{"teamId":"TSECOND","botTokenEnvironment":"SLACK_BOT_TOKEN_SECOND","root":"/existing/other/root"}]
   SLACK_BOT_TOKEN_FIRST=
   SLACK_BOT_TOKEN_SECOND=
   ```

   Startup prepares each local binding before authenticating its token and
   requires the derived workspace to match the configured `teamId`. A bad
   token, invalid root, or mismatched workspace leaves that installation
   unavailable without stopping healthy bindings. Several bindings may share a
   root; the daemon takes one root lock while keeping workspace snapshots and
   handler state in separate namespaced directories. Registry changes require
   a restart.
6. In each public or private channel used for the smoke test, invite the app
   with `/invite @Laborer`. The app cannot read or reply in a channel it has not
   joined.
7. Start the Runner from `next`. This is the complete one-command live run:

   ```sh
   bun run start:slack
   ```

   The package script loads the ignored `.env.local` with Node and launches the
   live adapter there. The Slack Socket Mode SDK requires Undici's WebSocket
   `ping` API, which Node exposes but Bun does not; running
   `src/slack/live.ts` directly with Bun creates a connection that drops at its
   first health check.

8. In an invited channel, post a new nonblank bug report or feature request,
   then reply in its thread. On the
   first turn Laborer schedules an `:hourglass_flowing_sand:` acknowledgement
   without blocking the handler and removes it after the turn finishes or
   fails. A transient reaction outage never blocks accepted handler work:
   reaction state and retry time are persisted, and a scoped background driver
   awaits and serializes each add/remove request until cleanup converges.
   Startup reconciles a stale reaction left by a hard crash. After a handler
   succeeds and every deliberate public reply from that turn is delivered,
   Laborer adds :white_check_mark: to the canonical thread root. That completion
   reaction is also durable and retried independently; permanent reaction
   failures remain observable without changing the successful turn outcome.
   Failed turns and turns with blocked or abandoned public replies are never
   marked complete. The tracked initializer first creates the thread's sibling
   worktree. The handler then
   runs a classifier there and deterministically selects either the
   `bug-to-pr` or `feature-to-pr` skill for a coding worker. The
   classifier and coding worker use the user's default OpenCode agent and
   configuration; the handler does not override plugins, tools, permissions,
   or approval policy. Later
   replies resume the persisted coding session without reclassification. Press
   Ctrl-C to disconnect cleanly.

`LABORER_OPENCODE_MODEL` is a live-supported optional model override and is
explicitly allowed through tracked `laborer.json` configuration.
`LABORER_OPENCODE_COMMAND` overrides the executable for automated tests only.
The handler removes both Slack token variables from every OpenCode child, sends the
bounded (2 MiB) prompt through non-TTY stdin rather than argv, keeps stdout
protocol-only, fatally decodes JSONL and export UTF-8 before JSON parsing, and
caps each OpenCode invocation at 1,280 KiB and 256 events.
One atomically replaced `opencode-stderr.log` per work thread retains at most
the latest 64 KiB, so diagnostics cannot accumulate without bound. A durable
staged mutation record is written before the first classifier, initial worker,
and every resumed worker mutation. A completed classifier result and completed
worker output/session are persisted before reply finalization; a started window that lacks a
recoverable session is reported as explicitly unresolved instead of silently
rerun. Resumed-session recovery accepts only a full terminal assistant with a
finite completion time and no abort/error. Public reply records, including
their trailing newline, remain limited
to 1 MiB.

Live state is stored in ignored `next/.laborer-runtime/`. Its state and
work-thread directories are forced to owner-only permissions, and the atomic
filesystem snapshot fails closed if it is corrupt or unwritable. Delete or
inspect this directory only while the Runner is stopped. Legacy startup acquires
its root-derived exclusive loopback TCP lease before any Slack network call.
Explicit multi-workspace startup acquires each lease after that binding's local
preparation and `auth.test`, before snapshot loading or Runner construction;
the app-wide Socket Mode receiver may already be connected while a binding
waits. A second Runner fails closed, clean shutdown releases the lease, and a
crash-stale nonsecret marker is safely replaced only by the new lease owner.
Runtime, lock, snapshot, and handler-state paths reject
pre-existing or traversed symlinks rather than chmodding or reading through
them. If the root-derived loopback port is occupied for any reason, startup
fails closed rather than risking a second owner.

No automated test opens a Slack connection. Tests inject a fake Socket Mode
client and continue to use Emulate for official `WebClient` HTTP behavior.

## What this prototype genuinely proves

- An activation is persisted as unassigned normalized input before context or
  handler work begins. Store operations atomically form/claim batches, record
  attempts, accept protocol replies, complete outcomes, claim outbox heads,
  and settle turns. Stable channel/timestamp message identity prevents replay
  under a different event ID; conflicting payloads fail closed.
- A store-driven worker gates each canonical thread. A later turn cannot be
  claimed until the prior handler outcome is known and every earlier outbound
  item is delivered or explicitly abandoned. Recovery replays a running turn
  before attempting its accepted pending replies. Separate threads run in
  parallel.
- Transient context reads persist their next retry time and wake automatically,
  including after a harness restart. Definite permanent reads proceed with
  normalized, deduplicated, oldest-first partial or activation-only context, as
  decided by #208.
- Handler execution crosses a real fresh-process boundary. The adapter writes a
  versioned JSON envelope to stdin, rejects it before spawn when its one-time
  UTF-8 serialization exceeds 4 MiB, supervises the backpressured stdin write,
  incrementally parses protocol-only NDJSON with fatal UTF-8 decoding,
  enforces the 1 MiB record limit before a newline or EOF plus aggregate
  per-invocation stdout record/byte and stderr-throughput limits, ignores valid
  extensible unknown record types, strictly rejects excess `public_reply`
  fields and blank reply IDs, and persists accepted replies before completion.
- A configured thread initializer crosses the same bounded process boundary,
  sees the same first-turn envelope, and must return exactly one validated
  `initialized` record. Its canonical directory is persisted once per new
  thread and becomes the current working directory for initial and resumed
  handler turns. Legacy threads remain explicitly uninitialized, while an
  interrupted setup replays with stable identities. The tracked example
  idempotently creates a real sibling Git worktree and copies only
  `next/.env.local`; it does not clean worktrees up.
- The issue #207 user-owned Bash handler stages every external mutation,
  classifies only the first turn, maps that classification to the
  `bug-to-pr` or `feature-to-pr` skill, and resumes the selected
  coding worker's persisted OpenCode session on later turns. Its prompt adapts
  the legacy workspace planner's untrusted-Slack-context boundary to the
  already-bound Laborer thread. Per-turn persisted replies make handler replay idempotent
  without teaching the Runner about classification, skills, or agents.
- `replyId` replay with identical text is idempotent; conflicting text is a
  terminal protocol outcome. Valid replies survive malformed output or nonzero
  exit and precede the sanitized operational notice.
- Stdout is never implicitly public and stderr remains internal. The fixture's
  secret diagnostic text is asserted absent from Slack.
- The process adapter uses a POSIX detached process group with a stable owned
  leader/sentinel, never signals a numeric group after that leader exits, uses
  the #203 two-hour deadline, TERM then a ten-second KILL fallback, waits for process reap, caps
  inherited-pipe draining, forces every new or existing handler state directory
  to owner-only `0700`, and performs scoped cleanup. Signal/timeout deaths leave
  the durable turn running; startup or the
  explicit Runner retry path marks the prior attempt interrupted and re-enters
  it invisibly with the same turn ID and a new attempt. Spawn, protocol, and
  ordinary nonzero-exit failures remain terminal.
  Live mode retains only a bounded metadata ring with no envelope payload or
  stderr evidence; tests must explicitly select bounded fixture evidence.
- Slack history normalization preserves human/external-bot kind and Slack ID,
  uses channel-qualified stable message IDs, excludes Laborer/system/blank/
  edited/deleted records, bounds root context to the preceding ten top-level
  messages, and bounds reply context at the activating reply.
- Live normalization treats Slack's `thread_broadcast` subtype as the authored
  conversational reply it represents, preserving its text, canonical
  `thread_ts`, and human/external-bot/Laborer self-trigger classification.
- Actual Emulate HTTP reads and writes prove public and private channel roots,
  root/reply activation, exact `thread_ts`, no broadcast flag, distinct human
  and bot users, and self-trigger prevention.
- A conservative Slack classifier retries only known transient, request, HTTP
  408/429/5xx, and rate-limit failures; it preserves Slack `Retry-After` and
  defaults unknown platform errors to permanent rather than hot-looping.
  Item-specific permanent failures block their output but allow exactly one
  linked sanitized notice to bypass it on a best-effort basis. Destination/auth
  failures do not enqueue an undeliverable notice. Neither path overtakes later
  handler output or advances the turn before local retry/abandon recovery.
- The default issue #204 harness is in-memory, as requested by the issue. A
  separate atomic filesystem snapshot layer validates versioned state and
  cross-record semantic invariants, including turn settlement, outbox
  references, notice identity, and per-turn ordering. Queued messages cannot
  own outbound items; running turns may contain only pending accepted replies;
  awaiting-delivery turns require pending, delivering, or blocked output; and
  completed/failed turns allow only delivered or explicitly abandoned output.
  Structural decoding rejects excess properties at every snapshot level while
  retaining the missing-acknowledgements migration. It fails closed without repair on impossible, corrupt, unreadable, or
  unwritable snapshots, closes handles on every path, and cleans temporary
  files; it is not the demo's persistence backend. After a transition acquires
  its synchronization permit, validation, atomic rename/fsync persistence, and
  the in-memory ref commit are uninterruptible; waiting for the permit remains
  interruptible.
- Effect services are narrow `Context.Service` contracts assembled with
  `Layer`s. Boundary/domain records use `Schema` classes and branded IDs;
  expected failures use tagged schema errors; resources use scopes.
- The live adapter resolves each Socket Mode envelope independently. Events for
  configured bindings remain unacknowledged while that route is pending, and a
  ready route persists the normalized ingress decision before acknowledgement;
  acknowledgement is initiated before even synchronous handler work, which
  continues in the scoped serialized Runner driver. Concurrent retries for one
  Events API identity share one bounded in-flight acceptance through ACK
  settlement. Capacity is reserved independently per configured workspace.
  Unknown, malformed, ambiguous, and identity-less envelopes share a separate
  bounded quarantine partition, so they cannot consume configured workspace
  capacity. Coalescing ownership remains until durable processing is terminal
  and every dynamically attached acknowledgement has settled.
  Each work thread has at most one active scoped driver regardless of queued
  event count. Durable event and channel/timestamp message identities absorb
  later retries and duplicate mention/message subscription delivery while still
  waking the active driver, or starting one when persisted work needs recovery.
- Production ingress defensively decodes Events API callbacks and normalizes
  public/private channel roots and replies, human/external-bot/Laborer authors,
  original text, edits, deletes, system records, blank messages, and excluded
  DM/MPIM channel kinds. Startup derives Slack identity with `auth.test`.
- Live configured-handler mode wires the fail-closed atomic filesystem store
  and fresh process boundary into a scoped Socket Mode resource. Listener removal,
  disconnect, and in-flight fiber/process interruption are scope-finalized.
- Each live Runner holds one OS-enforced, root-scoped loopback TCP lease for its
  full lifetime before durable-state load. Acquisition is bounded and
  cancellation-safe even though the app-wide Slack receiver starts
  independently. Filesystem boundaries combine `lstat`, canonical containment,
  no-follow opens, and descriptor-based chmod to reject symlink redirection.

### Local filesystem threat boundary

Sensitive config, snapshot, command, and handler-state operations retain and
fingerprint trusted parent directory descriptors, reject symlink leaves,
require parent directories to be owned by the current user (or root), and
reject group/world-writable parents. Node does not expose the required
`openat`/`renameat`/`execveat` primitives on macOS, so this prototype explicitly
trusts other processes running under the same OS UID. It does not claim race
safety against a malicious same-UID process; run only one trusted Runner and do
not mutate these paths while it is running.

## Remaining scope after these prototypes

- Production hardening, installation/packaging, and non-prototype work handlers.
  The tracked Bash handler and worktree initializer are an opt-in coding
  prototype, not a packaged or sandboxed production workflow.
- State migrations, retention, and operator retry/abandon CLI/UX. Live
  configured-handler mode uses the atomic filesystem store; Emulate scenarios
  retain the in-memory layer where they need inspectable isolation.
- Hard-crash process overlap and ambiguous real Slack delivery outcomes. Those
  accepted #201/#199 risks require process-level restart and real Slack tests.
- Automated Socket Mode reconnect fidelity and exact Slack rate-limit behavior,
  which Emulate does not implement. The thin production client delegates
  reconnect behavior to the official SDK.

## Emulate-specific evidence and workaround

Emulate 0.9 is useful for genuine stateful Web API HTTP behavior but differs
from Slack in two observed ways:

1. `conversations.replies` can truncate a small-limit result without returning
   `response_metadata.next_cursor`. The adapter still implements cursor
   pagination; for Emulate only, if the activation page lacks the canonical
   root it performs one official `WebClient` fallback read with `limit: 100`.
   This proves timestamp/context semantics, not Slack's cursor implementation.
2. `chat.postMessage` history identifies the configured bot by its bot user ID
   but omits `bot_id`. Tests validate the bot token with `auth.test`, assert the
   distinct bot user on every outbound message, and record this omission rather
   than fabricating a field.

Emulate startup uses bounded reserve/bind retries to safely handle the API's
required numeric-port TOCTOU window. Validation happens inside the acquired
scope, so a validation failure still closes the server. The explicit close API
returns a typed `EmulatorError`; the scope finalizer promotes such an error to a
defect because Effect finalizers cannot expose a typed failure after scope exit.
