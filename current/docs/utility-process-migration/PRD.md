# Utility Process Migration — Product Requirements Document

## Problem Statement

Laborer's built desktop app fails to start its backend services. When a user builds the app (`bun build:app`), installs it, and opens it, they see "Terminal service unavailable — RpcClientError: Failed to send HTTP request." The same error appears for the terminal service and potentially other sidecars.

The root cause is architectural: all four sidecar services (server, terminal, file-watcher, mcp) are spawned as child processes using `child_process.spawn()` with `ELECTRON_RUN_AS_NODE=1`, which runs the Electron binary as a plain Node.js process. Native addons like `node-pty` (terminal) and `@parcel/watcher` (file-watcher) are compiled against Bun's or system Node's ABI during `bun install --production` in the build script, but the Electron binary has a different Node.js ABI. This causes the sidecar processes to crash on startup when they attempt to load native modules.

Beyond the immediate crash, the current architecture has several structural issues:

1. **Ephemeral port allocation has race conditions.** The app reserves ports by binding to port 0, recording the port, then immediately closing — another process can claim the port before the sidecar binds to it.
2. **HTTP health polling is wasteful.** The HealthMonitor polls `http://127.0.0.1:<port>` with exponential backoff for every sidecar, adding startup latency and complexity.
3. **Auth token management for localhost HTTP.** Each sidecar needs an auth token to prevent other local processes from accessing its HTTP API.
4. **The `dev:web` browser mode fragments the codebase.** Maintaining two IPC transports (HTTP for browser, something else for Electron) adds complexity with no clear user benefit.

VS Code solved all of these problems by running services in Electron **utility processes** with **MessagePort IPC** — no HTTP servers, no port allocation, no health polling. This is the architecture we want to adopt.

## Solution

Migrate all four sidecar services from `child_process.spawn()` with HTTP/WebSocket communication to Electron `utilityProcess.fork()` with MessagePort IPC. Remove HTTP servers from sidecar packages entirely. Remove the `dev:web` browser mode. Unify dev and prod to both use utility processes, with `tsdown --watch` + auto-restart providing hot reload in dev.

### VS Code Reference Architecture

VS Code runs these services as utility processes (reference files in `.reference/vscode/`):

| Service | VS Code Reference |
|---------|------------------|
| **Utility process wrapper** | `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts` (line 153: `UtilityProcess` class, line 261: `utilityProcess.fork()` call, line 397: `connect()` creates MessagePort pair) |
| **Pty Host spawning** | `src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts` (line 50: `start()`, line 68: MessagePort connect, line 44: direct renderer connection via `ipcMain`) |
| **Pty Host entry point** | `src/vs/platform/terminal/node/ptyHostMain.ts` (line 52: detects utility process via `isUtilityProcess()`, line 83: registers `PtyService`) |
| **Pty Host service (node-pty)** | `src/vs/platform/terminal/node/ptyService.ts` (line 97: `PtyService`, line 337: creates `TerminalProcess`) |
| **Terminal process (node-pty wrapper)** | `src/vs/platform/terminal/node/terminalProcess.ts` (line 22: `import { spawn } from 'node-pty'`, line 311: `spawn()` call) |
| **Heartbeat service** | `src/vs/platform/terminal/node/heartbeatService.ts` (line 10: liveness monitoring) |
| **Pty Host lifecycle management** | `src/vs/platform/terminal/node/ptyHostService.ts` (line 33: `PtyHostService` proxy, line 365: `restartPtyHost()`, line 26: `MaxRestarts = 5`) |
| **Shared process (utility process)** | `src/vs/platform/sharedProcess/electron-main/sharedProcess.ts` (line 171: `type: 'shared-process'`) |
| **Extension host (utility process)** | `src/vs/platform/extensions/electron-main/extensionHostStarter.ts` (line 114: `type: 'extensionHost'`, line 121: `allowLoadingUnsignedLibraries: true`) |
| **File watcher (utility process)** | `src/vs/workbench/services/files/electron-browser/watcherClient.ts` (line 36: `type: 'fileWatcher'`) |
| **Window-scoped utility process** | `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts` (line 465: `WindowUtilityProcess`) |
| **MessagePort IPC server (utility side)** | `src/vs/base/parts/ipc/node/ipc.mp.ts` (line 57: listens on `process.parentPort`) |
| **MessagePort IPC client (main side)** | `src/vs/base/parts/ipc/electron-main/ipc.mp.ts` (line 16) |
| **Renderer MessagePort acquisition** | `src/vs/base/parts/ipc/electron-browser/ipc.mp.ts` (line 17: `acquirePort()`) |
| **Direct renderer-to-pty-host connection** | `src/vs/workbench/contrib/terminal/electron-browser/localTerminalBackend.ts` (line 110: `_connectToDirectProxy()`, line 135: `acquirePort()`) |
| **Utility process detection** | `src/vs/base/parts/sandbox/node/electronTypes.ts` (line 75: `isUtilityProcess()` checks for `process.parentPort`) |
| **IPC channel definitions** | `src/vs/platform/terminal/common/terminal.ts` (line 226: `TerminalIpcChannels` enum) |
| **Environment construction** | `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts` (line 276: `createEnv()` deep-clones `process.env`, strips dangerous vars) |
| **Crash recovery** | `src/vs/platform/terminal/node/ptyHostService.ts` (line 160: auto-restart up to 5 times on unexpected exit) |

## User Stories

1. As a developer, I want the built desktop app to start all services successfully, so that I can use terminals, file watching, and the server without errors.
2. As a developer, I want native modules (node-pty, @parcel/watcher) to load correctly in the built app, so that terminals and file watching work in production.
3. As a developer, I want the app to start faster without HTTP health polling delays, so that I can begin working immediately after launch.
4. As a developer, I want no port conflict errors when opening multiple app instances, so that I can run multiple workspaces simultaneously.
5. As a developer, I want sidecar processes to restart automatically if they crash, so that a transient failure doesn't require restarting the whole app.
6. As a developer, I want to see sidecar status (starting, healthy, crashed, restarting) in the UI, so that I know when services are ready or have issues.
7. As a developer, I want terminal sessions to persist across sidecar restarts during development, so that a code change in the terminal service doesn't kill my running shell sessions.
8. As a developer, I want the renderer to communicate with services via MessagePort (not HTTP), so that terminal I/O has minimal latency and zero-copy buffer transfer.
9. As a developer, I want hot reload in dev mode when I change sidecar source code, so that I don't have to manually restart the app to test changes.
10. As a developer, I want the dev and prod architectures to be the same (both using utility processes), so that bugs in process management are caught in dev, not just after building.
11. As a developer, I want to force utility process spawning in dev via an env var (`LABORER_FORCE_UTILITY=1`), so that I can test the production process management without building a full artifact.
12. As a developer, I want the MCP sidecar to communicate via MessagePort with the main process, so that it is consistent with the other three sidecars.
13. As a developer, I want the MCP sidecar to spawn external MCP servers as child processes internally (with stdin pipe), so that the MCP protocol's stdio transport still works despite utility processes not supporting stdin.
14. As a developer, I want the terminal utility process to run node-pty directly (flattened architecture, no nested pty-host child process), so that the terminal architecture is simpler and consistent with VS Code's pty host pattern.
15. As a developer, I want the `dev:web` browser mode removed, so that there is a single IPC transport (MessagePort) and less code to maintain.
16. As a developer, I want the build script updated to work with utility processes, so that `bun build:app` produces a working artifact without `ELECTRON_RUN_AS_NODE` workarounds.
17. As a developer, I want the Vite proxy routes removed since the renderer no longer connects to services via HTTP, so that the codebase is cleaner.
18. As a developer, I want the renderer to get a direct MessagePort to each utility process (bypassing the main process for data), so that high-throughput terminal I/O doesn't bottleneck on the main process.
19. As a developer, I want the existing Effect RPC handlers in sidecar services to remain, with only the transport layer swapped from HTTP to MessagePort, so that service logic doesn't need rewriting.
20. As a developer, I want sidecar crash information (stderr excerpts, exit code) forwarded to the renderer, so that I can diagnose issues without checking console logs.

## 'Polishing' Requirements

1. **Startup sequence.** Verify all four utility processes spawn and become responsive within 2 seconds on a cold start. The renderer should show a loading state while services start.
2. **Crash recovery.** Verify that when a utility process crashes, it auto-restarts (up to a configurable limit), and the renderer receives status updates without manual intervention.
3. **Terminal persistence.** After a terminal utility process restart, verify that existing PTY processes are correctly marked as stopped, and the renderer shows appropriate UI (not stale "running" indicators).
4. **Dev hot reload latency.** Verify that changing a sidecar source file results in the utility process restarting within 500ms (tsdown rebuild + re-fork).
5. **Memory and resource cleanup.** Verify that killing/re-forking utility processes does not leak file descriptors, MessagePorts, or memory in the main process.
6. **Graceful shutdown.** On app quit, verify all utility processes are terminated and all PTY child processes are killed. No orphaned processes.
7. **MessagePort reliability.** Verify that MessagePort connections survive renderer reloads (dev mode) and that the renderer reconnects to services after a reload.
8. **Error messages.** When a utility process fails to start or crashes, the error displayed in the renderer should include actionable context (what service, what happened, stderr excerpt).
9. **Build artifact size.** Verify the built app size does not significantly increase from this migration.
10. **Native module loading.** Verify `node-pty` and `@parcel/watcher` load correctly in utility processes on both arm64 and x64 macOS.

## Implementation Decisions

### Utility Process Manager (replaces SidecarManager)

A new module in `apps/desktop/` that replaces `SidecarManager`. Wraps Electron's `utilityProcess.fork()` API following VS Code's pattern (ref: `.reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts`).

Key responsibilities:
- Fork utility processes with `utilityProcess.fork(bootstrapPath, args, { serviceName, env, stdio: 'pipe' })`
- Create MessagePort pairs via `MessageChannelMain` for each utility process (ref: VS Code's `connect()` at line 397)
- Capture stdout/stderr for logging and crash diagnostics
- Track process lifecycle (spawn, exit events)
- Handle kill with SIGTERM, escalating to SIGKILL after a timeout
- Provide a `restart()` method that kills the old process and forks a new one

The entry point for each utility process is a bootstrap script (similar to VS Code's `bootstrap-fork.ts`) that reads a `LABORER_ENTRYPOINT` env var and dynamically imports the actual service module.

### Lifecycle Monitor (replaces HealthMonitor)

A new module that replaces the HTTP-polling `HealthMonitor`. Uses native utility process events instead of HTTP health checks:

- **Startup detection:** The utility process sends a `ready` message via `process.parentPort.postMessage()` once its service layer is initialized. The main process listens for this via the MessagePort. (ref: VS Code's `HeartbeatService` at `.reference/vscode/src/vs/platform/terminal/node/heartbeatService.ts`)
- **Crash detection:** Listens to the utility process `exit` event. On unexpected exit, schedules auto-restart with exponential backoff (500ms, 1s, 2s, 4s, 8s, capped at 10s) — same timing as current HealthMonitor.
- **Heartbeat:** Each utility process sends periodic heartbeat messages (every 5s). If no heartbeat is received within 15s, the process is considered unresponsive and is killed + restarted. (ref: VS Code's heartbeat monitoring at `.reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts` lines 376-407)
- **Status events:** Emits `starting`, `healthy`, `crashed`, `restarting` status to the renderer via `webContents.send()` — same interface as current HealthMonitor.
- **Max restarts:** Configurable limit (default 5, matching VS Code's `MaxRestarts` at `.reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts` line 26).

### MessagePort IPC Transport for Effect RPC

A new package or module that provides an Effect RPC transport over MessagePort. This replaces the current `RpcClient.layerProtocolHttp()` in the renderer and the HTTP server routes in the sidecars.

**Utility process side (server):**
- Listens on `process.parentPort` for incoming MessagePort connections (ref: `.reference/vscode/src/vs/base/parts/ipc/node/ipc.mp.ts` line 57)
- Each incoming MessagePort becomes an RPC channel
- Effect RPC handlers are registered on the channel (same handlers as current HTTP routes, different transport)

**Renderer side (client):**
- Requests a MessagePort to a utility process via `ipcRenderer.send()` + `acquirePort()` pattern (ref: `.reference/vscode/src/vs/base/parts/ipc/electron-browser/ipc.mp.ts` line 17)
- Wraps the MessagePort in an Effect RPC client transport
- The renderer gets a **direct** MessagePort to each utility process, bypassing the main process for data (ref: VS Code's direct renderer-to-pty-host connection at `.reference/vscode/src/vs/workbench/contrib/terminal/electron-browser/localTerminalBackend.ts` line 110)

**Message format:** Structured clone over MessagePort. Effect RPC requests/responses are serialized as JSON-compatible objects. Terminal output data uses `ArrayBuffer` transfer (zero-copy) for high throughput.

### Terminal Utility Process (flattened architecture)

The terminal sidecar is simplified from a two-level architecture (terminal HTTP server -> pty-host child process) to a single utility process that runs `node-pty` directly. This matches VS Code's pty host pattern (ref: `.reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts`).

Key changes:
- Remove the separate `pty-host.ts` entry point and the `PtyHostClient` that communicates with it over stdin/stdout
- The terminal utility process imports `node-pty` directly and manages PTY instances in-memory
- Remove the HTTP server (`NodeHttpServer`, health route, WebSocket route, RPC route)
- Replace with MessagePort-based RPC handlers and a MessagePort-based data channel for PTY I/O
- The existing `TerminalManager` Effect service keeps its logic but swaps its transport layer

### Terminal Session Persistence Across Restarts

When the terminal utility process restarts (dev hot reload or crash recovery), PTY child processes die. To provide a better experience:

- **Replay buffer:** The terminal utility process maintains a circular buffer of recent output per terminal (similar to VS Code's `PersistentTerminalProcess` using `@xterm/headless` for serialization, ref: `.reference/vscode/src/vs/platform/terminal/node/ptyService.ts` line 343).
- **State serialization on shutdown:** On graceful shutdown (SIGTERM), the terminal utility process serializes active terminal metadata (id, shell, cwd, env, replay buffer) to a temporary file.
- **State restoration on startup:** On startup, the terminal utility process reads the serialized state, re-spawns PTY processes, and replays the buffer to the renderer so terminals appear to survive the restart.
- **Graceful degradation:** If the process crashes (no time to serialize), terminals are marked as stopped in the renderer. The renderer shows the last-known output from its local xterm buffer.

### MCP Utility Process

The MCP sidecar migrates to a utility process with MessagePort IPC to the main process. Since `utilityProcess.fork()` does not support stdin, and the MCP protocol requires stdio transport to communicate with external MCP servers:

- The MCP utility process receives commands from the main process via MessagePort
- Internally, it spawns external MCP servers as `child_process.spawn()` with `stdin: 'pipe'` — the utility process has full access to `child_process` APIs
- This is a two-level architecture: `main process -> (MessagePort) -> MCP utility process -> (stdin/stdout) -> external MCP servers`

### Dev Mode: Unified Architecture with Hot Reload

Dev and prod both use utility processes. Hot reload is achieved via `tsdown --watch` + file-watching + auto-restart:

1. Each sidecar package runs `tsdown --watch` which incrementally rebuilds `dist/main.mjs` on source file changes (~50-150ms rebuild)
2. The main process watches each sidecar's `dist/` directory with `node:fs.watch()` for changes
3. When a change is detected, the main process kills the utility process and re-forks it with the updated code (~100-200ms spawn)
4. Total hot reload latency: ~300-500ms
5. The env var `LABORER_FORCE_UTILITY=1` is not needed since dev always uses utility processes. Instead, an env var `LABORER_SKIP_WATCH=1` can disable the file-watching auto-restart for debugging.

This matches VS Code's approach — they do not have HMR for utility processes; changes require a full restart of the affected process. VS Code's `PtyHostService.restartPtyHost()` (ref: line 365) does exactly this: kill + re-fork.

### Preload and Renderer Changes

The preload script no longer needs to pass service URLs (`--laborer-terminal-url`, `--laborer-server-url`, etc.) via `additionalArguments`. Instead:

- The preload exposes methods to acquire MessagePorts to each service via `contextBridge`
- The renderer calls these methods during initialization to get direct MessagePort connections
- The `desktopBridge` interface drops `getServerUrl()`, `getTerminalUrl()` and adds `acquireServicePort(serviceName)` which returns a `MessagePort` via `ipcRenderer.invoke()` + port transfer (ref: VS Code's `acquirePort()` at `.reference/vscode/src/vs/base/parts/ipc/electron-browser/ipc.mp.ts`)

### Build Script Changes

Update `scripts/build-desktop-artifact.ts` to:

- Remove `ELECTRON_RUN_AS_NODE=1` workarounds
- Include the bootstrap script for utility processes
- Ensure native modules (`node-pty`, `@parcel/watcher`) are compiled against Electron's Node ABI (utility processes share the Electron binary's ABI, so this happens naturally — no `electron-rebuild` needed)
- Remove port reservation and auth token logic from the staging `package.json`
- Update the staging directory structure to include utility process entry points

### Removals

- **`dev:web` script and browser mode** — The renderer only runs inside Electron. Remove `"dev:web"` from root `package.json`.
- **Vite proxy routes** — Remove `/rpc`, `/terminal-rpc`, `/terminal`, `/server-health`, `/terminal-health`, `/file-watcher-health` proxy configs from `apps/web/vite.config.ts`.
- **HTTP server code in sidecars** — Remove `NodeHttpServer`, health routes, WebSocket upgrade handlers, and HTTP RPC routes from `packages/terminal/`, `packages/server/`, `packages/file-watcher/`.
- **`SidecarManager`** — Replaced by the Utility Process Manager.
- **`HealthMonitor`** — Replaced by the Lifecycle Monitor.
- **Port reservation** (`apps/desktop/src/ports.ts`) — No more ephemeral ports or auth tokens.
- **Preload URL arguments** — No more `--laborer-terminal-url`, `--laborer-server-url`, `--laborer-file-watcher-url` parsing.
- **`ELECTRON_RUN_AS_NODE` usage** — Utility processes run natively in Electron's Node.js context.
- **`@laborer/env` server port configs** — `PORT`, `TERMINAL_PORT`, `FILE_WATCHER_PORT` env vars are no longer needed for service discovery.

## Testing Decisions

**What makes a good test:** Tests verify external behavior through public interfaces. They should be deterministic where possible. For utility process tests, we accept OS interaction (process spawning, MessagePort creation) since that is the behavior under test. Tests should NOT test internal IPC message formats — only the observable effect of RPC calls through the transport.

### Utility Process Manager (Integration tests)

Test that the manager can fork, communicate with, and kill utility processes. Verify:
- A utility process can be forked and sends a `ready` message
- MessagePort communication works bidirectionally
- Killing a utility process fires the expected exit event
- Re-forking after a kill produces a working new process
- Crash detection works (force-kill a process and verify crash event)

### MessagePort Effect RPC Transport (Unit tests)

Test the RPC transport layer in isolation using `MessageChannel` (available in Node.js). Verify:
- RPC requests sent over a MessagePort receive correct responses
- Streaming RPC (like terminal events) works over MessagePort
- Error responses are correctly propagated
- Connection cleanup on port close

### Terminal Utility Process (Integration tests)

Test the flattened terminal service that runs node-pty directly. Verify:
- Spawning a terminal produces output
- Writing input produces corresponding output
- Resize changes terminal dimensions
- Killing a terminal produces an exit event
- Multiple concurrent terminals work independently
- Terminal session persistence: after a restart, terminals are re-spawned and output is replayed

### Prior art

Existing tests use `@effect/vitest`. The existing tests in `packages/terminal/test/` and `packages/server/test/` provide patterns for testing Effect services. The new MessagePort transport tests can follow similar patterns.

## Out of Scope

- **Remote/SSH terminal connections.** This PRD covers only local terminal management. Remote terminals via SSH are a separate feature.
- **Flow control for terminal I/O.** VS Code implements high/low watermark flow control for terminal data. This can be added later if buffering becomes an issue.
- **Renderer-to-renderer IPC.** Multi-window communication is not part of this migration.
- **Web/browser client.** The `dev:web` mode is being removed. If browser support is needed in the future, it would be a separate effort with a WebSocket adapter.
- **Shared process pattern.** VS Code groups many services (extension management, settings sync, etc.) into a single "shared process." We keep separate utility processes per service for simplicity.
- **Extension host pattern.** VS Code's window-scoped `WindowUtilityProcess` with `windowLifecycleBound` is not needed since our services are app-scoped, not window-scoped.
- **Code signing for native modules.** VS Code uses `allowLoadingUnsignedLibraries` for extension hosts that load third-party native modules. Our utility processes only load known native modules (node-pty, @parcel/watcher), so this is not needed unless signing issues arise.

## Further Notes

### Why utility processes fix the native module ABI issue

The current architecture runs `process.execPath` (the Electron binary) with `ELECTRON_RUN_AS_NODE=1`, which puts Electron into a Node.js compatibility mode. Native modules compiled during `bun install --production` target Bun's or system Node's ABI, not Electron's. Electron utility processes, by contrast, run as **Chromium service processes** with the same V8 and Node ABI as the Electron main process. Native modules compiled for the Electron version load correctly without recompilation or `electron-rebuild`.

### Why MessagePort over HTTP

MessagePort provides binary-native structured clone with zero-copy `ArrayBuffer` transfer. For terminal I/O (which can be megabytes per second for `cat` of large files), this eliminates JSON serialization, HTTP framing, TCP stack overhead, and the base64 encoding currently used in the pty-host IPC protocol. MessagePort connections are also inherently secure (no network port exposed) and reliable (no port conflicts).

VS Code originally used `child_process.fork()` with JSON-over-IPC for their pty host but migrated to utility processes with MessagePort specifically for performance. Their own comment in `ipc.cp.ts` (ref: `.reference/vscode/src/vs/base/parts/ipc/node/ipc.cp.ts` lines 19-22) states: "This implementation doesn't perform well since it uses base64 encoding for buffers."

### Dev mode hot reload latency budget

The 300-500ms restart budget breaks down as:
- `tsdown --watch` incremental rebuild: ~50-150ms (esbuild is extremely fast)
- `fs.watch()` notification delivery: ~10-50ms
- `utilityProcess.fork()` + bootstrap: ~100-200ms
- Service initialization (Effect layer construction): ~50-100ms

This is comparable to VS Code's utility process restart time. VS Code developers use full restart for all utility process changes — there is no HMR for out-of-renderer code. The 300-500ms latency is fast enough that it feels like a "save and refresh" workflow.

### Terminal persistence across restarts

VS Code implements terminal persistence via `PersistentTerminalProcess` (ref: `.reference/vscode/src/vs/platform/terminal/node/ptyService.ts` line 343) which wraps each terminal in a replay buffer using `@xterm/headless`. When the pty host restarts, terminals are re-created and the buffer is replayed to restore the visual state. This is the pattern we follow. On ungraceful termination (crash), PTY processes are lost but the renderer retains its local xterm buffer, so the user still sees recent output — they just can't type into the terminal until it's re-spawned.
