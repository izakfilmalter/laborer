# PRD: Migrate from Tauri to Electron (and Bun to Node.js)

## Problem Statement

Laborer currently uses Tauri v2 as its desktop shell, which renders the frontend via the platform's native WebView (WebKit on macOS). This causes cross-platform inconsistency — the app behaves differently depending on the OS's WebView engine, and WebKit on macOS introduces cross-origin restrictions that require workarounds (the `tauri-plugin-localhost` hack). The Rust backend code in `src-tauri/` is entirely focused on process lifecycle management (sidecar spawning, health checking, crash monitoring) rather than business logic, making the Rust toolchain an expensive dependency for what is effectively a Node.js-shaped problem.

Additionally, the server, terminal, and MCP packages all run on the Bun runtime, but Electron ships with Node.js built-in. Continuing to compile sidecars into standalone Bun binaries (`bun build --compile`) and shipping them alongside Electron adds unnecessary complexity and binary size. Migrating to Node.js as the runtime for these services allows them to run as child processes of Electron using `ELECTRON_RUN_AS_NODE=1`, eliminating the need for compiled sidecar binaries entirely.

## Solution

Replace Tauri with Electron as the desktop shell, following the patterns established by the `.reference/t3code/` codebase. Simultaneously migrate the server, terminal, and MCP packages from Bun to Node.js runtime. The result is a unified JavaScript/TypeScript stack where:

- Electron's main process manages window lifecycle, system tray, global shortcuts, and child process spawning
- The server, terminal, and MCP services run as Node.js child processes via `ELECTRON_RUN_AS_NODE=1`
- The React frontend loads in Chromium (consistent cross-platform) via a custom `laborer://` protocol in production
- Auto-updates are handled by `electron-updater`
- No Rust toolchain is required

## User Stories

1. As a developer, I want the app to render identically on all platforms, so that I don't encounter platform-specific UI bugs caused by WebView engine differences.
2. As a developer, I want the app to launch reliably without needing to compile Rust code, so that my build times are faster and the toolchain is simpler.
3. As a developer, I want the system tray icon with workspace count, so that I can see at a glance how many workspaces are active without focusing the app.
4. As a developer, I want the "Show Laborer" and "Quit" tray menu items, so that I can control the app from the system tray.
5. As a developer, I want `Cmd+Shift+L` to focus the Laborer window from anywhere in the OS, so that I can quickly switch to my workspace manager.
6. As a developer, I want the window to hide (minimize to tray) when I close it instead of quitting, so that my workspaces keep running in the background.
7. As a developer, I want the window to remember its size and position across restarts, so that I don't have to reposition it every time.
8. As a developer, I want the app to automatically check for updates and prompt me to install them, so that I stay on the latest version without manual effort.
9. As a developer, I want crashed sidecar services to be automatically restarted with exponential backoff, so that transient failures are self-healing.
10. As a developer, I want the app to capture my shell environment (PATH, etc.) on startup, so that child processes can find tools like `git`, `docker`, and `gh`.
11. As a developer, I want the terminal WebSocket connections to work without cross-origin issues, so that xterm.js terminals function correctly in production builds.
12. As a developer, I want LiveStore WebSocket sync to work without cross-origin issues, so that real-time data synchronization is reliable.
13. As a developer, I want the MCP server binary to be symlinked to a discoverable path (`/usr/local/bin/laborer-mcp`), so that AI agents can find it.
14. As a developer, I want the dev mode experience to remain fast — Vite HMR in the renderer, watched rebuilds of the main process, and automatic Electron restarts on main process changes.
15. As a developer, I want the server, terminal, and MCP services to run on Node.js, so that no separate Bun runtime needs to be bundled or compiled.
16. As a developer, I want Effect RPC, LiveStore sync, and all HTTP endpoints to work identically after migration, so that no business logic changes are required.
17. As a developer, I want the native context menu, folder picker dialog, and confirmation dialog to be accessible from the renderer via a typed IPC bridge, so that the frontend can invoke native OS features.
18. As a developer, I want the macOS application menu to include standard items (About, Settings, Services, Hide, Quit), so that the app feels native.
19. As a developer, I want the packaged app to be distributed as a `.dmg` on macOS, so that installation follows the standard macOS pattern.
20. As a developer, I want the Electron preload script to use `contextIsolation: true` and `sandbox: true`, so that the app follows security best practices.

## 'Polishing' Requirements

Once the core migration is complete, verify the following for a refined experience:

1. **Visual parity** — Compare the Electron build side-by-side with the current Tauri build. Ensure fonts, scrollbars, selection highlights, and xterm.js rendering are visually equivalent or improved.
2. **Startup time** — Measure time from app launch to first interactive render. Ensure it is comparable to (or better than) the Tauri build.
3. **Memory usage** — Profile the Electron app's memory footprint. Chromium will use more memory than WebKit; ensure it stays within acceptable bounds.
4. **Tray icon quality** — Ensure the tray icon is crisp on Retina displays (use template images on macOS).
5. **Window state edge cases** — Test window state persistence when the window is on an external display that is later disconnected.
6. **Graceful shutdown** — Ensure all child processes (server, terminal, MCP) are cleanly terminated on app quit. No orphaned processes.
7. **Error recovery** — Simulate sidecar crashes and verify restart with exponential backoff works correctly, including the `sidecar:error` event to the renderer.
8. **Dev mode DX** — Ensure `turbo dev` starts Vite, the main process bundler, and Electron in the correct order with proper watching and restart behavior.
9. **CSP and security** — Review Content Security Policy headers for the custom protocol. Ensure `webSecurity` is not disabled.
10. **Accessibility** — Verify that native dialogs (folder picker, confirmation) and keyboard shortcuts work correctly with assistive technologies.

## Implementation Decisions

### Module 1: `apps/desktop/` — Electron Main Process (New)

A new `apps/desktop/` package containing the Electron main process, preload script, and desktop-specific build tooling. This follows the t3code pattern of separating the Electron shell from the web frontend.

**Main process (`src/main.ts`)** responsibilities:
- Bootstrap sequence: fix PATH, configure logging, set userData path, register custom protocol, create window
- Window management: BrowserWindow with `titleBarStyle: "hiddenInset"`, `contextIsolation: true`, `sandbox: true`
- Custom `laborer://` protocol for production (serves static files from bundled `apps/web/dist/`)
- In development, loads `VITE_DEV_SERVER_URL` (Vite dev server)
- Child process management: spawn server, terminal, and MCP as Node.js child processes via `ELECTRON_RUN_AS_NODE=1`
- Health checking: HTTP polling at short intervals with timeout (ported from Rust `sidecar.rs`)
- Crash monitoring: watch for unexpected child process exits, emit events to renderer, restart with exponential backoff
- System tray: `Tray` with dynamic tooltip showing workspace count, context menu with "Show Laborer" and "Quit"
- Global shortcut: `globalShortcut.register('CommandOrControl+Shift+L', ...)` to focus window
- Close-to-tray: intercept `close` event, hide window instead of quitting (except when explicitly quitting)
- Window state persistence: save/restore bounds using `electron-window-state` or custom implementation
- IPC handlers for native features: folder picker, confirmation dialog, context menu, open external URL
- Auto-update via `electron-updater` with state machine pattern (ported from t3code's `updateMachine.ts`)
- Application menu with macOS-standard items
- MCP symlink creation (`/usr/local/bin/laborer-mcp`)

**Preload script (`src/preload.ts`):**
- Exposes a typed `DesktopBridge` via `contextBridge.exposeInMainWorld()`
- Provides: `getWsUrl()`, `getServerUrl()`, `getTerminalUrl()`, `pickFolder()`, `confirm()`, `showContextMenu()`, `openExternal()`, `onMenuAction()`, `updateTrayWorkspaceCount()`, `restartSidecar()`, update-related methods

**Shell environment probing (`src/fix-path.ts`):**
- Port of Rust `probe_shell_environment()` — launches login shell to capture full PATH
- Uses `child_process.execSync` with the user's default shell and `-ilc 'echo $PATH'`
- Merges result into `process.env.PATH` before spawning child processes

**Build tooling:**
- `tsdown` for bundling main.ts and preload.ts to CJS (matching t3code)
- Dev scripts: `tsdown --watch` + Electron launcher with file watching and restart
- `wait-on` for synchronizing with Vite dev server

### Module 2: `packages/shared/` — Desktop Bridge Contract (Modified)

Add a `DesktopBridge` TypeScript interface to the shared package, defining the typed contract between the preload script and the renderer. This is the equivalent of t3code's `@t3tools/contracts` `DesktopBridge` interface.

The renderer accesses this via `window.desktopBridge` (injected by the preload script) or falls back to browser-native equivalents when running outside Electron.

### Module 3: `apps/web/` — Frontend Adaptations (Modified)

- Remove all `@tauri-apps/*` dependencies and imports
- Replace `src/lib/tauri.ts` runtime detection with Electron detection (`window.desktopBridge` check)
- Replace `invoke('await_initialization')` with the new `desktopBridge` API for getting service URLs
- Replace `invoke('update_tray_workspace_count')` with `desktopBridge.updateTrayWorkspaceCount()`
- Replace `invoke('restart_sidecar')` with `desktopBridge.restartSidecar()`
- Update Vite config: add explicit HMR config (`protocol: "ws"`, `host: "localhost"`) for Electron compatibility
- Remove `src-tauri/` directory entirely
- Update dev/build scripts to work with the new `apps/desktop/` package

### Module 4: `packages/server/` — Bun-to-Node Migration (Modified)

- Replace `@effect/platform-bun` with `@effect/platform-node` (`BunHttpServer` -> `NodeHttpServer`, `BunRuntime` -> `NodeRuntime`)
- Replace all ~25 `Bun.spawn()` call sites with a `child_process`-based utility function that provides the same ergonomics (async exit code, stdout/stderr as string)
- Replace `bun:sqlite` import in `sync-backend.ts` with `better-sqlite3`
- Remove `@types/bun` dev dependency
- Update tsconfig to remove `"bun"` from types array
- Update package.json scripts to use `tsx` instead of `bun run`
- Remove `Bun.spawn` test polyfills (they become unnecessary)

### Module 5: `packages/terminal/` — Bun-to-Node Migration (Modified)

- Replace `@effect/platform-bun` with `@effect/platform-node`
- Update package.json scripts to use `tsx`
- Remove `@types/bun` dev dependency
- Update tsconfig

### Module 6: `packages/mcp/` — Bun-to-Node Migration (Modified)

- Replace `@effect/platform-bun` with `@effect/platform-node` (`BunRuntime` -> `NodeRuntime`, `BunStream.stdin` -> `NodeStream.stdin`, `BunSink.stdout` -> `NodeSink.stdout`)
- Update package.json scripts to use `tsx`
- Remove `@types/bun` dev dependency
- Update tsconfig

### Module 7: Build & Packaging Pipeline (New/Modified)

- **`scripts/build-desktop-artifact.ts`** — Dynamic build script (following t3code's pattern) that:
  - Bundles the server, terminal, and MCP entry points with `tsdown` or `esbuild` (targeting Node.js, not compiling to standalone binaries)
  - Bundles `apps/web/` with Vite
  - Bundles `apps/desktop/` main/preload with tsdown
  - Creates a staging directory with all artifacts
  - Generates a production `package.json` with resolved dependencies
  - Runs `npm install --production` in the staging directory
  - Invokes `electron-builder` with dynamically generated config
  - Produces `.dmg` + `.zip` for macOS (arm64 initially)
- Remove the existing `apps/web/scripts/build-sidecars.ts` (no longer needed — sidecars are not compiled to binaries)
- Remove `src-tauri/` entirely (Cargo.toml, Rust source, capabilities, icons)

### Module 8: Root Configuration Updates (Modified)

- Add `@effect/platform-node` to the dependency catalog (replacing `@effect/platform-bun`)
- Add `electron`, `electron-updater`, `electron-builder`, `tsdown`, `wait-on` to catalog
- Add `better-sqlite3` and `@types/better-sqlite3` to catalog
- Add `tsx` to catalog (for running TypeScript in development)
- Remove `@effect/platform-bun` from catalog and overrides
- Update turbo.json with `apps/desktop` tasks
- Keep `bun` as the package manager (it's used for dependency management / task running, not as a runtime)

### Architectural Decisions

- **Child process communication:** Services communicate with the renderer via HTTP and WebSocket (same as today). The Electron main process does NOT proxy or relay these connections — it only provides the service URLs to the renderer via the preload bridge.
- **Port allocation:** In production, the main process reserves ephemeral ports for server and terminal services (using Effect's `Net.getAvailablePort()` or Node.js equivalent). In development, fixed ports are used (matching current behavior).
- **Auth token:** Generate a random auth token in the main process and pass it to child processes via environment variable. The renderer receives it via the preload bridge. This prevents other local processes from accessing the services.
- **Custom protocol scheme:** `laborer` (i.e., `laborer://app/index.html`), registered as privileged with `standard`, `secure`, `supportFetchAPI`, `corsEnabled` flags.
- **Process spawn utility:** Create a shared `spawn` utility in `packages/server/src/lib/` that wraps `child_process.spawn()` with the same ergonomics as `Bun.spawn()` — returns an object with `exited: Promise<number>` and `stdout`/`stderr` that can be collected as strings. This minimizes diff across the ~40 call sites.

## Testing Decisions

### What makes a good test

Tests should verify external behavior and observable outcomes, not implementation details. A test should break only when the feature it tests is actually broken, not when internal code is refactored.

### Modules to test

1. **Shell environment probing (`fix-path.ts`)** — Unit test that it correctly parses PATH from a mock shell invocation. Prior art: the Rust unit tests in `sidecar.rs` that test `build_shell_command`.

2. **Process spawn utility** — Unit test the `spawn()` wrapper function: exit code resolution, stdout/stderr collection, process killing, timeout behavior. This is a new module that replaces all `Bun.spawn()` usage, so it must be solid.

3. **Child process lifecycle (health check, restart, crash monitoring)** — Integration tests that spawn a mock HTTP server as a child process, verify health polling works, simulate a crash, and verify restart with backoff. Prior art: the Rust tests in `sidecar.rs`.

4. **Window state persistence** — Unit test the save/restore logic for window bounds (serialization, default handling, missing-display fallback).

5. **Auto-update state machine** — Unit test the state machine reducer (pure functions). Prior art: t3code's `updateMachine.ts` tests (if any).

6. **Server Bun-to-Node migration** — The existing e2e tests in `packages/server/test/` (container-service, docker-detection, deps-image-cache) already run under vitest on Node.js. After removing the `Bun.spawn` polyfills and switching to native `child_process`, these tests should continue to pass unchanged. This is the primary validation that the migration is correct.

7. **Preload bridge contract** — Type-level test (compile-time) that the preload implementation `satisfies DesktopBridge`. No runtime test needed.

### Prior art

- `packages/server/test/` — e2e tests using vitest
- `packages/terminal/test/` — pty-host integration tests
- `.reference/t3code/apps/desktop/scripts/smoke-test.mjs` — Electron smoke test pattern (launch app, wait for window, check it loads)

## Out of Scope

- **Linux and Windows support** — macOS only for the initial migration. Cross-platform packaging will be a follow-up.
- **Migration of Bun as package manager** — Bun will continue to be used for `bun install`, `bun run`, and workspace management. Only the runtime for server/terminal/mcp changes to Node.js.
- **New features** — This is a like-for-like migration. No new user-facing features are added (auto-updates being the exception, as it's a natural part of the Electron ecosystem).
- **Docker/OrbStack container features** — These are unchanged; only the `Bun.spawn()` calls to `docker` CLI are replaced with `child_process` equivalents.
- **LiveStore schema or RPC contract changes** — The data layer is untouched.
- **MCP protocol changes** — Only the runtime changes (`BunRuntime` -> `NodeRuntime`, `BunStream` -> `NodeStream`).
- **E2E Playwright tests** — The existing Playwright test infrastructure may need updates for Electron (using `electron` package in Playwright), but writing new E2E tests is out of scope.
- **Code signing** — macOS code signing and notarization will be addressed in a follow-up.

## Further Notes

### Migration Order

The recommended implementation order is:

1. **Bun-to-Node migration first** (Modules 4, 5, 6) — This can be done and validated independently. The services should still work with `turbo dev` (run via `tsx` in development) and pass all existing tests.
2. **Create `apps/desktop/` Electron shell** (Modules 1, 2) — Build the Electron main process, preload, and dev tooling. Initially, have it spawn the services the same way `turbo dev` does.
3. **Adapt the frontend** (Module 3) — Replace Tauri APIs with the Electron desktop bridge.
4. **Build and packaging pipeline** (Module 7) — Create the distribution build script.
5. **Root config and cleanup** (Module 8) — Update catalogs, remove `src-tauri/`, clean up Tauri references.

### Key Risks

- **`better-sqlite3` compatibility** — `bun:sqlite` and `better-sqlite3` have slightly different APIs. The LiveStore sync backend (`sync-backend.ts`) needs careful porting. Alternatively, `node:sqlite` is available in Node.js 22.5+ but is still experimental.
- **node-pty in Electron** — node-pty is a native addon that needs to be compiled for the correct Electron/Node.js ABI. The terminal service currently runs node-pty in a separate "PTY Host" process (already Node.js-based), which should work, but the Electron rebuild step must include it.
- **Effect platform-node HTTP server** — `NodeHttpServer.layer()` requires passing a `http.createServer()` factory, unlike `BunHttpServer.layer()` which creates its own server. This is a minor API difference but needs attention.
- **Binary size** — Electron adds ~150-200MB to the app bundle compared to Tauri's ~10MB. This is an accepted trade-off for cross-platform consistency.
- **Bun.spawn pipe patterns** — One call site in `deps-image-service.ts` pipes stdout from one subprocess directly into stdin of another (`{ stdin: tarProc.stdout }`). This Bun-specific pattern needs careful translation to Node.js streams.

### Reference Implementation

The `.reference/t3code/` codebase serves as the primary reference for the Electron architecture. Key files to consult:

- `apps/desktop/src/main.ts` — Main process patterns (1319 lines)
- `apps/desktop/src/preload.ts` — Preload bridge
- `apps/desktop/tsdown.config.ts` — Electron bundling
- `apps/desktop/scripts/dev-electron.mjs` — Dev mode orchestration
- `scripts/build-desktop-artifact.ts` — Packaging pipeline (778 lines)
- `packages/contracts/src/ipc.ts` — Typed IPC contract
