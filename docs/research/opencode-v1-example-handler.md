# OpenCode v1 example-handler contract

**Research ticket:** [#202](https://github.com/izakfilmalter/laborer/issues/202)

**Validated against:** installed OpenCode `1.18.4` on 2026-07-20, official tag commit [`49c69c5`](https://github.com/anomalyco/opencode/tree/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e), and the repository reference clone at `3ad6923c` (`1.17.1`).

## Decision

OpenCode should be a **user-owned example work handler**, not a Laborer core dependency. The example may spawn the installed `opencode` executable and translate its JSONL/process behavior into Laborer's generic handler lifecycle. Laborer core should know only generic process input, streamed output, opaque continuation state, cancellation, and a thread-bound reply capability; it should not import OpenCode packages, model OpenCode event types, discover OpenCode config, or own OpenCode sessions.

The supported v1 invocation is:

```text
opencode run --format json --dir <absolute-worktree> [--agent <name>] [--model <provider/model>] [--auto] <prompt>
```

A continuation is a **new OS process** with the same effective storage/config environment and exact working directory:

```text
opencode run --format json --dir <same-absolute-worktree> --session <sessionID> <next-prompt>
```

Do not use `--continue` (it selects the latest root session, not a stored work item), `--fork` (it creates a different session), or `--attach` in the v1 example. Official help documents all four switches, while the implementation shows `--continue` selecting the first root session returned by `session.list()` and `--session` doing an exact lookup ([CLI docs, “run”](https://opencode.ai/docs/cli/#run-1); [`run.ts`, session selection](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L390-L468)). In local mode the command waits for session idle, but the attach-mode `finish()` returns without awaiting the event loop, so attach mode is not a safe one-turn completion boundary ([`run.ts`, execution](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L605-L807)).

## Noninteractive one-turn behavior

`opencode run` is noninteractive by default. It creates or resolves one session, subscribes to events, sends exactly one prompt/command, streams selected output, and for a local run exits after that session reports `idle`. It automatically denies `question`, `plan_enter`, and `plan_exit`; other permission prompts are rejected unless `--auto` is supplied ([official CLI docs](https://opencode.ai/docs/cli/#run-1); [`run.ts`, permission rules and loop](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L365-L383), [`run.ts`, permission replies](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L731-L750)).

The example handler should pass the prompt as a single argv element, keep stdin closed, read stdout and stderr concurrently, and never use the TUI/interactive mode. `--auto` is dangerous in a broad user config; use it only with a dedicated least-privilege agent whose tool and permission allowlists are handler-owned.

The current app already uses the right basic shape—`opencode run --format json`, a named agent, explicit model/variant, timeout supervision, and an isolated temporary cwd—but it only parses final text and its config still merges with the user's global config (`current/packages/server/src/services/slack-workspace-planner.ts:252-285,310-373`). That implementation is evidence, not a core API to preserve.

## JSONL contract and session ID extraction

Despite the help text saying “raw JSON events,” stdout is a **normalized newline-delimited JSON subset**, not the internal event stream. The emitter writes one complete JSON object plus the OS newline per record and adds `type`, millisecond `timestamp`, and top-level `sessionID` ([`run.ts`, `emit`](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L613-L626)). Emitted record types are:

- `step_start` with `part`
- `step_finish` with `part`
- `text` with the **completed** text part
- `reasoning` with the completed reasoning part, only with `--thinking`
- `tool_use` only when a tool reaches `completed` or `error`
- `error` for prompt/API or `session.error` failures

The CLI does **not** emit `session.created`, incremental text deltas, permission events, or the terminal `idle` event. Record order and presence should not be used as a schema beyond what is needed. Parse stdout line-by-line, tolerate unknown `type` values and additive fields, require each consumed line to be valid JSON, and extract/validate the first nonempty top-level `sessionID`. Every subsequent record for the turn must match it. Persist `{ sessionID, cwd }` as the OpenCode example's opaque continuation state. A failure before the emitter starts can produce no session ID, so absence is a failed/non-resumable turn rather than a reason to guess from `session list`.

An installed `1.18.4` probe produced, in order, `step_start`, `text`, and `step_finish`; each carried the same `ses_…` top-level ID. A second fresh process using `--session` and the same `--dir` returned the same ID and correctly used prior-turn context. This matches the source emitter and exact session lookup above.

## Resume scope

Sessions are durable across CLI processes, but directory is part of OpenCode's instance/API scope. The handler must therefore persist and replay the same canonical absolute worktree path along with the ID. `opencode session list --format json` also reports each session's `directory`, but it is diagnostic only, not a continuation-selection mechanism ([official CLI docs, “session”](https://opencode.ai/docs/cli/#session); source SDK construction with `directory` in [`run.ts`](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L875-L885)).

Empirically, same-ID/same-directory continuation worked in a fresh `1.18.4` process. Attempting that ID under a different `--dir` did not produce a usable turn and hung until the external 120-second timeout. Treat `(sessionID, canonical cwd, effective storage environment)` as inseparable. If the worktree disappears or moves, fail explicitly; do not silently continue in another checkout.

## Exit and failure semantics

- Exit `0` means the CLI reached its own successful boundary. For local runs that is the matching session becoming idle with no captured `session.error`.
- Exit `1` covers argument/config/session lookup failures, immediate prompt/command errors, stream exceptions, and captured `session.error`. Installed probes confirmed `1` for an invalid model and nonexistent session.
- A `tool_use` record whose part state is `error` does not itself set the process exit code; the model may recover and the overall turn may still exit `0`.
- JSONL belongs on stdout. Human diagnostics, parser/config failures, and optional logs belong on stderr. Capture both; never append stderr to the JSON parser.
- Signal termination follows OS conventions, not a special OpenCode result: the installed binary exited by `SIGINT` (shell convention `130`) and `SIGTERM` (`143`).

The CLI sets `process.exitCode = 1` for run errors and its top-level `finally` calls `process.exit()` to avoid hanging on subprocesses ([`run.ts`, execution](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L763-L807); [`index.ts`, top-level exit](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/index.ts#L118-L142)). The example should require both an acceptable exit status **and** valid JSONL/turn state; neither alone proves a complete result.

## Timeout, cancellation, and signals

`opencode run` has no whole-command timeout flag. Provider and MCP timeouts are narrower configuration concerns, not a work-item deadline ([provider timeout](https://opencode.ai/docs/config/#models); [MCP timeout](https://opencode.ai/docs/mcp-servers/#options)). Laborer/the example handler must own the deadline.

On cancellation or deadline:

1. stop accepting records as successful output and mark the turn cancelled/timed out;
2. send `SIGTERM` to the supervised process tree;
3. after a short grace period, send `SIGKILL` to all surviving descendants;
4. await process exit and pipe drainage before resolving cleanup;
5. retain the last known continuation tuple only as an explicitly interrupted session, never as a completed turn.

A plain signal to the OpenCode PID is insufficient. In the installed probe, terminating a run while its Bash tool executed `sleep 60` left the tool process orphaned under PID 1. The current app's `terminateProcess()` signals only the direct child (`slack-workspace-planner.ts:292-307`), so that pattern must be strengthened for the example. A Unix process group is useful but not by itself a universal guarantee because tools may create their own groups; use recursive process-tree termination (and the platform equivalent, such as a Windows job object) plus TERM/KILL escalation. OpenCode noninteractive `run` installs no graceful SIGINT/SIGTERM session-abort handler; the special abort behavior in source belongs to interactive mode, not this contract.

## Cwd and config isolation

Always set both the spawn `cwd` and OpenCode `--dir` to the same canonical absolute worktree. `--dir` changes the local process directory and binds the SDK instance to it ([`run.ts`, directory resolution](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/cli/cmd/run.ts#L305-L317)).

OpenCode config is merged, not replaced. Official precedence is remote, global, `OPENCODE_CONFIG`, project config, `.opencode` directories, `OPENCODE_CONFIG_CONTENT`, then managed settings ([config precedence](https://opencode.ai/docs/config/#precedence-order)). Therefore:

- `--pure` only disables external plugins; it is not general config isolation ([CLI global flags](https://opencode.ai/docs/cli/#global-flags)).
- Put handler config/agents in a dedicated `OPENCODE_CONFIG_DIR` and pass `--pure`.
- Set source-supported `OPENCODE_DISABLE_PROJECT_CONFIG=1` if v1 intentionally excludes repository `opencode.json` and repository `.opencode` discovery; this variable is present in OpenCode source but is not listed in the public CLI environment-variable table, so pin/test it as a version-sensitive adapter detail (`.reference/opencode/packages/core/src/flag/flag.ts:54-56`, `.reference/opencode/packages/opencode/src/config/config.ts:395-399`).
- Use `OPENCODE_CONFIG_CONTENT` for final runtime overrides/allowlists, but do not mistake it for replacement semantics.
- Managed config remains higher precedence. If hostile/fully hermetic config isolation is required, use separate XDG/HOME roots and provision provider credentials deliberately; that also changes where durable sessions/auth live and must remain stable across resume.

The v1 example should aim for deterministic least privilege, not pretend it can erase administrator-managed policy. It may share the user's OpenCode credential/session store by an explicit product choice, but must not expose those details through Laborer core.

## Thread-bound public reply

Use a **Laborer-owned local stdio MCP server** as the supported tool mechanism. OpenCode officially supports local MCP `command`, `cwd`, `environment`, `enabled`, and timeout configuration ([MCP local configuration](https://opencode.ai/docs/mcp-servers/#local)). MCP tools are registered as `<sanitized-server-name>_<sanitized-tool-name>` ([OpenCode source, `.reference/opencode/packages/opencode/src/mcp/index.ts:673-695`](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/mcp/index.ts#L673-L695)) and are subject to normal agent tool/permission rules ([`.reference/opencode/packages/opencode/src/session/tools.ts:117-201`](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/tools.ts#L117-L201)).

The MCP server should expose one narrow tool, for example `laborer_public_reply`, with input `{ text: string }` only. Bind the Slack thread (or future public surface) in an unforgeable, short-lived capability passed in the MCP server environment or startup args. The model must not supply workspace/channel/thread IDs, credentials, or arbitrary recipients. The server validates expiry/work-item ownership, performs idempotent delivery, and returns a receipt. Configure the dedicated OpenCode agent to allow that exact prefixed tool and deny unrelated MCP/built-in mutation tools.

This is not currently present: Laborer's stdio MCP registers only PRD and issue toolkits (`current/packages/mcp/src/main.ts:1-21`), and the Slack planner only allows globally configured `slack_*` tools (`slack-workspace-planner.ts:267-283`). The generic public-reply capability should belong to Laborer's handler host/MCP boundary; OpenCode merely consumes it as one tool. A custom OpenCode plugin could also expose a tool, but it couples the example to OpenCode's plugin runtime and conflicts with the safer `--pure` posture, so MCP is the v1 choice.

## Exact example-handler obligations

The OpenCode example handler, outside core, must:

1. probe `opencode --version` and reject unsupported major versions;
2. build argv without shell interpolation and set canonical `cwd` plus matching `--dir`;
3. own a dedicated agent/config with least-privilege tools and the thread-bound MCP reply server;
4. stream-parse stdout as forward-compatible JSONL, capture stderr separately, and persist the first validated `{ sessionID, cwd }`;
5. resume only by explicit `--session`, same cwd, and stable storage/config environment;
6. treat exit, parsed errors, malformed JSONL, missing/mismatched session IDs, timeout, and cancellation as separate failure dimensions;
7. recursively terminate descendants on cancellation/timeout and await cleanup;
8. return only generic lifecycle/output/checkpoint information to Laborer core.

## Newly surfaced decision questions

1. **Reply cardinality:** may an agent call the public-reply tool multiple times during a turn, or must the capability be single-use with one final public response? This determines idempotency and UX semantics.
2. **Isolation boundary:** should the example intentionally reuse the user's OpenCode auth/session data while isolating config, or must deployments provision a separate XDG data root and credentials? Resume requires this choice to remain stable.
3. **Cancellation guarantee:** is “no surviving descendant process” a cross-platform v1 invariant? If yes, the handler runtime needs process-tree/job-object support rather than the current direct-child kill helper.
4. **Interrupted resume:** may users resume an OpenCode session whose prior process was killed, or should cancellation invalidate the opaque continuation checkpoint by policy?
