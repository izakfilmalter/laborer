# Terminal Service Extraction — Product Requirements Document

## Problem Statement

During development, the server package (`@laborer/server`) runs with `bun run --watch src/main.ts`. When any server code is edited, Bun restarts the entire process, which tears down the Effect layer tree — including `PtyHostClient`, which kills the PTY Host child process and all active terminal sessions. Every code change during development destroys all running terminals, forcing developers to re-spawn them and lose their shell history and state. This makes iterative development extremely frustrating.

The root cause is architectural: the terminal subsystem (PTY Host, PtyHostClient, TerminalManager, ring buffer, WebSocket route) lives inside the server package and shares its process lifecycle. There is no way for terminals to survive a server restart.

Additionally, terminal state is currently stored in LiveStore (a `terminals` table with status tracking), creating dual state management — the server maintains both an in-memory `Map<string, ManagedTerminal>` and commits events to LiveStore for every state change. The web app reads terminal state from LiveStore queries, coupling the UI to this persistence layer. Following VS Code's architecture, terminal state should be derived from the PTY process (in-memory only), not persisted in a centralized store.

## Solution

Extract the entire terminal subsystem into a new standalone package (`@laborer/terminal`) that runs as its own long-lived Bun HTTP server process on a dedicated port. This follows VS Code's architecture where the PTY Host is a separate process that survives editor restarts.

The terminal service owns all terminal lifecycle operations (spawn, write, resize, kill, restart, list) via Effect RPC endpoints, and serves the terminal WebSocket data channel directly to the web app. Terminal state is ephemeral and in-memory — derived from PTY process events, not stored in a database.

The server no longer knows about PTY processes, ring buffers, or terminal WebSocket connections. It communicates with the terminal service via an Effect RPC client to orchestrate workspace-level terminal operations (passing environment variables and configuration at spawn time). The server subscribes to the terminal service's event stream and materializes lifecycle events into LiveStore for the initial migration, but the terminal events and table are ultimately removed from LiveStore as the web app is updated to query the terminal service directly.

The web app's Vite proxy routes `/terminal` WebSocket connections directly to the terminal service port for minimal latency. Terminal list and status information comes from RPC calls to the terminal service, replacing the LiveStore `queryDb(terminals)` subscriptions.

During `turbo dev`, both the server and terminal service start as independent processes. Only the server restarts on server code changes — the terminal service (and all its terminals) keeps running.

## User Stories

1. As a developer, I want terminals to survive server code changes during development, so that I don't lose shell sessions every time I edit server code.
2. As a developer, I want `turbo dev` to start both the server and terminal service automatically, so that I don't need to manage multiple processes manually.
3. As a developer, I want the terminal service to run on a configurable port via `TERMINAL_PORT` environment variable, so that it doesn't conflict with other services.
4. As a developer, I want the terminal service to share the same `.env.local` configuration as the server, so that environment setup is consistent.
5. As a developer, I want to spawn a terminal by providing a command, cwd, and environment variables, so that the terminal service is workspace-agnostic.
6. As a developer, I want the web app's terminal WebSocket to connect directly to the terminal service, so that PTY I/O data doesn't pass through the server.
7. As a developer, I want to list all active terminals via RPC, so that the UI can display terminal state without LiveStore.
8. As a developer, I want to receive terminal lifecycle events (spawned, status changed, exited) via an Effect RPC streaming endpoint, so that the server (or any client) can subscribe to state changes.
9. As a developer, I want the terminal service to implement a grace period for reconnection (like VS Code's 60-second window), so that brief disconnections don't kill terminals.
10. As a developer, I want the terminal service to detect orphaned terminals (no connected WebSocket clients after the grace period), so that abandoned terminals are eventually cleaned up.
11. As a developer, I want terminal ring buffer replay on WebSocket reconnection, so that I can see previous output when reconnecting to a terminal.
12. As a developer, I want the server to pass all workspace-specific configuration (env vars, ports, cwd) at terminal spawn time, so that the terminal service doesn't need to know about workspaces.
13. As a developer, I want the terminal service to track stopped terminals in memory (with their command and config), so that restart operations work without a database.
14. As a developer, I want terminal state removed from LiveStore, so that there is a single source of truth (the terminal service) and no dual state management.
15. As a developer, I want the web app's terminal pane to get status updates via WebSocket control messages from the terminal service, so that the UI reacts to terminal exits and restarts without LiveStore.
16. As a developer, I want the sidebar terminal list to query the terminal service directly, so that it doesn't depend on LiveStore for terminal state.
17. As a developer, I want the terminal service to handle its own graceful shutdown (killing all PTYs) on SIGINT/SIGTERM, so that processes aren't orphaned.
18. As a developer, I want the terminal service to be independently restartable without affecting the server, so that terminal service updates don't disrupt the main application.
19. As a developer, I want existing tests (pty-host, terminal-manager, ring-buffer) to be ported to the new package and pass, so that extraction doesn't regress functionality.
20. As a developer, I want the server to kill all terminals for a workspace by tracking terminal IDs and calling the terminal service's kill RPC, so that workspace cleanup still works.
21. As a developer, I want the xterm.js buffer to clear when a terminal is restarted, so that old output doesn't persist after restart (via a WebSocket control message instead of a LiveStore event).
22. As a developer, I want the panel layout to still reference terminal IDs in leaf nodes, so that terminal panes can reconnect to their terminals after a page reload.
23. As a developer, I want dashboard terminal counts to come from the terminal service RPC, so that the workspace dashboard shows accurate counts without LiveStore.
24. As a developer, I want cross-tab terminal state consistency, so that opening multiple browser tabs shows the same terminal list and status.

## 'Polishing' Requirements

1. Verify that terminal keystroke-to-output latency is not degraded by the new RPC hop (still under 50ms for local usage).
2. Verify that the WebSocket data channel works correctly with the Vite dev proxy routing to the terminal service port.
3. Verify that terminal ring buffer replay on reconnection delivers the same experience as before (no missing output, correct chunking).
4. Verify that the grace period reconnection works correctly — terminals survive brief WebSocket disconnects but are cleaned up after the timeout.
5. Verify that orphan detection correctly identifies terminals with no subscribers and cleans them up.
6. Verify that all terminal UI states render correctly: loading, connected, disconnected/reconnecting, process exited, and restarting.
7. Verify that the sidebar terminal list updates reactively when terminals are spawned, killed, or change status.
8. Verify that `turbo dev` starts both services reliably and that server restarts don't cause terminal service restarts.
9. Verify that the terminal service's `--watch` mode only triggers on changes within the terminal package, not on server package changes.
10. Verify that graceful shutdown of the terminal service kills all PTY processes and the PTY Host child process without orphans.
11. Verify that the `dotenv -e ../../.env.local` pattern works correctly for both the server and terminal service.
12. Verify that error handling is clean: terminal service unreachable shows a meaningful error in the UI, not a silent failure.

## Implementation Decisions

### New Package: `@laborer/terminal`

A new workspace package at `packages/terminal/` with its own `package.json`, `tsconfig.json`, and entry point. Follows the same patterns as `@laborer/server`: Bun runtime, Effect services, TypeScript source consumed directly (no build step).

The entry point launches a Bun HTTP server on the port specified by the `TERMINAL_PORT` env var (default 3001). The server exposes:
- **POST /rpc** — Effect RPC endpoints for terminal operations
- **GET /terminal?id=...** — WebSocket upgrade for PTY I/O data channel
- **GET /events** — Effect RPC streaming endpoint for lifecycle events (or bundled into POST /rpc)

### Terminal RPC Contract

A new RPC contract (in `@laborer/shared` or in the terminal package itself) defining:
- `terminal.spawn({ command, args?, cwd, env, cols, rows })` — returns `{ id }`. The terminal service generates the ID.
- `terminal.write({ id, data })` — sends input to PTY.
- `terminal.resize({ id, cols, rows })` — resizes PTY.
- `terminal.kill({ id })` — kills PTY, marks terminal as stopped (kept in memory for restart).
- `terminal.remove({ id })` — fully removes terminal from memory.
- `terminal.restart({ id })` — kills existing PTY, spawns new one with same config.
- `terminal.list()` — returns all terminals with their current state (id, command, status, workspaceId).
- `terminal.events()` — streaming endpoint that pushes lifecycle events: `{ type: "spawned" | "statusChanged" | "exited" | "removed" | "restarted", id, ... }`.

The `workspaceId` is passed as metadata at spawn time and stored in-memory alongside the terminal. The terminal service does not interpret it — it's opaque context for the caller.

### Moved Modules (Server to Terminal)

The following modules move from `@laborer/server` to `@laborer/terminal` largely unchanged:
- `pty-host.ts` — The Node.js child process that manages `node-pty`. Unchanged.
- `services/pty-host-client.ts` — IPC client for the PTY Host. Unchanged.
- `lib/ring-buffer.ts` — Circular byte buffer for scrollback replay. Unchanged.
- `routes/terminal-ws.ts` — WebSocket route for PTY I/O. Minor changes: adds control message support for status notifications (exit, restart).

### Modified Module: TerminalManager

The `TerminalManager` is moved and simplified:
- **Removed:** All LiveStore event commits (`terminalSpawned`, `terminalStatusChanged`, `terminalKilled`, `terminalRemoved`, `terminalRestarted`).
- **Removed:** All LiveStore table reads (`queryDb(terminals, ...)`).
- **Removed:** Dependency on `LaborerStore` service.
- **Removed:** Dependency on `WorkspaceProvider` (env vars are passed at spawn time).
- **Added:** Stopped terminal retention — when a PTY exits, the terminal entry remains in the in-memory map with status "stopped" (preserving command and config for restart).
- **Added:** Event emission — lifecycle events are emitted to an internal `Effect.Queue` or `PubSub` that the streaming RPC endpoint consumes.
- **Added:** Grace period tracking — when a terminal's last WebSocket subscriber disconnects, a timer starts. If no new subscriber connects within the grace period (60 seconds, configurable), the terminal is killed. Mirrors VS Code's `PersistentTerminalProcess.detach()` pattern.
- **Added:** Orphan detection — on startup, any terminals without subscribers and past their grace period are cleaned up.

### WebSocket Control Messages

The terminal WebSocket data channel (`/terminal?id=...`) is extended with control messages alongside raw PTY data:
- **Server-to-client:** `{"type":"status","status":"stopped","exitCode":0}` — terminal exited. Replaces LiveStore `terminalStatusChanged`.
- **Server-to-client:** `{"type":"status","status":"restarted"}` — terminal restarted. Replaces LiveStore `TerminalRestarted` event stream. Client should clear xterm.js buffer.
- **Server-to-client:** `{"type":"status","status":"running"}` — terminal is running (sent on initial connect).
- **Client-to-server:** Raw text frames (PTY input) and JSON `{"type":"ack","chars":N}` (flow control) — unchanged.

Text frames that start with `{` and contain `"type":"status"` are control messages; all other text frames are PTY data. Alternatively, a binary framing protocol can distinguish control from data, but JSON prefix detection is simpler and matches the existing ack frame pattern.

### Server-Side Changes

The server removes all terminal modules and adds a `TerminalClient` Effect service:
- Connects to the terminal service via Effect RPC HTTP client at `http://localhost:${TERMINAL_PORT}`.
- Provides methods matching the terminal RPC contract for the server to call (spawn, kill, list, etc.).
- Subscribes to `terminal.events()` on startup for any server-side orchestration needs (workspace cleanup tracking).
- The server tracks which terminal IDs belong to which workspace in its own in-memory map, so `killAllForWorkspace` can call `terminal.kill` for each.

The `node-pty` dependency is removed from the server's `package.json`.

### LiveStore Terminal State Removal

The terminal events and table are removed from LiveStore:
- Remove events: `v1.TerminalSpawned`, `v1.TerminalStatusChanged`, `v1.TerminalKilled`, `v1.TerminalRemoved`, `v1.TerminalRestarted`, `v1.TerminalOutput`.
- Remove table: `terminals`.
- The `panelLayout` table's `LeafNode` type retains the `terminalId` field — it's a string reference that the UI uses to reconnect terminal panes to their WebSocket channels. Validation of whether a terminal ID is still valid is done via the terminal service RPC.

### Web App Changes

The web app replaces all LiveStore terminal queries with terminal service RPC calls:
- `terminal-list.tsx`: Calls `terminal.list()` via RPC (or fetches from the server which proxies it). Uses React Query (or a similar mechanism) for caching and reactive updates. Polls or subscribes to changes.
- `terminal-pane.tsx`: Terminal status is derived from the WebSocket connection state and control messages, not from LiveStore. The "Process exited" banner is triggered by `{"type":"status","status":"stopped"}` WebSocket message. The xterm.js buffer clear on restart is triggered by `{"type":"status","status":"restarted"}` WebSocket message.
- `routes/index.tsx`: Initial panel layout generation queries the terminal service for running terminals instead of LiveStore.
- `workspace-dashboard.tsx`: Terminal counts come from the terminal service RPC.

The Vite dev proxy is updated:
- `/terminal` WebSocket -> `http://localhost:${TERMINAL_PORT}` (direct to terminal service)
- Terminal RPC calls route to the terminal service port (new proxy rule, or the web app calls the terminal service directly)

### Environment Configuration

A shared `.env.local` file in the repo root contains all environment variables. Both the server and terminal service use `dotenv -e ../../.env.local` to load it. The terminal service reads `TERMINAL_PORT` (default 3001). The server reads `TERMINAL_PORT` to know where the terminal service is.

Package scripts pattern:
```json
{
  "with-env": "dotenv -e ../../.env.local --",
  "dev": "pnpm with-env bun run --watch src/main.ts",
  "start": "pnpm with-env bun run src/main.ts"
}
```

### Turbo Configuration

`turbo.json` adds a `dev` task for the terminal package. The terminal service and server run as independent `persistent` dev tasks — neither depends on the other for startup, though the server will retry connecting to the terminal service if it starts first.

The terminal service's `--watch` mode only watches files within `packages/terminal/` (Bun's default behavior since it watches the entry point's dependency graph). Server code changes do not trigger terminal service restarts.

### Grace Period and Reconnection

Following VS Code's model:
- When a terminal's last WebSocket subscriber disconnects, a 60-second grace timer starts (configurable via env var).
- If a new WebSocket subscriber connects within the grace period, the timer is cancelled and the ring buffer is replayed for seamless reconnection.
- If the grace period expires with no subscribers, the terminal is killed.
- This enables terminals to survive brief network interruptions, page reloads, and server restarts during development.

### Orphan Detection

A simplified version of VS Code's orphan protocol:
- On terminal service startup, there are no orphans (in-memory state starts empty).
- During operation, the grace period mechanism handles orphan cleanup automatically.
- If a terminal is spawned via RPC but never has a WebSocket subscriber connect within the grace period, it is killed as an orphan.

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior through the module's public interface, not implementation details. A test should break only when the module's behavior changes, not when its internal structure is refactored. Tests should be deterministic and not depend on timing or external services.

### Modules to Test

**Ported tests (from `@laborer/server` to `@laborer/terminal`):**
- `pty-host.test.ts` — Tests for the PTY Host child process IPC protocol, spawning, data coalescing, flow control, and error handling. These move unchanged.
- `terminal-manager.test.ts` — Tests for terminal lifecycle management. Updated to remove LiveStore assertions and add assertions for the new event emission, grace period, and in-memory stopped terminal retention.
- `ring-buffer.test.ts` — Tests for the circular byte buffer. Moves unchanged.

**New tests:**
- Terminal RPC integration tests — Spawn a terminal via RPC, verify it appears in `terminal.list()`, write data, verify output via WebSocket, kill it, verify status change via the event stream.
- Grace period tests — Verify that terminals survive subscriber disconnect within the grace period and are cleaned up after it expires.
- WebSocket control message tests — Verify that status control messages are sent on terminal exit and restart.

### Prior Art

The existing `pty-host.test.ts` and `terminal-manager.test.ts` in `packages/server/test/` provide the pattern: Effect test layers with mocked dependencies, `vitest` as the test runner, and `Effect.gen` for test bodies.

## Out of Scope

- **Terminal buffer persistence across terminal service restarts.** VS Code serializes xterm.js buffer state for cross-session recovery. Our terminals are fully ephemeral — if the terminal service restarts, all terminals are lost. This matches the current behavior where server restarts lose terminals.
- **Headless xterm.js serializer.** VS Code runs a headless xterm.js in the PTY Host for buffer serialization. Our ring buffer replay is sufficient and simpler.
- **Multi-window orphan detection protocol.** VS Code's question/reply protocol handles multiple editor windows claiming terminals. We have a single server, so the grace period timer is sufficient.
- **Terminal profiles.** VS Code has a rich terminal profile system (shell discovery, user configuration, extension contributions). Our terminals are spawned with explicit commands — no profile abstraction needed.
- **Horizontal scaling.** The terminal service is a single process. Running multiple instances with terminal affinity is out of scope.
- **Authentication/authorization** between the server and terminal service. They run on localhost in a trusted environment.
- **LiveStore migration/versioning** for the schema change (removing terminal events/table). Existing eventlogs may contain terminal events — the deprecated no-op materializer pattern (already used for `v1.TerminalOutput`) handles backward compatibility.

## Further Notes

- The `node-pty` dependency and its `spawn-helper` permission fix logic move entirely to the terminal package. The server no longer needs a native module dependency.
- The terminal service should log its port on startup so developers can verify it's running.
- If the terminal service is unreachable when the server starts, the server should log a warning and retry — not crash. Terminal operations will fail gracefully until the terminal service is available.
- The web app should show a clear "Terminal service unavailable" state if it cannot connect, rather than silently failing.
- This extraction creates a clean boundary that enables future improvements: the terminal service could run on a different machine, support multiple servers, or be replaced with a different implementation without changing the server or web app.
