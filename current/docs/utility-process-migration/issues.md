# Utility Process Migration — Issues

Parent PRD: [PRD.md](./PRD.md)

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Bootstrap entry point script | None | Done |
| 2 | UtilityProcessManager core (fork, kill, restart) | #1 | Done |
| 3 | MessagePort Effect RPC transport (server side) | None | Done |
| 4 | MessagePort Effect RPC transport (client side) | #3 | Done |
| 5 | Preload MessagePort acquisition | #2 | Done |
| 6 | Terminal utility process: basic PTY spawn via MessagePort RPC | #1, #2, #3 | Done |
| 7 | Terminal utility process: full RPC surface | #6 | Done |
| 8 | Terminal PTY I/O data channel over MessagePort | #7, #5 | Done |
| 9 | Renderer terminal UI wired to MessagePort | #8, #4 | Done |
| 10 | Server utility process: RPC over MessagePort | #1, #2, #3 | Done |
| 11 | LiveStore sync over MessagePort | #10, #5 | Done |
| 12 | Renderer server UI wired to MessagePort | #11, #4 | Done |
| 13 | Server-to-terminal MessagePort channel | #6, #10 | Done |
| 14 | File-watcher as utility process | #1, #2, #3, #10 | Done |
| 15 | MCP as utility process | #1, #2, #3 | Done |
| 16 | Lifecycle Monitor (replaces HealthMonitor) | #2 | Done |
| 17 | Dev mode hot reload (tsdown --watch + auto-restart) | #2, #16 | Done |
| 18 | Terminal session persistence across restarts | #6, #16 | Done |
| 19 | Remove HTTP servers, Vite proxy, dev:web, URL resolution | #9, #12, #14, #15 | Done |
| 20 | Build script update + port reservation removal | #19 | Done |

---

## Issue 1: Bootstrap entry point script

### What to build

Create a bootstrap script that all utility processes use as their entry point when forked via `utilityProcess.fork()`. The bootstrap reads a `LABORER_ENTRYPOINT` environment variable and dynamically imports the target service module. It detects whether it is running inside a utility process by checking for `process.parentPort` (ref: `.reference/vscode/src/vs/base/parts/sandbox/node/electronTypes.ts` line 75: `isUtilityProcess()`). After the service module signals readiness, the bootstrap sends a `{ type: 'ready' }` message to the parent via `process.parentPort.postMessage()`.

This follows VS Code's `bootstrap-fork.ts` pattern (ref: `.reference/vscode/src/bootstrap-fork.ts` line 229: dynamic import of `VSCODE_ESM_ENTRYPOINT`).

### Acceptance criteria

- [x] A bootstrap script exists that can be passed to `utilityProcess.fork()` as the module path
- [x] The bootstrap reads `LABORER_ENTRYPOINT` from the environment and dynamically imports it
- [x] The bootstrap detects the utility process context via `process.parentPort`
- [x] After the entrypoint module is loaded, a `{ type: 'ready' }` message is sent to the parent process
- [x] If the entrypoint fails to load, an error message is sent to the parent and the process exits with code 1
- [x] A test verifies: fork the bootstrap with a dummy entrypoint, receive the ready message, kill the process

### Blocked by

None — can start immediately

### User stories addressed

- User story 1 (built app starts services successfully)
- User story 10 (dev and prod architectures are the same)

---

## Issue 2: UtilityProcessManager core (fork, kill, restart)

### What to build

Create a `UtilityProcessManager` class in `apps/desktop/` that replaces the current `SidecarManager`. It wraps Electron's `utilityProcess.fork()` API following VS Code's pattern (ref: `.reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts` line 153: `UtilityProcess` class).

The manager forks utility processes using the bootstrap script from issue #1, creates `MessageChannelMain` port pairs for IPC (ref: VS Code line 397: `connect()`), captures stdout/stderr for logging and crash diagnostics, tracks process lifecycle via `spawn` and `exit` events, and provides methods for kill (SIGTERM with SIGKILL escalation) and restart.

### Acceptance criteria

- [x] `UtilityProcessManager` class with methods: `fork(name, entrypoint)`, `kill(name)`, `restart(name)`, `killAll()`, `killAllAndWait(timeout)`
- [x] Each forked process gets a `MessageChannelMain` pair — one port sent to the utility process, one retained by the manager
- [x] stdout/stderr are captured in pipe mode and stored in a per-process ring buffer (last 50 lines)
- [x] Process lifecycle tracked: `spawn` event sets PID, `exit` event records code
- [x] Kill sends SIGTERM, escalates to force-kill after 2 seconds (matching current SidecarManager behavior)
- [x] `restart()` kills the old process, waits for exit, then forks a new one
- [x] Environment construction deep-clones `process.env`, strips dangerous vars (`DEBUG`, `ELECTRON_RUN_AS_NODE`), sets `LABORER_ENTRYPOINT` (ref: VS Code line 276: `createEnv()`)
- [x] Wired into `main.ts` app lifecycle: fork on `app.whenReady()`, kill all on `before-quit`
- [x] A test verifies: fork a process, verify spawn event, verify MessagePort communication, kill, verify exit event

### Blocked by

- Blocked by "Bootstrap entry point script" (#1)

### User stories addressed

- User story 1 (built app starts services)
- User story 2 (native modules load correctly)
- User story 5 (auto-restart on crash)

---

## Issue 3: MessagePort Effect RPC transport (server side)

### What to build

Build an Effect RPC server transport adapter that serves RPC handlers over a `MessagePort` instead of HTTP. This runs inside utility processes. The adapter listens on `process.parentPort` for incoming `MessagePort` transfers (ref: `.reference/vscode/src/vs/base/parts/ipc/node/ipc.mp.ts` line 57: listens on `process.parentPort`), and wraps each received port in an Effect RPC server channel.

This replaces `RpcServer.layerProtocolHttp` currently used in all sidecar `main.ts` files. The RPC handlers themselves remain unchanged — only the transport layer is swapped.

### Acceptance criteria

- [x] A module exports an Effect Layer that serves an RPC group over a MessagePort
- [x] The adapter receives a `MessagePort` and handles incoming RPC request messages
- [x] Request/response RPC works: client sends a request message, server processes via the RPC handler, sends a response message
- [x] Streaming RPC works: server sends multiple messages for a single request (e.g., `terminal.events` stream)
- [x] Errors in RPC handlers are serialized and sent back as error response messages
- [x] The adapter cleans up when the MessagePort closes
- [x] Unit tests verify all of the above using Node.js `MessageChannel` (no Electron dependency needed for testing)

### Blocked by

None — can start immediately

### User stories addressed

- User story 8 (MessagePort communication)
- User story 19 (Effect RPC handlers remain, transport swapped)

---

## Issue 4: MessagePort Effect RPC transport (client side)

### What to build

Build an Effect RPC client transport adapter that sends RPC requests over a `MessagePort` instead of HTTP. This runs inside the renderer process. It replaces `RpcClient.layerProtocolHttp` currently used in `LaborerClient` and `TerminalServiceClient` atoms.

The adapter wraps a `MessagePort` in an Effect RPC client that supports both request/response and streaming patterns. It pairs with the server-side adapter from issue #3.

### Acceptance criteria

- [x] A module exports an Effect Layer that provides an RPC client over a MessagePort
- [x] The client sends request messages and receives response messages over the port
- [x] Streaming responses work: the client receives multiple messages for a single stream request and yields them as an Effect Stream
- [x] Error responses from the server are deserialized and surfaced as Effect RPC errors
- [x] The client handles port disconnection gracefully (surfaces as a connection error)
- [x] Unit tests verify request/response, streaming, error propagation, and disconnection using Node.js `MessageChannel` paired with the server adapter from #3

### Blocked by

- Blocked by "MessagePort Effect RPC transport (server side)" (#3)

### User stories addressed

- User story 8 (MessagePort communication)
- User story 19 (Effect RPC handlers remain, transport swapped)

---

## Issue 5: Preload MessagePort acquisition

### What to build

Update the Electron preload script to expose a method for the renderer to acquire direct `MessagePort` connections to utility processes. This follows VS Code's `acquirePort()` pattern (ref: `.reference/vscode/src/vs/base/parts/ipc/electron-browser/ipc.mp.ts` line 17).

The flow: renderer calls `desktopBridge.acquireServicePort(serviceName)` → preload sends an IPC request to the main process → main process creates a `MessageChannelMain` pair, sends one port to the named utility process, returns the other to the renderer via `webContents.postMessage()` → renderer receives the `MessagePort`.

For direct renderer-to-utility-process connections (ref: VS Code's `localTerminalBackend.ts` line 110: `_connectToDirectProxy()`), the main process listens on `ipcMain` for port acquisition requests and brokers the connection.

### Acceptance criteria

- [x] `DesktopBridge` interface gains `acquireServicePort(serviceName: string): Promise<MessagePort>`
- [x] Preload exposes the method via `contextBridge.exposeInMainWorld()`
- [x] Main process handles `laborer:acquire-service-port` IPC: creates `MessageChannelMain`, transfers one port to the utility process, returns the other to the requesting renderer window
- [x] The renderer receives a working `MessagePort` that can send/receive messages to/from the utility process
- [x] Multiple ports can be acquired for different services
- [x] Port acquisition works after a utility process restart (new port to new process)
- [x] Test: renderer acquires a port, sends a ping, receives a pong from the utility process

### Blocked by

- Blocked by "UtilityProcessManager core" (#2)

### User stories addressed

- User story 8 (renderer communicates via MessagePort)
- User story 18 (direct MessagePort bypassing main process)

---

## Issue 6: Terminal utility process: basic PTY spawn via MessagePort RPC

### What to build

Fork the terminal service as an Electron utility process and flatten the existing two-level architecture (terminal HTTP server → pty-host child process) into a single process that imports `node-pty` directly. This matches VS Code's pty host pattern (ref: `.reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts` line 83: registers `PtyService`; ref: `.reference/vscode/src/vs/platform/terminal/node/terminalProcess.ts` line 311: direct `spawn()` call).

Implement the two most essential RPC handlers (`terminal.spawn` and `terminal.kill`) over the MessagePort RPC transport from issue #3. No renderer changes yet — validate by calling RPCs from the main process or a test harness.

### Acceptance criteria

- [x] Terminal service forks as a utility process via `UtilityProcessManager.fork('terminal', ...)`
- [x] The utility process imports `node-pty` directly (no separate pty-host child process)
- [x] `terminal.spawn` RPC: creates a PTY via `node-pty.spawn()`, returns terminal metadata (id, pid, shell, cwd)
- [x] `terminal.kill` RPC: kills the PTY process, returns confirmation
- [x] PTY output data is available via the MessagePort (at minimum, a data event or callback)
- [x] The existing `TerminalManager` Effect service logic is preserved, only the transport and pty-host layers change
- [x] Test: fork the terminal utility process, call `spawn`, verify PTY produces output, call `kill`, verify exit

### Blocked by

- Blocked by "Bootstrap entry point script" (#1)
- Blocked by "UtilityProcessManager core" (#2)
- Blocked by "MessagePort Effect RPC transport (server side)" (#3)

### User stories addressed

- User story 1 (built app starts services)
- User story 2 (native modules load correctly — node-pty in utility process)
- User story 14 (flattened terminal architecture)

---

## Issue 7: Terminal utility process: full RPC surface

### What to build

Extend the terminal utility process to implement the complete `TerminalRpcs` surface over MessagePort: `write`, `resize`, `list`, `remove`, `restart`, and `events` (streaming). After this issue, the terminal utility process has full feature parity with the current HTTP-based terminal service.

### Acceptance criteria

- [x] `terminal.write` RPC: sends input data to a PTY
- [x] `terminal.resize` RPC: changes PTY dimensions (cols, rows)
- [x] `terminal.list` RPC: returns all active terminals with metadata
- [x] `terminal.remove` RPC: removes a terminal from the manager
- [x] `terminal.restart` RPC: kills and re-spawns a terminal with the same config
- [x] `terminal.events` streaming RPC: emits terminal lifecycle events (spawned, output, exited) as an Effect Stream over MessagePort
- [x] All RPCs match the existing `TerminalRpcs` type definitions in `packages/shared/src/rpc.ts`
- [x] Tests verify each RPC handler end-to-end through the MessagePort transport

### Blocked by

- Blocked by "Terminal utility process: basic PTY spawn via MessagePort RPC" (#6)

### User stories addressed

- User story 19 (Effect RPC handlers remain, transport swapped)

---

## Issue 8: Terminal PTY I/O data channel over MessagePort

### What to build

Replace the WebSocket-based PTY data channel (`ws://.../terminal?id=<id>`) with a dedicated `MessagePort` per terminal session. Terminal output uses `ArrayBuffer` transfer for zero-copy (ref: PRD section "MessagePort IPC Transport for Effect RPC" — "Terminal output data uses ArrayBuffer transfer").

The main process brokers a per-terminal `MessagePort` pair: one end goes to the terminal utility process (attached to a specific PTY), the other goes to the renderer (attached to the xterm.js instance).

### Acceptance criteria

- [x] When a terminal is spawned, the renderer can request a dedicated `MessagePort` for that terminal's I/O
- [x] PTY output bytes are sent from the terminal utility process to the renderer via `MessagePort.postMessage()` with `ArrayBuffer` transfer (zero-copy)
- [x] Renderer input bytes are sent to the terminal utility process via the same `MessagePort`
- [x] The data channel is separate from the RPC channel (RPC handles commands, data channel handles I/O stream)
- [x] The `MessagePort` is closed when the terminal exits
- [x] Latency is imperceptible (under 50ms keystroke-to-echo for local PTY)
- [x] Test: spawn a terminal, connect the data channel, send input, verify output arrives via the MessagePort

### Blocked by

- Blocked by "Terminal utility process: full RPC surface" (#7)
- Blocked by "Preload MessagePort acquisition" (#5)

### User stories addressed

- User story 8 (MessagePort for terminal I/O)
- User story 18 (direct MessagePort to utility process)

---

## Issue 9: Renderer terminal UI wired to MessagePort

### What to build

Update the renderer's terminal UI components to use MessagePort transport instead of HTTP/WebSocket. This is the end-to-end tracer bullet: the terminal list loads, terminals spawn, and PTY I/O flows entirely through MessagePort.

Key files to change:
- `TerminalServiceClient` atom: swap `RpcClient.layerProtocolHttp` for the MessagePort RPC client from #4
- `use-terminal-list` hook: update to use the MessagePort-based client
- `use-terminal-websocket` hook: replace WebSocket connection with the MessagePort data channel from #8
- `terminal-list.tsx`: update error handling (no more "Start terminal service with turbo dev" — use sidecar status instead)

### Acceptance criteria

- [x] `TerminalServiceClient` atom uses the MessagePort Effect RPC client transport
- [x] Terminal list loads via MessagePort RPC (`terminal.list`)
- [x] Creating a new terminal calls `terminal.spawn` via MessagePort RPC
- [x] Terminal I/O (typing, output rendering) flows through the MessagePort data channel
- [x] Terminal resize events are sent via MessagePort RPC
- [x] Terminal kill/remove works via MessagePort RPC
- [x] Error state shows meaningful message when the terminal utility process is unavailable (not the old HTTP error)
- [x] The `terminal.events` stream works over MessagePort for real-time terminal list updates

### Blocked by

- Blocked by "Terminal PTY I/O data channel over MessagePort" (#8)
- Blocked by "MessagePort Effect RPC transport (client side)" (#4)

### User stories addressed

- User story 1 (built app works)
- User story 8 (MessagePort communication)

---

## Issue 10: Server utility process: RPC over MessagePort

### What to build

Fork the main server as an Electron utility process and serve `LaborerRpcs` handlers over MessagePort instead of HTTP. The server has a complex initialization sequence with deferred services — this must be preserved. The server currently also acts as an HTTP RPC client to terminal and file-watcher services; that inter-service communication is addressed separately in issues #13 and #14.

### Acceptance criteria

- [x] Server forks as a utility process via `UtilityProcessManager.fork('server', ...)`
- [x] `LaborerRpcs` handlers are served over the MessagePort RPC transport
- [x] The server's deferred service initialization pattern is preserved (ready message sent after core layers, deferred services build in background)
- [x] A simple RPC call (e.g., `health` or `project.list`) works from the main process via MessagePort
- [x] Server-to-terminal and server-to-file-watcher connections are temporarily stubbed or left as HTTP (migrated in #13, #14)
- [x] The server's LiveStore setup is preserved (sync channel migrated separately in #11)
- [x] Test: fork server utility process, call an RPC, verify response

### Blocked by

- Blocked by "Bootstrap entry point script" (#1)
- Blocked by "UtilityProcessManager core" (#2)
- Blocked by "MessagePort Effect RPC transport (server side)" (#3)

### User stories addressed

- User story 1 (built app starts services)
- User story 19 (Effect RPC handlers remain, transport swapped)

---

## Issue 11: LiveStore sync over MessagePort

### What to build

Replace the WebSocket-based LiveStore sync channel between the server and the renderer with a MessagePort channel. Currently the renderer's LiveStore web worker connects via `WebSocket` to `GET /rpc` (WebSocket upgrade) on the server. With this change, the renderer acquires a `MessagePort` to the server utility process and passes it to the LiveStore web worker for sync.

### Acceptance criteria

- [x] The server utility process exposes a LiveStore sync channel over a dedicated `MessagePort`
- [x] The renderer acquires this `MessagePort` via the preload bridge
- [x] The LiveStore web worker receives the `MessagePort` and uses it for sync instead of a WebSocket URL
- [x] LiveStore events committed on the server propagate to the renderer in real time
- [x] LiveStore events committed on the renderer propagate to the server
- [x] Sync works correctly after a renderer reload (new port acquisition)
- [x] Test: commit an event on the server, verify it appears in the renderer's LiveStore

### Blocked by

- Blocked by "Server utility process: RPC over MessagePort" (#10)
- Blocked by "Preload MessagePort acquisition" (#5)

### User stories addressed

- User story 8 (MessagePort communication)

---

## Issue 12: Renderer server UI wired to MessagePort

### What to build

Update the renderer's `LaborerClient` atom to use the MessagePort Effect RPC client transport instead of HTTP. All server RPC calls (project CRUD, workspace management, config, PRD operations, brrr, tasks, reviews, GitHub, etc.) flow through MessagePort.

### Acceptance criteria

- [x] `LaborerClient` atom uses the MessagePort Effect RPC client transport
- [x] All ~30 `LaborerRpcs` endpoints work over MessagePort
- [x] Project listing, workspace creation, config updates, PRD operations all function correctly
- [x] The `server-init-status` check (deferred service readiness) works over MessagePort
- [x] Error handling surfaces meaningful messages when the server utility process is unavailable

### Blocked by

- Blocked by "LiveStore sync over MessagePort" (#11)
- Blocked by "MessagePort Effect RPC transport (client side)" (#4)

### User stories addressed

- User story 1 (built app works)
- User story 8 (MessagePort communication)
- User story 19 (Effect RPC handlers remain, transport swapped)

---

## Issue 13: Server-to-terminal MessagePort channel

### What to build

The server utility process currently connects to the terminal service via an HTTP RPC client (`TerminalClient` using `createSidecarRpcClient()` in `sidecar-rpc.ts`). Replace this with a `MessagePort` channel between the two utility processes.

The main process brokers the connection: creates a `MessageChannelMain` pair, sends one port to the server utility process, sends the other to the terminal utility process. The server uses the MessagePort Effect RPC client to call `TerminalRpcs` on the terminal.

### Acceptance criteria

- [x] Main process creates a `MessageChannelMain` pair and transfers ports to server and terminal utility processes
- [x] Server's `TerminalClient` uses the MessagePort RPC client instead of HTTP
- [x] `createSidecarRpcClient()` in `sidecar-rpc.ts` supports MessagePort transport (or is replaced)
- [x] Server can call `terminal.spawn`, `terminal.write`, etc. on the terminal utility process via MessagePort
- [x] The lazy connection pattern is preserved (server doesn't block startup if terminal isn't ready yet)
- [x] Test: server calls terminal RPC via the brokered MessagePort

### Blocked by

- Blocked by "Terminal utility process: basic PTY spawn via MessagePort RPC" (#6)
- Blocked by "Server utility process: RPC over MessagePort" (#10)

### User stories addressed

- User story 4 (no port conflicts)
- User story 8 (MessagePort communication)

---

## Issue 14: File-watcher as utility process

### What to build

Migrate the file-watcher service from `child_process.spawn()` + HTTP to `utilityProcess.fork()` + MessagePort. Serve `FileWatcherRpcs` over MessagePort. The main process brokers a MessagePort pair between the server and file-watcher utility processes, replacing the server's HTTP-based `FileWatcherClient`.

### Acceptance criteria

- [x] File-watcher forks as a utility process via `UtilityProcessManager.fork('file-watcher', ...)`
- [x] `FileWatcherRpcs` handlers served over MessagePort RPC transport
- [x] `@parcel/watcher` native module loads correctly in the utility process
- [x] Main process brokers a MessagePort between server and file-watcher utility processes
- [x] Server's `FileWatcherClient` uses MessagePort RPC client instead of HTTP
- [x] `fileWatcher.subscribe`, `fileWatcher.events` (streaming), and other RPCs work over MessagePort
- [x] Test: fork file-watcher, subscribe to a directory, create a file, verify event received

### Blocked by

- Blocked by "Bootstrap entry point script" (#1)
- Blocked by "UtilityProcessManager core" (#2)
- Blocked by "MessagePort Effect RPC transport (server side)" (#3)
- Blocked by "Server utility process: RPC over MessagePort" (#10)

### User stories addressed

- User story 1 (built app starts services)
- User story 2 (native modules — @parcel/watcher loads in utility process)

---

## Issue 15: MCP as utility process

### What to build

Migrate the MCP sidecar from `child_process.spawn()` with stdin pipe to `utilityProcess.fork()` with MessagePort. Since `utilityProcess.fork()` does not support stdin (always `'ignore'`), the MCP utility process receives commands from the main process via MessagePort. Internally, it spawns external MCP servers as `child_process.spawn()` with `stdin: 'pipe'` — the utility process has full access to `child_process` APIs.

The MCP service currently also connects to the main server via HTTP RPC (`LaborerRpcClient`). This should be updated to use a MessagePort brokered by the main process.

### Acceptance criteria

- [x] MCP forks as a utility process via `UtilityProcessManager.fork('mcp', ...)`
- [x] The MCP utility process receives commands from the main process via MessagePort (not stdin)
- [x] The MCP utility process spawns external MCP servers as `child_process` with stdin pipe internally
- [x] The MCP stdio transport for external servers (JSON-RPC over stdin/stdout) continues to work
- [x] Main process brokers a MessagePort between MCP and server utility processes for `LaborerRpcClient`
- [x] The MCP tool surface (PRD tools, project discovery, etc.) works end-to-end
- [x] Test: fork MCP utility process, send a command via MessagePort, verify it processes correctly

### Blocked by

- Blocked by "Bootstrap entry point script" (#1)
- Blocked by "UtilityProcessManager core" (#2)
- Blocked by "MessagePort Effect RPC transport (server side)" (#3)

### User stories addressed

- User story 12 (MCP communicates via MessagePort)
- User story 13 (MCP spawns external servers with stdin)

---

## Issue 16: Lifecycle Monitor (replaces HealthMonitor)

### What to build

Build a new `LifecycleMonitor` class that replaces the HTTP-polling `HealthMonitor`. It uses native utility process events and a heartbeat MessagePort protocol instead of HTTP health checks.

Reference: VS Code's `HeartbeatService` (ref: `.reference/vscode/src/vs/platform/terminal/node/heartbeatService.ts` line 10) and `PtyHostService` crash recovery (ref: `.reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts` lines 160-170: auto-restart, line 26: `MaxRestarts = 5`, lines 376-407: heartbeat monitoring).

### Acceptance criteria

- [x] Startup detection: listens for `{ type: 'ready' }` message from utility processes, emits `healthy` status
- [x] Crash detection: listens for utility process `exit` events, emits `crashed` status with stderr excerpt and exit code
- [x] Auto-restart on unexpected exit with exponential backoff (500ms, 1s, 2s, 4s, 8s, capped at 10s)
- [x] Max restart limit (default 5) — after limit, emits `crashed` and stops retrying
- [x] Heartbeat: utility processes send periodic heartbeat messages (every 5s); if no heartbeat within 15s, the process is killed + restarted as unresponsive
- [x] Status events (`starting`, `healthy`, `crashed`, `restarting`) forwarded to all renderer windows via `webContents.send('sidecar:status', status)`
- [x] Manual restart support via IPC from renderer (resets backoff counter)
- [x] Graceful shutdown: cancels all pending restart timers
- [x] Test: fork a utility process, kill it, verify crash detection and auto-restart

### Blocked by

- Blocked by "UtilityProcessManager core" (#2)

### User stories addressed

- User story 3 (faster startup without health polling)
- User story 5 (auto-restart on crash)
- User story 6 (sidecar status in UI)
- User story 20 (crash info forwarded to renderer)

---

## Issue 17: Dev mode hot reload (tsdown --watch + auto-restart)

### What to build

Implement dev-mode hot reload for utility processes. When a sidecar's source code changes, `tsdown --watch` incrementally rebuilds the `dist/main.mjs` file. The main process watches each sidecar's `dist/` directory with `node:fs.watch()` and automatically kills + re-forks the affected utility process.

Update turbo config and package.json dev scripts so that the new workflow runs `tsdown --watch` for each sidecar package alongside the desktop main process. Remove the old `tsx --watch` dev scripts and `dev:web` mode.

### Acceptance criteria

- [x] Main process watches `packages/*/dist/` directories for changes using `node:fs.watch()`
- [x] When a dist file changes, the corresponding utility process is killed and re-forked
- [x] A debounce prevents multiple rapid restarts during a single rebuild
- [x] Total hot reload latency is under 500ms (rebuild + restart)
- [x] `LABORER_SKIP_WATCH=1` env var disables file watching for debugging
- [x] `turbo.json` updated: `dev` task runs `tsdown --watch` for sidecar packages
- [x] Package.json `dev` scripts updated for each sidecar package
- [x] The desktop dev script orchestrates: start Electron, watch dist dirs, fork utility processes
- [x] Utility process restarts use the LifecycleMonitor from #16 (restart counts, status events)
- [x] Test: change a sidecar source file, verify the utility process restarts within 500ms

### Blocked by

- Blocked by "UtilityProcessManager core" (#2)
- Blocked by "Lifecycle Monitor" (#16)

### User stories addressed

- User story 9 (hot reload in dev)
- User story 10 (dev and prod same architecture)

---

## Issue 18: Terminal session persistence across restarts

### What to build

Implement terminal session persistence so that terminals survive utility process restarts (both dev hot reload and crash recovery). This follows VS Code's `PersistentTerminalProcess` pattern (ref: `.reference/vscode/src/vs/platform/terminal/node/ptyService.ts` line 343: wraps terminals in replay buffers using `@xterm/headless`).

### Acceptance criteria

- [x] Each terminal has a circular replay buffer of recent output maintained in the terminal utility process
- [x] On graceful shutdown (SIGTERM), the terminal utility process serializes active terminal metadata (id, shell, cwd, env, replay buffer contents) to a temporary file
- [x] On startup, the terminal utility process checks for serialized state, re-spawns PTY processes with the same configuration, and replays the buffer
- [x] After a graceful restart, the renderer receives replay data and the terminal appears to continue seamlessly
- [x] On ungraceful termination (crash, SIGKILL), terminals are marked as stopped in the renderer
- [x] The renderer retains its local xterm buffer on crash, showing last-known output even without replay
- [x] Replay buffer size is configurable (default: sufficient for ~1000 lines of terminal output)
- [x] Test: spawn a terminal, produce output, gracefully restart the utility process, verify output is replayed

### Blocked by

- Blocked by "Terminal utility process: basic PTY spawn via MessagePort RPC" (#6)
- Blocked by "Lifecycle Monitor" (#16)

### User stories addressed

- User story 7 (terminals persist across restarts)

---

## Issue 19: Remove HTTP servers, Vite proxy, dev:web, URL resolution

### What to build

With all four services running as utility processes with MessagePort IPC, remove all the HTTP infrastructure that is no longer needed. This is a cleanup issue — no new functionality, just removal of dead code.

### Acceptance criteria

- [x] HTTP server code removed from `packages/terminal/` (NodeHttpServer, health route, WebSocket upgrade, HTTP RPC route)
- [x] HTTP server code removed from `packages/server/` (NodeHttpServer, health route, init-status route, HTTP RPC route, WebSocket sync upgrade)
- [x] HTTP server code removed from `packages/file-watcher/` (NodeHttpServer, health route, HTTP RPC route)
- [x] Vite proxy routes removed from `apps/web/vite.config.ts` (`/rpc`, `/terminal-rpc`, `/terminal`, `/*-health`)
- [x] `dev:web` script removed from root `package.json`
- [x] URL resolver functions removed from `apps/web/src/lib/desktop.ts` (`serverRpcUrl`, `terminalRpcUrl`, `serverWsSyncUrl`, `terminalWsUrl`, `serverInitStatusUrl`)
- [x] `getServerUrl()` and `getTerminalUrl()` removed from `DesktopBridge` interface and preload
- [x] Preload URL argument parsing removed (`--laborer-serverUrl`, `--laborer-terminalUrl`, `--laborer-fileWatcherUrl`)
- [x] `buildPreloadArgs()` in `main.ts` no longer passes service URLs
- [x] `@laborer/env` server port configs (`PORT`, `TERMINAL_PORT`, `FILE_WATCHER_PORT`) removed or deprecated
- [x] No remaining references to HTTP-based service communication in the codebase

### Blocked by

- Blocked by "Renderer terminal UI wired to MessagePort" (#9)
- Blocked by "Renderer server UI wired to MessagePort" (#12)
- Blocked by "File-watcher as utility process" (#14)
- Blocked by "MCP as utility process" (#15)

### User stories addressed

- User story 15 (dev:web removed)
- User story 17 (Vite proxy routes removed)

---

## Issue 20: Build script update + port reservation removal

### What to build

Update the build script (`scripts/build-desktop-artifact.ts`) to work with the utility process architecture and remove all legacy process spawning infrastructure.

### Acceptance criteria

- [x] Build script includes the bootstrap entry point script in the staging directory
- [x] Build script no longer relies on `ELECTRON_RUN_AS_NODE` (not set anywhere in the build or runtime)
- [x] Staging directory structure updated for utility process entry points
- [x] `apps/desktop/src/ports.ts` (port reservation module) deleted
- [x] `apps/desktop/src/sidecar.ts` (old SidecarManager) deleted
- [x] `apps/desktop/src/health.ts` (old HealthMonitor) deleted
- [x] Auth token generation removed (no longer needed — MessagePort is inherently secure)
- [x] `bun build:app` produces a working `.dmg` where all four services start as utility processes
- [x] Native modules (`node-pty`, `@parcel/watcher`) load correctly in the built app on macOS arm64 and x64
- [x] The built app starts all services and the terminal is functional
- [x] Test: build the app, install it, open it, verify no "Terminal service unavailable" error

### Blocked by

- Blocked by "Remove HTTP servers, Vite proxy, dev:web, URL resolution" (#19)

### User stories addressed

- User story 1 (built app starts services)
- User story 2 (native modules load correctly)
- User story 4 (no port conflicts)
- User story 16 (build script updated)
