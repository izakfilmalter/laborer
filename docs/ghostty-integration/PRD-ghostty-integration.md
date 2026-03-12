# Ghostty Terminal Integration — Product Requirements Document

## Problem Statement

Laborer currently renders terminals in the web app with xterm.js and the WebGL addon. That architecture is portable and relatively simple, but it still makes terminal rendering a JavaScript-in-the-renderer concern. Even after fixing the major progressive slowdown issue, Laborer is still fundamentally limited by a browser-driven terminal stack for parsing, layout, rendering, and some interaction behavior.

Laborer only targets macOS, which means it can take advantage of a native Metal-based terminal renderer instead of carrying the compromises of a cross-platform browser terminal. Ghostty already provides a high-performance native terminal engine and macOS renderer, but it is designed around native AppKit and Metal surfaces, not direct browser embedding.

The problem to solve is not just "make terminals faster." The problem is that Laborer wants to evolve from a browser-rendered terminal into a native macOS terminal experience while preserving its existing application structure: pane-based terminal UI, multiple concurrent terminals, Electron shell, and app-specific workspace behavior. To do that, Laborer needs a production-oriented integration path for Ghostty that is compatible with Electron and explicit about what functionality is supported initially versus deferred.

## Solution

Introduce a new Ghostty-backed terminal stack alongside the existing `@laborer/terminal` package. The new stack runs as a dedicated macOS helper process that hosts a native N-API addon built with `node-gyp` and `node-addon-api`, links to Ghostty via a vendored Git submodule, creates Ghostty-managed terminal surfaces, and exports their rendered IOSurfaces to Electron.

Electron remains the desktop shell and pane manager. Laborer renders Ghostty output inside the existing application window by importing shared IOSurface-backed textures and displaying them in the renderer via WebGPU. Ghostty owns PTY creation and shell lifecycle for Ghostty terminals. Laborer owns pane layout, focus routing, terminal creation/removal, and the application-level state around those terminals.

The first production target is macOS-only Ghostty integration for Laborer, not a cross-platform abstraction. The implementation supports core terminal interactions and core Ghostty action callbacks needed for day-to-day use, while explicitly documenting unsupported Ghostty actions for later work.

## User Stories

1. As a Laborer user, I want a terminal that feels native on macOS, so that typing, scrolling, and rendering feel as fast as a dedicated terminal app.
2. As a Laborer user, I want Ghostty-rendered terminals to appear inside Laborer's existing pane layout, so that I keep the same multiterminal workspace UX.
3. As a Laborer user, I want to open multiple Ghostty terminals at once, so that I can run shells, builds, and tools side by side.
4. As a Laborer user, I want opening one terminal to not degrade the performance of other terminals, so that multiterminal workflows remain smooth.
5. As a Laborer user, I want Ghostty to manage the shell process for each Ghostty terminal, so that the native terminal engine owns the full terminal lifecycle.
6. As a Laborer user, I want keyboard input to be delivered reliably to the focused Ghostty pane, so that shells and TUIs work without input lag or dropped keys.
7. As a Laborer user, I want mouse input to work in Ghostty panes, so that selection, scrolling, and mouse-aware terminal apps behave correctly.
8. As a Laborer user, I want terminal resize to update immediately, so that TUIs and full-screen programs reflow correctly when pane sizes change.
9. As a Laborer user, I want focus changes to be reflected correctly in Ghostty, so that cursor state, selection, and keyboard routing remain correct.
10. As a Laborer user, I want terminal titles and current working directory updates to flow back into Laborer, so that the sidebar and pane chrome show useful metadata.
11. As a Laborer user, I want bell notifications and other core terminal signals to surface through Laborer, so that I notice meaningful terminal events.
12. As a Laborer user, I want Ghostty terminals to work with common interactive applications such as `vim`, `less`, `top`, and `git`, so that the integrated terminal is useful for real work.
13. As a Laborer user, I want terminal fonts, theme, and keybinding behavior to come from Ghostty's configuration files, so that Ghostty behavior is predictable and standard.
14. As a Laborer user, I want Laborer to keep working as a macOS-only app without adding Linux or Windows compatibility layers, so that the implementation stays focused.
15. As a Laborer developer, I want the Ghostty integration to live beside the existing xterm.js terminal package during development, so that migration can happen incrementally.
16. As a Laborer developer, I want Ghostty to run outside the Electron main process, so that native rendering work and PTY work do not threaten overall app responsiveness.
17. As a Laborer developer, I want the Ghostty runtime to be crash-isolated, so that a Ghostty failure does not take down the main app process.
18. As a Laborer developer, I want the rendering path to avoid CPU pixel copies, so that the architecture keeps the performance benefits of a native renderer.
19. As a Laborer developer, I want the new native layer to be testable in isolation, so that surface lifecycle and rendering behavior can be validated without full UI debugging.
20. As a Laborer developer, I want end-to-end tests for the full surface pipeline, so that regressions in rendering, input, and resize are caught automatically.
21. As a Laborer developer, I want unsupported Ghostty actions to be clearly documented, so that future work can extend the integration intentionally.
22. As a Laborer developer, I want Ghostty to be version-pinned in the repo, so that builds are reproducible and integration breakage is controlled.
23. As a Laborer developer, I want the native addon build to use standard Node tooling, so that the package integrates with the rest of the monorepo and Electron packaging flow.
24. As a Laborer developer, I want the Ghostty helper process to integrate cleanly with Laborer's supervision model, so that startup, shutdown, and restart behavior are deterministic.

## 'Polishing' Requirements

1. Verify that typing in a Ghostty pane feels subjectively native and does not exhibit visible keystroke lag under normal local usage.
2. Verify that opening several Ghostty terminals does not cause frame drops or degraded throughput in already-open terminals.
3. Verify that pane resize remains stable during drag-resize and does not produce blank frames, stale sizes, or obvious flicker.
4. Verify that focus changes between panes, tabs, and the app window always leave exactly one terminal receiving keyboard input.
5. Verify that terminal titles, working directory updates, and bell events appear consistently in Laborer's UI.
6. Verify that common TUIs and color-heavy output render correctly with no obvious corruption.
7. Verify that Ghostty config file changes are either applied on next terminal creation or documented clearly if live reload is not supported initially.
8. Verify that helper-process crashes surface a clear error state in the UI instead of a silent blank pane.
9. Verify that startup and shutdown are clean: no orphan helper processes, no orphan shell processes, and no leaked native surfaces.
10. Verify that unsupported Ghostty actions fail safely and are visible in logs for future implementation work.

## Implementation Decisions

### New Package Alongside Existing Terminal Package

Create a new Ghostty-focused package alongside the existing `@laborer/terminal` package rather than replacing it immediately. This keeps the migration incremental and allows xterm.js and Ghostty paths to coexist while the new stack matures.

### Dedicated macOS Helper Process

Run Ghostty in a dedicated standalone helper process instead of the Electron main process or an Electron utility process.

This is the best fit for performance and architectural isolation because:
- Ghostty expects native macOS UI primitives such as `NSView` and `CAMetalLayer`.
- Laborer already has a proven supervised sidecar pattern.
- The terminal hot path can continue to bypass the Electron main process.
- Crash isolation is stronger than putting the native runtime in the main process.

Electron utility processes are suitable for headless workers, but they are a poor fit for native AppKit surface ownership and have less clear ergonomics for NSView-backed rendering.

### Native Addon Module

Build a native N-API addon with `node-gyp` and `node-addon-api`. The addon wraps the Ghostty C API and exposes a minimal, testable control surface to the helper process.

The addon is responsible for:
- initializing the Ghostty app runtime
- creating and destroying Ghostty terminal surfaces
- forwarding keyboard, mouse, focus, and resize events
- reporting core action callbacks back to the helper process
- extracting or publishing IOSurface identifiers for rendered frames

The addon should encapsulate native complexity behind stable interfaces so most of the rest of Laborer can treat Ghostty as a controllable terminal backend instead of a bundle of AppKit details.

### Ghostty-Owned PTY Lifecycle

Ghostty manages PTY creation and shell lifecycle for Ghostty terminals. Laborer's existing `node-pty` stack remains in place only for the old terminal path during migration.

This reduces architectural mismatch and avoids trying to split Ghostty's renderer from its native runtime assumptions. It also means process metadata and lifecycle events for Ghostty terminals must come from Ghostty callbacks and Ghostty-managed state instead of the existing PTY host protocol.

### Zero-Copy Render Path with Shared Textures

Use the IOSurface-backed zero-copy GPU path as the primary rendering architecture:
- Ghostty renders into a native Metal-backed surface.
- The helper process exposes the IOSurface identity/handle needed by Electron.
- Electron imports that surface using shared texture support.
- The renderer displays the imported texture through WebGPU.

This avoids a GPU-to-CPU-to-GPU copy path and preserves the core performance reason for adopting Ghostty.

### Core Action Support Only

Initial integration supports core Ghostty actions needed to keep Laborer's terminal UI functional:
- terminal title changes
- current working directory updates
- bell notifications
- close/exited-surface handling
- any minimal focus or state callbacks needed to keep pane state correct

Laborer does not attempt to implement the full Ghostty action matrix in the first production iteration.

### Unsupported Actions Must Be Explicitly Documented

The implementation must maintain an explicit list of Ghostty actions that are intentionally unsupported at launch. This list is part of the product contract for the first version and should include at least the categories below unless implemented during development:
- split-management actions already handled by Laborer's own pane model
- search UI actions
- advanced key-sequence and key-table overlays
- URL-opening flows beyond Laborer's existing link behavior
- desktop notification variants beyond core bell handling
- progress reporting and command-finished integrations beyond simple metadata
- scrollbar and other native Ghostty UI affordances that do not map directly into Laborer's design

### Ghostty Config File Ownership

Ghostty uses its standard configuration files for fonts, theme, and keybindings. Laborer does not become the source of truth for those settings.

This keeps the Ghostty integration closer to user expectations and reduces the amount of Laborer-specific config plumbing required in the first version.

### Ghostty Source Distribution

Vendor Ghostty through a git submodule so the integration is pinned to a known version and can be patched if necessary.

If a reliable release artifact path becomes available later, Laborer may add CI-generated binary caching or downloadable prebuilt artifacts, but the baseline supported approach is submodule-based source pinning.

### Helper Process Responsibilities

The Ghostty helper process owns:
- Ghostty runtime startup and shutdown
- terminal surface lifecycle
- native input and resize event handling
- callback translation from Ghostty into Laborer control messages
- surface registration and texture-handle publication
- process supervision hooks for Electron startup and shutdown

Electron main remains a thin orchestration layer, not the execution host for Ghostty.

### Major Modules

The implementation should be split into deep modules with small public interfaces:

- **Ghostty Runtime Host** — owns Ghostty app initialization, config loading, and runtime callbacks.
- **Ghostty Surface Manager** — owns create/destroy/focus/resize/input APIs for terminal surfaces.
- **Shared Surface Bridge** — translates native IOSurface-backed render targets into Electron-importable shared textures.
- **Ghostty Helper Service** — process-level control plane that exposes terminal lifecycle and event APIs to the rest of Laborer.
- **Desktop Integration Layer** — supervises the helper process and brokers any Electron-specific texture import or process lifecycle concerns.
- **Web Renderer Display Layer** — renders imported textures in pane components and routes focus/input/resize events back to the helper.
- **Ghostty Action Mapper** — converts supported Ghostty action callbacks into Laborer UI/state updates and records unsupported actions.

## Testing Decisions

**What makes a good test:** Good tests verify externally visible behavior at the module boundary. They should assert that a terminal surface can be created, rendered, resized, focused, and torn down correctly, not that specific internal callbacks fired in a certain order unless that ordering is itself part of the contract.

### Native Addon Tests

Write native-focused tests for the addon and runtime host that verify:
- Ghostty runtime initialization succeeds
- a terminal surface can be created and destroyed cleanly
- size and focus updates are accepted and reflected without crashing
- keyboard and mouse events are accepted by the surface API
- a renderable IOSurface-backed target can be produced for a terminal
- core action callbacks are surfaced to the host layer

These tests should target the addon's public interface or a narrow harness around it, not private native implementation details.

### End-to-End Rendering Tests

Write end-to-end tests for the full pipeline that verify:
- the helper process starts and creates a Ghostty terminal
- the terminal renders visible output through the shared texture path
- resize updates produce valid subsequent frames
- keyboard input reaches the shell and produces expected output
- helper-process failure produces a visible error state rather than a hang

These tests should validate the production path, including the Electron-facing texture bridge.

### Prior Art

Use existing terminal integration tests and terminal-manager tests in the repo as the pattern for process lifecycle assertions, and use cmux's Ghostty integration as the architectural reference for native callback wiring and surface ownership.

## Out of Scope

- Linux and Windows support.
- A fallback abstraction for non-macOS platforms.
- Full parity with all Ghostty actions and native UI affordances.
- Replacing the existing xterm.js stack on day one.
- Reusing Laborer's current `node-pty` terminal manager for Ghostty-backed terminals.
- Building a custom Laborer settings UI for Ghostty fonts, themes, or keybindings.
- CPU readback rendering paths as a supported production architecture.
- A Tauri migration or non-Electron desktop rewrite.
- A guarantee that unsupported Ghostty actions will be silently emulated by Laborer.

## Further Notes

- The first major technical risk is validating that Ghostty can render correctly when hosted in a helper-owned native surface whose IOSurface is displayed inside Electron rather than by attaching Ghostty directly to an Electron-owned window.
- The second major technical risk is the exact Electron shared-texture import path and where the main process must broker texture handles.
- The implementation should treat unsupported Ghostty actions as a tracked backlog item with observability, not an undocumented omission.
- If future implementation proves that a tiny native host shim is required in Electron main for AppKit ownership reasons, that is acceptable as long as Ghostty's heavy runtime and PTY lifecycle remain outside the main process.
