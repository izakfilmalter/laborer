# Issues: Migrate from Tauri to Electron (and Bun to Node.js)

Parent PRD: [PRD-migrate-to-electron.md](./PRD-migrate-to-electron.md)

---

## Issue 1: Node.js spawn utility

### What to build

Create a `child_process`-based spawn wrapper in `packages/server/src/lib/spawn.ts` that provides the same ergonomics as `Bun.spawn()`. The utility should return an object with `exited: Promise<number>` for the exit code and helpers to collect stdout/stderr as strings. It must also support the pipe pattern where one process's stdout feeds another's stdin (used in `deps-image-service.ts` for tar piping).

This is a foundational module — all ~40 `Bun.spawn()` call sites across the server package will migrate to use it. Refer to the PRD's "Process spawn utility" architectural decision.

### Acceptance criteria

- [x] `spawn()` function wraps `child_process.spawn()` and returns `{ exited: Promise<number>, stdout, stderr, kill(), pid }`
- [x] stdout/stderr can be collected as full strings via `.text()` or similar
- [x] Supports `cwd`, `env`, `stdin` (including piping from another process's stdout) options
- [x] Supports `stdout: 'pipe'` and `stderr: 'pipe'` modes
- [x] Unit tests cover: successful exit, non-zero exit, stdout/stderr collection, process killing, stdin piping between processes
- [x] Tests run and pass under vitest (Node.js)

### Blocked by

None — can start immediately.

### User stories addressed

- User story 15
- User story 16

---

## Issue 2: Migrate workspace-provider Bun.spawn sites

### What to build

Replace all ~16 `Bun.spawn()` calls in `packages/server/src/services/workspace-provider.ts` with the new spawn utility from Issue 1. This file has the highest density of spawn calls — git worktree operations, branch management, directory creation/cleanup, and status checks.

Also remove the `ensureBunSpawnForNodeTests()` polyfill from any workspace-provider-related test files, since the production code will now use native Node.js APIs.

### Acceptance criteria

- [ ] All `Bun.spawn()` calls in `workspace-provider.ts` replaced with the spawn utility
- [ ] All `await proc.exited` patterns updated
- [ ] All `new Response(proc.stdout).text()` patterns updated
- [ ] No references to `Bun` namespace remain in the file
- [ ] Existing e2e tests for workspace-provider pass (if any)
- [ ] TypeScript compiles without errors

### Blocked by

- Blocked by "Node.js spawn utility"

### User stories addressed

- User story 15
- User story 16

---

## Issue 3: Migrate remaining server Bun.spawn sites

### What to build

Replace `Bun.spawn()` calls in all remaining server service files:
- `container-service.ts` (~5 calls — docker run/stop/rm/pause/unpause)
- `deps-image-service.ts` (~10 calls — docker operations + the tar pipe pattern)
- `docker-detection.ts` (~2 calls — which docker, docker info)
- `diff-service.ts` (~1 call — git diff)
- `pr-watcher.ts` (~1 call — gh pr view)
- `handlers.ts` (~2 calls — gh pr view, open editor)

Special attention needed for `deps-image-service.ts` line ~586 which uses Bun's subprocess pipe pattern (`{ stdin: tarProc.stdout }`) to pipe tar output between processes.

Remove the `ensureBunSpawnForNodeTests()` polyfills from `docker-detection.e2e.test.ts`, `container-service.e2e.test.ts`, and `deps-image-cache.e2e.test.ts`.

### Acceptance criteria

- [ ] All `Bun.spawn()` calls in the 6 listed files replaced with the spawn utility
- [ ] The tar pipe pattern in `deps-image-service.ts` works correctly with Node.js streams
- [ ] All `ensureBunSpawnForNodeTests()` polyfills removed from test files
- [ ] No references to `Bun` namespace remain in any of the 6 service files or 3 test files
- [ ] Existing e2e tests pass (docker-detection, container-service, deps-image-cache)
- [ ] TypeScript compiles without errors

### Blocked by

- Blocked by "Node.js spawn utility"

### User stories addressed

- User story 15
- User story 16

---

## Issue 4: Server Bun-to-Node runtime swap

### What to build

Swap the server package from Bun runtime to Node.js. This is the final step of the server Bun migration — after spawn sites are already converted (Issues 2, 3), this handles the remaining Bun-specific APIs:

1. Replace `@effect/platform-bun` with `@effect/platform-node` in `packages/server/src/main.ts` (`BunHttpServer` -> `NodeHttpServer` with `http.createServer()`, `BunRuntime` -> `NodeRuntime`)
2. Replace `import { Database } from 'bun:sqlite'` with `better-sqlite3` in `packages/server/src/services/sync-backend.ts` — the LiveStore sync backend
3. Update `packages/server/tsconfig.json` to remove `"bun"` from types array
4. Update `packages/server/package.json`: swap `@effect/platform-bun` -> `@effect/platform-node`, add `better-sqlite3` + `@types/better-sqlite3`, remove `@types/bun`, update scripts from `bun run` to `tsx`
5. Update root `package.json` catalog: add `@effect/platform-node`, `better-sqlite3`

Verify the server starts, RPC endpoints respond, and LiveStore WebSocket sync works.

### Acceptance criteria

- [ ] `@effect/platform-bun` fully replaced with `@effect/platform-node` in server main.ts
- [ ] `bun:sqlite` replaced with `better-sqlite3` in sync-backend.ts — all Database operations work identically
- [ ] WAL mode, prepared statements, transaction-wrapped batch inserts all function correctly
- [ ] Server starts successfully via `tsx src/main.ts`
- [ ] RPC endpoints respond (test manually or via existing tests)
- [ ] LiveStore WebSocket sync works end-to-end
- [ ] `@types/bun` removed from server package.json
- [ ] Server tsconfig no longer references `"bun"` type
- [ ] All server tests pass

### Blocked by

- Blocked by "Migrate workspace-provider Bun.spawn sites"
- Blocked by "Migrate remaining server Bun.spawn sites"

### User stories addressed

- User story 15
- User story 16

---

## Issue 5: Terminal + MCP Bun-to-Node runtime swap

### What to build

Swap both the terminal and MCP packages from Bun runtime to Node.js:

**Terminal (`packages/terminal/`):**
- Replace `@effect/platform-bun` with `@effect/platform-node` in `src/main.ts` (`BunHttpServer` -> `NodeHttpServer`, `BunRuntime` -> `NodeRuntime`)
- Update tsconfig to remove `"bun"` from types
- Update package.json: swap deps, remove `@types/bun`, update scripts to `tsx`

**MCP (`packages/mcp/`):**
- Replace `@effect/platform-bun` with `@effect/platform-node` in `src/main.ts` (`BunRuntime` -> `NodeRuntime`, `BunStream.stdin` -> Node stdin stream equivalent, `BunSink.stdout` -> Node stdout sink equivalent)
- Update tsconfig to remove `"bun"` from types
- Update package.json: swap deps, remove `@types/bun`, update scripts to `tsx`

The MCP package uses `BunStream.stdin` and `BunSink.stdout` for stdio-based MCP transport, which need Node.js equivalents from `@effect/platform-node`.

### Acceptance criteria

- [ ] Terminal service starts successfully via `tsx src/main.ts`
- [ ] Terminal RPC endpoints respond
- [ ] Terminal WebSocket PTY I/O works (connect xterm.js, type commands, see output)
- [ ] MCP server starts and communicates over stdio
- [ ] `@types/bun` removed from both packages
- [ ] Both tsconfigs no longer reference `"bun"` type
- [ ] Terminal tests pass (pty-host integration tests)
- [ ] No references to `Bun` namespace remain in either package

### Blocked by

None — can start immediately (independent of server spawn migration).

### User stories addressed

- User story 15
- User story 16

---

## Issue 6: Electron shell scaffold + dev tooling

### What to build

Create a new `apps/desktop/` package that provides a minimal but functional Electron shell. This is the tracer bullet — the simplest possible Electron app that opens a BrowserWindow loading the Vite dev server.

**Package setup:**
- `apps/desktop/package.json` with `electron`, `tsdown`, `wait-on` deps (follow t3code pattern)
- `apps/desktop/tsconfig.json` extending root, with `"types": ["node", "electron"]`
- `apps/desktop/tsdown.config.ts` bundling main.ts + preload.ts to CJS in `dist-electron/`

**Main process (`src/main.ts`):**
- Minimal bootstrap: `app.whenReady()` -> create BrowserWindow
- Window config: `titleBarStyle: "hiddenInset"`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Load `VITE_DEV_SERVER_URL` in development
- Preload script path: `path.join(__dirname, 'preload.js')`

**Preload (`src/preload.ts`):**
- Minimal `contextBridge.exposeInMainWorld('desktopBridge', {})` — empty bridge for now

**Dev scripts:**
- `dev:bundle` — `tsdown --watch` (rebuilds main/preload on change)
- `dev:electron` — script that waits for Vite dev server + built files, launches Electron, watches for changes, restarts on rebuild (follow t3code's `dev-electron.mjs` pattern)
- `dev` — runs both in parallel

**Monorepo integration:**
- Add `apps/desktop` to root workspace
- Add `apps/desktop` tasks to `turbo.json`
- Wire so `turbo dev` starts Vite (apps/web), services, AND Electron

### Acceptance criteria

- [ ] `apps/desktop/` exists with package.json, tsconfig, tsdown config
- [ ] `bun run dev` in apps/desktop opens an Electron window showing the Vite-served frontend
- [ ] Preload script loads without errors (even though bridge is empty)
- [ ] Window has hiddenInset title bar with traffic light positioning
- [ ] `contextIsolation: true` and `sandbox: true` are set
- [ ] `tsdown --watch` rebuilds on source changes
- [ ] Electron restarts automatically when main process bundle changes
- [ ] Vite HMR works inside the Electron window
- [ ] `turbo dev` orchestrates all processes (web, server, terminal, desktop)
- [ ] TypeScript compiles without errors

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1
- User story 2
- User story 14
- User story 20

---

## Issue 7: Shell environment probing + port allocation

### What to build

Implement two foundational capabilities in the Electron main process that child processes depend on:

**Shell environment probing (`src/fix-path.ts`):**
Port the Rust `probe_shell_environment()` from `sidecar.rs` to TypeScript. On macOS, Electron inherits a minimal PATH from launchd. This module launches the user's login shell (`-ilc 'echo $PATH'`, falling back to `-lc`) to capture their full PATH with all shell profile additions (homebrew, nvm, pyenv, etc.). Merge the result into `process.env.PATH` before spawning any child processes.

**Ephemeral port reservation:**
Reserve two ephemeral ports (for server and terminal) at startup using Node.js `net.createServer()` listen-then-close pattern (or Effect's `Net.getAvailablePort()`). Store the ports and pass them to child processes via environment variables. Also generate a random auth token.

### Acceptance criteria

- [ ] `fixPath()` correctly captures PATH from the user's login shell on macOS
- [ ] Handles both `-il` and `-l` shell flag variants (try `-il` first, fall back to `-l`)
- [ ] Works with bash, zsh, and fish shells
- [ ] Two ephemeral ports are reserved at startup without conflicts
- [ ] A random auth token is generated
- [ ] Ports and auth token are accessible for passing to child process env
- [ ] Unit tests for PATH parsing with mock shell output
- [ ] Unit test for port reservation (verifies ports are valid and distinct)

### Blocked by

- Blocked by "Electron shell scaffold + dev tooling"

### User stories addressed

- User story 10

---

## Issue 8: Spawn sidecars as child processes

### What to build

Add child process spawning to the Electron main process. Spawn the server, terminal, and MCP services as Node.js child processes using `ELECTRON_RUN_AS_NODE=1`. This replaces the Rust `SidecarManager` from `sidecar.rs`.

**For each service (server, terminal, MCP):**
- Spawn via `child_process.spawn(process.execPath, [entryPath], { env: { ELECTRON_RUN_AS_NODE: '1', ...serviceEnv } })`
- Entry paths: resolve to the bundled service entry points (in dev: `../../packages/server/src/main.ts` run via tsx; in prod: bundled `dist/` files)
- Pass environment: ports (from Issue 7), auth token, DATA_DIR, TERMINAL_PORT, etc.
- Capture stderr in a ring buffer (last 50 lines) for crash diagnostics
- Graceful shutdown on app quit: SIGTERM first, SIGKILL after 2-second timeout
- Handle `SIGINT` and `SIGTERM` on the main process, plus Electron's `before-quit` event

### Acceptance criteria

- [ ] Server child process starts and listens on the allocated port
- [ ] Terminal child process starts and listens on the allocated port
- [ ] MCP child process starts (stdio-based, no port)
- [ ] All child processes receive the correct environment variables
- [ ] stderr is captured in a ring buffer per child process
- [ ] On app quit, all child processes are terminated gracefully (SIGTERM -> SIGKILL)
- [ ] No orphaned processes after app quit (verify with `ps`)
- [ ] In dev mode, services can be run via tsx; in prod, via bundled entry points
- [ ] The window waits for services to be ready before showing (initially just a sleep/delay; health checking comes in Issue 9)

### Blocked by

- Blocked by "Server Bun-to-Node runtime swap"
- Blocked by "Terminal + MCP Bun-to-Node runtime swap"
- Blocked by "Shell environment probing + port allocation"

### User stories addressed

- User story 9
- User story 15

---

## Issue 9: Health checking + crash monitoring + restart

### What to build

Port the health check, crash monitoring, and restart-with-backoff systems from Rust `sidecar.rs` to the Electron main process. This makes the child process management production-ready.

**Health checking:**
- HTTP polling at 100ms intervals against the server and terminal health endpoints
- 10-second timeout for initial startup
- Block window visibility until both services are healthy
- Emit `sidecar:healthy` event to renderer when ready

**Crash monitoring:**
- Watch for unexpected child process exits (non-zero exit code or signal)
- Capture last 50 stderr lines for diagnostics
- Emit `sidecar:error` event to renderer with service name and stderr excerpt

**Restart with backoff:**
- On unexpected exit, restart with exponential backoff (500ms, 1s, 2s, 4s... up to 10s)
- Reset backoff counter on successful health check after restart
- Support manual restart via IPC (`restartSidecar(name)` from renderer)

### Acceptance criteria

- [ ] Health check polling detects when server/terminal are ready
- [ ] Window shows only after both services pass health check
- [ ] Unexpected child process exit triggers `sidecar:error` event with stderr excerpt
- [ ] Crashed service is automatically restarted
- [ ] Restart uses exponential backoff (500ms base, 10s cap)
- [ ] Manual restart via `restartSidecar()` IPC works
- [ ] Backoff counter resets after a successful restart
- [ ] Health check timeout (10s) produces a clear error state

### Blocked by

- Blocked by "Spawn sidecars as child processes"

### User stories addressed

- User story 9

---

## Issue 10: DesktopBridge contract + service URL passing

### What to build

Define the complete `DesktopBridge` TypeScript interface in `packages/shared/` and implement it end-to-end: IPC handlers in the main process, preload script implementation, and renderer access.

**DesktopBridge interface (in packages/shared/):**
```
getServerUrl(): string
getTerminalUrl(): string
pickFolder(): Promise<string | null>
confirm(message: string): Promise<boolean>
showContextMenu(items, position?): Promise<string | null>
openExternal(url: string): Promise<boolean>
onMenuAction(listener): () => void
updateTrayWorkspaceCount(count: number): Promise<void>
restartSidecar(name: string): Promise<void>
onSidecarStatus(listener): () => void
```

**Main process IPC handlers:**
- `desktop:pick-folder` — native folder picker via `dialog.showOpenDialog()`
- `desktop:confirm` — native confirm via `dialog.showMessageBox()`
- `desktop:context-menu` — build and show native `Menu` from items array, return selected ID
- `desktop:open-external` — `shell.openExternal()` with URL validation
- `desktop:update-tray-count` — update tray tooltip
- `desktop:restart-sidecar` — trigger manual restart

**Preload implementation:**
- `contextBridge.exposeInMainWorld('desktopBridge', { ... } satisfies DesktopBridge)`
- Service URLs injected via environment variables from main process

### Acceptance criteria

- [ ] `DesktopBridge` interface defined in packages/shared/ and exported
- [ ] Preload script implements the full interface with `satisfies DesktopBridge`
- [ ] `window.desktopBridge` is accessible from the renderer
- [ ] `getServerUrl()` returns the correct server URL
- [ ] `getTerminalUrl()` returns the correct terminal URL
- [ ] `pickFolder()` opens native macOS folder picker and returns selected path
- [ ] `confirm()` shows native confirmation dialog and returns boolean
- [ ] `showContextMenu()` shows native context menu and returns selected item ID
- [ ] `openExternal()` opens URL in default browser with validation (no `javascript:` etc.)
- [ ] `onMenuAction()` receives menu actions from the application menu
- [ ] TypeScript enforces the contract (preload satisfies interface, renderer has typed access)

### Blocked by

- Blocked by "Health checking + crash monitoring + restart"

### User stories addressed

- User story 17

---

## Issue 11: Frontend Tauri-to-Electron migration

### What to build

Replace all Tauri API usage in the frontend with the new Electron DesktopBridge. There are exactly 5 files that import `@tauri-apps/*`:

1. **`src/lib/tauri.ts`** — Rewrite as `src/lib/desktop.ts`: replace `isTauri()` with `isElectron()` (checks `window.desktopBridge`), replace URL resolution to use `desktopBridge.getServerUrl()` / `getTerminalUrl()`, replace `waitForSidecars()` with bridge-based initialization
2. **`src/routes/index.tsx`** — Replace `getCurrentWindow().hide()` with `desktopBridge` equivalent or `window.close()` (close-to-tray is handled by main process)
3. **`src/hooks/use-sidecar-crash-listener.ts`** — Replace `listen('sidecar:error'/'sidecar:healthy')` and `invoke('restart_sidecar')` with `desktopBridge.onSidecarStatus()` and `desktopBridge.restartSidecar()`
4. **`src/hooks/use-tray-workspace-count.ts`** — Replace `invoke('update_tray_workspace_count')` with `desktopBridge.updateTrayWorkspaceCount()`
5. **`src/components/add-project-form.tsx`** — Replace `@tauri-apps/plugin-dialog` `open()` with `desktopBridge.pickFolder()`

Also update `vite.config.ts` to add explicit HMR config (`protocol: "ws"`, `host: "localhost"`) for Electron compatibility. Remove all `@tauri-apps/*` dependencies from `apps/web/package.json`.

### Acceptance criteria

- [ ] `src/lib/tauri.ts` replaced with `src/lib/desktop.ts` using DesktopBridge
- [ ] `isElectron()` correctly detects Electron environment
- [ ] All 5 Tauri consumer files updated to use DesktopBridge
- [ ] No `@tauri-apps/*` imports remain anywhere in `apps/web/src/`
- [ ] All `@tauri-apps/*` deps removed from `apps/web/package.json`
- [ ] Vite HMR works inside Electron (explicit ws protocol + localhost host)
- [ ] The app loads and functions in the Electron window with full service connectivity
- [ ] The app still works in plain browser mode (graceful fallback when `desktopBridge` is absent)
- [ ] TypeScript compiles without errors

### Blocked by

- Blocked by "DesktopBridge contract + service URL passing"

### User stories addressed

- User story 1
- User story 11
- User story 12
- User story 16
- User story 17

---

## Issue 12: Custom protocol + production frontend serving

### What to build

Register a custom `laborer://` protocol in the Electron main process for serving the frontend in production builds (non-dev). This replaces Tauri's `tauri-plugin-localhost` which served the frontend on `http://localhost:4101`.

**Protocol registration:**
- Register `laborer` as a privileged scheme before `app.whenReady()` using `protocol.registerSchemesAsPrivileged()` with `standard`, `secure`, `supportFetchAPI`, `corsEnabled`
- On ready, register a file protocol handler that serves static files from the bundled `apps/web/dist/` directory
- Implement SPA fallback: any path that doesn't match a file resolves to `index.html`

**Window loading:**
- In dev: load `VITE_DEV_SERVER_URL` (already done in Issue 6)
- In prod: load `laborer://app/index.html`

**Verification:**
- Build the web app with Vite (`vite build`)
- Launch Electron in production mode
- Verify the app loads, routes work (SPA navigation), and static assets (CSS, JS, images) are served correctly

### Acceptance criteria

- [ ] `laborer://` protocol registered as privileged scheme
- [ ] Static files from `apps/web/dist/` are served correctly via the protocol
- [ ] SPA fallback routing works (deep links resolve to index.html)
- [ ] CSS, JS, font, and image assets load correctly
- [ ] WebSocket connections to services work from the custom protocol origin
- [ ] No CORS errors in the console
- [ ] Content-Type headers are set correctly for all file types

### Blocked by

- Blocked by "Frontend Tauri-to-Electron migration"

### User stories addressed

- User story 1
- User story 11
- User story 12
- User story 20

---

## Issue 13: System tray, global shortcut, close-to-tray

### What to build

Port the desktop integration features from Tauri's Rust code to Electron:

**System tray:**
- Create a `Tray` with the app icon (template image for macOS Retina)
- Dynamic tooltip: "Laborer — N workspaces" (updated via IPC from renderer)
- Context menu: "Show Laborer" (focus/show window) and "Quit" (actually quit, not just hide)

**Global shortcut:**
- Register `CommandOrControl+Shift+L` via `globalShortcut.register()`
- On trigger: show the window if hidden, focus it, bring to front

**Close-to-tray:**
- Intercept the window `close` event
- If not actually quitting (i.e., user clicked the close button, not Cmd+Q or tray Quit): hide the window instead of closing
- Track "is actually quitting" state via `before-quit` event

**IPC integration:**
- `updateTrayWorkspaceCount(count)` updates the tray tooltip
- Already wired in Issue 10's DesktopBridge; this issue implements the tray-side logic

### Acceptance criteria

- [ ] Tray icon appears in macOS menu bar
- [ ] Tray icon is crisp on Retina displays (uses template image)
- [ ] Tray tooltip shows workspace count
- [ ] Tray context menu has "Show Laborer" and "Quit" items
- [ ] "Show Laborer" focuses/shows the window
- [ ] "Quit" terminates the app (including child processes)
- [ ] `Cmd+Shift+L` focuses the window from any app
- [ ] Closing the window hides it (doesn't quit)
- [ ] `Cmd+Q` actually quits (not just hides)
- [ ] Tray tooltip updates when workspace count changes

### Blocked by

- Blocked by "Spawn sidecars as child processes"

### User stories addressed

- User story 3
- User story 4
- User story 5
- User story 6

---

## Issue 14: Window state persistence + application menu

### What to build

**Window state persistence:**
Save and restore window bounds (x, y, width, height) and maximized state across app restarts. Use a simple JSON file in the userData directory (or `electron-window-state` package).

Handle edge cases:
- First launch: use default size (800x600) centered on primary display
- External display disconnected: if saved bounds are off-screen, reset to default on primary display
- Maximized state: restore maximized if it was maximized when closed

**Application menu:**
Build a macOS-native application menu with standard items:
- App menu: About Laborer, separator, Settings (sends menu action to renderer), separator, Services, Hide, Hide Others, Show All, separator, Quit
- Edit menu: Undo, Redo, Cut, Copy, Paste, Select All
- View menu: Reload, Toggle DevTools (dev only), separator, Actual Size, Zoom In, Zoom Out, Toggle Fullscreen
- Window menu: Minimize, Zoom, separator, Bring All to Front

### Acceptance criteria

- [ ] Window bounds are saved to disk on move/resize/close
- [ ] Window bounds are restored on next launch
- [ ] Maximized state is persisted and restored
- [ ] If saved bounds are off-screen (display disconnected), window resets to default centered position
- [ ] First launch uses 800x600 centered on primary display
- [ ] macOS application menu appears with all standard items
- [ ] Edit menu items (copy, paste, etc.) work in text fields
- [ ] View menu items work (reload, devtools in dev, zoom, fullscreen)
- [ ] "Settings" menu action is sent to renderer via IPC

### Blocked by

- Blocked by "Electron shell scaffold + dev tooling"

### User stories addressed

- User story 7
- User story 18

---

## Issue 15: Auto-update system

### What to build

Integrate `electron-updater` for automatic update checking and installation, following t3code's state machine pattern.

**Update state machine (`src/update-machine.ts`):**
Pure reducer functions managing states: `disabled` -> `idle` -> `checking` -> `available` -> `downloading` -> `downloaded` -> quit & install. Error states with context (which phase failed) and retry capability.

**Auto-updater integration:**
- `autoUpdater` configured with `autoDownload: false`, `autoInstallOnAppQuit: false` (manual control)
- Startup delay of 15 seconds before first check
- Poll every 4 hours
- Architecture-aware: detect arm64 hosts running x64 builds (Rosetta) and disable differential downloads
- GitHub releases as the update provider

**IPC to renderer:**
- `desktop:update-get-state` — get current update state
- `desktop:update-download` — trigger download of available update
- `desktop:update-install` — quit and install
- `desktop:update-state` — push state changes to renderer

**DesktopBridge additions:**
- `getUpdateState()`, `downloadUpdate()`, `installUpdate()`, `onUpdateState(listener)`

### Acceptance criteria

- [ ] Update state machine has pure reducer functions with unit tests
- [ ] Auto-updater checks for updates 15 seconds after launch
- [ ] Auto-updater polls every 4 hours
- [ ] `autoDownload` is false (user must explicitly download)
- [ ] Update state is broadcast to renderer via IPC
- [ ] Renderer can get current state, trigger download, and trigger install
- [ ] Architecture detection works (arm64 vs x64/Rosetta)
- [ ] Error states are handled with retry capability
- [ ] State machine unit tests pass

### Blocked by

- Blocked by "Electron shell scaffold + dev tooling"

### User stories addressed

- User story 8

---

## Issue 16: Service bundling for distribution

### What to build

Create a build step that bundles the server, terminal, and MCP service entry points into distributable Node.js bundles using `tsdown` or `esbuild`. These bundles will run as `ELECTRON_RUN_AS_NODE=1` child processes in the packaged Electron app.

**For each service (server, terminal, MCP):**
- Bundle with tsdown/esbuild targeting Node.js (`format: 'esm'` or `'cjs'`)
- Externalize native modules: `better-sqlite3`, `node-pty`, `@parcel/watcher`
- Handle WASM files: `wa-sqlite.node.wasm` needs to be copied alongside the bundle
- Output to a `dist/` directory within each package

**Verification:**
- Run each bundled output via `node dist/index.mjs` (with `ELECTRON_RUN_AS_NODE=1`)
- Verify the server responds to RPC requests
- Verify the terminal service manages PTY sessions
- Verify the MCP server communicates over stdio

### Acceptance criteria

- [ ] Server bundle runs correctly via `node dist/index.mjs`
- [ ] Terminal bundle runs correctly via `node dist/index.mjs`
- [ ] MCP bundle runs correctly via `node dist/index.mjs`
- [ ] Native modules (`better-sqlite3`, `node-pty`, `@parcel/watcher`) are correctly externalized
- [ ] `wa-sqlite.node.wasm` is included alongside the server bundle
- [ ] All RPC endpoints function correctly from bundled builds
- [ ] Bundle sizes are reasonable (not duplicating large dependencies)
- [ ] Build script can be run via `bun run build:services` or similar

### Blocked by

- Blocked by "Server Bun-to-Node runtime swap"
- Blocked by "Terminal + MCP Bun-to-Node runtime swap"

### User stories addressed

- User story 19

---

## Issue 17: Electron packaging + .dmg distribution

### What to build

Create `scripts/build-desktop-artifact.ts` — a dynamic build script that packages the entire Electron application for macOS distribution. Follow t3code's pattern of generating electron-builder config programmatically.

**Build pipeline steps:**
1. Build all packages: `turbo run build` (services + web + desktop)
2. Create a staging directory with:
   - `apps/desktop/dist-electron/` (main.js, preload.js)
   - `apps/desktop/resources/` (icons: icon.icns, icon.png)
   - `apps/web/dist/` (bundled frontend)
   - Service bundles from Issue 16 (server, terminal, MCP)
3. Generate production `package.json` with resolved dependencies (no workspace: links)
4. Run `bun install --production` in staging directory
5. Generate electron-builder config:
   - `appId: "com.izakfilmalter.laborer"`
   - `productName: "Laborer"`
   - macOS: dmg + zip targets, icon.icns, category `public.app-category.developer-tools`
6. Run `electron-builder` with macOS arm64 target
7. Create MCP symlink logic: post-install script or first-run hook that creates `/usr/local/bin/laborer-mcp`

**Remove old build artifacts:**
- Delete `apps/web/scripts/build-sidecars.ts`

### Acceptance criteria

- [ ] `bun run dist:desktop:dmg` produces a `.dmg` file for macOS arm64
- [ ] The .dmg installs correctly (drag to Applications)
- [ ] The installed app launches and shows the UI
- [ ] Child processes start and services are reachable
- [ ] The custom `laborer://` protocol serves the frontend
- [ ] System tray, global shortcut, and close-to-tray all work in the packaged app
- [ ] Window state persistence works in the packaged app
- [ ] MCP binary is accessible (symlink or PATH discovery)
- [ ] `apps/web/scripts/build-sidecars.ts` is deleted
- [ ] Build script supports `--skip-build` flag for iterating on packaging only

### Blocked by

- Blocked by "Custom protocol + production frontend serving"
- Blocked by "System tray, global shortcut, close-to-tray"
- Blocked by "Window state persistence + application menu"
- Blocked by "Auto-update system"
- Blocked by "Service bundling for distribution"

### User stories addressed

- User story 13
- User story 19

---

## Issue 18: Cleanup + remove Tauri

### What to build

Remove all Tauri-related code, configuration, and dependencies from the repository. This is the final cleanup after the full Electron migration is verified.

**Delete entirely:**
- `apps/web/src-tauri/` (Cargo.toml, Rust source, capabilities, icons, tauri.conf.json)
- `apps/web/scripts/tauri-dev.sh`
- `apps/web/scripts/build-sidecars.ts` (if not already deleted in Issue 17)

**Remove dependencies:**
- All `@tauri-apps/*` packages from `apps/web/package.json` (if not already removed in Issue 11)
- Any remaining `@effect/platform-bun` references in root `package.json` catalog and overrides
- Any remaining `@types/bun` references anywhere

**Clean up references:**
- Remove Tauri-related scripts from `apps/web/package.json` (`tauri`, `tauri:dev`, etc.)
- Update any documentation referencing Tauri or Rust
- Clean up `.gitignore` entries for Tauri build artifacts (`src-tauri/target/`, etc.)
- Remove any Cargo/Rust toolchain configuration (`.cargo/`, `rust-toolchain.toml` if present)

**Final verification:**
- `turbo dev` starts all services + Electron correctly
- `turbo build` succeeds
- `turbo typecheck` passes
- Production build produces a working `.dmg`
- No orphaned references to Tauri, Bun runtime, or Rust remain

### Acceptance criteria

- [ ] `apps/web/src-tauri/` directory is deleted
- [ ] `apps/web/scripts/tauri-dev.sh` is deleted
- [ ] No `@tauri-apps/*` dependencies remain in any package.json
- [ ] No `@effect/platform-bun` references remain in any package.json
- [ ] No `@types/bun` references remain in any package.json
- [ ] No Rust/Cargo configuration files remain
- [ ] `turbo dev` works end-to-end
- [ ] `turbo build` succeeds
- [ ] `turbo typecheck` passes
- [ ] Production `.dmg` build works
- [ ] `grep -r "tauri" --include="*.ts" --include="*.tsx" --include="*.json" apps/ packages/` returns no results (excluding docs/PRD)

### Blocked by

- Blocked by "Electron packaging + .dmg distribution"

### User stories addressed

- User story 2

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Node.js spawn utility | None | Done |
| 2 | Migrate workspace-provider Bun.spawn sites | 1 | Ready |
| 3 | Migrate remaining server Bun.spawn sites | 1 | Ready |
| 4 | Server Bun-to-Node runtime swap | 2, 3 | Blocked |
| 5 | Terminal + MCP Bun-to-Node runtime swap | None | Ready |
| 6 | Electron shell scaffold + dev tooling | None | Ready |
| 7 | Shell environment probing + port allocation | 6 | Blocked |
| 8 | Spawn sidecars as child processes | 4, 5, 7 | Blocked |
| 9 | Health checking + crash monitoring + restart | 8 | Blocked |
| 10 | DesktopBridge contract + service URL passing | 9 | Blocked |
| 11 | Frontend Tauri-to-Electron migration | 10 | Blocked |
| 12 | Custom protocol + production frontend serving | 11 | Blocked |
| 13 | System tray, global shortcut, close-to-tray | 8 | Blocked |
| 14 | Window state persistence + application menu | 6 | Blocked |
| 15 | Auto-update system | 6 | Blocked |
| 16 | Service bundling for distribution | 4, 5 | Blocked |
| 17 | Electron packaging + .dmg distribution | 12, 13, 14, 15, 16 | Blocked |
| 18 | Cleanup + remove Tauri | 17 | Blocked |

### Parallelism opportunities

Three independent starting tracks can run simultaneously:
- **Track A:** Issues 1 -> 2, 3 -> 4 (server Bun-to-Node)
- **Track B:** Issue 5 (terminal + MCP Bun-to-Node)
- **Track C:** Issue 6 -> 7, 14, 15 (Electron scaffold + independent desktop features)

These converge at Issue 8 (spawn sidecars), then proceed sequentially through the integration chain.
