# PTY Host Process Isolation — Product Requirements Document

## Problem Statement

Laborer's terminal feature does not work. When a user spawns a terminal via the UI, the PTY process created by `node-pty` inside the Bun HTTP server process dies within 15-45ms with a SIGHUP signal. The interactive shell never produces any output, and the terminal immediately transitions from "running" to "stopped" status.

Extensive debugging has eliminated many possible causes (server `--watch` mode, LiveStore sync, `import()` vs `require()` of node-pty, shell type, environment variables, working directory). The issue occurs **only** when `node-pty` is used inside the running Bun HTTP server process — standalone Bun scripts with identical spawn code work fine. Non-interactive commands (`zsh -c 'echo ok'`) work, but interactive shells (`zsh -i`) die immediately.

The root cause is that the Bun HTTP server runtime environment (likely its event loop, file descriptor management, or signal handling) interferes with the `tty.ReadStream` that `node-pty` creates internally on the PTY master file descriptor. When the interactive shell starts and queries terminal capabilities, something in the server process causes the stream to error or close, which triggers SIGHUP to the child process.

Additionally, LiveStore sync between the server and web client is currently disabled (commented out as a debugging measure), which means terminal output events committed by the server cannot reach the web client. This must be re-enabled for terminals to function end-to-end.

## Solution

Move all `node-pty` operations out of the main Bun HTTP server process into an isolated child process called the **PTY Host**. This is the same architecture used by VS Code, which never runs `node-pty` in its main server process.

The PTY Host is a single, long-lived Bun subprocess that manages all PTY instances. It communicates with the main server via newline-delimited JSON messages over stdin/stdout. The main server's `TerminalManager` service is refactored to send commands to the PTY Host instead of calling `node-pty` directly.

This solves the SIGHUP problem by completely isolating PTY file descriptors and signal handling from the Bun HTTP server's runtime. It also provides a cleaner separation of concerns and makes the terminal subsystem independently testable.

## User Stories

1. As a developer, I want to spawn a terminal in a workspace and have it stay running, so that I can interact with a shell session.
2. As a developer, I want to type commands into a terminal and see their output, so that I can use the terminal as I would any shell.
3. As a developer, I want terminal output to appear in the web UI in real time, so that I can see what my commands and agents are doing.
4. As a developer, I want to resize the terminal pane and have the PTY dimensions update correctly, so that full-screen programs (vim, htop, etc.) render properly.
5. As a developer, I want to kill a terminal and have the underlying process actually terminate, so that resources are freed.
6. As a developer, I want to spawn multiple terminals simultaneously across different workspaces, so that I can run agents, test runners, and shells in parallel.
7. As a developer, I want the rlph workflow commands (startLoop, writePRD, review, fix) to work, since they depend on terminal spawning.
8. As a developer, I want terminals to be marked as "stopped" if the server crashes and restarts, so that I don't see orphaned "running" terminals that are actually dead.
9. As a developer, I want the PTY Host to check and fix `node-pty`'s `spawn-helper` permissions on startup, so that I don't hit a cryptic `posix_spawnp failed` error after a fresh `bun install`.
10. As a developer, I want the server to handle PTY Host crashes gracefully (marking terminals as stopped), so that the app doesn't get stuck in an inconsistent state.
11. As a developer, I want terminal output to persist across page reloads via LiveStore event replay, so that I can see previous output when I reopen a terminal pane.
12. As a developer, I want workspace destruction to kill all terminals in that workspace, so that cleanup is complete.
13. As a developer, I want the PTY Host startup to be transparent — no manual steps required beyond starting the server.
14. As a developer, I want terminals spawned with a specific command (e.g., `rlph --once`) to run that command and exit cleanly when done.

## 'Polishing' Requirements

1. **Startup reliability.** Verify the PTY Host starts reliably on server launch, including after `bun install` (spawn-helper permissions).
2. **Latency.** Verify keystroke-to-output latency through the IPC channel is imperceptible (under 50ms for local usage).
3. **Output fidelity.** Verify that terminal output through the IPC channel preserves all bytes correctly (colors, Unicode, cursor positioning, binary data from programs like `htop` or `vim`).
4. **Cleanup completeness.** On server shutdown, verify the PTY Host and all child PTY processes are terminated, not orphaned.
5. **Error messages.** If the PTY Host fails to start or crashes, the error should be logged clearly with enough context to diagnose.
6. **Resource usage.** Verify the PTY Host process doesn't leak memory or file descriptors over time with many terminal spawn/kill cycles.
7. **LiveStore sync stability.** After re-enabling sync, verify terminal output events flow reliably without dropped events or connection issues.

## Implementation Decisions

### PTY Host Script

A plain Bun script (no Effect) that manages `node-pty` instances in a simple message loop. On startup, it:

- Checks and fixes `spawn-helper` execute permissions for the `node-pty` prebuilds (currently handled by a `postinstall` script in `packages/server/package.json`, which will be replaced by this startup check).
- Reads newline-delimited JSON commands from stdin.
- Writes newline-delimited JSON events to stdout.
- Maintains an in-memory `Map<string, IPty>` of active PTY instances.
- stderr is reserved for debug logging and error output (not part of the IPC protocol).

### IPC Protocol

**Commands (server -> PTY Host, via stdin):**

| Command | Fields | Description |
|---------|--------|-------------|
| `spawn` | `id`, `shell`, `args`, `cwd`, `env`, `cols`, `rows` | Create a new PTY |
| `write` | `id`, `data` | Send input to a PTY |
| `resize` | `id`, `cols`, `rows` | Resize a PTY |
| `kill` | `id` | Kill a PTY process |

**Events (PTY Host -> server, via stdout):**

| Event | Fields | Description |
|-------|--------|-------------|
| `ready` | (none) | PTY Host has started and is ready to accept commands |
| `data` | `id`, `data` | Output from a PTY (base64-encoded to preserve binary) |
| `exit` | `id`, `exitCode`, `signal` | A PTY process exited |
| `error` | `id?`, `message` | An error occurred (id is optional for host-level errors) |

All messages are JSON objects with a `type` field, serialized one per line (newline-delimited).

Terminal output data is base64-encoded in the IPC messages to safely transport arbitrary bytes (including null bytes, escape sequences, and binary output from TUI programs) over the JSON text protocol.

### PTY Host IPC Client

A new Effect service (`PtyHostClient`) in the server that:

- Spawns the PTY Host as a child process during Effect layer construction.
- Sends JSON commands by writing to the child process's stdin.
- Reads JSON events from the child process's stdout via a line-based stream parser.
- Routes incoming `data` and `exit` events to per-terminal callbacks registered by `TerminalManager`.
- On PTY Host process exit (crash or normal), notifies `TerminalManager` to mark all terminals as stopped.
- Provides typed methods: `spawn()`, `write()`, `resize()`, `kill()`.

### TerminalManager Refactor

The existing `TerminalManager` Effect service keeps its public interface but replaces its internals:

- Removes the `node-pty` import entirely.
- Depends on `PtyHostClient` instead of importing `node-pty` directly.
- The `spawn()` method sends a `spawn` command to the PTY Host and registers data/exit callbacks.
- The data callback commits `v1.TerminalOutput` events to LiveStore (same as before).
- The exit callback commits `v1.TerminalStatusChanged` and removes the terminal from the in-memory map (same as before).
- `write()`, `resize()`, `kill()` delegate to `PtyHostClient`.

### Stale Terminal Cleanup

On server startup (during `TerminalManager` layer construction), query LiveStore for any terminals with status `"running"` and commit `v1.TerminalStatusChanged { status: "stopped" }` for each. These are orphans from a previous server crash.

### LiveStore Sync Re-enablement

Remove the debug comment that disables sync in the server's LiveStore setup. Verify that terminal output events committed by the server propagate to the web client via WebSocket sync and appear in the terminal pane's `store.events()` subscription.

### Layer Composition

The new dependency chain is:

```
TerminalManager -> PtyHostClient -> (child process)
```

`PtyHostClient` is a new layer that must be provided to `TerminalManager`. The PTY Host child process is an implementation detail of the `PtyHostClient` layer.

### postinstall Script

The existing `postinstall` script in `packages/server/package.json` that runs `chmod +x` on `spawn-helper` is removed. The PTY Host script handles permission checking on startup instead, which is more reliable (survives re-installs, works in CI, etc.).

## Testing Decisions

**What makes a good test:** Tests verify external behavior through the public interface of each module. They do not test implementation details or internal state. Tests should be deterministic. For PTY-related tests, we accept that they interact with the OS (spawning real shell processes) since that is the behavior under test.

### PTY Host Script (Integration tests)

Test the PTY Host as a standalone subprocess. Send JSON commands via stdin, read JSON events from stdout. Verify:

- Spawn command creates a working PTY that produces output.
- Write command sends input that the PTY process receives.
- Resize command changes PTY dimensions.
- Kill command terminates the PTY and produces an exit event.
- Multiple concurrent PTYs work independently.
- Invalid commands produce error events, not crashes.
- The `ready` event is emitted on startup.

### TerminalManager + PtyHostClient (Integration tests)

Test through the `TerminalManager` Effect service interface with a real `PtyHostClient` (spawning the actual PTY Host process). Verify:

- `spawn()` returns a terminal response and the terminal produces output events in LiveStore.
- `write()` sends input that produces corresponding output.
- `resize()` changes dimensions without crashing the PTY.
- `kill()` terminates the PTY and updates terminal status in LiveStore.
- Stale terminal cleanup on startup marks orphaned terminals as stopped.
- PTY Host crash triggers marking all terminals as stopped.

### Prior art

The existing codebase uses `@effect/vitest` for testing Effect services. The test setup patterns in the codebase (if any exist) should be followed for consistency.

## Out of Scope

- **Heartbeat monitoring and auto-restart of the PTY Host.** If the PTY Host crashes, terminals are marked as stopped. The user must restart the server to get a new PTY Host. Auto-restart is a future enhancement.
- **Custom flow control (pause/resume).** VS Code implements high/low watermark flow control. V1 relies on the OS-level TCP and PTY buffer backpressure. Flow control can be added later if output buffering becomes a problem.
- **Persistent terminals across server restarts.** When the server restarts, all PTY processes are lost. LiveStore preserves the terminal output history for replay, but the shell session is gone. Reconnectable persistent terminals are a future feature.
- **Node.js runtime for the PTY Host.** The PTY Host runs on Bun, same as the server. If Bun-specific issues arise in the isolated child process, switching to Node.js is a fallback option but not planned for v1.
- **Multiple PTY Host processes.** V1 uses a single PTY Host for all terminals. Sharding across multiple hosts is not needed at this scale.
- **Changes to the web client.** The web client's terminal pane, RPC mutations, and LiveStore subscriptions remain unchanged. The fix is entirely server-side.

## Further Notes

### Why process isolation works

The SIGHUP issue occurs because `node-pty` creates a `tty.ReadStream` on the PTY master file descriptor inside the spawning process. When that process is a Bun HTTP server with its own event loop, fd management, and signal handling, the ReadStream encounters errors that propagate as SIGHUP to the child shell. By moving `node-pty` into a dedicated child process that does nothing but manage PTYs, the file descriptors and signals are isolated from the HTTP server's runtime.

VS Code validated this architecture at massive scale — their "Pty Host" process is a child process forked from the main server, handling all terminal operations via IPC. They have zero special SIGHUP workarounds because process isolation inherently prevents the problem.

### Base64 encoding for terminal output

Terminal output can contain arbitrary bytes (null bytes, raw escape sequences, binary data from TUI programs). JSON cannot safely transport raw binary, so terminal output data in IPC messages is base64-encoded. The overhead is ~33% size increase, which is acceptable for local IPC over stdio pipes. If this becomes a performance concern, the protocol can be switched to a length-prefixed binary format in the future.

### Relationship to the main PRD

This PRD addresses a subset of the TerminalManager module described in the main `PRD.md`. The public interface of `TerminalManager` (as consumed by RPC handlers) does not change. The PTY Host is an internal architectural decision that makes the terminal subsystem actually work. Once this PRD is implemented, the terminal-related user stories in the main PRD (stories 3, 6, 16, 17) become achievable.
