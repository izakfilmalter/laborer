# Slack-to-handler tracer bullet

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
`WebClient` instances, injects normalized events below the future Socket Mode
adapter, launches one fresh fixture child process per turn, and prints the
store/process/Slack evidence. Cleanup is scope-finalized.

Run the adversarial proof with:

```sh
bun run check
```

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

## Deliberately outside issue #204

- Socket Mode transport, envelope acknowledgement, Slack reconnect/retry event
  delivery, and production event normalization. Tests inject the normalized
  boundary chosen by #200.
- A production `laborer.json` loader, PATH/executable validation, root lock,
  installation/packaging, and a real user work handler. The child is a fixture
  that exercises the real adapter/parser/supervisor boundary.
- A production atomic filesystem store wired into the Runner, migrations,
  retention, and operator CLI/UX. The tracer uses the in-memory Layer so tests
  remain local and inspectable.
- Hard-crash process overlap and ambiguous real Slack delivery outcomes. Those
  accepted #201/#199 risks require process-level restart and real Slack tests.
- Socket Mode and exact Slack rate-limit fidelity, which Emulate does not
  implement.

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
