# Slack-to-handler tracer bullet and live fixture smoke

> **THROWAWAY LOGIC PROTOTYPE for issue #204.** This is a local vertical proof,
> not the production Runner. Every file under `src/prototype/` exists only for
> this tracer.

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

## Run the live Slack fixture smoke mode

> **FIXTURE MODE ONLY.** `start:slack` connects the production Socket Mode and
> Web API adapters to a real workspace, but deliberately invokes the committed
> `src/prototype/fixture-handler.ts`. It is not arbitrary-handler support and
> cannot be configured to execute a command or shell string.

### Provision the app manually

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App**, then
   **From an app manifest**.
2. Select the development workspace, choose YAML, and paste the complete
   contents of [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Review and
   create the app. The manifest enables Socket Mode, creates the Laborer bot,
   subscribes only to `app_mention`, `message.channels`, and `message.groups`,
   and requests only `app_mentions:read`, `channels:history`, `groups:history`,
   and `chat:write` bot scopes.
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
6. In each public or private channel used for the smoke test, invite the app
   with `/invite @Laborer`. The app cannot read or reply in a channel it has not
   joined.
7. Start the Runner from `next`:

   ```sh
   bun run start:slack
   ```

8. In an invited channel, post a new nonblank message such as
   `@Laborer fixture smoke`, then reply in its thread. The fixture posts an
   intentionally obvious `[PUBLIC ...]` echo for each turn. Press Ctrl-C to
   disconnect cleanly.

Live state is stored in ignored `next/.laborer-runtime/`. Its state and
work-thread directories are forced to owner-only permissions, and the atomic
filesystem snapshot fails closed if it is corrupt or unwritable. Delete or
inspect this directory only while the Runner is stopped. A root-derived
exclusive loopback TCP lease is acquired before `auth.test`, Socket Mode, or
snapshot loading; a second Runner fails closed, clean shutdown releases the
lease, and a crash-stale nonsecret marker is safely replaced only by the new
lease owner. Runtime, lock, snapshot, and handler-state paths reject
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
  versioned JSON envelope to stdin, incrementally parses protocol-only NDJSON,
  enforces the 1 MiB record limit before a newline or EOF, ignores valid unknown
  record types, rejects malformed records, and persists accepted `public_reply`
  records before process completion.
- `replyId` replay with identical text is idempotent; conflicting text is a
  terminal protocol outcome. Valid replies survive malformed output or nonzero
  exit and precede the sanitized operational notice.
- Stdout is never implicitly public and stderr remains internal. The fixture's
  secret diagnostic text is asserted absent from Slack.
- The process adapter uses a POSIX detached process group, the #203 two-hour
  deadline, TERM then a ten-second KILL fallback, waits for process reap, caps
  inherited-pipe draining, forces every new or existing handler state directory
  to owner-only `0700`, and performs scoped cleanup. An interrupted attempt is
  recorded as such and replayed invisibly with the same turn ID and a new
  attempt.
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
  It fails closed without repair on impossible, corrupt, unreadable, or
  unwritable snapshots, closes handles on every path, and cleans temporary
  files; it is not the demo's persistence backend.
- Effect services are narrow `Context.Service` contracts assembled with
  `Layer`s. Boundary/domain records use `Schema` classes and branded IDs;
  expected failures use tagged schema errors; resources use scopes.
- The live adapter acknowledges each Socket Mode envelope before normalization
  or asynchronous Runner work, then injects the existing normalized ingress
  boundary. Durable event and channel/timestamp message identities absorb Slack
  retries and duplicate mention/message subscription delivery.
- Production ingress defensively decodes Events API callbacks and normalizes
  public/private channel roots and replies, human/external-bot/Laborer authors,
  original text, edits, deletes, system records, blank messages, and excluded
  DM/MPIM channel kinds. Startup derives Slack identity with `auth.test`.
- Live fixture mode wires the fail-closed atomic filesystem store and fresh
  process boundary into a scoped Socket Mode resource. Listener removal,
  disconnect, and in-flight fiber/process interruption are scope-finalized.
- Live startup holds one OS-enforced, root-scoped loopback TCP lease for its
  full lifetime before any Slack connection or durable-state load. Filesystem
  boundaries combine `lstat`, canonical containment, no-follow opens, and
  descriptor-based chmod to reject symlink redirection.

## Remaining scope after this live smoke adapter

- A production `laborer.json` loader, PATH/executable validation,
  installation/packaging, and a real user work handler. The child is a fixture
  that exercises the real adapter/parser/supervisor boundary.
- State migrations, retention, and operator retry/abandon CLI/UX.
  Live fixture mode now uses the atomic filesystem store; Emulate scenarios
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
