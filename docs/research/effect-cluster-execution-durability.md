# Effect Cluster durability for long-running Actions

**Research date:** 2026-07-27

## Question

Can Laborer promote its conversation-to-execution Cluster prototype into an
Execution plane that lets many long-running Actions continue while the
reloadable Slack/Conversation daemon switches from blue to green? What does
Effect Cluster actually recover if the Execution host itself stops?

## Verdict

Yes, with one important boundary:

- The current prototype is a good starting point **if `SingleRunner`, the
  Workflow handlers, and the Action processes move into a stable Execution-host
  process that is not replaced during a daemon cutover**. Blue and green should
  be RPC clients of that one host. A blue client disconnecting does not require
  the host's running Workflow or Action to stop.
- The user's intuition about SQL durability is substantially correct: the
  Cluster workflow engine persists a journal of keyed workflow, activity,
  deferred, resume, interrupt, and clock messages plus their replies, and
  reconstructs unfinished work from that journal.
- It does **not** checkpoint a JavaScript fiber, arbitrary local variables, an
  open pipe, or an operating-system child process. If the Execution host dies,
  unfinished workflow code is run again from its handler entry point. Completed
  keyed activities replay their stored replies; an activity that had not stored
  a terminal reply is eligible to execute again. An external child process is
  preserved or adopted only if Laborer's Action adapter implements that
  supervision protocol itself.

This distinction is favorable for the blue-green requirement. The normal
cutover should replace only the daemon client, not the Execution host. Host
crash recovery is a separate, at-least-once execution problem.

The repository pins `effect` and its SQLite integration to
`4.0.0-beta.99`; the installed source is byte-identical to Effect's
`effect@4.0.0-beta.99` tag at commit
[`6184a7d`](https://github.com/Effect-TS/effect/tree/6184a7dc53cb9310e299b65ad6d6c712c2cbf202).
See [`apps/bot/package.json`](../../apps/bot/package.json) and
[`bun.lock`](../../bun.lock).

## What is persisted

`SingleRunner` is explicitly a single-process cluster implementation. It
always uses SQL-backed message storage, optionally uses SQL runner storage, and
uses no-op runner communication and health services. The source explicitly says
it is not multi-runner coordination
([`SingleRunner.ts` lines 25–74](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/SingleRunner.ts#L25-L74)).
Consequently, blue and green must not each start a competing `SingleRunner`
against the same SQLite file. One stable Execution host should own it.

The SQL message store creates these Cluster tables:

- `cluster_messages`: encoded request/control envelopes, entity address,
  payload, primary key, processed state, last reply, read lease, and delayed
  delivery time.
- `cluster_replies`: terminal exits and stream chunks, with uniqueness
  constraints per request.
- `cluster_migrations`, plus `cluster_runners` and `cluster_locks` when SQL
  runner storage is selected.

The message and reply schemas are visible in
[`SqlMessageStorage.ts` lines 687–919](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/SqlMessageStorage.ts#L687-L919).
A terminal reply marks the associated request processed in the same SQL
transaction that inserts the reply
([lines 459–468](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/SqlMessageStorage.ts#L459-L468)).
Unread or lease-expired requests without terminal replies are selected for
processing again
([lines 349–403](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/SqlMessageStorage.ts#L349-L403)).
When a runner acquires shards, it resets their read leases so recovery can
happen immediately rather than waiting for the normal lease expiration
([`Sharding.ts` lines 344–379](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/Sharding.ts#L344-L379)).

There is no separate persisted workflow-stack snapshot. Instead,
`ClusterWorkflowEngine` models the durable points as Cluster entity RPCs:

- `run` is persisted and keyed once per workflow execution.
- `activity` is persisted and keyed by activity name plus attempt.
- deferred completion and resume requests are persisted and keyed.
- clocks are persisted requests with a delivery time.

See
[`ClusterWorkflowEngine.ts` lines 644–760](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L644-L760).
The workflow handler is invoked from its beginning when the persisted `run`
request is handled
([lines 347–386](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L347-L386)).
On that replay, keyed activity and deferred lookups return already-persisted
replies rather than repeating completed durable steps
([lines 462–478 and 505–573](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L462-L573)).

Arbitrary effects between these durable boundaries are not journaled. A raw SQL
update, in-memory mutation, or child-process spawn placed directly in a Workflow
handler can therefore happen again after host recovery.

## Idempotency and durable primitives

A Workflow execution ID is the digest of its Workflow tag and the
application-supplied idempotency key
([`Workflow.ts` lines 316–317 and 421–460](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/workflow/Workflow.ts#L316-L460)).
Cluster then composes the storage primary key from entity type, execution ID,
RPC tag, and the RPC's own key
([`Envelope.ts` lines 402–433](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/Envelope.ts#L402-L433)).
SQL enforces uniqueness and returns the original request and latest reply when a
duplicate is submitted
([`SqlMessageStorage.ts` lines 406–451](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/SqlMessageStorage.ts#L406-L451)).

An `Activity` is durable at its encoded result boundary. Its execution effect
still runs in the current process, and its default interrupt policy retries an
interrupted effect before eventually defecting
([`Activity.ts` lines 116–200](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/workflow/Activity.ts#L116-L200)).
Cluster's activity message is keyed by activity name and logical attempt. A
completed reply is reusable; no completed reply means there is no evidence from
which Cluster could infer that an external side effect finished.

A `DurableDeferred` persists a named completion and causes an awaiting Workflow
to suspend until that completion can be read
([`DurableDeferred.ts` lines 128–164](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/workflow/DurableDeferred.ts#L128-L164)).
This is suitable for an Action-result wake or external completion token.

`DurableQueue` is not automatically supplied by `SingleRunner`. It delegates to
a separate `PersistedQueueFactory`, enqueues a stable item ID, attaches a
`DurableDeferred`, and suspends the Workflow while a worker processes the item
([`DurableQueue.ts` lines 171–226](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/workflow/DurableQueue.ts#L171-L226)).
The SQL queue store uses worker leases, refreshes those leases, and makes
unfinished rows available again after interruption or lease expiry
([`PersistedQueue.ts` lines 712–760 and 909–1071](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/persistence/PersistedQueue.ts#L712-L1071)).
That is durable, at-least-once queue processing; it is not adoption of the
previous worker's operating-system process.

## Process lifecycle behavior

### The daemon/client disconnects, but the Execution host stays alive

This is the desired blue-green case and is supported by the shape already used
in the prototype:

1. The caller submits `Workflow.execute(..., { discard: true })`.
2. The persisted `run` request is accepted and the caller receives its stable
   execution ID without waiting for completion.
3. The Workflow and its activities are owned by the Execution host, not by the
   RPC client's socket or scope.
4. Blue can exit, green can connect to the same host, and green can poll or
   consume an application outbox keyed by the execution ID.

Workflow `run` messages are both persisted and server-uninterruptible
([`ClusterWorkflowEngine.ts` lines 689–706](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L689-L706)).
Cluster also suppresses transient client interrupts for persisted messages
during shutdown or shard reassignment
([`entityManager.ts` lines 199–229](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/internal/entityManager.ts#L199-L229)).
Most importantly, the client process is not the process executing the Action in
this topology.

### The Execution host stops and restarts

During graceful Cluster shutdown, active durable requests are interrupted
without storing that interruption as their terminal result; the source says
they will be retried when the entity restarts
([`entityManager.ts` lines 199–229](https://github.com/Effect-TS/effect/blob/6184a7dc53cb9310e299b65ad6d6c712c2cbf202/packages/effect/src/unstable/cluster/internal/entityManager.ts#L199-L229)).
After an ungraceful process death, the same lack of a terminal reply leaves the
request eligible for SQL redelivery.

On restart, the Workflow handler is reconstructed and run from its entry point.
Completed activities, deferreds, and clocks replay from their keyed replies.
An unfinished activity has no terminal reply and can execute again. Effect
Cluster contains no child-process PID, process-start token, stdout offset, or
adoption protocol in these records.

Therefore:

- A child process continues through a **daemon cutover** because the separate
  Execution host never stops.
- A child process does not automatically continue through an **Execution-host
  restart**. Laborer must choose and implement one of:
  - an idempotent external service keyed by `executionId`;
  - a persisted process identity plus a probe/adopt/reconcile protocol;
  - or an at-least-once relaunch policy whose outputs are deduplicated.

Whether a Unix child happens to remain alive after its parent is killed is not
a Cluster guarantee and is insufficient without a way for the new host to
identify and communicate with that child.

## Assessment of Laborer's current tracer

The existing
[`conversation-execution-tracer-prototype`](../../apps/bot/src/conversation-execution-tracer-prototype/README.md)
proves useful pieces:

- deterministic Workflow execution IDs;
- `discard: true` asynchronous acceptance;
- typed RPC over a Unix socket;
- shared SQLite-backed Cluster and application persistence;
- an application outbox with a stable terminal event ID;
- serialized Conversation events and exactly one observable terminal wake.

The proof still co-locates the Conversation runtime, RPC server,
`SingleRunner`, Workflow handlers, and outbox pump in one Bun process
([`demo.ts` lines 193–224](../../apps/bot/src/conversation-execution-tracer-prototype/demo.ts)).
Its Workflow body performs ordinary SQL writes and sleeps directly rather than
using `Activity`, `DurableDeferred`, or `DurableQueue`
([`demo.ts` lines 101–139](../../apps/bot/src/conversation-execution-tracer-prototype/demo.ts)).
It deletes its scratch directory at startup and explicitly reports
`child-processes=0`
([`demo.ts` lines 44–49 and 783–786](../../apps/bot/src/conversation-execution-tracer-prototype/demo.ts)).

The prototype passed locally during this research:

```text
PASS action     start=queued; duplicate execution id; workflow-runs=1
PASS wake       queued/running=0; terminal=1
VERDICT two peer runtimes in one Bun root work for this tracer
```

That is evidence for the logical boundary, not yet for process isolation or
restart behavior. It can be promoted as a scaffold by:

1. moving the execution RPC server, `SingleRunner`, Workflow layers, Action
   supervision, and the write side of the terminal outbox into one stable host;
2. moving Conversation handling and outbox consumption into replaceable daemon
   generations;
3. sending an immutable, versioned Action invocation descriptor to the host;
4. keeping one stable `executionId` and one versioned event envelope across old
   and new daemon generations.

New Actions may start through green immediately while Actions submitted through
blue continue in the host. No old daemon generation needs to remain draining
for hours.

## Smallest decisive process-level test

Extend the tracer into three real processes using one temporary SQLite database:

1. **Execution host:** owns one `SingleRunner`, Workflow registrations, the
   execution RPC socket, durable outbox writes, and several fixture Action child
   processes.
2. **Blue client:** starts at least three blocked Actions using stable,
   distinct execution IDs, verifies asynchronous acceptance, then exits.
3. **Green client:** starts only after blue has exited, connects to the same
   host, reads all running executions, releases the fixture gates, consumes the
   durable terminal events, and acknowledges them.

The test must assert:

- the Execution-host PID and every fixture Action PID are unchanged across the
  blue-to-green cutover;
- blue's exit sends no signal to the Action children;
- green becomes operational before any Action finishes;
- each start key produces one Workflow execution and one child-process launch;
- Actions completing while no daemon client is connected are still delivered;
- green accepts old-version event envelopes and produces exactly one
  Conversation wake per terminal event;
- a new Action started by green can run alongside the older Actions.

Add a separate host-crash subcase, or a follow-up test, that kills the Execution
host during an `Activity` and restarts it on the same database. It should prove
that the unfinished activity executes again unless the fixture adapter
implements adoption. Keeping that assertion explicit prevents SQL workflow
durability from being mistaken for exactly-once external process execution.
