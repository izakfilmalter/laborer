# Bundle Backend Services as Tauri Sidecars

## Problem Statement

Laborer currently runs as multiple separate processes: the Tauri desktop app (web frontend), the main server (`@laborer/server` on port 2100), the terminal service (`@laborer/terminal` on port 2102), and the MCP server (`@laborer/mcp` via stdio). Users must manually start these services or rely on `turbo dev` during development. For a distributable desktop app, all backend services need to be bundled into the Tauri `.app` bundle so that launching the app starts everything automatically.

## Solution

Use `bun build --compile` to create standalone executables for all three backend services (`@laborer/server`, `@laborer/terminal`, `@laborer/mcp`), then bundle them as Tauri sidecars using the `bundle.externalBin` configuration. The Tauri Rust side manages the lifecycle of these sidecars — spawning them on app startup, monitoring their health, and killing them on app exit. The MCP binary is also symlinked into `/usr/local/bin/laborer-mcp` on first launch so AI agents can reference it by name.

## User Stories

1. As a desktop user, I want the Laborer app to start all backend services automatically when I open it, so that I don't need to run separate terminal commands.
2. As a desktop user, I want the Laborer app to stop all backend services when I quit, so that orphan processes don't consume resources.
3. As a desktop user, I want to see an error notification if a backend service crashes, so that I know something went wrong and can take action.
4. As a desktop user, I want the ability to restart a crashed service from the error notification, so that I can recover without restarting the entire app.
5. As a desktop user, I want the app to work without requiring Bun installed on my machine, so that I can use it as a normal macOS application.
6. As a desktop user, I accept that Node.js must be installed on my machine for terminal functionality, since the PTY host requires it.
7. As an AI agent user (Claude Code, etc.), I want the MCP server binary available as `laborer-mcp` on my PATH after installing the app, so that I can configure my AI tools to use it without knowing the .app bundle internals.
8. As a developer, I want a build script that compiles all three services and places them in the correct sidecar directory with target-triple suffixes, so that `tauri build` produces a complete app bundle.
9. As a developer, I want the sidecar lifecycle management code to be tested, so that I can confidently make changes to the process management logic.
10. As a desktop user, I want the services to use fixed ports (2100, 2102) by default, so that the configuration is simple and predictable.
11. As a desktop user, I want the app window to appear only after the backend services are healthy, so that I don't see a broken UI during startup.
12. As a developer building on macOS, I want the build to target macOS (both arm64 and x86\_64), so that the app works on Apple Silicon and Intel Macs.
13. As a desktop user, I want the MCP symlink to be created or updated on each app launch, so that app updates automatically update the MCP binary available to AI agents.

## 'Polishing' Requirements

1. Verify that all three sidecars start and respond to health checks within a reasonable timeout (e.g., 10 seconds). If not, surface a clear error.
2. Ensure the app window is not shown until the server and terminal services are healthy (the web frontend already connects to them on load).
3. Verify that quitting the app (via Cmd+Q or tray menu "Quit") cleanly kills all sidecar processes and their child processes (especially the Node.js PTY host spawned by the terminal service).
4. Verify that the MCP symlink creation handles the case where `/usr/local/bin/` requires elevated permissions (prompt or degrade gracefully).
5. Test that the compiled server gracefully falls back to `fs.watch` when `@parcel/watcher` native addon is not available.
6. Ensure environment variables (PORT, TERMINAL\_PORT, DATA\_DIR, etc.) are correctly passed from the Tauri app to the sidecars.
7. Verify that the terminal service's PTY host can locate `node-pty` native binaries when running from inside the app bundle.
8. Test the complete build-to-launch cycle: `bun run build` produces a `.app` that starts all services and functions correctly.

## Implementation Decisions

### Sidecar Architecture

- Use Tauri's `bundle.externalBin` to declare three sidecars: `laborer-server`, `laborer-terminal`, and `laborer-mcp`.
- Place compiled binaries in `src-tauri/sidecars/` with target-triple suffixes (e.g., `laborer-server-aarch64-apple-darwin`).
- The `sidecars/` directory is `.gitignore`d since it contains build artifacts.

### Build Process

- Use `bun build --compile` to produce standalone executables for each service.
- For `@laborer/mcp`: compile directly — it has zero native dependencies.
- For `@laborer/server`: compile with `@parcel/watcher` and `@livestore/adapter-node` marked as `--external`. Ship their native modules alongside. The server already gracefully falls back to `fs.watch` if `@parcel/watcher` is unavailable.
- For `@laborer/terminal`: compile the main service, but ship `pty-host.ts` as a separate pre-bundled JS file (via `bun build` without `--compile`) that Node.js can execute. Ship `node-pty` native bindings alongside.
- A build script in `apps/web/scripts/` orchestrates: (1) compile all three services, (2) bundle pty-host.js, (3) copy native addons, (4) place everything in `src-tauri/sidecars/` with correct naming.
- The `beforeBuildCommand` in `tauri.conf.json` is updated to run both the Vite build and the sidecar compilation.

### Path Resolution Changes

- Replace `import.meta.url`-based path resolution in `pty-host-client.ts` with `process.execPath`-relative resolution, so the compiled terminal binary can find the sibling `pty-host.js` and `node-pty` native files.
- Replace `import.meta.url`-based MCP entry path in `mcp-registrar.ts` with a well-known path (the symlinked `/usr/local/bin/laborer-mcp` or the binary inside the app bundle resolved via `process.execPath`).

### Sidecar Lifecycle Management (Rust Side)

- Use the direct `tokio::process::Command` approach (following the OpenCode pattern) rather than `tauri-plugin-shell`, for fine-grained control over process groups, environment, and lifecycle.
- Resolve sidecar paths using `tauri::process::current_binary()` — at runtime, Tauri strips the target-triple suffix, so sidecars are at `<binary_dir>/laborer-server`, etc.
- Create a `SidecarManager` Rust module that:
  - Spawns each sidecar on app setup.
  - Passes environment variables (PORT, TERMINAL\_PORT, DATA\_DIR, etc.).
  - Creates a process group for each sidecar (Unix) so child processes are also killed on shutdown.
  - Monitors stdout/stderr and logs via `tauri-plugin-log`.
  - Performs health checks (HTTP GET to `/` endpoint) for server and terminal services.
  - Emits Tauri events (`sidecar:error`, `sidecar:healthy`) to the frontend.
  - Kills all sidecars on `RunEvent::Exit`.
- Start terminal service first (port 2102), then server (port 2100, which connects to terminal). MCP is not started by the app — it's launched independently by AI agents.
- The main window's `visible: false` config stays as-is. The frontend already shows the window when ready via Tauri APIs. The sidecars must be healthy before the frontend can connect.

### macOS Shell Environment

- Probe the user's login shell (e.g., `/bin/zsh`) to inherit PATH and other environment variables, following the OpenCode pattern. This is necessary because macOS GUI apps do not inherit terminal-configured environment.
- Merge the shell environment with sidecar-specific variables before spawning.

### MCP Symlink

- On app setup, create a symlink at `/usr/local/bin/laborer-mcp` pointing to the MCP binary inside the app bundle.
- If the symlink already exists and points to the correct location, skip.
- If `/usr/local/bin/` is not writable, log a warning but do not block app startup. The user can manually configure the path.

### Service Discovery

- Use the current fixed port defaults: server on 2100, terminal on 2102.
- The Tauri app passes these as environment variables to the sidecars explicitly, matching what the `@laborer/env` package expects.

### Error Handling

- If a sidecar crashes, emit a `sidecar:error` Tauri event with the service name and last stderr output.
- The frontend displays an error notification with a "Restart" action button.
- The frontend can invoke a `restart_sidecar` Tauri command to restart a specific service.
- The `SidecarManager` tracks the state of each sidecar (starting, healthy, crashed, stopped).

### Cargo Dependencies

- Add `tokio` (for async process management, already a transitive dep of Tauri).
- Add `process-wrap` for process group management on Unix.
- Do NOT add `tauri-plugin-shell` — we use direct process management.

### Distribution Layout Inside App Bundle

```
Laborer.app/Contents/MacOS/
  laborer              (main Tauri binary)
  laborer-server       (compiled sidecar)
  laborer-terminal     (compiled sidecar)
  laborer-mcp          (compiled sidecar)
  pty-host.js          (pre-bundled Node.js script)
  node_modules/
    node-pty/          (native addon + spawn-helper)
```

## Testing Decisions

Tests should verify external behavior — that sidecars start, respond to health checks, and shut down cleanly — without testing internal implementation details of the Rust code.

### Modules to Test

1. **SidecarManager (Rust integration tests)**:
   - Test that a mock sidecar binary (a simple HTTP server) can be spawned, health-checked, and killed.
   - Test that killing the manager kills all child processes.
   - Test that a crashed sidecar emits the correct error state.
   - Test that restarting a sidecar works after a crash.
   - Test that environment variables are correctly passed to sidecars.

2. **Build script (shell/script test)**:
   - Test that the build script produces correctly named binaries in the sidecars directory.
   - Test that the target-triple suffix is correct for the current platform.

### Prior Art

- The existing Rust tests in `src-tauri/` (if any) for Tauri command testing patterns.
- The OpenCode reference project's sidecar management for patterns.

## Out of Scope

- **Cross-platform builds** (Windows, Linux) — macOS only for this PRD.
- **Auto-update mechanism** for the desktop app.
- **Dynamic port allocation** — using fixed ports for now.
- **Bundling Node.js** into the app — users must have Node.js installed for terminal functionality.
- **Service status UI** (progress bars, health indicators) — services start silently for this iteration.
- **Code signing and notarization** for macOS distribution.
- **CI/CD pipeline** for automated builds.

## Further Notes

- The terminal service's dependency on system Node.js is the main friction point for end users. A future follow-up could explore rewriting the PTY host in Rust using `portable-pty` to eliminate this requirement entirely.
- The `@parcel/watcher` fallback to `fs.watch` may result in slightly less efficient file watching, but is functionally equivalent for the use case.
- The server's `@livestore/adapter-node` dynamic import is the highest-risk compilation target. If it proves too difficult to bundle, an alternative is to ship a small `node_modules` alongside the server binary with just the required native modules.
- The MCP server is the cleanest compilation candidate and should be attempted first as a proof of concept.
