# Architecture Comparison: VS Code vs t3code vs Laborer

A comprehensive comparison of server boot sequences, process isolation strategies, terminal implementations, and data storage across three desktop applications built with Electron.

---

## Table of Contents

1. [Framework Overview](#1-framework-overview)
2. [Server / App Boot Sequence](#2-server--app-boot-sequence)
3. [Process Isolation](#3-process-isolation)
4. [Terminal Implementation](#4-terminal-implementation)
5. [Data Storage](#5-data-storage)
6. [Communication / IPC](#6-communication--ipc)
7. [Summary Comparison Tables](#7-summary-comparison-tables)

---

## 1. Framework Overview

### VS Code

- **Type:** General-purpose code editor
- **Language:** TypeScript (strict)
- **UI framework:** Custom DOM-based workbench (no React/Vue/etc.)
- **Module system:** ESM with custom AMD loader (historical)
- **DI system:** Custom decorator-based DI container (`InstantiationService`, `ServiceCollection`, `SyncDescriptor`)
- **Build:** Custom gulp-based build, webpack for web
- **Package manager:** npm/yarn
- **Terminal emulator:** xterm.js with WebGL renderer
- **Key dependencies:** Electron, node-pty, @xterm/xterm, spdlog, vscode-textmate, ripgrep

### t3code

- **Type:** AI coding agent orchestrator (single-agent focus)
- **Language:** TypeScript (strict)
- **UI framework:** React 19 + Vite 8
- **Routing:** TanStack Router (file-based)
- **State management:** Zustand (client), Effect services (server)
- **DI system:** Effect Layer composition (`Layer.provideMerge`, `Layer.unwrap`)
- **CLI framework:** Effect CLI (`Command.make`)
- **Build:** Turborepo monorepo, tsdown bundler, Bun runtime
- **Terminal emulator:** xterm.js
- **Key dependencies:** Effect, ws (WebSocket), node-pty, Bun.spawn, Lexical, @dnd-kit, TanStack Query

### Laborer

- **Type:** AI coding agent orchestrator (multi-agent, parallel workspaces)
- **Language:** TypeScript (strict, ESM throughout)
- **UI framework:** React 19 + Vite
- **Routing:** TanStack Router (file-based)
- **State management:** LiveStore (event-sourced, OPFS SQLite client + filesystem SQLite server), Effect atoms
- **DI system:** Effect Layer composition (`Layer.provide`, `Layer.provideMerge`)
- **Build:** Turborepo monorepo, tsdown bundler, Bun package manager
- **Terminal emulator:** xterm.js v6 with WebGL renderer
- **Linting/formatting:** Biome via Ultracite (zero-config)
- **Key dependencies:** Effect, @effect/rpc, LiveStore, node-pty, @xterm/xterm, @xterm/headless, @parcel/watcher, @pierre/diffs, @pierre/trees, Plate.js, electron-builder

---

## 2. Server / App Boot Sequence

### VS Code: Imperative OOP with Custom DI Container

VS Code has **two boot paths** -- Electron desktop and headless server -- both following the same pattern: bootstrap layers that progressively configure the environment, then delegate to DI-container-based service composition.

#### Electron Main Process Boot

```
src/main.ts (true entry point)
  |-- configurePortable(), parseCLIArgs(), configureCommandlineSwitches()
  |-- enableSandbox(), configure GPU, setCrashReporter
  |-- registerSchemesAsPrivileged(), resolveNLSConfiguration()
  |-- app.once('ready', onReady)
       |
       v
  onReady()
  |-- bootstrapESM()
  |-- import('./vs/code/electron-main/main.js')
       |
       v
  CodeMain.main() -> CodeMain.startup()
  |
  |-- FIRST-TIER DI CONTAINER: CodeMain.createServices()
  |   ServiceCollection with concrete instances:
  |     IProductService, IEnvironmentMainService, ILoggerMainService,
  |     ILogService, IFileService, IUriIdentityService, IStateService,
  |     IUserDataProfilesMainService, IConfigurationService
  |   Plus lazy SyncDescriptors:
  |     ILifecycleMainService, IRequestService, IThemeMainService,
  |     ISignService, ITunnelService, IProtocolMainService
  |   -> new InstantiationService(services, strict=true)
  |
  |-- initServices() -- mkdir, stateService.init(), config.initialize()
  |
  |-- claimInstance() -> NodeIPC server (single-instance lock)
  |
  |-- CodeApplication.startup()
       |
       |-- SECOND-TIER DI CONTAINER: initServices() -> createChild(services)
       |   Child ServiceCollection adds 25+ services:
       |     IUpdateService, IWindowsMainService, IDialogMainService,
       |     IStorageMainService, ILocalPtyService, ITelemetryService,
       |     IExtensionsScannerService, etc.
       |   -> mainInstantiationService.createChild(services)
       |
       |-- initChannels() -> register IPC channels
       |-- lifecycleMainService.phase = Ready
       |-- openFirstWindow()
       |-- lifecycleMainService.phase = AfterWindowOpen
       |-- lifecycleMainService.phase = Eventually (after delay)
```

#### Server (Headless) Boot

```
src/server-main.ts
  |-- parsedArgs = minimist(process.argv)
  |-- http.createServer() with lazy handler
  |-- server.listen()
  |-- On first request -> loadCode() -> bootstrapESM()
       |
       v
  createServer()
  |-- determineServerConnectionToken()
  |-- setupServerServices()  <- FLAT DI CONTAINER (no child hierarchy)
  |   ServiceCollection with ~25 services
  |   -> new InstantiationService(services)
  |   -> Promise.all([config.initialize(), profiles.init(), ...])
  |   -> Register IPC channels on SocketServer
  |-- instantiationService.createInstance(RemoteExtensionHostAgentServer)
```

**Key patterns:**
- **Manual-then-DI:** Foundational services created as concrete instances, higher-level as `SyncDescriptor`s for lazy on-demand instantiation
- **Topological sort:** DI container builds a `Graph` of transitive dependencies, processes roots first (leaf deps instantiated first), detects cycles
- **Lazy instantiation via Proxy:** Services with `supportsDelayedInstantiation=true` are wrapped in a `Proxy` backed by `GlobalIdleValue` -- constructed during idle time or on first access. Event listeners (`onDid*`/`onWill*`) buffered and replayed.
- **Two-tier container hierarchy (Electron only):** `CodeMain.createServices()` builds tier 1 (core infrastructure), `CodeApplication.initServices()` calls `createChild()` for tier 2 (app-level)

### t3code: Functional Effect Layer Composition

t3code uses Effect's layer system for purely declarative dependency composition.

#### Entry Point

```
apps/server/src/index.ts (23 lines)
  |
  |-- Compose outer RuntimeLayer:
  |     Layer.empty
  |       |> Layer.provideMerge(CliConfig.layer)
  |       |> Layer.provideMerge(ServerLive)
  |       |> Layer.provideMerge(OpenLive)
  |       |> Layer.provideMerge(NetService.layer)
  |       |> Layer.provideMerge(NodeServices.layer)
  |       |> Layer.provideMerge(FetchHttpClient.layer)
  |
  |-- Command.run(t3Cli, { version })
  |     .pipe(Effect.provide(RuntimeLayer))
  |     .pipe(NodeRuntime.runMain)
```

#### CLI Handler -> Inner Layer Construction

```
apps/server/src/main.ts -- t3Cli command handler
  |
  |-- makeServerProgram(input)
  |     |-- cliConfig.fixPath()
  |     |-- Effect.provide(LayerLive(input))
  |
  |-- LayerLive(input) builds (bottom-up, later layers depend on earlier):
       Layer.empty
         |> Layer.provideMerge(ServerConfigLive(input))          -- config from CLI/env/bootstrap
         |> Layer.provideMerge(ServerSettingsLive)                -- settings.json + file watcher
         |> Layer.provideMerge(AnalyticsServiceLayerLive)         -- PostHog telemetry
         |> Layer.provideMerge(ServerLoggerLive)                  -- dual file+console logger
         |> Layer.provideMerge(SqlitePersistence.layerConfig)     -- SQLite + WAL + migrations
         |> Layer.provideMerge(ProviderRegistryLive)              -- Codex + Claude discovery
         |> Layer.provideMerge(makeServerProviderLayer())          -- provider adapters
         |> Layer.provideMerge(makeServerRuntimeServicesLayer())   -- orchestration, git, terminals
```

#### Deep Service Graph (serverLayers.ts)

```
makeServerRuntimeServicesLayer():
  Orchestration: OrchestrationEngineLive <- ProjectionPipelineLive + EventStoreLive + CommandReceiptRepoLive
  Checkpoints:   CheckpointStoreLive <- GitCoreLive
  Reactors:      OrchestrationReactorLive <- ProviderRuntimeIngestionLive + ProviderCommandReactorLive + CheckpointReactorLive
  Terminal:      TerminalManagerLive <- makeRuntimePtyAdapterLayer() [dynamic Bun/Node selection]
  Git:           GitManagerLive <- GitCoreLive + GitHubCliLive + RoutingTextGenerationLive
  Keybindings:   KeybindingsLive

makeServerProviderLayer():  (Layer.unwrap -- effectful)
  ProviderServiceLive <- ProviderAdapterRegistryLive <- CodexAdapterLive + ClaudeAdapterLive + ProviderSessionDirectoryLive
```

#### Runtime Program (after layers built)

```
makeServerRuntimeProgram:
  1. yield* Server (get start/stopSignal)
  2. yield* start -> createServer() in wsServer.ts
  3. fork recordStartupHeartbeat (telemetry)
  4. Auto-open browser (unless --no-browser)
  5. yield* stopSignal -> blocks forever (awaits shutdown)

createServer() (wsServer.ts):
  1. Resolve 15+ services from context
  2. Sync default keybindings
  3. Create 5 readiness gates (Deferred<void>):
     pushBusReady, keybindingsReady, terminalSubscriptionsReady,
     orchestrationSubscriptionsReady, httpListening
  4. Start subsystems, marking gates as each completes
  5. awaitServerReady = Effect.all(all 5 gates)
  6. HTTP server binds, WebSocket upgrade handler validates auth
  7. Connection handler sends welcome push, registers message routing
```

**Key patterns:**
- **Two-tier layer composition:** Lightweight outer layer for CLI shell, heavyweight inner layer with resolved config
- **`Layer.provideMerge` bottom-up chaining:** Services at the bottom are dependencies of those above
- **`Layer.unwrap` for dynamic layers:** When construction requires running effects (e.g., detecting Bun vs Node for PTY adapter)
- **Readiness gates via `Deferred`:** 5 deferred values combined with `Effect.all` -- no client communication until all subsystems ready
- **Config resolution cascade:** CLI flags > env vars > bootstrap envelope (file descriptor)

### Laborer: Electron UtilityProcess + Deferred Effect Services

Laborer follows VS Code's utility process pattern but with Effect-based service composition.

#### Desktop App Startup (main.ts)

```
main.ts (Electron main process)
  |-- fixPath() -- macOS PATH fix
  |-- registerSchemeAsPrivileged() -- laborer:// protocol before app.ready
  |-- Register GitHub OAuth protocol handler
  |
  |-- app.whenReady()
       |-- Register laborer:// protocol handler (production: serve built frontend)
       |-- Create UtilityProcessManager
       |-- Create LifecycleMonitor (health tracking, crash recovery, exponential backoff)
       |-- Wire bootstrap message handler (ready/heartbeat)
       |
       |-- Start the server backend child process
       |-- Fork terminal and file-watcher utility processes:
       |     Each: utilityProcess.fork(bootstrap.cjs, { env: { LABORER_ENTRYPOINT: path } })
       |
       |-- Register IPC handlers for DesktopBridge
       |-- Wire tray, auto-update, global shortcuts
       |-- Restore saved windows or create initial window
```

#### Utility Process Boot

```
utility-process-bootstrap.ts (CJS entry for utilityProcess.fork)
  |-- Read LABORER_ENTRYPOINT env var
  |-- Dynamic import(entrypoint) -- terminal or file-watcher utility entrypoint
  |-- On success: send { type: 'ready' } to parent
  |-- Start heartbeat timer (every 5s)
  |-- On failure: send { type: 'error' }, exit
```

#### Backend-to-Utility Connections

```
startServerBackend():
  |-- Reserve loopback ports for terminal and file-watcher utilities
  |-- Pass their WebSocket RPC URLs to the server backend through its environment
```

#### Server Backend Initialization (deferred pattern)

```
packages/server/src/main.ts
  |
  |-- Immediate layer (fast startup):
  |     LaborerStoreLive (SQLite), ConfigService, RepositoryIdentity
  |
  |-- DeferredServicesProxyLive:
  |     Creates Ref-backed proxy services
  |     Each proxy initially delegates to Effect.die("not initialized")
  |
  |-- Background fiber builds real implementations in groups:
  |     Group 3 (independent): TerminalClient
  |
  |-- As each group completes: Ref.set() swaps proxy with real implementation
  |-- When all groups done: DeferredServicesReady = true
  |-- Renderer polls lifecycle.initStatus RPC to detect readiness
```

#### Renderer Boot

```
apps/web/src/main.tsx
  |-- Create TanStack Router
  |-- Provider hierarchy:
  |     LifecyclePhaseProvider > ThemeProvider > HotkeysProvider > TooltipProvider
  |       > AtomRegistryProvider > AppSettingsProvider > SyncStatusProvider
  |         > LiveStoreProvider (StoreRegistryProvider + Suspense)
  |           > <Outlet />
  |
  |-- LiveStore worker created, sync port acquired from server
  |-- Store initializes from OPFS, syncs in background
  |-- LaborerClient and TerminalServiceClient atoms acquire MessagePorts lazily
```

**Key patterns:**
- **Split supervision:** The server is a child process; native terminal and file-watcher services are Electron utility processes
- **Deferred service initialization:** `Ref`-backed proxies allow RPC server to start immediately, real services hot-swapped when ready
- **Loopback RPC:** The backend connects to utility services through reserved loopback WebSocket endpoints
- **LiveStore event sourcing:** Bidirectional sync between server SQLite and client OPFS SQLite
- **Effect Layer composition:** Same `Layer.provide`/`Layer.provideMerge` pattern as t3code

---

## 3. Process Isolation

### VS Code: 6 Process Types with Full Isolation

VS Code runs the most processes, with each major subsystem isolated:

```
                          Node IPC
    2nd Instance ──────────────────────► Main Process (hub)
                                              |
                    +-------------------------+
                    | Electron IPC            | MessagePort
                    v                         v
              Renderer (Window)         Shared Process
                    |                    (UtilityProcess)
                    |                         |
                    | MessagePort             |
                    +-------------------------+
                    | (direct after port transfer)
                    |
                    | MessagePort
                    +----------------► Extension Host(s)
                    |                  (UtilityProcess, 1+ per kind)
                    |
                    | MessagePort
                    +----------------► PTY Host
                    |                  (UtilityProcess)
                    |
                    | MessagePort
                    +----------------► Utility Workers
                                       (UtilityProcess, on-demand)
```

| Process | Count | What it owns | Why isolated |
|---------|-------|-------------|--------------|
| **Main** | 1 | Window lifecycle, native OS APIs, process spawning | Electron requirement; must stay lean |
| **Renderer** | 1 per window | UI rendering, workbench services | Chromium sandbox |
| **Shared Process** | 1 | Extension installs, settings sync, telemetry, marketplace | Heavy network/disk I/O out of main |
| **Extension Host** | 1+ per kind | All extension code, language servers, `vscode.*` API | Third-party code isolation |
| **PTY Host** | 1 | All PTY management, reconnection, scrollback | Crash resilience (auto-restarts 5x) |
| **Utility Workers** | on-demand | Per-window heavyweight Node.js work | Generic isolation escape hatch |

**Extension Host kinds:**
1. `LocalProcess` -- Node.js UtilityProcess (desktop, full Node API)
2. `LocalWebWorker` -- Web Worker in renderer iframe (lightweight/web extensions)
3. `Remote` -- runs on remote machine (SSH, WSL, container)

**Crash isolation:** Each process can crash independently. PTY host auto-restarts up to 5 times. Extension host crash shows a notification but the editor keeps running. Shared process crash is recoverable.

### t3code: Minimal Processes + Effect Fibers

```
Desktop mode:
  Electron Main Process
    |
    +-- [child_process.spawn, ELECTRON_RUN_AS_NODE=1] --> Server Process
    |                                                       |
    |                                                       +-- [spawn] --> codex app-server (per session)
    |                                                       +-- [node-pty/Bun.spawn] --> shell (per terminal)
    |                                                       +-- [in-process] --> Claude SDK (fibers)
    |                                                       +-- [in-process] --> Effect fibers (orchestration, reactors)
    |                                                       +-- [spawn] --> git, pgrep, ps (short-lived)
    |
    +-- [Chromium] --> Renderer (React app)
                        +-- [Web Workers] --> Diff rendering pool

Web mode (CLI):
  Server Process (single)
    +-- same child processes as above
  Browser
    +-- Web Workers for diffs
```

| Process | What it owns | Isolation? |
|---------|-------------|------------|
| **Main** (Electron) | Window lifecycle, server spawning | Yes -- server is a child |
| **Server** | Everything: orchestration, terminals, providers, git, settings, WebSocket | No internal isolation |
| **Renderer** | React UI, Zustand stores | Chromium sandbox |
| **Codex** | Per-session child process (JSON-RPC over stdio) | Yes -- separate process |
| **Claude** | In-process Effect fibers consuming SDK AsyncIterable | No -- in server process |

**Concurrency without isolation:** t3code uses 100+ `Effect.fork*` calls for cooperative fiber-based concurrency. Key patterns:
- `Effect.forkScoped` for long-running background work
- `DrainableWorker` (queue + single consumer fiber) for sequential event processing
- `Effect.forkChild` for fire-and-forget

**The one isolation boundary:** In desktop mode, the Electron main process has exponential-backoff restart logic for the server child. If the server crashes, the shell survives and restarts it.

### Laborer: Backend Child + VS Code-Style Utility Processes

```
Electron Main Process (hub)
  |
  |-- [child_process.spawn] --> Server Backend Process
  |   |                           |
  |   |                           +-- [in-process] --> Effect fibers (31+ services)
  |   |                           +-- [in-process] --> LiveStore (SQLite)
  |   |                           +-- [in-process] --> Git operations
  |   |
  |   +-- [loopback WebSocket] ---> Terminal RPC
  |   +-- [loopback WebSocket] ---> File-watcher RPC
  |
  |-- [utilityProcess.fork] --> Terminal Utility Process
  |                               |
  |                               +-- [in-process node-pty] --> shell (per terminal)
  |                               +-- [per-terminal MessagePort] --> PTY data channels
  |
  |-- [utilityProcess.fork] --> File Watcher Utility Process
  |                               |
  |                               +-- [in-process @parcel/watcher] --> native FS events
  |
  |                               |
  |
  |-- [Chromium] --> Renderer
                      +-- [Dedicated Worker] --> LiveStore OPFS SQLite
                      +-- [Shared Worker] --> LiveStore leader election
```

| Process | Count | What it owns | Why isolated |
|---------|-------|-------------|--------------|
| **Main** | 1 | Window lifecycle, utility process management, IPC brokering, tray, auto-update | Electron requirement; stays lean |
| **Server** | 1 | Domain logic for projects, workspaces, diffs, git, and containers | Core backend isolation and independent restart |
| **Terminal** | 1 | All PTY management via node-pty, session persistence, flow control | Native addon isolation, crash resilience |
| **File Watcher** | 1 | Filesystem watching via @parcel/watcher | Native addon isolation, event flooding protection |
| **Renderer** | 1 per window | React UI, LiveStore client, xterm.js rendering | Chromium sandbox |

**Crash resilience:** `LifecycleMonitor` tracks utility-process health via heartbeat, while `BackendProcessManager` supervises the server child. Each backend process can restart without taking down the Electron shell.

**Deferred initialization:** The server backend starts with `Ref`-backed proxy services, then builds real implementations in background fibers. This means the RPC server is ready to accept connections before all domain services are fully initialized.

### Process Isolation Comparison

| Aspect | VS Code | t3code | Laborer |
|--------|---------|--------|---------|
| **Total process types** | 6 | 2-3 | 5 (main + server + 2 utility + renderer) |
| **PTY isolation** | Separate PTY host process, auto-restarts 5x | In-server process, no isolation | Separate terminal utility process with health monitoring |
| **File watching** | Dedicated watcher process | In-process | Separate file-watcher utility process |
| **Heavy I/O isolation** | Shared process for network/disk ops | All in server | Server child process (separated from main) |
| **Crash granularity** | Per-subsystem | All-or-nothing (server restart) | Per-utility-process |
| **Concurrency model** | OS processes + event loop | Effect fibers (cooperative, single-threaded) | Effect fibers within isolated utility processes |
| **Process communication** | MessagePort (direct, after port transfer) | WebSocket JSON | Loopback WebSocket plus direct MessagePort |

---

## 4. Terminal Implementation

### VS Code: Three-Process PTY Architecture with Flow Control

VS Code's terminal spans three OS processes with sophisticated flow control and reconnection.

#### Architecture

```
+-------------------------------+    +-----------------------------+    +-----------------------------+
|       RENDERER PROCESS        |    |    MAIN / SHARED PROCESS    |    |      PTY HOST PROCESS       |
|                               |    |                             |    |                             |
|  TerminalService              |    |  PtyHostService             |    |  PtyService                 |
|    +-- TerminalInstance       |    |    +-- IPtyHostStarter      |    |    +-- Map<id, Persistent   |
|          +-- XtermTerminal    |    |    +-- HeartbeatMonitor     |    |    |   TerminalProcess>      |
|          |   (xterm.js +      |    |    +-- ProxyChannel ->     |    |    |                         |
|          |    addons)         |    |    |   IPtyService          |    |    +-- TerminalProcess       |
|          +-- ProcessManager   |    |                             |    |    |   +-- node-pty          |
|              +-- AckBuffer   |    |                             |    |    |   +-- flow control      |
|              +-- IPC proxy    |    |                             |    |    +-- XtermSerializer       |
|                               |    |                             |    |    |   (@xterm/headless)     |
|  MessagePort <----------------|----|----- MessagePort ---------->|----|--> |                         |
+-------------------------------+    +-----------------------------+    +-----------------------------+
```

#### Data Flow

```
User keystroke
  -> xterm.js raw.onData
  -> TerminalInstance -> processManager.write(data)
  -> ITerminalChildProcess.input(data)  [IPC proxy over MessagePort]
  -> PtyService.input(id, data)  [PTY host process]
  -> PersistentTerminalProcess.input(data)
  -> TerminalProcess -> ptyProcess.write(data)  [node-pty]
  -> SHELL processes input, produces output
  -> node-pty ptyProcess.onData  [TerminalProcess receives output]
  -> TerminalDataBufferer batches (5ms throttle)
  -> XtermSerializer records for replay
  -> PtyService fires onProcessData over IPC
  -> PtyHostService forwards via ProxyChannel
  -> TerminalProcessManager.onProcessData
  -> SeamlessRelaunchDataFilter + BeforeProcessData hooks
  -> TerminalInstance -> xterm.raw.write(data)
  -> xterm.js renders to DOM/WebGL canvas
```

#### Flow Control (Backpressure)

- **HighWatermarkChars** = 100,000 -- When unacknowledged chars exceed this, PTY is **paused** (`ptyProcess.pause()`)
- **LowWatermarkChars** = 5,000 -- When client catches up, PTY is **resumed**
- **CharCountAckSize** = 5,000 -- Renderer sends acks in 5K char chunks via `acknowledgeDataEvent()`
- `AckDataBufferer` in `TerminalProcessManager` batches acks before sending over IPC

#### Persistence / Reconnection

**Live reconnection** (PTY host still running):
1. On window reload, `PersistentTerminalProcess` keeps shell alive with grace timers (60s long, 6s short)
2. New window calls `backend.getTerminalLayoutInfo()` and `backend.attachToProcess(id)`
3. `XtermSerializer` replays full terminal buffer state via `triggerReplay()`

**Cold persistence** (PTY host died):
1. On shutdown, `PtyService.serializeTerminalState()` serializes xterm buffer via `XtermSerializer`
2. State includes `IShellLaunchConfig`, process details, unicode version, replay data
3. On restore, `reviveTerminalProcesses()` creates new processes pre-loaded with serialized buffer

**Orphan detection:**
- PTY host fires `onProcessOrphanQuestion` via IPC
- Waits 4s for renderer response -- if no response within 500ms, terminal is orphaned

#### Key Features
- Shell integration addon (headless xterm in PTY host) for command detection
- WebGL rendering with DOM fallback
- Multiple xterm addons: Search, Unicode11, Serialize, Image, Ligatures, Clipboard
- Seamless relaunch data filter for terminal profile changes

### t3code: Single-Process PTY with WebSocket Streaming

t3code keeps all PTY management in the server process, streaming data to the browser via WebSocket.

#### Architecture

```
+-------------------------------+    +-------------------------------+
|       BROWSER (CLIENT)        |    |       SERVER PROCESS          |
|                               |    |                               |
|  ThreadTerminalDrawer         |    |  TerminalManagerRuntime       |
|    +-- TerminalViewport       |    |    (EventEmitter, 1413 lines) |
|         +-- xterm.js Terminal |    |    +-- Map<key, SessionState> |
|         +-- FitAddon          |    |    +-- PtyAdapter             |
|         +-- NativeApi calls   |    |    |   (BunPTY or NodePTY)    |
|                               |    |    +-- History persistence    |
|  WsTransport                  |    |    +-- Subprocess polling     |
|    +-- request/response       |    |                               |
|    +-- push subscriptions     |    |  wsServer.ts                  |
|    +-- reconnection           |    |    +-- HTTP/WebSocket server  |
|                               |    |    +-- Request routing        |
|  WebSocket <-- push events ---|----|--> pushBus (sequenced fanout) |
|  WebSocket --- requests ----->|----|-->  route to TerminalManager  |
+-------------------------------+    +-------------------------------+
```

#### Data Flow

```
User keystroke
  -> xterm.js terminal.onData(data)
  -> NativeApi.terminal.write({ threadId, terminalId, data })
  -> WsTransport.request() -- JSON: {id, body: {_tag: "terminal.write", ...}}
  -> [WebSocket]
  -> wsServer.ts routeRequest() -> case "terminal.write"
  -> TerminalManager.write() -> session.process.write(data)  [node-pty/Bun.spawn]
  -> SHELL processes input, produces output
  -> PtyProcess.onData callback
  -> TerminalManagerRuntime.onProcessData()
     - Sanitize control sequences (strip device status requests, color queries)
     - Append to session.history, cap at 5,000 lines
     - Queue debounced disk persistence (40ms)
     - Emit "output" event (raw unsanitized data for display)
  -> pushBus.publishAll("terminal.event", {type: "output", data})
  -> [WebSocket push: {type: "push", channel: "terminal.event", ...}]
  -> WsTransport receives push -> routes to terminal.event listeners
  -> TerminalViewport onEvent handler -> terminal.write(event.data)
  -> xterm.js renders output
```

#### Communication Protocol

**Request/response** (client-initiated):
- `terminal.open`, `terminal.write`, `terminal.resize`, `terminal.clear`, `terminal.restart`, `terminal.close`

**Push events** (server-initiated, 7 types):
- `started`, `output`, `exited`, `error`, `cleared`, `restarted`, `activity`

#### Flow Control

**None.** Raw WebSocket push with no backpressure mechanism. The server sends all PTY output as fast as it arrives.

#### Persistence

- History written to `${logsDir}/${base64url(threadId)}.log` files
- 40ms debounced writes via serialized promise queue
- History sanitized (device status requests, color queries stripped) before persist
- Capped at 5,000 lines
- On `terminal.open`, history read from disk and included in snapshot
- Client writes `\u001bc` (reset) + snapshot.history to xterm on connect

#### PTY Adapter Selection (Dynamic)

```typescript
// serverLayers.ts -- Layer.unwrap for runtime selection
const runtime = process.versions.bun !== undefined ? "bun" : "node";
// BunPTY: Bun.spawn() with terminal option (built-in PTY, no native addon)
// NodePTY: node-pty via dynamic import (native addon)
```

#### Key Features
- Shell resolution with fallback chain (requested shell -> $SHELL -> /bin/zsh -> /bin/bash -> /bin/sh)
- Per-thread locking (`runWithThreadLock`) to serialize concurrent operations
- Subprocess activity detection via `pgrep`/`ps` polling (1s interval)
- Inactive session eviction (max 128 retained)
- Split terminal views on client (groups with `MAX_TERMINALS_PER_GROUP`)
- Terminal context selection ("Add to chat" for selected text)
- URL/path link detection in output

### Laborer: VS Code-Style Isolated PTY with MessagePort Data Channels

Laborer runs PTY management in a dedicated terminal utility process, with per-terminal MessagePort channels for high-throughput data.

#### Architecture

```
+-------------------------------+    +-----------------------------+    +-----------------------------+
|       RENDERER PROCESS        |    |    ELECTRON MAIN PROCESS    |    |  TERMINAL UTILITY PROCESS   |
|                               |    |                             |    |                             |
|  Terminal Component           |    |  UtilityProcessManager      |    |  TerminalManager            |
|    +-- xterm.js Terminal      |    |    +-- Port brokering       |    |    +-- PtyHostClient        |
|    +-- WebGL Addon            |    |    +-- LifecycleMonitor     |    |    |   (node-pty in-process) |
|    +-- Fit/Image/Unicode      |    |                             |    |    +-- Data coalescing (5ms)|
|    +-- Flow control acks      |    |                             |    |    +-- Flow control         |
|                               |    |                             |    |    +-- Replay buffers       |
|  RPC Port (service calls)     |    |                             |    |    +-- Session persistence  |
|    terminal.spawn/write/etc.  |    |                             |    |    +-- Agent status detect  |
|                               |    |                             |    |                             |
|  Data Port (per-terminal)     |    |                             |    |  TerminalDataChannel        |
|    raw PTY I/O + control msgs |    |                             |    |    per-terminal MessagePort |
|                               |    |                             |    |                             |
|  MessagePort <-- data --------|----|----- broker transfers ----->|----|--> MessagePort              |
|  MessagePort --- RPC -------->|----|----- port acquisition ----->|----|--> RPC Server               |
+-------------------------------+    +-----------------------------+    +-----------------------------+
```

#### Data Flow

```
User keystroke
  -> xterm.js captures key
  -> Renderer sends raw string to terminal data channel MessagePort
  -> terminal-data-channel.ts receives message
  -> ptyHostClient.write(terminalId, data)
  -> pty-direct.ts writes to node-pty IPty instance
  -> SHELL processes input, produces output
  -> node-pty onData callback
  -> Data coalescing buffer (5ms aggregation)
  -> Buffer flushes -> dataCallbacks fire
  -> TerminalManager.subscribe() callback posts to data channel MessagePort
  -> Renderer receives data via MessagePort
  -> xterm.js terminal.write(data)
  -> xterm.js renders via WebGL
```

#### Flow Control (VS Code-compatible)

- **HighWatermark** = 100,000 chars -- PTY paused when unacked chars exceed this
- **LowWatermark** = 5,000 chars -- PTY resumed when client catches up
- Renderer sends `{"type":"ack","chars":N}` control messages over the data MessagePort
- `pty-direct.ts` tracks unacknowledged char count per terminal

#### Control Messages (over data channel MessagePort)

```
{"type":"status","status":"running"}      -- on connect
{"type":"status","status":"stopped","exitCode":N}  -- PTY exited
{"type":"status","status":"restarted"}    -- terminal restarted
{"type":"ack","chars":N}                  -- flow control (renderer -> utility)
```

#### Persistence

- Circular replay buffer per terminal (in memory)
- On graceful shutdown (SIGTERM): metadata + replay buffers serialized to temp file
- On startup: persisted terminals respawned with same config
- `@xterm/headless` + `@xterm/addon-serialize` for server-side screen state capture

#### Key Features
- Data coalescing (5ms buffer, matches VS Code's `TerminalDataBufferer`)
- Backpressure flow control (high/low watermark, matches VS Code constants)
- Per-terminal MessagePort channels (zero-copy structured clone, not JSON serialization)
- Foreground process detection (classifies: agent, editor, devServer, shell, unknown)
- Agent status tracking (active vs waiting_for_input)
- Replay buffer for late-connecting subscribers
- Session persistence across utility process restarts
- `spawn-helper` permission fix on layer construction (chmod +x for node-pty)

### Terminal Comparison

| Aspect | VS Code | t3code | Laborer |
|--------|---------|--------|---------|
| **PTY process isolation** | Separate PTY host (UtilityProcess) | In-server process | Separate terminal utility process |
| **PTY library** | node-pty | node-pty or Bun.spawn (runtime-detected) | node-pty |
| **Data transport** | MessagePort (direct to PTY host) | WebSocket JSON | MessagePort (per-terminal channel) |
| **Data serialization** | Structured clone | JSON over WebSocket | Structured clone |
| **Flow control** | Yes: 100K high / 5K low watermark, ack-based | None | Yes: 100K high / 5K low watermark, ack-based |
| **Data coalescing** | 5ms batch (`TerminalDataBufferer`) | None | 5ms batch (coalescing buffer) |
| **Reconnection** | Full replay via `XtermSerializer` + grace timers (60s/6s) | History file replay on `terminal.open` | Replay buffer + session persistence file |
| **Headless xterm** | Yes (in PTY host for serialization + shell integration) | No | Yes (for screen state capture) |
| **Shell integration** | Yes (command detection via escape sequences) | No | No |
| **Subprocess detection** | Via shell integration addon | `pgrep`/`ps` polling (1s) | `ps` command-based classification |
| **WebGL rendering** | Yes (with DOM fallback) | No (default renderer) | Yes (WebGL addon) |
| **Split terminals** | Yes (groups in panel + editor tabs) | Yes (client-side groups) | Yes (resizable panels) |
| **Crash recovery** | PTY host auto-restarts 5x | Server restart loses all terminals | Terminal utility restarts independently |

---

## 5. Data Storage

### VS Code

| Layer | Mechanism | What's stored |
|-------|-----------|--------------|
| **State service** | SQLite database (`state.vscdb`) | Global state, UI state, workspace state |
| **Storage service** | SQLite per workspace + global | Extension storage, workspace data |
| **Configuration** | JSON files | `settings.json`, `keybindings.json`, workspace configs |
| **Extension data** | File system | Installed extensions in `~/.vscode/extensions/` |
| **Terminal** | In-memory `XtermSerializer` (xterm-headless) | Scrollback buffer for reconnection |
| **Settings sync** | Cloud (Microsoft account) via shared process | Settings, extensions, keybindings, snippets |

### t3code

| Layer | Mechanism | What's stored |
|-------|-----------|--------------|
| **Server (primary)** | SQLite (`state.sqlite`, WAL mode) via `@effect/sql-sqlite-bun` or `node:sqlite` | Event-sourced orchestration events, projection tables (projects, threads, messages, turns, checkpoints) |
| **Server** | JSON files | `settings.json`, `keybindings.json`, `anonymous-id` |
| **Server** | File system | Attachments (UUID-named), terminal history logs, server logs, provider event logs |
| **Client** | `localStorage` (`t3code:renderer-state:v8`) | Project ordering, expand/collapse state (Zustand) |
| **Client** | `localStorage` (`t3code:terminal-state:v1`) | Terminal open/closed, split layouts, active terminal (Zustand persist) |

**Event sourcing architecture:**
- `OrchestrationEventStore` -- append-only event log in SQLite
- `Decider` -- processes commands, validates invariants, produces events
- `Projector` -- replays events to build read models
- 16 numbered SQLite migrations managed via Effect layers

### Laborer

| Layer | Mechanism | What's stored |
|-------|-----------|--------------|
| **Server** | SQLite via LiveStore (`@livestore/adapter-node`, filesystem) | Event-sourced projects, workspaces, app settings, and durable compatibility events |
| **Client** | OPFS-backed SQLite via LiveStore (`@livestore/adapter-web`) | Same schema, synced bidirectionally with server |
| **Client workers** | Dedicated Worker (OPFS SQLite), Shared Worker (leader election) | Canonical client-side database |
| **Terminal** | In-memory circular replay buffer + temp file on shutdown | Terminal scrollback for session persistence |
| **Config** | `laborer.json` per project | Agent type, dev server config, setup scripts, worktree directory |
| **Config** | `~/.config/laborer/` | Global configuration |
| **Window state** | Electron APIs + LiveStore | Window bounds, panel layout tree per windowId |

**LiveStore event sourcing:**
- Immutable, append-only eventlog -- old events never rewritten
- State tables materialized from events (automatic rematerialization on schema changes)
- 30+ event types (e.g., `v1.ProjectCreated`, `v1.WorkspaceCreated`, `v1.TerminalSpawned`)
- Bidirectional sync: server SQLite <-> client OPFS SQLite via MessagePort sync protocol
- Event schema evolution rules: new fields must be optional/defaulted, no renaming/type changes, no deleting event definitions

---

## 6. Communication / IPC

### VS Code

| Channel | Mechanism | Used for |
|---------|-----------|----------|
| Main <-> Renderer | Electron IPC (`ipcMain`/`ipcRenderer`) | Bootstrap, window commands |
| Main <-> Renderer (data) | MessagePort (transferred after handshake) | High-throughput service calls |
| Main <-> Shared Process | MessagePort via UtilityProcess.connect() | Service channels |
| Renderer <-> Shared Process | MessagePort (direct, main brokers initial transfer) | Extension management, sync, telemetry |
| Renderer <-> Extension Host | MessagePort (direct) | Extension API, language servers |
| Renderer <-> PTY Host | MessagePort (direct) | Terminal I/O, lifecycle |
| 1st <-> 2nd instance | Node IPC (`net.Server`/`net.Socket`) | Single-instance enforcement |

**Key pattern:** `ProxyChannel.fromService()` / `ProxyChannel.toService()` -- transparent RPC marshaling across any IPC boundary. Every method call and event is serialized automatically.

### t3code

| Channel | Mechanism | Used for |
|---------|-----------|----------|
| Server <-> Browser | WebSocket (JSON) | All communication: RPC (request/response) + push events |
| Desktop Main <-> Server | `child_process.spawn` + fd 3 (bootstrap) | One-time config transfer, then WebSocket |
| Server <-> Codex | `child_process.spawn` + JSON-RPC over stdio | Agent session communication |
| Server <-> Claude | In-process `AsyncIterable` | SDK streaming (no IPC) |

**Key pattern:** Single WebSocket with two modes:
- Request/response: `{id, body}` -> `{id, result}` (60s timeout, incrementing IDs)
- Push: `{type: "push", sequence, channel, data}` (fanout to all clients, latest cached for late subscribers)
- Reconnection with exponential backoff (500ms to 8s max)

### Laborer

| Channel | Mechanism | Used for |
|---------|-----------|----------|
| Main <-> Renderer | Electron IPC | Window commands, folder picker, context menu, update state, OAuth |
| Renderer <-> Server backend | WebSocket (RPC via @effect/rpc) | Domain RPCs |
| Renderer <-> Terminal utility | MessagePort (RPC) | Terminal lifecycle RPCs |
| Renderer <-> Terminal utility | MessagePort (per-terminal data channel) | Raw PTY I/O + flow control |
| Renderer <-> Server backend | WebSocket (LiveStore sync) | Bidirectional SQLite sync |
| Server <-> Terminal utility | Loopback WebSocket | TerminalRpcs (server triggers terminal operations) |
| Server <-> File-watcher utility | Loopback WebSocket | FileWatcherRpcs |
| Main -> Utility processes | `parentPort.postMessage` | Bootstrap (ready/heartbeat), port transfers |

**Key patterns:**
- **Port acquisition (VS Code pattern):** Renderer calls `bridge.ipcSend(ACQUIRE_SERVICE_PORT_CHANNEL)` -> Main creates a `MessageChannelMain` pair for direct terminal data -> preload relays the renderer port via `window.postMessage`
- **Effect RPC:** Domain and service RPCs use WebSocket transports; high-throughput terminal data uses direct MessagePorts
- **Boundary-specific serialization:** RPC uses JSON over WebSocket, while terminal data uses structured clone over MessagePort

---

## 7. Summary Comparison Tables

### Architecture at a Glance

| | VS Code | t3code | Laborer |
|---|---------|--------|---------|
| **App type** | Code editor | AI agent orchestrator (single) | AI agent orchestrator (multi, parallel) |
| **UI framework** | Custom DOM workbench | React 19 + Vite | React 19 + Vite |
| **DI system** | Custom DI container (decorators + topological sort) | Effect Layers | Effect Layers |
| **State management** | Service-based (custom) | Zustand (client) + Effect (server) | LiveStore (event-sourced, synced) |
| **Build system** | Gulp + webpack | Turborepo + tsdown + Bun | Turborepo + tsdown + Bun |
| **Runtime** | Electron + Node.js | Node.js / Bun + Electron (optional) | Electron + Node.js |
| **CLI mode** | `code --wait`, remote server | `t3` CLI (primary mode) | Desktop only |

### Process Model

| | VS Code | t3code | Laborer |
|---|---------|--------|---------|
| **OS processes** | 6 types | 2-3 | 5 (main + server + 2 utility + renderer) |
| **PTY isolation** | Dedicated PTY host | In-server | Dedicated terminal utility |
| **File watcher** | Dedicated process | In-server | Dedicated file-watcher utility |
| **Crash granularity** | Per-subsystem | All-or-nothing | Per-utility-process |
| **Concurrency** | OS processes | Effect fibers (single-threaded) | Effect fibers within isolated utility processes |

### IPC

| | VS Code | t3code | Laborer |
|---|---------|--------|---------|
| **Primary IPC** | MessagePort (Electron) | WebSocket (JSON) | WebSocket + MessagePort |
| **RPC framework** | Custom ProxyChannel | Custom WS_METHODS routing | @effect/rpc |
| **Serialization** | Structured clone | JSON | JSON + structured clone |
| **Direct process-to-process** | Yes (after port transfer) | N/A (single server) | Yes (loopback WebSockets) |

### Terminal

| | VS Code | t3code | Laborer |
|---|---------|--------|---------|
| **PTY process** | Separate PTY host | In-server | Separate terminal utility |
| **Data transport** | MessagePort | WebSocket JSON | MessagePort (per-terminal) |
| **Flow control** | Yes (100K/5K watermark) | No | Yes (100K/5K watermark) |
| **Data batching** | 5ms | None | 5ms |
| **Reconnection** | XtermSerializer + grace timers | History file replay | Replay buffer + persistence file |
| **Headless xterm** | Yes | No | Yes |
| **WebGL rendering** | Yes (with fallback) | No | Yes |

### Data Storage

| | VS Code | t3code | Laborer |
|---|---------|--------|---------|
| **Primary DB** | SQLite (state.vscdb) | SQLite (state.sqlite, WAL) | SQLite via LiveStore (server + client OPFS) |
| **Event sourcing** | No | Yes (OrchestrationEventStore) | Yes (LiveStore eventlog) |
| **Client-server sync** | Settings Sync (cloud) | WebSocket push (read model) | LiveStore bidirectional sync (MessagePort) |
| **Config persistence** | JSON files | JSON files | JSON files + LiveStore |
| **Terminal history** | In-memory XtermSerializer | Disk files (debounced) | In-memory replay buffer + temp file |
