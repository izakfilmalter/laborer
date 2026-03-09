# Issues: Bundle Backend Services as Tauri Sidecars

## Issue 1: Compile MCP service as standalone binary (tracer bullet)

### What to build

This is the tracer bullet issue — prove the entire `bun build --compile` + sidecar naming + build script pattern works using the simplest service: `@laborer/mcp`. This service has zero native dependencies, making it the ideal first candidate.

Create a build script in `apps/web/scripts/` that:
1. Compiles `packages/mcp/src/main.ts` into a standalone executable using `bun build --compile`.
2. Determines the Rust target triple for the current platform (e.g., `aarch64-apple-darwin`).
3. Copies the compiled binary to `apps/web/src-tauri/sidecars/laborer-mcp-<target-triple>`.
4. Adds the `sidecars/` directory to `src-tauri/.gitignore`.

This issue does NOT wire the MCP binary into the Tauri app lifecycle — it only establishes the build pipeline that later issues will extend.

### Acceptance criteria

- [x] A build script exists that compiles `@laborer/mcp` into a standalone binary via `bun build --compile`
- [x] The compiled binary is placed in `src-tauri/sidecars/laborer-mcp-<target-triple>` with the correct naming convention
- [x] The build script correctly determines the Rust target triple for macOS (both arm64 and x86_64)
- [x] `src-tauri/sidecars/` is in `.gitignore`
- [x] The compiled MCP binary can be executed directly and functions correctly (connects to a running server, responds to MCP protocol over stdio)
- [x] The build script is reusable — structured so that later issues can extend it for the server and terminal services

### Blocked by

None — can start immediately.

### User stories addressed

- User story 5: App works without Bun installed
- User story 8: Build script compiles services into sidecar directory
- User story 12: Target macOS (arm64 and x86_64)

---

## Issue 2: Compile server service as standalone binary

### What to build

Extend the build script from the tracer bullet to compile `@laborer/server` into a standalone sidecar binary. The server has native dependencies (`@parcel/watcher`, `@livestore/adapter-node`) that require special handling — mark them as `--external` and ship their native modules alongside, or accept graceful fallbacks where they exist.

Key changes beyond compilation:
1. Fix the `import.meta.url`-based path resolution in `mcp-registrar.ts` so it works in a compiled binary. The `DEFAULT_MCP_ENTRY_PATH` currently resolves to `packages/mcp/src/main.ts` relative to the source file — this needs to use `process.execPath`-relative resolution or an environment variable override when running as a compiled binary.
2. Handle `@parcel/watcher` — the server already falls back to `fs.watch` if the native addon is unavailable (see `file-watcher.ts`), so marking it external and not shipping it is acceptable.
3. Handle `@livestore/adapter-node` — this is dynamically imported and has native SQLite transitive dependencies. Either ship the native modules alongside or find an alternative bundling strategy.
4. Handle `bun:sqlite` — this is a Bun built-in and should work in compiled mode, but verify.

### Acceptance criteria

- [ ] The build script compiles `@laborer/server` into a standalone binary via `bun build --compile`
- [ ] The compiled binary is placed in `src-tauri/sidecars/laborer-server-<target-triple>`
- [ ] The compiled server binary starts successfully and responds to health checks on its configured port
- [ ] The `mcp-registrar.ts` path resolution works correctly when running as a compiled binary (does not crash on `import.meta.url` resolution)
- [ ] The server gracefully handles unavailable `@parcel/watcher` (falls back to `fs.watch`)
- [ ] LiveStore persistence works correctly in the compiled binary (SQLite operations function normally)
- [ ] Native module files that need to be shipped alongside are identified and copied by the build script

### Blocked by

- Blocked by "Compile MCP service as standalone binary (tracer bullet)" (uses the same build script pattern)

### User stories addressed

- User story 5: App works without Bun installed
- User story 8: Build script compiles services into sidecar directory
- User story 12: Target macOS (arm64 and x86_64)

---

## Issue 3: Compile terminal service + pty-host as standalone binary

### What to build

The hardest compilation target. The terminal service has a unique architecture: the main Bun HTTP server spawns a Node.js child process (`pty-host.ts`) that manages PTY instances via `node-pty`. This requires a two-part build:

1. **Compile the terminal main service** into a standalone binary via `bun build --compile`. This is the HTTP server that handles RPC and WebSocket connections.

2. **Bundle `pty-host.ts` as a separate JS file** via `bun build` (without `--compile`) into a single `pty-host.js` that Node.js can execute. This cannot be compiled into the main binary because it must run under Node.js (Bun's `tty.ReadStream` does not fire data events for PTY master file descriptors).

3. **Fix path resolution in `pty-host-client.ts`**: Replace the `import.meta.url`-based path resolution (`dirname(fileURLToPath(import.meta.url))` + relative join) with `process.execPath`-relative resolution, so the compiled terminal binary can find the sibling `pty-host.js` file.

4. **Ship `node-pty` native bindings**: Copy the platform-specific `.node` files and `spawn-helper` executables alongside the sidecar binary. The bundled `pty-host.js` must be able to load these at runtime via `createRequire`.

5. **Handle `node-pty` module resolution in the bundled pty-host.js**: Since the `pty-host.ts` uses `createRequire(import.meta.url)('node-pty')`, the bundled version needs to resolve `node-pty` from the shipped `node_modules/` directory adjacent to the binary.

### Acceptance criteria

- [ ] The build script compiles `@laborer/terminal` main service into a standalone binary
- [ ] The compiled binary is placed in `src-tauri/sidecars/laborer-terminal-<target-triple>`
- [ ] `pty-host.ts` is bundled into a single `pty-host.js` file via `bun build` (not `--compile`)
- [ ] `pty-host.js` is placed alongside the sidecar binary in the sidecars directory
- [ ] `node-pty` native bindings (`.node` files, `spawn-helper`) are copied to the correct location
- [ ] The compiled terminal binary starts, spawns the pty-host Node.js subprocess, and successfully creates PTY sessions
- [ ] The path resolution in `pty-host-client.ts` detects whether it is running from source or as a compiled binary and resolves `pty-host.js` accordingly
- [ ] System Node.js is the only external runtime dependency

### Blocked by

- Blocked by "Compile MCP service as standalone binary (tracer bullet)" (uses the same build script pattern)

### User stories addressed

- User story 5: App works without Bun installed
- User story 6: Node.js required for terminal functionality
- User story 8: Build script compiles services into sidecar directory
- User story 12: Target macOS (arm64 and x86_64)

---

## Issue 4: SidecarManager Rust module — spawn and kill processes

### What to build

Create the core Rust module for managing sidecar processes within the Tauri app. This module handles spawning external binaries, passing environment variables, creating process groups for clean shutdown, and probing the macOS shell environment.

Follow the OpenCode reference pattern (`cli.rs`, `server.rs`) but adapted for multiple sidecars:

1. **Shell environment probing**: On macOS, GUI apps do not inherit terminal-configured environment (PATH, etc.). Probe the user's login shell (e.g., `/bin/zsh -l -c env`) to capture PATH and other variables needed by the sidecars (for `git`, `docker`, `node` access).

2. **Process spawning**: Use `tokio::process::Command` (not `tauri-plugin-shell`) for fine-grained control. Resolve sidecar binary paths using `tauri::process::current_binary()` + parent directory. Spawn each sidecar in its own process group (Unix) using the `process-wrap` crate so child processes are also killed on shutdown.

3. **Environment variable passing**: Pass PORT, TERMINAL_PORT, DATA_DIR, and other variables from `@laborer/env` to the sidecars. Merge with the probed shell environment.

4. **Process lifecycle**: Track spawned processes via a `SidecarManager` struct stored in Tauri's managed state. Provide `kill_all()` to terminate all sidecars. Wire `kill_all()` into `RunEvent::Exit` so quitting the app cleans up all processes.

5. **Stdout/stderr monitoring**: Read sidecar stdout/stderr asynchronously and forward to `tauri-plugin-log`.

6. **Cargo dependencies**: Add `tokio` features, `process-wrap`, and `reqwest` (for health checks in the next issue).

### Acceptance criteria

- [x] A `SidecarManager` Rust module exists with the ability to spawn, track, and kill sidecar processes
- [x] Shell environment probing works on macOS — sidecars inherit PATH and other login shell variables
- [x] Spawned processes are created in their own process group (Unix) for clean group-kill on shutdown
- [x] Environment variables (PORT, TERMINAL_PORT, etc.) are passed correctly to sidecar processes
- [x] `kill_all()` terminates all tracked sidecar processes and their child process groups
- [x] `RunEvent::Exit` triggers `kill_all()` automatically
- [x] Stdout/stderr from sidecars is logged via `tauri-plugin-log`
- [x] Integration tests verify: spawning a mock binary, passing env vars, killing processes, process group cleanup
- [x] New Cargo dependencies are added: `tokio` (with process, io features), `process-wrap`

### Blocked by

None — can start immediately (can use mock binaries for testing, independent of the compilation issues).

### User stories addressed

- User story 1: App starts all backend services automatically
- User story 2: App stops all backend services on quit
- User story 9: Sidecar lifecycle management is tested
- User story 10: Services use fixed ports

---

## Issue 5: SidecarManager — health checks and Tauri events

### What to build

Extend the `SidecarManager` from the previous issue with health check polling, state tracking, and Tauri event emission. This enables the app to know when sidecars are ready, detect crashes, and support restart.

1. **Health check polling**: After spawning a sidecar, poll its HTTP health endpoint (GET `/`) at 100ms intervals. Both `@laborer/server` (port 2100) and `@laborer/terminal` (port 2102) return JSON health responses on their root endpoint. Use `reqwest` with a short timeout. Implement a configurable overall timeout (e.g., 10 seconds) after which the sidecar is considered failed to start.

2. **State tracking**: Each sidecar has a state: `Starting`, `Healthy`, `Crashed(String)`, `Stopped`. Track state transitions and store last stderr output for crash diagnostics.

3. **Tauri events**: Emit events to the frontend webview:
   - `sidecar:healthy` — when a sidecar passes its health check (payload: service name)
   - `sidecar:error` — when a sidecar crashes or fails to start (payload: service name, error message, last stderr)

4. **Restart command**: Add a `restart_sidecar` Tauri command that the frontend can invoke. It kills the specified sidecar (if still running), then re-spawns it with the same configuration and re-runs health checks.

5. **Crash detection**: Monitor the `tokio::process::Child` for unexpected termination. When detected, update state to `Crashed` and emit `sidecar:error`.

### Acceptance criteria

- [x] Health check polling runs after each sidecar is spawned, waiting for a successful HTTP response
- [x] A configurable timeout (default 10s) triggers a startup failure if health checks don't pass
- [x] Sidecar state transitions are tracked: Starting -> Healthy, Starting -> Crashed, Healthy -> Crashed, Crashed -> Starting (on restart)
- [x] `sidecar:healthy` Tauri event is emitted when a sidecar becomes healthy
- [x] `sidecar:error` Tauri event is emitted with service name and error details on crash or startup failure
- [x] `restart_sidecar` Tauri command kills and re-spawns a specific sidecar
- [x] Crash detection works — if a healthy sidecar's process exits unexpectedly, state moves to Crashed and error event is emitted
- [x] Integration tests verify: health check success/failure/timeout, crash detection, restart flow, event emission

### Blocked by

- Blocked by "SidecarManager Rust module — spawn and kill processes"

### User stories addressed

- User story 3: Error notification on crash
- User story 4: Ability to restart crashed service
- User story 9: Sidecar lifecycle management is tested
- User story 11: Window appears after services are healthy

---

## Issue 6: Wire sidecars into Tauri app setup and frontend routing

### What to build

The integration issue that ties everything together. Configure the Tauri app to bundle the compiled sidecar binaries, spawn them on startup in the correct order, and update the frontend to connect directly to sidecar ports instead of relying on the Vite dev proxy.

#### Tauri configuration
- Add `bundle.externalBin` entries in `tauri.conf.json` for all three sidecars: `sidecars/laborer-server`, `sidecars/laborer-terminal`, `sidecars/laborer-mcp`.
- Update `beforeBuildCommand` to run both the Vite frontend build AND the sidecar compilation script (from issues #1-3).
- Add sidecar-related capabilities if needed.

#### App setup orchestration
Wire the `SidecarManager` (from issues #4-5) into `lib.rs` setup:
1. Spawn terminal service first (port 2102) and wait for it to become healthy.
2. Spawn server service (port 2100) — it connects to the terminal service on startup.
3. MCP is NOT spawned by the app (launched independently by AI agents).
4. Only after both services are healthy does the app proceed to show the webview.

#### Frontend URL routing
Currently the frontend uses relative URLs (`/rpc`, `/terminal`) which work via the Vite dev proxy. In the Tauri production build, there is no proxy. The frontend needs to:
- Detect when running in Tauri production mode (vs dev mode with Vite proxy).
- Connect directly to `http://localhost:2100/rpc` for the server RPC and LiveStore sync.
- Connect directly to `ws://localhost:2102/terminal` for terminal WebSocket connections.
- The `laborer-client.ts`, `livestore.worker.ts`, and `use-terminal-websocket.ts` files need to resolve URLs based on the runtime context.

One approach: add an `await_initialization` Tauri command (following the OpenCode pattern) that the frontend calls on load. It returns the server and terminal URLs. In non-Tauri mode, the frontend continues using relative URLs (Vite proxy).

#### Dev mode compatibility
The `tauri dev` flow must still work. In dev mode, the Vite proxy handles routing, so the frontend should continue using relative URLs. The sidecars are not spawned by Tauri in dev mode — they run via `turbo dev` as separate processes.

### Acceptance criteria

- [ ] `tauri.conf.json` declares all three sidecars in `bundle.externalBin`
- [ ] `beforeBuildCommand` runs both the Vite build and sidecar compilation
- [ ] The Tauri app setup spawns terminal then server sidecars in order, waiting for health checks
- [ ] The frontend connects directly to sidecar ports in Tauri production mode
- [ ] The frontend continues using relative URLs (Vite proxy) in dev mode
- [ ] `tauri build` produces a complete `.app` bundle containing the Tauri binary and all sidecar binaries
- [ ] The app launches, services start, and the UI is fully functional when opening the built `.app`
- [ ] `tauri dev` continues to work without breaking the existing dev workflow

### Blocked by

- Blocked by "Compile MCP service as standalone binary (tracer bullet)"
- Blocked by "Compile server service as standalone binary"
- Blocked by "Compile terminal service + pty-host as standalone binary"
- Blocked by "SidecarManager — health checks and Tauri events"

### User stories addressed

- User story 1: App starts all backend services automatically
- User story 2: App stops all backend services on quit
- User story 10: Services use fixed ports
- User story 11: Window appears after services are healthy

---

## Issue 7: Frontend crash notification and restart UI

### What to build

Add frontend handling for sidecar crash events. When a backend service crashes, the user sees an error notification with the service name and a "Restart" button.

1. **Tauri event listeners**: Listen for `sidecar:error` events from the Rust side. Extract the service name and error message from the payload.

2. **Error notification**: Display a toast/notification (using the existing `sonner` toast library in the project) showing:
   - Which service crashed (e.g., "Server", "Terminal")
   - A brief error summary
   - A "Restart" action button

3. **Restart action**: When the user clicks "Restart", invoke the `restart_sidecar` Tauri command with the service name. Show a "Restarting..." state on the toast.

4. **Success feedback**: Listen for `sidecar:healthy` events. When the restarted service becomes healthy, dismiss the error toast and optionally show a success toast.

5. **Tauri detection**: These listeners should only be registered when running in Tauri mode (check `window.__TAURI_INTERNALS__`). In non-Tauri mode (web dev), skip the listeners.

### Acceptance criteria

- [ ] The frontend listens for `sidecar:error` Tauri events when running in Tauri mode
- [ ] A toast notification appears when a sidecar crashes, showing the service name and error details
- [ ] The toast has a "Restart" action button that invokes the `restart_sidecar` Tauri command
- [ ] After clicking restart, the toast shows a "Restarting..." state
- [ ] When the sidecar becomes healthy again (`sidecar:healthy` event), the error toast is dismissed
- [ ] No Tauri event listeners are registered in non-Tauri mode (web dev)

### Blocked by

- Blocked by "Wire sidecars into Tauri app setup and frontend routing"

### User stories addressed

- User story 3: Error notification on crash
- User story 4: Ability to restart crashed service

---

## Issue 8: MCP symlink creation on app launch

### What to build

When the Tauri app launches, create a symlink at `/usr/local/bin/laborer-mcp` pointing to the compiled MCP binary inside the app bundle. This allows AI agents (Claude Code, Codex, OpenCode) to reference the MCP server by a stable path without knowing the `.app` bundle internals.

1. **Resolve MCP binary path**: Use `tauri::process::current_binary()` to find the main Tauri binary, then resolve the sibling `laborer-mcp` binary in the same directory.

2. **Symlink creation**: On app setup, check if `/usr/local/bin/laborer-mcp` exists:
   - If it's already a symlink pointing to the correct location, skip.
   - If it doesn't exist, create the symlink.
   - If it exists but points elsewhere (e.g., old version), update the symlink.

3. **Permission handling**: `/usr/local/bin/` may require elevated permissions. If symlink creation fails due to permissions:
   - Log a warning via `tauri-plugin-log`.
   - Do NOT block app startup.
   - The user can manually create the symlink or configure their AI agent to use the full path inside the `.app` bundle.

4. **Update MCP registrar path**: The server's `mcp-registrar.ts` currently writes MCP config pointing to `bun run <path-to-mcp-source>`. When running as a sidecar, it should instead point to `/usr/local/bin/laborer-mcp` (or the binary path inside the bundle). Pass the MCP binary path as an environment variable from the Rust side to the server sidecar.

### Acceptance criteria

- [ ] On app launch, a symlink is created at `/usr/local/bin/laborer-mcp` pointing to the MCP binary inside the app bundle
- [ ] If the symlink already exists and points to the correct location, it is not recreated
- [ ] If the symlink exists but points to a different location, it is updated
- [ ] If symlink creation fails due to permissions, a warning is logged but app startup is not blocked
- [ ] The server sidecar receives the MCP binary path via environment variable and the `mcp-registrar.ts` uses it when writing AI agent configurations
- [ ] AI agent config entries use the symlinked path (e.g., `{ command: "/usr/local/bin/laborer-mcp" }`) instead of `bun run <source-path>`

### Blocked by

- Blocked by "Wire sidecars into Tauri app setup and frontend routing"

### User stories addressed

- User story 7: MCP binary available on PATH for AI agents
- User story 13: MCP symlink updated on each launch
