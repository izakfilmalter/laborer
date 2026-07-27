# Development daemon live reload

**Status:** Ready for implementation

## Summary

Add a development-only supervisor that replaces the running Laborer daemon with
a freshly loaded Daemon generation after source changes. The supervisor prepares
green while blue continues serving, asks blue to stop scheduling new work,
allows generation-owned work to finish, transfers exclusive runtime ownership,
and activates green against the existing durable state.

This is warm process replacement, not in-process hot module replacement and not
active-active processing. At most one Daemon generation owns Slack ingress,
Runner state, workspace locks, ACP process supervisors, or daemon-owned Action
processes at a time.

The operator starts it with:

```sh
bun run --cwd next dev:slack
```

`start:slack` remains the production entry point and keeps its current lifecycle.

## Current evidence

The throwaway
[blue/green reload prototype](../next/src/blue-green-reload-prototype/README.md)
proves the intended single-owner state transition:

```text
blue active → blue draining + green prepared → blue released → green active
```

The production ACP composition already has a separate per-workspace ACP process
supervisor. It owns ACP child generations, prompt admission, bounded restart
episodes, durable health, session detachment, and later session resume. Daemon
live reload must compose above that module rather than duplicate or bypass it.

The missing production seams are:

- Runner admission currently persists and schedules work in the same operation;
- `start:slack` owns its Socket Mode connection and workspace scopes directly;
- a second daemon correctly fails to acquire the exclusive Runner locks; and
- no stable parent process currently coordinates a prepared candidate, drain,
  ownership release, activation, or rollback.

## Goals

- A valid source edit can replace the live development daemon without an
  operator finding a globally idle moment.
- A candidate that cannot typecheck, load, or prepare leaves the active
  generation untouched.
- An ACP prompt or daemon-owned Action process is never interrupted merely to
  satisfy a reload deadline.
- Slack and application events accepted while blue drains are durable, are not
  scheduled in blue, and are processed once by green.
- A conversation continues through its existing durable ACP session after
  cutover; the prompt that allowed blue to drain is neither replayed nor
  abandoned.
- Only one generation can mutate Runner, Application, ACP, Action, permission,
  stream, or workspace state at a time.
- A green activation failure releases green's partial ownership and attempts to
  reactivate the still-loaded blue code.
- Reload behavior is deterministic and testable offline with fake Slack, fake
  ACP, fixture processes, and temporary runtime roots.

## Non-goals

- Production deployment, `launchd` updates, packaging, or companion-driven
  daemon updates.
- Active-active daemon generations or routing unrelated conversations to green
  while blue still owns other conversations.
- A permanently resident Slack ingress broker.
- A guarantee that Slack has no connection gap. Laborer's guarantee begins when
  an event has been durably accepted.
- Transferring a live WebSocket, ACP stdio connection, operating-system child,
  or in-memory Runner between processes.
- Detaching or adopting ordinary user scripts that are owned by a generation.
- Supporting persistence changes that old and new code cannot both decode.
- Reloading dependency installation, Node itself, environment variables, or the
  supervisor's own code without restarting `dev:slack`.

## Canonical lifecycle

A Daemon generation has one of four externally meaningful phases:

- **Prepared** — its code and configuration have loaded, but it owns no
  workspace lock, durable runtime, Slack connection, ACP child, or Action child.
- **Active** — it exclusively owns the daemon runtime and may accept and
  schedule work.
- **Draining** — it retains exclusive ownership and continues durable
  acceptance, but it starts no new work.
- **Released** — all ingress and generation-owned resources are closed and all
  workspace locks are released.

The ACP process supervisor's numbered child generations remain a distinct
concept. A new Daemon generation reconstructs one ACP process supervisor per
ready workspace; those supervisors resume existing durable ACP sessions when
the next prompt needs them.

At every observable point:

1. zero or one Daemon generation owns runtime state;
2. only the owning generation may be Active or Draining;
3. a Prepared generation cannot read or write exclusive runtime state; and
4. green cannot become Active until blue is Released.

## Operator workflow

1. Run `bun run --cwd next dev:slack`.
2. The supervisor starts the initial generation and prints its generation ID
   when it becomes Active.
3. Saving a TypeScript source change under `next/src` schedules one debounced
   reload.
4. While a candidate is only preparing, blue remains fully Active.
5. Once green is Prepared, blue becomes Draining. Messages arriving during this
   period are accepted durably and wait for green.
6. When blue releases ownership, green activates and startup recovery drains
   the queued work.
7. The supervisor reports preparation, drain, release, activation, rollback,
   and failure using bounded diagnostics.
8. Ctrl-C stops the supervisor, any Prepared candidate, and the owning
   generation through the existing explicit shutdown path.

Edits that arrive during candidate preparation supersede that candidate before
draining begins. Edits that arrive after draining begins are coalesced into a
subsequent reload; the current handoff completes rather than reopening blue's
admission gate.

The first implementation watches `next/src/**/*.ts`. Changes to dependencies,
environment, package metadata, or the supervisor itself require restarting
`dev:slack`.

## Module shape

### Development daemon supervisor

The file watcher and command entry point use one deep module:

```ts
interface DevelopmentDaemonSupervisor {
  readonly reload: Effect.Effect<ReloadOutcome, ReloadError>
  readonly status: Effect.Effect<DaemonSupervisorSnapshot>
}
```

Construction is scoped: acquiring the module starts the initial generation and
closing its scope ends every owned process. Callers do not coordinate individual
generation phases. `reload` serializes replacement attempts and returns a
bounded outcome such as `Activated`, `PreparationRejected`, `RolledBack`, or
`Unavailable`.

The implementation hides:

- source debouncing and stale-candidate rejection;
- typecheck and candidate preparation;
- child-process IPC;
- drain aggregation across workspace Runners and generation-owned processes;
- Socket Mode sealing;
- workspace-lock handoff;
- activation and rollback; and
- child cleanup after success or failure.

### Generation control

Each child has a small, versioned, schema-decoded IPC protocol. Supervisor
commands are:

```text
activate
drain
stop
```

Generation reports are:

```text
prepared
active
released
failed
```

Reports carry only protocol version, generation ID, phase, and a bounded reason
code. They never carry Slack payloads, prompts, credentials, environment
values, filesystem content, ACP traffic, or child output.

The child emits `prepared` after loading the application modules, decoding its
configuration, resolving configured roots, and completing checks that require
no exclusive runtime resource. Preparation must not acquire Runner locks,
construct stores that publish state, authenticate workspace bindings, connect
Socket Mode, start ACP process supervisors, or spawn Actions.

### Runner quiescence

Extend the Runner interface with one operation:

```ts
readonly quiesce: Effect.Effect<void, RunnerError>
```

`quiesce` is idempotent. It atomically closes scheduling admission and waits
until every already-admitted thread driver has finished. The scheduling gate and
thread-driver registry must change under one synchronization decision so an
acceptance cannot race between the idle observation and gate closure.

After the gate closes:

- `accept` and `acceptApplicationEvent` still validate and durably persist;
- successful acceptance reports scheduling as `Deferred`;
- duplicate acceptance remains idempotent;
- retries and every other scheduling entry point honor the same gate;
- no new acknowledgement, thread, Application, ACP prompt, or configured
  handler driver starts; and
- the next Runner instance discovers and drives the persisted work through its
  existing startup recovery.

The existing per-thread `drain(threadId)` operation keeps its current meaning.
It must not be repurposed for generation quiescence.

## Reload sequence

```mermaid
sequenceDiagram
    participant W as "Source watcher"
    participant S as "Development supervisor"
    participant B as "Blue generation"
    participant G as "Green generation"
    participant Slack

    W->>S: Source changed
    S->>S: Debounce and typecheck
    S->>G: Spawn fresh code
    G-->>S: Prepared
    S->>B: Drain
    Slack->>B: Event
    B->>B: Persist event; defer scheduling
    B->>B: Finish admitted prompts and owned processes
    B->>B: Seal ingress, flush, close scopes, release locks
    B-->>S: Released
    S->>G: Activate
    G->>G: Acquire locks and validate durable state
    G->>G: Recreate workspace and ACP supervisors
    G->>Slack: Connect Socket Mode
    G-->>S: Active
    G->>G: Recover deferred work
    S->>B: Stop
```

### Preparation

The supervisor runs the repository typecheck before spawning a candidate.
Typecheck failure is a preparation rejection and cannot affect blue.

The candidate loads current source in a fresh Node process. It validates all
configuration and pure startup inputs but does not touch exclusive state.
Prepared children have an activation deadline because no user work depends on
them; an expired candidate is stopped and blue remains Active.

### Draining

After green reports Prepared, the supervisor tells blue to drain. Blue asks
every ready workspace Runner to quiesce and waits without a destructive
deadline.

Draining waits for:

- every Runner driver admitted before gate closure;
- every active ACP prompt contained by those drivers;
- every ordinary script or implementation process whose operating-system
  lifetime is owned by the generation; and
- every ingress acceptance already crossing the durable-persistence seam.

A durable asynchronous Execution may outlive blue only when its execution
runtime already proves independent ownership and restart-safe event delivery.
The first implementation does not detach or adopt ordinary user scripts.

Blocked outbound items, dormant ACP sessions, queued turns, and durable
Execution events do not themselves block draining when no generation-owned
operation is still running.

### Sealing and releasing

Once admitted work is idle, blue:

1. removes the Socket Mode listener and disconnects its WebSocket;
2. waits for every already-received envelope to reach terminal acknowledgement
   handling;
3. verifies that Runner persistence is healthy;
4. closes workspace scopes, including ACP process supervisors, which detach
   resumable sessions and reap their ACP children;
5. closes any remaining generation-owned process scopes;
6. releases every unique Laborer-root lock; and
7. reports Released.

No green Slack connection opens before this point. Slack may route each payload
to any open Socket Mode connection, so overlapping blue and green receivers
would violate the single-owner design.

### Activation

Green activation is global across the configured daemon:

1. acquire every unique configured root lock;
2. read and decode all durable state without publishing mutations;
3. reject persistence that is incompatible with the candidate;
4. construct every workspace binding that was valid at preparation;
5. reconstruct its Runner and ACP process supervisor scopes;
6. connect the single Socket Mode receiver; and
7. report Active only after ingress can route to the reconstructed bindings.

Activation must not migrate or publish durable state before all locks and
read-only validations succeed. The first implementation supports only
backward-compatible persistence changes. A schema migration needs a separate
decision and recovery design.

Bindings already known to be invalid may remain unavailable. Failure to
reconstruct a binding that was ready in blue fails the candidate activation and
initiates rollback rather than silently shrinking daemon coverage.

### Rollback

Blue remains alive in Released phase until green reports Active. If green
activation fails:

1. green closes every partially acquired scope and releases all locks;
2. the supervisor sends `activate` to blue;
3. blue reacquires the same roots using its already-loaded code and validated
   configuration snapshot;
4. blue reconstructs its workspace runtimes and reconnects Socket Mode; and
5. the supervisor reports RolledBack.

There is one rollback attempt. If rollback also fails, the supervisor stops the
candidate, reports Unavailable, exits nonzero, and does not use a liveness timer
to kill or invent ownership. Durable runtime state remains available for the
ordinary `start:slack` recovery path.

After green reports Active, blue is stopped and cannot be used for a later
rollback.

## Slack and durability guarantees

Laborer acknowledges a Socket Mode envelope only after its normalized event has
crossed the existing durable acceptance seam. Blue continues this acceptance
while Draining.

The handoff guarantees:

- no durably accepted input is removed by reload;
- no deferred input is processed by both generations;
- no active ACP prompt is deliberately interrupted by reload;
- no completed prompt is replayed in green;
- durable ACP session identity is resumed rather than transcript-replayed; and
- persisted public-output and permission state use their existing recovery
  rules.

The handoff does not guarantee continuous Slack connectivity. There is a
bounded interval after blue disconnects and before green connects. Events not
yet delivered by Slack remain Slack's delivery responsibility. Eliminating that
gap would require a stable ingress broker and is not part of this design.

## Failure behavior

| Failure | Required result |
| --- | --- |
| Typecheck fails | Reject candidate; blue remains Active |
| Candidate exits before Prepared | Reject candidate; blue remains Active |
| New edit arrives before drain | Stop stale candidate; prepare newest source |
| New edit arrives during drain | Finish current handoff; schedule another reload |
| Blue does not become idle | Remain Draining; never force-kill for reload |
| Blue exits during drain | Confirm exit and cleanup, then activate green through ordinary durable recovery |
| Green cannot acquire every root | Release partial ownership and reactivate blue |
| Green cannot decode durable state | Publish nothing, release ownership, reactivate blue |
| A previously ready binding cannot start | Release green and reactivate blue |
| Green fails after reporting Active | Existing daemon and ACP crash-recovery behavior applies; do not resurrect released blue |
| Supervisor IPC closes | Generation begins explicit scoped shutdown and releases ownership |
| Ctrl-C | Cancel candidate, explicitly stop the owner, reap children, and exit |

## Observability

Development logs include:

- Daemon generation ID;
- phase transition;
- preparation, drain, activation, and rollback duration;
- number of ready, deferred, and unavailable workspace bindings;
- count of active Runner drivers and generation-owned processes; and
- bounded failure reason codes.

Logs exclude Slack content, prompts, tool arguments, ACP traffic, credentials,
environment values, and unbounded child output.

## Automated verification

All automated tests are offline and cross the same public seams used by the
implementation.

### Runner tests

- Hold one driver open, call `quiesce`, accept another event, and prove the
  second event is durable but not scheduled.
- Complete the first driver and prove `quiesce` resolves.
- Construct a new Runner and prove startup recovery processes the deferred event
  once.
- Exercise accept-versus-quiesce race hooks and prove there is no late driver.
- Prove Application events, retries, and acknowledgements cannot bypass the
  closed scheduling gate.

### Supervisor tests

- A preparation rejection leaves blue Active.
- Successful replacement follows Prepared, Draining, Released, Active with one
  owner at every observation.
- Rapid edits discard a stale Prepared candidate before drain.
- An edit during drain creates a subsequent reload.
- Green activation failure releases partial resources and reactivates blue.
- Rollback failure ends Unavailable without concurrent ownership.
- Ctrl-C stops candidate and owner without orphan fixture processes.

### Process-level tracer

Use real fixture child processes with fake workspace locks, fake Socket Mode,
temporary durable stores, and a fake ACP peer:

1. hold a blue ACP prompt open;
2. prepare green from a distinct fixture generation;
3. begin drain and deliver another Slack event;
4. prove blue persists but does not schedule that event;
5. complete the ACP prompt;
6. prove blue disconnects and releases before green acquires;
7. prove green performs `session/resume`, never repeats `session/new` or the
   completed prompt, and processes the deferred event once; and
8. prove no fixture process, socket, or lock remains after shutdown.

A separate fixture holds a daemon-owned Action script open and proves reload
waits for it without sending TERM or KILL.

### Multi-workspace tracer

- Quiesce two workspace Runners sharing one root plus one Runner on a distinct
  root.
- Prove each unique root is acquired and released once.
- Prove one slow workspace holds the global cutover while every workspace keeps
  durable acceptance.
- Prove green binding regression rolls the whole daemon back.

## Acceptance

The first implementation is accepted when:

- `bun run --cwd next dev:slack` starts one Active generation;
- a valid source edit during an ACP prompt prepares green without interrupting
  blue;
- a Slack message accepted during drain is processed once after cutover;
- the next turn resumes the same ACP session without transcript replay;
- an invalid source edit leaves blue serving;
- a green activation failure demonstrably reactivates blue;
- no reload timeout kills an active prompt or daemon-owned Action;
- every observed handoff has at most one runtime owner;
- production `start:slack` behavior is unchanged;
- focused tests and the complete `next` check pass without Slack credentials;
  and
- one explicitly requested live canary confirms a real Socket Mode reconnect
  and follow-up conversation under dedicated development credentials.

## Implementation slices

1. **Runner quiescence** — add the admission gate, `Deferred` scheduling result,
   race tests, and startup recovery proof.
2. **Generation child lifecycle** — extract `start:slack` composition into
   prepare/activate/drain/release scopes behind schema-decoded IPC.
3. **Development supervisor** — add source watching, typecheck, candidate
   freshness, process cleanup, and the `dev:slack` command.
4. **Rollback** — add read-only activation validation, released-blue
   reactivation, and activation-failure tests.
5. **ACP and Action proof** — verify prompt-boundary session resume and waiting
   for daemon-owned script processes.
6. **Multi-workspace proof** — aggregate Runner quiescence and perform global
   root ownership handoff.
7. **Promotion cleanup** — replace the throwaway state-machine prototype with
   production tests and update `next/AGENTS.md` with the real command and
   guarantees.
