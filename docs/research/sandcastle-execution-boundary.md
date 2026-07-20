# Sandcastle execution-boundary patterns for Laborer

## Research question

Which patterns from Matt Pocock’s Sandcastle should inform Laborer’s generic local command-and-working-directory execution boundary, and which Sandcastle-specific architecture should Laborer deliberately avoid inheriting?

## Scope and source basis

This report evaluates Sandcastle at commit [`e99f832f26dc9d245c019a9ddd19fa5dee792427`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427) (package version 0.12.0). It uses Sandcastle’s source, tests, ADRs, and first-party documentation rather than treating its public API as a generic contract.

Laborer’s target is narrower: invoke a user-configured local command in a configured directory once per serialized Slack turn, let that process exit, and publish only deliberate replies. Classification, models, agents, repositories, worktrees, pull requests, and continuation state remain user-workflow concerns.

## Answer in brief

Sandcastle’s most useful lesson is **not** its agent-provider abstraction. It is the separation of a small execution primitive from caller-owned workflow: resolve and validate execution context before spawning; deliver potentially large input through stdin instead of interpolating it into a shell command; treat exit status, protocol output, diagnostics, cancellation, and resource cleanup as distinct concerns; keep each continuation call to one explicit invocation; and expose capability-specific behavior only where its owner can implement it correctly.

For Laborer, the boundary should be smaller still:

1. A configured command and `cwd` determine where execution happens.
2. Each queued turn starts one fresh child process, writes one versioned turn envelope to stdin, closes stdin, consumes a deliberately narrow stdout protocol, waits for exit, and reaps the process.
3. The handler receives a stable work-thread identity and owns all continuation/session storage. Laborer must not inspect, copy, rewrite, or select agent session files.
4. Laborer owns supervision and delivery mechanics; the handler owns every workflow decision, including whether and how to reply publicly.

Sandcastle’s sandbox, Git/worktree, prompt, agent/model, iteration-loop, session-transfer, and template architecture should not enter Laborer core.

## Pattern-by-pattern findings

### 1. User-configured command and `cwd`

**Useful pattern.** Sandcastle made `cwd` an explicit per-entry-point option because changing process-global cwd prevents one process from safely targeting multiple repositories. It resolves relative paths against process startup cwd, converts the result to an absolute path, and fails before execution when it is missing or not a directory ([ADR 0002](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0002-cwd-option.md#L3-L20), [`resolveCwd`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/resolveCwd.ts#L11-L46)). Laborer should likewise resolve and validate its configured `cwd` without calling `process.chdir()`.

**Required adaptation.** Sandcastle does not accept an arbitrary command: an `AgentProvider` builds a provider-specific shell command and parses provider-specific JSONL ([`AgentProvider`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L202-L277)). Laborer should put the configured command at the boundary itself. Prefer an executable plus argv array in durable configuration; if the product intentionally accepts an opaque shell command, treat the whole string as trusted operator configuration and never concatenate Slack text into it.

**Recommendation.** Resolve the command configuration and absolute `cwd` at startup (and revalidate at invocation if disappearance must be detected). Report configuration failures before claiming a Slack turn. Keep inbound content entirely in stdin.

### 2. One ephemeral invocation per turn

**Useful pattern.** Sandcastle defines an iteration as one agent invocation, and its default `maxIterations` is one ([`DEFAULT_MAX_ITERATIONS`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L90-L92), [domain definition](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CONTEXT.md#L79-L87)). Its continuation API deliberately resumes for exactly one iteration because hiding multiple continuation choices inside one call makes session semantics ambiguous ([ADR 0011](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0011-resume-is-one-iteration.md#L1-L19)).

**Recommendation.** Laborer should enforce the stronger invariant needed by the Wayfinder destination: one dequeued turn equals one newly spawned process and one terminal process result. Messages arriving during that invocation stay queued; they do not become writes to a long-lived child. A follow-up turn is a fresh invocation with the same stable work-thread identity.

**Do not inherit.** Sandcastle also offers warm, reusable sandboxes whose installed dependencies and build artifacts persist between runs ([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L261-L345)). That is valuable for coding agents but violates Laborer’s “idle threads consume no process resources” proof and makes ownership after crashes harder. No warm handler, TUI, reusable sandbox, or internal iteration loop belongs in the prototype.

### 3. Input and output protocol

**Useful input pattern.** Sandcastle’s execution handle supports stdin explicitly to avoid Linux’s per-argument size limit, and its agent providers prefer stdin for large prompts ([`PrintCommand` and execution contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L217-L223), [`SandboxProvider.exec`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L23-L47)). Its literal-inline-prompt rule also protects forwarded user content from accidental `{{...}}` or shell-expression interpretation ([ADR 0008](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0008-inline-prompts-skip-processing.md#L1-L18)).

Laborer should write a versioned JSON turn envelope to child stdin and close it. Slack message text must remain data, never command-line syntax, shell interpolation, template syntax, or environment-variable content. The envelope should include the stable Laborer work-thread ID, a unique turn/delivery ID, normalized inbound message data, and enough Slack references for the handler to reason about the turn without granting it control of Laborer’s delivery bookkeeping.

**Useful output pattern.** Sandcastle normalizes diverse JSONL streams to a small event vocabulary and ignores unknown event types defensively ([provider interface](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L264-L277), [provider-author guidance](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/agents/adding-an-agent-provider.md#L134-L139)). It also distinguishes a termination marker from a typed payload instead of conflating “done” with “the result” ([ADR 0010](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0010-structured-output.md#L1-L14)).

**Required adaptation.** Laborer should not normalize agent events. It should define its own small, versioned handler protocol. A strong default is NDJSON on stdout, where only explicit records such as `public_reply` are publishable; stderr is diagnostic output. Unknown record types can be rejected or ignored according to the protocol version, but arbitrary stdout must never become a Slack reply. Process EOF plus exit status is the lifecycle signal—do not require an AI-generated completion token.

This preserves the public-reply boundary: the platform publishes only validated reply records, while the workflow decides whether to emit one. It also permits future non-reply records without parsing prose.

### 4. Process supervision

Sandcastle surfaces several good low-level requirements:

- Execution returns stdout, stderr, and exit code separately; non-zero exit is failure, with stderr preferred for diagnostics ([`invokeAgent`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L140-L209)).
- Streaming implementations are required rather than pretending a buffered callback is live ([`SandboxProvider`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L23-L47)).
- Retained stdout/stderr tails are bounded even though output is delivered live, preventing an unbounded string from crashing the supervisor ([no-sandbox provider](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/no-sandbox.ts#L24-L35), [implementation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/no-sandbox.ts#L99-L134)).
- Cancellation belongs to a specific operation, not to the existence of a reusable resource ([ADR 0004](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0004-abort-signal-on-run-and-interactive.md#L1-L11)).

Laborer should adopt these with stricter local-process semantics:

1. Keep a handle to the actual child (preferably its process group).
2. On timeout, shutdown, or cancellation, send a graceful signal, wait a bounded grace period, hard-kill the process group, and await close/reap before advancing the queue.
3. Bound diagnostic retention and protocol line/record size while optionally streaming diagnostics to logs.
4. Treat malformed protocol, output overflow, spawn failure, timeout, signal death, and non-zero exit as distinct typed outcomes.
5. Prefer a wall-clock invocation deadline for the generic contract. An output-idle timeout assumes chatty agents and can kill a valid quiet arbitrary command.

**Critical negative lesson.** Sandcastle’s no-sandbox provider spawns a host child but exposes no kill operation and `close()` is a no-op ([source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/no-sandbox.ts#L54-L166)). Sandcastle’s own completion-timeout ADR acknowledges that force-completion can abandon and leak that host process and its children ([ADR 0019](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0019-completion-timeout-for-hanging-process.md#L10-L16)). Laborer must not merely race a promise against a timeout; timeout completion is not complete until the child tree is terminated and reaped.

### 5. Agent/session continuation

**Useful principle.** Sandcastle eventually moved session persistence behind the component that understands it because storage location, keying, transfer, and content rewriting differ by agent ([ADR 0012](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0012-agent-provider-owned-session-storage.md#L1-L31)). It refuses to reach into OpenCode’s private SQLite schema to synthesize portability ([ADR 0016](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0016-resume-requires-filesystem-backed-sessions.md#L3-L22)). Its concrete implementation shows why: Claude, Codex, and Pi have different directories, filename discovery, and cwd-rewrite rules ([`AgentSessionStorage`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L233-L262), [`SessionStore`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SessionStore.ts#L1-L13)).

**Recommendation.** Apply that ownership rule more completely than Sandcastle can: Laborer passes a stable work-thread ID on every turn; the user handler owns any mapping from that ID to OpenCode/Claude/Codex/custom continuation state. Laborer persists queue and delivery state, not agent sessions. It must not parse session IDs from stdout, copy transcripts, rewrite embedded cwd values, decide resume versus fork, or gate which CLIs qualify.

If a handler needs a platform-provided filesystem location, Laborer may later expose a stable per-work-thread state directory as an opaque convenience. That still leaves file formats and session selection entirely handler-owned.

### 6. Customization and the platform/workflow boundary

Sandcastle explicitly says users write the prompt and the engine imposes no workflow, task-management, or context-source opinion ([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L577)). Its workflow templates are self-contained consumers of the public package rather than shared internals, specifically so workflows can diverge without expanding the core API ([ADR 0009](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0009-templates-no-shared-code.md#L1-L23)). This is the closest architectural analogue to Laborer’s desired boundary.

For Laborer:

| Laborer platform owns | User-configured handler owns |
| --- | --- |
| Slack activation normalization | Classification and routing |
| Work-thread identity | Models, agents, prompts, and skills |
| Per-thread turn serialization and queued arrivals | Agent/session continuation and handler state |
| Restart-safe inbound/delivery bookkeeping | Repositories, worktrees, sandboxes, Git, and PRs |
| Spawning configured command in configured `cwd` | Workflow retries and domain decisions |
| Child supervision and protocol validation | Whether and what to emit as a public reply |
| Publishing only explicit reply records | Content and formatting of those replies |

The command boundary is Laborer’s customization mechanism. Adding model selectors, provider registries, workflow hooks, prompt preprocessors, issue-tracker plugins, or coding-agent templates would duplicate capabilities the handler already owns and would make Laborer less generic.

## Sandcastle-specific architecture Laborer should not inherit

1. **Agent providers and model knowledge.** Sandcastle’s provider builds Claude/Codex/OpenCode/etc. commands, permission flags, stream parsers, usage extraction, and resume flags ([`AgentProvider`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L264-L277)). Laborer invokes one configured command and understands only its own protocol.
2. **Sandbox-provider hierarchy.** Bind-mount, isolated, and no-sandbox providers exist to move repositories and constrain coding agents ([`SandboxProvider` union](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L161-L241)). Local execution in a configured directory is the prototype boundary; container/VM support can live inside the command.
3. **Git branches, worktrees, commit collection, and merge strategies.** These dominate Sandcastle’s lifecycle ([README “How it works”](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L548-L558)) but are explicitly handler-owned in Laborer.
4. **Prompt files, substitutions, and shell expansion.** Sandcastle executes `` !`command` `` fragments in prompt files ([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L624)). Laborer transports normalized Slack input literally and should not be a prompt engine.
5. **AI completion markers and internal multi-iteration loops.** `<promise>COMPLETE</promise>` exists because Sandcastle may invoke multiple agents in a run ([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L643-L683)). Laborer has an OS-process terminal boundary per Slack turn.
6. **Agent structured-output extraction and repair retries.** XML-tag scanning and schema repair are agent orchestration features ([README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L685-L747)). Laborer should validate its own handler protocol only; a handler may use any agent-output mechanism internally.
7. **Session capture/transfer/fork.** These require agent-private filesystem knowledge and cwd rewriting. Laborer supplies stable identity and leaves continuation behind the command.
8. **Interactive and warm-resource APIs.** Sandcastle’s TUI and reusable sandbox are intentionally long-lived. Laborer’s proof requires ephemeral per-turn execution.
9. **Lifecycle workflow hooks and environment merging as a mini-orchestrator.** Setup, secrets, package installation, and tool permissions should be expressed by the configured handler command or its own launcher. Laborer may need a minimal explicit environment policy, but not host/sandbox hook phases.
10. **Coding-agent scaffolds and issue-tracker choices.** Sandcastle’s templates package opinions about issue selection and coding pipelines ([template list](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L750-L762)). Laborer core must remain indifferent to the work performed.

## Proposed minimum Laborer execution contract

This is a research recommendation, not an implementation specification:

```text
Configuration
  command: executable + argv (or explicitly documented trusted shell command)
  cwd: path resolved to an absolute existing directory
  timeout: finite wall-clock duration

For each serialized turn
  spawn a fresh process in cwd
  write one versioned JSON turn envelope to stdin
  close stdin
  parse bounded, versioned stdout records
  stream/bound stderr only for diagnostics
  publish only validated public_reply records after/according to durable delivery rules
  await exit and record typed outcome
  on cancel/timeout: terminate process group, escalate, reap

Continuation
  include stable workThreadId on every invocation
  handler owns all session/state lookup and mutation
```

The reply protocol and durable publication order must align: a parsed reply is an intent, not proof that Slack received it. Laborer should persist reply intent/idempotency state before or alongside Slack delivery according to the later delivery-contract decision.

## Risks and caveats

- **Shell-vs-argv configuration:** accepting a shell string is convenient but makes quoting platform-dependent. It remains safe from Slack injection only if inbound data is exclusively stdin and never interpolated.
- **Stdout multiplexing:** arbitrary handlers often log to stdout. If stdout is protocol-only, this must be explicit; otherwise use a dedicated inherited file descriptor for protocol records and leave stdout/stderr as logs.
- **Timeout semantics:** a wall-clock deadline is generic but may interrupt legitimate long work. It must be configurable and its timeout outcome persisted without losing the queued next turn.
- **Reply timing:** streaming `public_reply` records can produce partial external side effects before a later non-zero exit. Buffer-until-success is simpler; immediate delivery is more responsive but requires precise partial-success semantics.
- **Process trees:** killing only the direct child is insufficient when the handler starts agent CLIs, MCP servers, or shell grandchildren. Supervision must be tested against descendants.

## Newly surfaced precise decision questions

1. **Command representation:** Is configuration an executable plus argv array, an opaque shell command, or both with distinct tagged forms?
2. **Protocol framing:** Should v1 stdout be one final JSON document, NDJSON records, or a dedicated protocol file descriptor so normal stdout remains available for logs?
3. **Publication timing:** Are valid `public_reply` records buffered until exit code 0, or may Laborer durably publish them while the handler is still running? What is the declared result if a later exit is non-zero?
4. **Termination policy:** What default wall-clock timeout and graceful-to-hard-kill interval apply, and must Laborer kill the full process group on every supported OS?
5. **Handler state affordance:** Is stable `workThreadId` sufficient, or should Laborer also create and pass a stable per-thread state directory while remaining ignorant of its contents?
6. **Environment policy:** Which minimal metadata belongs in the stdin envelope versus environment variables, and does Laborer inherit the parent environment unchanged or use an explicit allow/override configuration?

## Recommended next step

Resolve questions 1–3 before implementing the tracer bullet. They determine spawn safety, parser shape, and restart-safe Slack side effects. The prototype should then test: large/adversarial Slack text remains literal through stdin; two work threads run concurrently while one thread serializes; a mid-turn message becomes the next fresh invocation; a follow-up resumes via handler-owned state; malformed output is never published; and timeout kills and reaps a child plus descendant process.
