# PRD: Migrate from xterm.js to ghostty-web with Terminal Persistence

## Problem Statement

Laborer's terminal rendering stack uses xterm.js v6 with five addons (WebGL, Fit, Image, Unicode11, WebLinks) and a custom Vite plugin to work around an xterm.js ESM bundling bug. The rendering depends on a WebGL addon that must gracefully degrade on context loss, and terminal reconnection replays up to 5MB of raw ring buffer data in 128KB chunks -- a slow, bandwidth-heavy process that sends unparsed byte history rather than a compact representation of the current screen.

Meanwhile, ghostty-web provides a WASM-compiled Ghostty VT100 parser with a 60fps canvas renderer in a ~400KB bundle. It exposes an xterm.js-compatible API (same Terminal class, same events, same FitAddon pattern) and natively handles Unicode 15.1, link detection, and keyboard input without requiring separate addons. The Mux project (`.reference/mux/`) demonstrates a robust terminal persistence architecture -- headless xterm state serialization, race-free attach, cached screen state for late subscribers, backend device query handling, and PTY-first resize -- that dramatically improves reconnection performance and reliability.

Laborer should migrate its frontend terminal renderer from xterm.js to ghostty-web and simultaneously adopt Mux's terminal persistence patterns to replace the raw ring buffer replay with compact screen state serialization.

## Solution

Replace xterm.js with ghostty-web as the terminal rendering engine across Laborer's frontend. Simultaneously, introduce a backend headless terminal state manager (using `@xterm/headless` + `@xterm/addon-serialize`) that mirrors all PTY output and provides compact ~4KB screen state snapshots on reconnection, replacing the current 5MB ring buffer replay. Add a frontend Terminal Session Router that centralizes WebSocket stream management with cached screen state for late subscribers. Adopt PTY-first resize to prevent output clobbering during panel resizing.

This is a hard cutover -- xterm.js and all its addons are removed entirely once the migration is complete. The existing WebSocket transport is preserved (it is more performant than ORPC for bidirectional terminal I/O). The existing keyboard bypass system (Cmd+W, Cmd+Shift+Enter, Ctrl+B prefix mode) is preserved identically.

This PRD is separate from and does not supersede the existing native Ghostty integration PRD (`docs/ghostty-integration/`), which targets a future macOS-only Metal/IOSurface rendering path. This PRD covers the near-term cross-platform migration to ghostty-web's WASM + canvas approach.

## User Stories

1. As a developer, I want terminals to render using ghostty-web's WASM-based parser, so that I get accurate VT100 emulation powered by the same engine as the native Ghostty terminal.
2. As a developer, I want terminal rendering at 60fps via canvas, so that scrolling through large output buffers is smooth without depending on WebGL context availability.
3. As a developer, I want terminals to reconnect with a ~4KB screen state snapshot instead of replaying 5MB of raw output, so that reconnection is near-instantaneous.
4. As a developer, I want the backend to subscribe to live PTY output before serializing screen state on reconnect, so that no terminal output is lost during the reconnection window.
5. As a developer, I want the backend to maintain a headless terminal that responds to device queries (DA1/DSR), so that TUI applications like vim, htop, and Yazi work correctly even before the frontend renderer is mounted.
6. As a developer, I want incomplete escape sequences to be buffered on the backend, so that partial VT sequences never reach the frontend and cause rendering glitches.
7. As a developer, I want terminal resize to be sent to the backend PTY first, with the frontend resizing only after the backend confirms, so that shell output is never formatted for stale dimensions.
8. As a developer, I want a centralized Terminal Session Router on the frontend that enforces exactly one WebSocket per terminal and caches screen state, so that late-mounting components (e.g., after tab switch) receive the current screen state immediately without a server round-trip.
9. As a developer, I want the existing keyboard bypass behavior preserved exactly (Cmd+W close pane, Cmd+Shift+Enter fullscreen, Ctrl+B prefix mode with 1500ms timeout), so that my muscle memory is unaffected by the migration.
10. As a developer, I want clickable URLs in terminal output detected automatically, so that I can Cmd+Click to open links in my browser without needing a separate addon.
11. As a developer, I want correct rendering of wide Unicode characters (CJK, emoji), so that terminal output with international text is properly aligned without a separate Unicode addon.
12. As a developer, I want the terminal theme (zinc color scale, JetBrains Mono font stack, cursor blink bar style) preserved identically, so that the visual appearance is unchanged after migration.
13. As a developer, I want the terminal scrollback (100k lines) preserved in ghostty-web's in-memory buffer, so that I can scroll back through long AI agent sessions.
14. As a developer, I want WASM initialization to happen once on app startup and be idempotent, so that creating multiple terminals does not re-download or re-compile the WASM module.
15. As a developer, I want terminal instances to stay alive when their tab is hidden, so that I do not lose frontend scrollback state or cause TUI apps to thrash on tab switches.
16. As a developer, I want the fullscreen portal behavior preserved (terminal stays mounted, no re-creation), so that toggling fullscreen is seamless with no flash or reconnection.
17. As a developer, I want the WebSocket flow control (ack every 5000 chars) preserved, so that fast PTY output does not overwhelm the frontend.
18. As a developer, I want the WebSocket exponential backoff reconnection preserved (500ms initial, 30s max, 3 consecutive failure limit), so that transient disconnections recover automatically.
19. As a developer, I want the dev server terminal pane wrapper to work identically with the new terminal engine, so that dev server terminals are visually distinguished with their teal header.
20. As a developer, I want the terminal-with-sidebars layout (resizable diff panes and dev server terminals) to work correctly with ghostty-web resize events, so that panel drag-resizing is smooth.
21. As a developer, I want xterm.js and all its addons completely removed from the dependency tree after migration, so that the bundle size is reduced and we no longer maintain the Vite enum patch plugin.
22. As a developer, I want the ghostty-web WASM binary served correctly in both development (Vite dev server) and production (Electron/Tauri) builds, so that terminals work in all deployment contexts.
23. As a developer, I want terminal disposal to fully clean up WASM memory, canvas elements, event listeners, and WebSocket connections, so that there are no resource leaks when terminals are closed.
24. As a developer, I want the headless xterm on the backend to be resized in sync with the real PTY, so that the serialized screen state always reflects the correct terminal dimensions.
25. As a developer, I want OSC title change events from ghostty-web forwarded to the UI, so that terminal tab titles update based on the running process.
26. As a developer, I want the connection status overlays (loading, disconnected, reconnecting banners) to work with the new session router, so that I have visibility into connection state.

## Polishing Requirements

1. Verify that the terminal feels subjectively identical to the current xterm.js experience -- same colors, same font rendering, same cursor behavior, same scroll speed.
2. Confirm that resize during active panel drag produces no visible tearing, no stale-dimension output, and the 100ms debounce feels responsive.
3. Test that reconnection after a network interruption restores the screen in under 100ms (vs the current multi-second ring buffer replay).
4. Verify that all TUI applications used in daily workflow (vim, htop, lazygit, yazi, fzf) render correctly with the new engine.
5. Confirm that fullscreen toggle (Cmd+Shift+Enter) produces no flash, no canvas re-creation, and no momentary blank frame.
6. Verify that Ctrl+B prefix mode visual indicator and 1500ms timeout feel identical.
7. Check that the "Disconnected" and "Reconnecting" banners appear and disappear at the right moments with the new session router.
8. Confirm that terminal exit banners display correctly and that exited terminals cannot receive input.
9. Verify that the WASM binary loads correctly on cold start with no console errors or warnings in both dev and production builds.
10. Confirm that opening 10+ concurrent terminals does not degrade rendering performance or cause excessive memory growth.
11. Verify that the ghostty-web canvas is properly DPI-scaled on Retina displays.
12. Check that text selection and clipboard copy (Cmd+C) work correctly in the new terminal.

## Implementation Decisions

### Modules to Build or Modify

#### 1. Backend: Headless Terminal State Manager
A new module within the `@laborer/terminal` package that replaces the ring buffer with `@xterm/headless` and `@xterm/addon-serialize`. For each terminal, it maintains a headless xterm instance that receives all PTY output in parallel with live subscribers. It exposes a `getScreenState(terminalId): string` method that returns a compact VT escape sequence representation of the current screen (~4KB). The headless terminal also responds to device queries (DA1/DSR) by forwarding its `onData` output back to the PTY, ensuring TUI applications get immediate responses even before the frontend renderer mounts. An escape sequence buffering layer wraps the raw PTY `onData` callback, holding back trailing `\x1b`, `\x1b[`, or `\x1b[0-9;]*` fragments until a complete sequence arrives. The headless terminal is resized in sync with the real PTY on every resize event to keep the serialized state dimensionally accurate.

This module replaces the `RingBuffer` class and the `TerminalBufferState` tracking in the terminal manager.

#### 2. Backend: WebSocket Attach Protocol
Modifies the WebSocket connection handler to implement race-free attach. On client connect: (a) subscribe the client to live PTY output first, (b) serialize the headless terminal's screen state, (c) send the serialized state as the first WebSocket text frame (prefixed with a JSON control message `{"type":"screenState"}`), (d) flush any output that arrived between serialization and now, (e) continue streaming live output. This replaces the current chunked ring buffer replay (`sendScrollback` with 128KB chunks). The existing flow control (ack every 5000 chars) and status control messages (`{"type":"status"}`) are preserved.

#### 3. Frontend: ghostty-web Terminal Component
Modifies `terminal-pane.tsx` to use ghostty-web instead of xterm.js. Calls `await init()` once (idempotent) before creating terminals. Creates `new Terminal()` with the existing theme configuration (zinc color scale), font stack (JetBrains Mono), cursor settings (blink, bar), and scrollback (100k lines). Loads ghostty-web's built-in `FitAddon` instead of `@xterm/addon-fit`. Uses ghostty-web's built-in link detection (OSC8 + regex URL provider) instead of `@xterm/addon-web-links`. Removes addon loading for WebGL, Image, and Unicode11 -- ghostty-web handles rendering and Unicode natively. Preserves the existing `attachCustomKeyEventHandler` call with the same bypass logic from `terminal-keys.ts`. Preserves the ResizeObserver with 100ms debounce. Removes the `@xterm/xterm/css/xterm.css` import.

#### 4. Frontend: Terminal Session Router
A new React context and class (lifted from Mux's `TerminalSessionRouter` pattern) that centralizes WebSocket stream management. It enforces exactly one WebSocket connection per terminal ID, caches the most recent screen state per terminal, and supports multiple subscriber callbacks. When a component subscribes to a terminal that already has a cached screen state, it receives the state immediately via `setTimeout(0)` without a server round-trip. When the last subscriber unsubscribes, the WebSocket is closed. The router replaces the per-component `useTerminalWebSocket` hook. A `TerminalRouterProvider` React context wraps the app and recreates the router when the backend connection changes. All consumers (TerminalView, resize handlers, input handlers) gracefully handle a `null` router during reconnection.

#### 5. Frontend: PTY-First Resize Handler
Modifies the resize flow in the terminal component. Instead of calling `fitAddon.fit()` and then sending a resize RPC, the new flow: (a) calls `fitAddon.proposeDimensions()` to calculate desired cols/rows without applying them, (b) sends the resize to the backend via the terminal service RPC, (c) only after the backend confirms, calls `terminal.resize(cols, rows)` on the frontend. Resize requests are serialized (one in-flight at a time) with a pending flag for coalescing rapid resize events during panel drag.

#### 6. Cleanup: xterm.js Removal
Remove all `@xterm/*` packages from `apps/web/package.json` (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-image`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-webgl`). Add `ghostty-web` as a dependency. Remove the `patchXtermEnumPlugin()` from `vite.config.ts`. Remove the `@xterm/xterm/css/xterm.css` import. Add `@xterm/headless` and `@xterm/addon-serialize` as dependencies of the `@laborer/terminal` backend package. Remove the `RingBuffer` class and its tests. Update the Vite config to ensure `ghostty-vt.wasm` is served correctly (it auto-resolves relative to `import.meta.url`, but verify in both dev and production builds).

### Architectural Decisions

- **Hard cutover**: No feature flag or coexistence period. ghostty-web's API compatibility makes a clean swap feasible.
- **WebSocket transport preserved**: More performant than ORPC for bidirectional terminal I/O. Persistence improvements layer on top of the existing WebSocket protocol.
- **Ring buffer replaced entirely**: The headless xterm serialize approach is strictly superior -- ~4KB vs ~5MB, preserves parsed terminal state (colors, cursor position, alternate screen), and eliminates the need for chunked replay.
- **Headless xterm on backend, ghostty-web on frontend**: The backend uses `@xterm/headless` (not ghostty-web) because it runs in Node.js where WASM initialization adds complexity, and `@xterm/addon-serialize` provides the serialization capability we need. The frontend uses ghostty-web for rendering.
- **WASM serving**: ghostty-web auto-resolves `ghostty-vt.wasm` relative to `import.meta.url`. For Vite dev, this works out of the box. For production builds, the WASM file needs to be included in the build output (Vite's asset handling or explicit copy).
- **Inline image support dropped**: ghostty-web does not support iTerm2/Sixel inline images. The `@xterm/addon-image` functionality is removed with no replacement. This is an accepted gap.
- **OSC color query handling**: The session router should intercept OSC 10/11 color queries (foreground/background) from TUI apps and respond with the configured theme colors, matching Mux's approach. This prevents TUIs from blocking on unanswered color queries.

## Testing Decisions

A good test verifies external behavior through the module's public interface, not internal implementation details. Tests should be resilient to refactoring -- if the implementation changes but the behavior is identical, tests should still pass.

### Modules to Test

#### 1. Backend: Headless Terminal State Manager
- Test that writing PTY output to the headless terminal and calling `getScreenState()` returns valid VT escape sequences that reconstruct the screen.
- Test that device query sequences (DA1) written to the headless terminal produce responses forwarded back to the PTY write callback.
- Test that the escape sequence buffering holds back incomplete sequences and forwards complete ones.
- Test that resizing the headless terminal updates the serialized state dimensions.
- Test that the headless terminal correctly handles alternate screen mode (the serialized state includes the alternate buffer switch sequence).
- Prior art: existing ring buffer tests can inform the test structure (input/output verification pattern).

#### 2. Backend: WebSocket Attach Protocol
- Test that on connect, the client receives a screen state message before any live output.
- Test race-free attach: start producing PTY output, connect a client mid-stream, verify no output is lost between the screen state snapshot and the first live output message.
- Test that flow control ack messages are still processed correctly.
- Test that status control messages (running/stopped/restarted) are delivered correctly.
- Prior art: existing WebSocket route tests in the terminal package.

#### 3. Frontend: ghostty-web Terminal Component
- Test that the terminal initializes (WASM loads, terminal opens in container, FitAddon fits).
- Test that `onData` fires when simulating keyboard input and that `write()` renders output.
- Test that the custom key event handler correctly bypasses Cmd+W, Cmd+Shift+Enter, and Ctrl+B.
- Test that terminal disposal cleans up all resources (no dangling event listeners or WASM memory).
- Test that the theme configuration is applied correctly (background, foreground, cursor colors).
- Prior art: existing terminal pane test patterns (if any), or create new component test fixtures.

#### 4. Frontend: Terminal Session Router
- Test that subscribing to a terminal creates exactly one WebSocket connection.
- Test that multiple subscribers to the same terminal share one WebSocket.
- Test that cached screen state is delivered to late subscribers immediately.
- Test that unsubscribing the last subscriber closes the WebSocket.
- Test that the router handles WebSocket disconnection/reconnection gracefully.
- Test that OSC 10/11 color queries are intercepted and responded to with theme colors.
- Prior art: this is new infrastructure; tests should follow the project's existing React hook/context test patterns.

#### 5. Frontend: PTY-First Resize Handler
- Test that `proposeDimensions()` is called without applying the resize to the terminal.
- Test that the backend resize RPC is sent before `terminal.resize()` is called.
- Test that rapid resize events are coalesced (only one in-flight resize at a time).
- Test that the terminal is resized to the correct dimensions after backend confirmation.
- Prior art: existing resize-related test patterns in the terminal pane.

#### 6. Cleanup: xterm.js Removal
- Verify that no `@xterm/*` imports remain in the frontend codebase (can be a grep-based lint check).
- Verify that `ghostty-vt.wasm` is served correctly in dev and production builds.
- Verify that the Vite config no longer contains the `patchXtermEnumPlugin`.
- Prior art: build verification tests, dependency audit.

## Out of Scope

- **Native Ghostty integration (Metal/IOSurface)**: The existing `docs/ghostty-integration/` PRD covers the future macOS-only native rendering path. This PRD is the near-term cross-platform WASM migration.
- **Inline image support**: ghostty-web does not support iTerm2/Sixel protocols. This is an accepted gap. A future addon or upstream contribution could address it.
- **Transport layer migration**: The WebSocket transport is preserved. No migration to ORPC or other streaming protocols.
- **Terminal session persistence across app restarts**: Neither the current system nor this migration persists terminal sessions to disk. Terminals are lost on app restart. This remains unchanged.
- **Keybinding changes**: The keyboard bypass system is preserved exactly as-is. No new keybindings are introduced.
- **Terminal settings UI**: No new user-facing settings for ghostty-web configuration. The existing theme and font configuration is applied programmatically.
- **Linux/Windows platform-specific concerns**: ghostty-web is cross-platform by nature. No platform-specific rendering paths are introduced.
- **Performance benchmarking**: While we expect improved performance (no WebGL dependency, lighter reconnection), formal benchmarking is not part of this PRD.

## Further Notes

- ghostty-web's `init()` function is idempotent -- calling it multiple times is safe and returns immediately after the first load. It should be called early in the app lifecycle (e.g., in the app root or terminal router provider initialization).
- ghostty-web uses a `contenteditable` element for input capture rather than a hidden `<textarea>` like xterm.js. This may affect CSS targeting for caret hiding (Mux uses `caretColor: "transparent"` on the container).
- The `FitAddon` from ghostty-web includes a built-in `observeResize()` method that sets up a `ResizeObserver` with 100ms debounce. This could replace the manual `ResizeObserver` setup in the current terminal pane, but we should evaluate whether the PTY-first resize flow requires custom observation logic.
- The headless xterm `@xterm/addon-serialize` v0.14+ automatically includes alternate buffer switch sequences (`\x1b[?1049h`) when serializing terminals in alternate screen mode (vim, htop). This ensures correct restoration of TUI applications.
- ghostty-web's `Terminal.options` is backed by a `Proxy` that applies changes live. Runtime changes to `fontSize`, `fontFamily`, `cursorBlink`, and `cursorStyle` take effect immediately without recreating the terminal.
- The WASM binary auto-resolves its location via `import.meta.url`. For Electron production builds, verify that the WASM file is included in the app bundle and accessible at the resolved path.
