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
>
> **THROWAWAY ACP STREAMING PROTOTYPE for issues #234 and #236.** The isolated
> `acp-conversation-prototype` composition uses official stable-v1 ACP over
> newline-delimited stdio and Emulate Slack. It preserves public ACP message
> boundaries, filters private activity, reuses sessions, and serializes turns.
> Emulate 0.9 does not implement Slack's native stream methods, so automated
> integration retains the `chat.postMessage` then `chat.update` fallback. It is
> test-only and does not replace the production `start:slack` ACP runtime or
> user Actions. Streamed Slack messages deliberately remain
> outside the durable outbox in this proof, so crash retry/replay of a partially
> delivered stream is not yet guaranteed.
>
> **DEDICATED LIVE ACP CANARY.** `start:acp-canary` composes the production ACP
> runtime under isolated credentials and state. It is a manual gate and must
> prove native streaming plus one Action/Execution scene.
>
> **PRODUCTION ACP COMPOSITION for issue #257.** `start:slack` uses
> the normal workspace registry, root lock, durable Runner and file Application
> state, Git and implementation-agent adapters, and native Slack streaming, but
> injects the durable ACP Conversation adapter. Each authenticated workspace
> owns one scoped ACP child and isolated workspace state. Incompatible startup
> quarantines only that binding. There is no legacy Conversation fallback and
> no dual publication or alternate production entrypoint.

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

To run the production lifecycle, use:

```sh
bun run start:slack
```

The ACP child receives only required runtime variables and application
environment names explicitly opted into by `laborer.json`; Slack, workspace
registry, and Laborer bridge or memory authority variables are removed. Project
OpenCode configuration remains authoritative. Ordinary questions create no
Action, Execution, branch, or worktree. The implementation-agent adapter stays
available for explicit coding Actions and is acquired lazily.

Public Conversation chunks in this composition are projected into the durable
Runner state before Slack delivery. The projection records semantic message and
chunk order, cumulative and confirmed hashes, Slack timestamps, and every
start/append/stop or post/update intent and outcome. Deltas after the first
visible chunk are coalesced until either 256 Unicode code points are pending or
the oldest pending delta is one second old. The durable per-workspace,
per-channel, per-method request budget spaces native starts and stops by three
seconds, native appends and fallback posts by one second, and fallback updates
by 1.2 seconds. Slack `Retry-After` extends that persisted schedule; each
operation has at most five attempts. The WebClient performs no hidden retries
and returns rate limits to the projection, and each HTTP attempt has a ten-second
deadline. A definitely rejected transient operation may retry, while an outcome
that could have reached Slack becomes explicitly unresolved instead of risking
duplicate public text. Cumulative fallback updates are the exception because
replay converges idempotently. Startup reconciles prepared and acknowledged
operations from the same workspace-scoped state. A native request that was in
flight when the daemon stopped remains unresolved because Slack provides no
exactly-once key for these methods.

Existing pre-ACP Conversations are adopted through the v15 migration ledger on
their first ACP-handled participant turn, provided they have no ACP binding or
live Execution. Laborer durably fixes the triggering-message cutoff before a
dedicated `conversations.replies` read, then retains the newest chronological
suffix up to 90 days, 200 messages, and 256 KiB including trust and degradation
markers. The snapshot uses current visible Slack text, excludes the triggering
turn, and is reference-only untrusted data; Agent context remains a separate
authoritative input. Reads have bounded pages, requests, time, and transient
retries. Permanent or exhausted reads seed an explicit partial/unavailable
marker rather than invented history. The ledger persists only digest, counts,
range, truncation, and sanitized diagnostic codes. A fresh ACP session and its
deterministic seed attempt are never blindly repeated: an uncorrelatable
`session/new` boundary becomes unresolved for operator recovery, while a
persisted binding resumes the existing fresh ACP session and seed admission uses
the normal no-blind-replay prompt ledger. Later participant and Execution events
remain in the Runner FIFO until adoption is terminal.

ACP tool permissions are fail-closed and one-shot. Laborer posts only a safe
category, the authorized Slack actor, and **Allow once** or **Reject** controls;
tool arguments and ACP titles stay private. A decision is durably claimed before
Socket Mode acknowledges the interaction, and stale, replayed, or cross-actor,
thread, session, and workspace clicks cannot authorize work. Pending authority
is bounded to 4 requests per turn, 16 per Conversation, and 64 per workspace;
the authority file is capped at 1 MiB. Terminal Slack control removal has a
separate bounded durable outbox: transient and rate-limit failures retry with
`Retry-After` or bounded backoff, while exhausted or permanent failures remain
locally diagnosed and never restore authority. At most 64 unresolved
presentations are admitted. Capacity is checked durably before Slack posting;
the next request fails closed without evicting any older cleanup obligation.
Successfully applied terminal updates are removed immediately. Explicit
permanent diagnostics are retained for seven days before compaction, and the
outbox remains bounded to 128 records and 128 KiB.
Before posting controls, Laborer persists a random non-secret presentation
marker and sends it in Slack's documented `chat.postMessage.metadata`
`event_payload`. The installed `@slack/web-api` `chat.postMessage` contract does
not expose `client_msg_id`, so it is not treated as an idempotency key. After an
ambiguous post or real process restart, a bounded `conversations.replies` lookup
with `include_all_metadata` accepts exactly one same-workspace, same-thread,
Laborer-authored message carrying that marker, recovers its timestamp, and
applies the already-durable terminal state. The 30-second live retry deadline is
separate from durable reconciliation retention: ambiguous intents remain for
seven days after permission expiry, and every startup in that window performs
at least one exact-scope lookup. A still-unresolved intent becomes an explicit
retained diagnostic when that window expires. Missing, duplicate, wrong-thread,
wrong-bot, and wrong-workspace candidates never regain decision authority.

Effective metadata distinguishes the ACP implementation (`OpenCode` and its
version) from the selected Conversation agent/mode. A single keyed aggregate
covers every admitted environment name and value; the readable name list is
bounded diagnostic data, and neither values nor per-secret digests are persisted.
OpenCode configuration binding inventories at most 128 regular files, 256 KiB
per file, 1 MiB total, and 6 directory levels. It covers project
`opencode.json[c]`, project `.opencode` config/resources, deterministic global
XDG config/resources, and deterministic global `auth.json`. An ordinary root
`skill/` directory is not an OpenCode source. Symlinks and source-identity
changes fail closed; limit overflow is explicitly marked incomplete. The
persisted binding contains only keyed aggregate content/path digests and category
counts, not paths or source values. OpenCode's pinned version covers built-in
native tool behavior; source hashes cover user policy, MCP, plugins, skills,
commands, and tools. OpenCode exposes no complete redacted effective manifest,
so remote/managed runtime provider and plugin behavior remains OpenCode-owned
and the metadata records that limitation instead of inventing a manifest.

The exact supported runtime matrix and sole green cutover signal are documented
in [`docs/acp-runtime-matrix.md`](./docs/acp-runtime-matrix.md). The deployment,
manual live-acceptance gate, and rollback policy are in
[`docs/acp-production-cutover.md`](./docs/acp-production-cutover.md).

## Run the production-runtime OpenCode ACP canary later

This Slack-connected live step is deliberately **not** part of automated
acceptance. The canary uses the production ACP supervisor, Action/Execution MCP,
permission interactions, durable native stream projection, adoption, and
recovery under dedicated Slack credentials and the isolated
`acp-canary:<team>` runtime namespace. It has no legacy Conversation path.

For a later human smoke test, create and install a **separate Slack app** for the
canary. Reusing the production Slack app is unsafe: Socket Mode delivers each
event to only one connection, so two connections for one app can steal events
from each other even when they serve different Laborer roots. The dedicated app
and installation are mandatory, and its bot must be invited to the smoke-test
channel separately.

Provide only the explicitly named canary credentials in the launch environment:

```dotenv
LABORER_ACP_CANARY_SLACK_APP_TOKEN=
LABORER_ACP_CANARY_SLACK_BOT_TOKEN=
```

The command never falls back to `SLACK_APP_TOKEN` or `SLACK_BOT_TOKEN`; missing
or wrong-kind canary credentials fail startup, as do canary credentials equal
to production credentials present in the same environment. Neither production nor canary
Slack credentials cross into the ACP child environment. Once the separate app
is installed, ensure the `opencode` CLI is authenticated and run from `next`:

```sh
bun run start:acp-canary
```

The explicit command defaults to `opencode acp`, with the configured
`LABORER_ROOT` (or this `next` directory) as both process cwd and ACP session
working context. It initializes ACP once, creates one in-memory ACP session per
accepted Slack work thread, reuses that session for follow-up turns while the
canary lives, and streams each public ACP message through Slack's native
`chat.startStream`, `chat.appendStream`, and `chat.stopStream` methods. Appends
carry only new ACP text. Both native streaming and the post/update fallback
limit one logical public message to Slack's documented 12,000-character
`markdown_text` hard bound, counted as Unicode code points so surrogate pairs
are never split. Every started stream is
stopped when the turn exits, including after partial ACP failure, defects, or
interruption. This avoids the permanent `(edited)` marker produced by the
Emulate-only post/update fallback. The stream recipient is the latest human in
the turn. Native streaming uses the authenticated local workspace team ID:
Socket ingress already quarantines Slack Connect, Enterprise, and otherwise
ambiguous authorization envelopes through `isOrdinaryWorkspaceEvent`, so this
path follows that existing boundary rather than adding external-team support.
Press Ctrl-C to close its Effect scope, disconnect Slack, close ACP stdio, and
reap the supervised child. Stop failures are attempted independently for every
stream: a stop failure after otherwise successful ACP work becomes a sanitized
delivery failure, while an existing ACP failure remains the primary turn
outcome. The live canary requires one `create-feature` Action through
implementation and the final ACP result as an explicit operator gate. When
composed with the reference Application repository, each logical Conversation
stores a separate generation-numbered binding containing the opaque ACP session
ID, its original canonical cwd, introduced and pending human Slack IDs, and an
explicit `pending`, `submitting`, or `initialized` phase. A separate nullable
ambiguous prompt ID records which logical prompt must not be replayed without
changing whether a replacement session still needs initialization. Legacy
schema-v1 snapshots decode explicitly through schema v2 and schema v3 into
schema v4 with no invented ambiguity, so a deterministic logical session ID is
never mistaken for an opaque transport ID. Conversation prompt staging,
transition to `running`, new bindings, and participant additions all require a
fully `Published` repository transaction before ACP submission; an ancillary
post-rename directory-sync failure therefore prevents the call. File-backed mutations use an adjacent
owner-only SQLite `BEGIN IMMEDIATE` lock, reread the latest snapshot while
locked, and publish atomically; generation CAS therefore remains valid across
independent processes. The initialization phases make each crash boundary
explicit. `pending` safely retries the initial snapshot; `submitting` treats
submission as ambiguous and retains its pending introductions; `initialized`
never replays them. Application recovery submits an exact persisted running turn
only when its binding is absent or is `pending` without an ambiguous prompt ID,
which proves the prompt was not submitted. For ambiguous or otherwise
non-pending running turns, recovery
resumes or safely rebinds the ACP session to reconcile process health, emits no
prompt or public output, and returns a conservative failure so the Application
keeps the turn running rather than claiming model completion. Issue #253 will
add operator resolution and explicit blocking for this ambiguous state. On
restart, stable ACP v1
`session/resume` receives the original cwd and a freshly readiness-verified copy
of the exact workspace memory MCP configuration; `session/load` and transcript
replay are not used, and updates outside an active prompt are dropped. Only an
exact pinned-OpenCode session-not-found response or ACP `ResourceNotFound`
response with its canonical message and either no URI or the requested session
URI permits an atomic generation replacement. Explicitly conflicting identity,
wrong-code, and wrong-message failures do not replace.
Pinned OpenCode 1.18.4 first calls the backing SDK `session.get` during
`session/resume`. Its missing-session HTTP error is not an ACP tagged error, so
`fromUnknownError` serializes it as the otherwise-generic JSON-RPC shape
`-32603 / "Internal error: OpenCode service failure" / {service:"session"}`.
Laborer never replaces from that shape alone: only for the pinned OpenCode
identity with advertised `session/list` support does it exhaust the cwd-scoped
list (bounded to 100 cursor pages) and classify unavailable when the exact
session ID is absent. The same wire failure with the session still listed
remains a quarantining service failure.

Slack public projection is intentionally narrower than ACP transport intake.
ACP still accepts up to 1 MiB of public output as a transport-safety bound, but
each logical message projected to Slack may contain at most 12,000 Unicode code
points because both [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage)
and [`chat.update`](https://docs.slack.dev/reference/methods/chat.update) impose
that limit on `markdown_text`; `chat.update` instead hard-fails `text` above
4,000 characters with `msg_too_long`. The fallback sends agent-authored
Markdown only as `markdown_text`. Slack forbids combining that field with
`text` or `blocks`, so duplicating the body into a top-level accessibility
fallback would itself be invalid; Slack's top-level `text` accessibility
guidance applies when composing block messages, which this projection does not
use. The installed official `@slack/web-api` 8.0.0 request types model
`markdown_text` as the same exclusive message-content variant for post and
update. If the next ACP chunk
would cross 12,000 code points, Laborer rejects that chunk, finalizes the
already-confirmed native stream or fallback message in place, marks the
Application event failed, and posts the existing sanitized failure notice as a
separate operational item. Recovery retains the terminal evidence and does not
repost or update the partial message.
An unavailable replacement preserves the old ambiguous prompt ID while
remaining `pending`; recovery therefore cannot replay the old prompt, while a
later newly allowed turn still sends current Soul, Workspace memory, and all
introduced, pending, and newly observed participant profiles exactly once.
Capability, protocol, registration, and transport failures remain private,
quarantine the affected work, poison and reap the shared ACP process, and never
silently replace it. Durable mode requires advertised `session/resume` support
before creating its first session. Generic durable agents must also negotiate
`laborer.dev/prompt-epoch/v1`: Laborer offers it in client capability `_meta`
and requires the agent capability response before `session/new`. A replacement snapshots current Soul,
Workspace memory, and relevant profiles, then becomes the binding resumed by
later processes. Slack participant-name enrichment admits at
most four concurrent `users.info` requests per authenticated workspace. Each
lookup has a five-second total deadline including capacity wait. Every newly
introduced human is enriched; only lookups that fail or time out fall back to a
stable Slack-ID name; one bounded local summary covers a prompt's fallbacks.
Every bootstrap and conversation `session/new` carries an equivalent trusted
configuration for one stable workspace-bound `laborer-memory` MCP server and
tool identity. Same-name process-global replacements are serialized, wait for
authorized memory call lifecycles to finish, and independently prove readiness
before exposing the new session. Unresolved calls remain process-owned after
their conversation session is invalidated. A drain timeout atomically poisons
the ACP process, claims every session, and clears its permission, lifecycle,
turn, and registration state before shutdown; later handles cannot reuse it.
Claim starts one shared detached cleanup that every reaper and scope shutdown
awaits, so interrupting the caller cannot strand child or session release.
Immediately before each ACP prompt, after all context and profile work, an
atomic health check verifies that the process is healthy and the same session
reference and generation remain registered to the conversation.
Public agent chunks additionally require a verified current-prompt epoch. The
portable Laborer extension sends an unpredictable ACP request `_meta` epoch and
opens publication only when the agent echoes it in a session update. Pinned
OpenCode does not emit live `user_message_chunk` updates: its resume tests emit
no transcript chunks, its event bridge emits only assistant deltas, and its
ascending `msg_` IDs encode a full 48-bit millisecond-plus-counter order in the
first twelve hexadecimal digits. Laborer accepts only the reviewed OpenCode
identity and version 1.18.4, waits at most 25 ms for a later local
clock tick before sending `session/prompt`, and requires the full order to be
strictly greater than both that boundary and every previously observed order.
Older or same-prior-tick delayed IDs remain suppressed. Agents that
provide neither marker have every public chunk suppressed, then fail and poison
the process at prompt completion rather than risking replay; extension-based
agents additionally have five seconds to echo the marker before cancellation
and poison cleanup. A completed prompt response allows a bounded two-second
transport-ordering grace for an already causal marker to arrive; time never
opens the epoch by itself. OpenCode is not subject to the first-token deadline
because its first valid current assistant chunk is itself the marker.
Pinned OpenCode response-only `end_turn`, `max_tokens`, and `refusal` outcomes
are valid textless settlements and leave publication closed. Although ACP v1
defines `max_turn_requests`, pinned OpenCode's reviewed prompt mapper does not
emit it, so a response-only instance remains fail-closed. `cancelled` is known
settled: Laborer completes the binding transition to clear submission ambiguity,
then returns a typed `signal` failure so the Application leaves the logical
prompt `running` and recovery never mistakes cancellation for successful model
completion or blindly replays it.
Registration and active-call drain waits have five-second deadlines. The sole
`memory` tool can add, replace, or remove
Workspace memory and validated Slack User-profile content; Soul is not mutable.
Writes are owner-only, atomic, cross-process serialized, and reread the
operator-editable Markdown while holding the lock. Root and workspace directory
identities are retained and rechecked before reads and writes, including
immediately around lock-database creation/open and diagnostic temporary-file
publication. Memory permission
is granted once only after a preceding pinned-OpenCode tool update identified
the exact generated tool, conversation session, and call ID; request titles are
never an authorization source. A bounded FIFO/LRU window retains the 64 most
recent consumed call IDs per session: immediate and near-term replay cannot
rearm `allow_once`. Eviction skips session-qualified calls that remain active;
fully active capacity denies new observations privately until a terminal update
makes safe progress possible. Ordinary inactive eviction permits legitimate
long-lived sessions to continue beyond 64 calls. Registration/readiness failure fails the
current operation and reaps the polluted ACP child instead of using it for a
fallback session. Scoped shutdown atomically claims each bootstrap or volatile
conversation session once before explicitly closing it. Durable conversation
sessions are detached so a later process can resume them; stdio is then closed
and the child reaped. Workspace
memory is limited to 4,000 rendered characters, User profiles to 2,000, and
profiles are created only by a successful mutation. Tool activity and bounded
registration or mutation diagnostics remain private rather than becoming Slack
messages. Routine maintenance chatter stays private, while explicit questions
about remembered information can still receive substantive answers. Because its dedicated Slack app owns a
separate app-wide event stream and its Runner state is in memory, the canary does
not take the production root lock and can run alongside the existing daemon.
Inbound ACP NDJSON is capped before reaching the official SDK's otherwise
unbounded line buffer: 2 MiB per line, 256 MiB over the canary-process lifetime,
and 250,000 non-empty records. Post-start child failure closes the transport,
and scoped cleanup waits after EOF, escalates through TERM and KILL, and treats a
child that remains unreaped after KILL as a cleanup defect. The common
unexpected-exit path is fixture-tested; synthetic injection of Node's rarer
post-spawn ChildProcess `error` event remains a low residual test gap.

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
   `chat:write`, `reactions:write`, and `users:read` bot scopes. It does not
   request `users:read.email`.
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
   `laborer-bug-to-pr` or `laborer-feature-to-pr` skill for a coding worker. The
   classifier and coding worker use the user's default OpenCode agent and
   configuration; the handler does not override plugins, tools, permissions,
   or approval policy. Later
   replies resume the persisted coding session without reclassification. Press
   Ctrl-C to disconnect cleanly.

Conversation agent and model selection come only from the user's OpenCode
configuration. Optional implementation-only selection lives under
`application.implementation.agent` and `application.implementation.model`.
Implementation sessions also inherit the selected OpenCode agent's permission
policy: Laborer never installs or restores a wildcard allow rule. Before it
reattaches or resumes a persisted session, a one-time migration removes every
exact `{ permission: "*", pattern: "*", action: "allow" }` entry left by the old
adapter through OpenCode's session API. All other rules and their order are
preserved; sessions without that exact entry are not updated. If inspection or
cleanup fails, the Execution stays unresolved and the session is not resumed or
prompted. Explicit allows execute, denies remain denied, and asks remain
approval-gated rather than being silently promoted. Because Laborer does not present implementation-agent
permission prompts in Slack, unattended coding Actions should use explicit
allow/deny policy; a pending ask can be interrupted through the normal Execution
cancel control or answered through OpenCode's own permission interface.
`LABORER_OPENCODE_COMMAND` overrides the executable for automated tests only.

### Expose a temporary Slack OAuth callback

The local installation flow can expose an OAuth callback server listening on
`127.0.0.1:8787` through Tailscale Funnel. Funnel is needed only while installing
the Slack app into another workspace; it is not part of ordinary Slack runtime
operation.

```sh
bun run slack:funnel:on
```

The command runs Funnel in the background and prints the public callback URL,
local target, and Slack app-management URL. It finds the macOS App Store
Tailscale binary automatically; set `TAILSCALE_BIN` to override the executable.
The command does not start the callback server itself.

Inspect or disable the Funnel with:

```sh
bun run slack:funnel:status
bun run slack:funnel:off
```

The off command resets the current Tailscale Funnel configuration. Do not use it
when the machine intentionally hosts another Funnel.

See [`docs/slack-local-secrets.md`](../docs/slack-local-secrets.md) for the
Keychain service names and the multi-workspace launch command. Slack credentials
must not be stored in `.env.local` because the reference initializer copies that
file into agent worktrees.

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
  `laborer-bug-to-pr` or `laborer-feature-to-pr` skill, and resumes the selected
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
3. Emulate 0.9 does not yet accept Slack's `markdown_text` request field. The
   scoped test fixture translates `markdown_text` to legacy `text` only at the
   final Emulate HTTP transport boundary. Production and direct official
   `WebClient` gateway tests send `markdown_text` without `text`.

Emulate startup uses bounded reserve/bind retries to safely handle the API's
required numeric-port TOCTOU window. Validation happens inside the acquired
scope, so a validation failure still closes the server. The explicit close API
returns a typed `EmulatorError`; the scope finalizer promotes such an error to a
defect because Effect finalizers cannot expose a typed failure after scope exit.
