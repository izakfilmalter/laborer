# PTY Host Process Isolation — Issues

---

## Issue 1: PTY Host script — spawn and echo

### Parent PRD

See PRD-pty-host.md

### What to build

Create the standalone PTY Host Bun script that manages node-pty instances in an isolated child process. On startup, the script checks and fixes `spawn-helper` execute permissions for the node-pty prebuilds, then emits a `ready` event on stdout. It reads newline-delimited JSON commands from stdin (`spawn`, `write`, `resize`, `kill`) and writes newline-delimited JSON events to stdout (`ready`, `data`, `exit`, `error`). Terminal output data is base64-encoded in `data` events. The script maintains an in-memory `Map<string, IPty>` of active PTY instances. stderr is reserved for debug logging.

See PRD-pty-host.md sections: "PTY Host Script", "IPC Protocol".

### Acceptance criteria

- [ ] PTY Host script exists as a plain Bun script (no Effect) at a reasonable location in `packages/server/`
- [ ] On startup, checks and fixes spawn-helper execute permissions and emits a `ready` JSON event on stdout
- [ ] Handles `spawn` command: creates a PTY via node-pty with the specified shell, args, cwd, env, cols, rows
- [ ] Forwards PTY output as base64-encoded `data` events on stdout
- [ ] Forwards PTY exit as `exit` events with exitCode and signal on stdout
- [ ] Handles `write` command: sends input data to the specified PTY
- [ ] Handles `resize` command: resizes the specified PTY dimensions
- [ ] Handles `kill` command: kills the specified PTY process and emits an `exit` event
- [ ] Invalid or malformed commands produce `error` events, not crashes
- [ ] Multiple concurrent PTY instances work independently (keyed by id)
- [ ] All IPC messages are JSON objects with a `type` field, one per line

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1 (spawn a terminal that stays running)
- User story 2 (type commands and see output)
- User story 9 (spawn-helper permissions fix on startup)
- User story 13 (PTY Host startup is transparent)

---

## Issue 2: PtyHostClient Effect service — spawn and route events

### Parent PRD

See PRD-pty-host.md

### What to build

Create a new `PtyHostClient` Effect service in the server that spawns the PTY Host child process during Effect layer construction, waits for the `ready` event, and provides typed methods: `spawn()`, `write()`, `resize()`, `kill()`. The service writes JSON commands to the child process's stdin and reads JSON events from stdout via a line-based stream parser. Incoming `data` and `exit` events are routed to per-terminal callbacks registered by callers. When the PTY Host process exits (crash or normal), the service notifies registered crash callbacks. Wire the new service into the layer graph in `main.ts`.

See PRD-pty-host.md sections: "PTY Host IPC Client", "Layer Composition".

### Acceptance criteria

- [ ] `PtyHostClient` is an Effect service with tag `"@laborer/PtyHostClient"` following existing service patterns
- [ ] Layer construction spawns the PTY Host script as a Bun child process
- [ ] Waits for the `ready` event before the layer is considered constructed
- [ ] Provides typed `spawn(id, shell, args, cwd, env, cols, rows)` method that sends a spawn command via stdin
- [ ] Provides typed `write(id, data)` method
- [ ] Provides typed `resize(id, cols, rows)` method
- [ ] Provides typed `kill(id)` method
- [ ] Implements a line-based JSON parser on the child process's stdout
- [ ] Routes `data` events to per-terminal data callbacks
- [ ] Routes `exit` events to per-terminal exit callbacks
- [ ] On PTY Host process exit, invokes a registered crash callback
- [ ] Layer is wired into `main.ts` and provided to `TerminalManager`
- [ ] Layer teardown kills the PTY Host child process and all its PTY children

### Blocked by

- Blocked by #1

### User stories addressed

- User story 1 (spawn a terminal that stays running)
- User story 13 (PTY Host startup is transparent)

---

## Issue 3: TerminalManager refactor — use PtyHostClient instead of node-pty

### Parent PRD

See PRD-pty-host.md

### What to build

Refactor the existing `TerminalManager` Effect service to depend on `PtyHostClient` instead of importing node-pty directly. Remove the dynamic `import("node-pty")` call and the debug `require("node-pty")` spawn block. The `spawn()` method sends a spawn command via `PtyHostClient` and registers data/exit callbacks. The data callback commits `v1.TerminalOutput` events to LiveStore (same behavior as before). The exit callback commits `v1.TerminalStatusChanged` and removes the terminal from the in-memory map. `write()`, `resize()`, `kill()` delegate to `PtyHostClient`. The public interface of `TerminalManager` is unchanged — all existing RPC handlers continue working without modification.

See PRD-pty-host.md sections: "TerminalManager Refactor", "Layer Composition".

### Acceptance criteria

- [ ] `TerminalManager` no longer imports node-pty (neither `import` nor `require`)
- [ ] `TerminalManager` depends on `PtyHostClient` via `yield* PtyHostClient`
- [ ] `spawn()` sends a spawn command to `PtyHostClient` and registers data/exit callbacks
- [ ] Data callback commits `v1.TerminalOutput` events to LiveStore with terminal output
- [ ] Exit callback commits `v1.TerminalStatusChanged { status: "stopped" }` and cleans up in-memory state
- [ ] `write()` delegates to `PtyHostClient.write()`
- [ ] `resize()` delegates to `PtyHostClient.resize()`
- [ ] `kill()` delegates to `PtyHostClient.kill()` and updates LiveStore status
- [ ] `killAllForWorkspace()` continues to work, killing all terminals for a workspace
- [ ] Debug PTY spawn block (the `require("node-pty")` section) is removed
- [ ] The `ManagedTerminal` interface no longer holds an `IPty` reference
- [ ] RPC handlers (`terminal.spawn`, `terminal.write`, `terminal.resize`, `terminal.kill`) work end-to-end through the new architecture
- [ ] `rlph.*` RPC handlers that depend on terminal spawning continue to work

### Blocked by

- Blocked by #2

### User stories addressed

- User story 1 (spawn a terminal that stays running)
- User story 2 (type commands and see output)
- User story 3 (terminal output appears in web UI in real time)
- User story 4 (resize updates PTY dimensions)
- User story 5 (kill terminates the process)
- User story 6 (multiple terminals simultaneously)
- User story 14 (terminals with specific commands run and exit cleanly)

---

## Issue 4: Stale terminal cleanup on server startup

### Parent PRD

See PRD-pty-host.md

### What to build

Add stale terminal cleanup to the `TerminalManager` layer construction. On server startup, query LiveStore for any terminals with status `"running"` and commit `v1.TerminalStatusChanged { status: "stopped" }` for each — these are orphans from a previous server crash. Additionally, when `PtyHostClient` reports that the PTY Host process has crashed, mark all currently tracked terminals as stopped in LiveStore.

See PRD-pty-host.md sections: "Stale Terminal Cleanup".

### Acceptance criteria

- [ ] On `TerminalManager` layer construction, queries LiveStore for terminals with status `"running"`
- [ ] Commits `v1.TerminalStatusChanged { status: "stopped" }` for each orphaned terminal found
- [ ] When `PtyHostClient` reports a PTY Host crash, all in-memory tracked terminals are marked as stopped in LiveStore
- [ ] Orphan cleanup happens before the service starts accepting new spawn requests
- [ ] Cleanup is logged for observability

### Blocked by

- Blocked by #3

### User stories addressed

- User story 8 (terminals marked as stopped after server crash/restart)
- User story 10 (PTY Host crash handled gracefully)

---

## Issue 5: LiveStore sync verification and end-to-end terminal data path

### Parent PRD

See PRD-pty-host.md

### What to build

Verify that LiveStore sync between the server and web client is working for terminal events. Confirm that `v1.TerminalOutput` events committed by the server (via TerminalManager -> PtyHostClient -> PTY Host) propagate to the web client via WebSocket sync and appear in the terminal pane's store subscription. If sync is disabled or broken, re-enable it. This slice validates the full data path: PTY Host -> PtyHostClient -> TerminalManager -> LiveStore -> WebSocket sync -> web client -> xterm.js.

See PRD-pty-host.md sections: "LiveStore Sync Re-enablement".

### Acceptance criteria

- [ ] LiveStore sync configuration in `laborer-store.ts` is active (not commented out)
- [ ] `v1.TerminalOutput` events committed on the server appear in the web client's LiveStore
- [ ] `v1.TerminalStatusChanged` events committed on the server appear in the web client's LiveStore
- [ ] `v1.TerminalSpawned` events committed on the server appear in the web client's LiveStore
- [ ] Terminal output is visible in the xterm.js pane in the web UI after spawning a terminal through the new PTY Host architecture
- [ ] No dropped events or sync connection issues under normal usage

### Blocked by

- Blocked by #3

### User stories addressed

- User story 3 (terminal output appears in web UI in real time)
- User story 11 (terminal output persists across page reloads via LiveStore event replay)

---

## Issue 6: Remove postinstall script and cleanup

### Parent PRD

See PRD-pty-host.md

### What to build

Remove any remaining postinstall `chmod +x` script for spawn-helper from `packages/server/package.json`. The PTY Host's startup permission check (implemented in #1) is now the sole mechanism for ensuring spawn-helper is executable. Also clean up any remaining debug code or leftover direct node-pty references in the server package that are no longer needed after the refactor.

See PRD-pty-host.md sections: "postinstall Script".

### Acceptance criteria

- [ ] No postinstall script referencing spawn-helper exists in `packages/server/package.json`
- [ ] No direct node-pty imports remain in the server package (only the PTY Host script should import node-pty)
- [ ] No debug PTY spawn code remains in terminal-manager.ts
- [ ] `bun install` followed by server start works correctly (PTY Host fixes permissions on startup)
- [ ] node-pty dependency remains in `packages/server/package.json` (it's still needed by the PTY Host script)

### Blocked by

- Blocked by #1

### User stories addressed

- User story 9 (spawn-helper permissions fixed on startup)
- User story 13 (PTY Host startup is transparent — no manual steps)

---

## Issue 7: PTY Host integration tests

### Parent PRD

See PRD-pty-host.md

### What to build

Set up vitest and `@effect/vitest` test infrastructure for the server package (no test setup currently exists). Write integration tests for the PTY Host script as a standalone subprocess — send JSON commands via stdin, read JSON events from stdout. These tests spawn real shell processes since that is the behavior under test.

See PRD-pty-host.md sections: "PTY Host Script (Integration tests)".

### Acceptance criteria

- [ ] vitest is configured for `packages/server/` with `@effect/vitest`
- [ ] Test: PTY Host emits `ready` event on startup
- [ ] Test: `spawn` command creates a working PTY that produces `data` events with output
- [ ] Test: `write` command sends input that the PTY process receives and echoes
- [ ] Test: `resize` command changes PTY dimensions without crashing
- [ ] Test: `kill` command terminates the PTY and produces an `exit` event
- [ ] Test: multiple concurrent PTYs work independently
- [ ] Test: invalid/malformed commands produce `error` events, not crashes
- [ ] Tests are deterministic and clean up spawned processes

### Blocked by

- Blocked by #1

### User stories addressed

- Testing/polish (PRD polishing requirements 1-3)

---

## Issue 8: TerminalManager + PtyHostClient integration tests

### Parent PRD

See PRD-pty-host.md

### What to build

Write integration tests through the `TerminalManager` Effect service interface with a real `PtyHostClient` (spawning the actual PTY Host process). Tests verify the full server-side stack without the web client.

See PRD-pty-host.md sections: "TerminalManager + PtyHostClient (Integration tests)".

### Acceptance criteria

- [ ] Test: `spawn()` returns a terminal response and the terminal produces output events in LiveStore
- [ ] Test: `write()` sends input that produces corresponding output
- [ ] Test: `resize()` changes dimensions without crashing the PTY
- [ ] Test: `kill()` terminates the PTY and updates terminal status in LiveStore to `"stopped"`
- [ ] Test: stale terminal cleanup on startup marks orphaned terminals as stopped
- [ ] Test: PTY Host crash triggers marking all tracked terminals as stopped
- [ ] Tests use `@effect/vitest` patterns and the test infrastructure from #7
- [ ] Tests are deterministic and clean up spawned processes and LiveStore state

### Blocked by

- Blocked by #3, #7

### User stories addressed

- Testing/polish (PRD polishing requirements 1-5)

---

# Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | PTY Host script — spawn and echo | None | Done |
| 2 | PtyHostClient Effect service | #1 | Done |
| 3 | TerminalManager refactor | #2 | Ready |
| 4 | Stale terminal cleanup | #3 | Blocked |
| 5 | LiveStore sync verification | #3 | Blocked |
| 6 | Remove postinstall + cleanup | #1 | Ready |
| 7 | PTY Host integration tests | #1 | Ready |
| 8 | TerminalManager + PtyHostClient integration tests | #3, #7 | Blocked |
