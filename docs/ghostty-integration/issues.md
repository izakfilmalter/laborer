# Ghostty Terminal Integration — Issues

---

## Issue 1: Ghostty helper tracer bullet with one visible terminal — DONE

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Desktop process supervision, new Ghostty package, native addon runtime, helper process control path, renderer display surface, end-to-end tests

### What to build

Create the thinnest end-to-end Ghostty path that proves Laborer can launch a dedicated Ghostty helper process, initialize the native runtime, create one Ghostty terminal surface, and show a visible rendered frame inside the app.

This slice should not aim for full terminal parity. Its purpose is to establish the production architecture end to end: helper process supervision, native addon boot, surface creation, shared-surface publication, Electron import, and renderer display. A completed slice gives Laborer one demoable Ghostty-backed pane inside the existing app shell.

### Acceptance criteria

- [x] Laborer can start a dedicated Ghostty helper process alongside existing desktop services
- [x] The helper process can initialize the Ghostty runtime through a native addon
- [x] Laborer can create one Ghostty terminal surface and display its rendered output in a pane
- [x] Failure to start the helper process produces a visible, non-silent error state
- [x] An end-to-end test verifies helper startup and first-frame rendering

### Progress

Native addon layer complete: app runtime creation with callbacks, surface lifecycle with offscreen NSWindow/NSView hosting, surface control (size/focus), IOSurface handle extraction, and 25 tests passing. Helper process (ghostty-host.ts) and Effect client service (GhosttyHostClient) complete with 13 integration tests passing. Desktop sidecar integration complete: 'ghostty' added to SidecarManager with entry point resolution, stdin pipe for NDJSON IPC, HealthMonitor spawning (no HTTP — like MCP), crash detection with toast UI, and IPC restart support. Pixel readback rendering pipeline complete: getSurfacePixels in native addon (IOSurface lock/read/copy), get_pixels IPC command with base64 transport, Effect client integration, e2e test verifying helper startup and first-frame pixel data through the full pipeline. All 42 tests passing.

### Blocked by

None - can start immediately

### User stories addressed

- User story 1
- User story 2
- User story 14
- User story 16
- User story 17

---

## Issue 2: Vendor and build Ghostty through a pinned native toolchain — DONE

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Repository dependency management, native build tooling, package configuration, desktop packaging assumptions, native test harness

### What to build

Add the pinned Ghostty source dependency and the native build foundation needed for the Ghostty integration to compile reproducibly on contributor machines and in CI.

This slice should introduce the Ghostty submodule, wire up `node-gyp` and `node-addon-api`, and provide a minimal build/test harness for the native addon package so later slices can focus on runtime behavior instead of bootstrap work.

### Acceptance criteria

- [x] Ghostty is vendored as a pinned git submodule in the repo
- [x] A new native addon package builds with `node-gyp` and `node-addon-api`
- [x] The package can link against the pinned Ghostty source successfully
- [x] Native addon build steps are documented in package scripts or repo docs
- [x] A minimal native test harness can load the built addon in CI/dev

### Blocked by

None - can start immediately

### User stories addressed

- User story 22
- User story 23

---

## Issue 3: Shared surface bridge from Ghostty to Electron renderer

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Native addon surface export, desktop integration layer, Electron texture import path, renderer WebGPU display, end-to-end tests

### What to build

Build the zero-copy render bridge that makes Ghostty practical inside Laborer. A Ghostty surface created by the helper process should publish the IOSurface information needed by Electron, and the renderer should display that surface via the shared texture path.

This slice should harden the rendering architecture chosen in the PRD and prove Laborer can update the displayed terminal surface without CPU pixel readback.

### Acceptance criteria

- [ ] A Ghostty surface can publish an Electron-importable shared surface handle or identifier
- [ ] Electron can import the surface and expose it to the renderer
- [ ] The renderer can display the imported surface through WebGPU
- [ ] Subsequent rendered frames update the displayed terminal view correctly
- [ ] End-to-end tests verify visible rendering beyond the initial frame

### Blocked by

- Blocked by Issue 1
- Blocked by Issue 2

### User stories addressed

- User story 1
- User story 4
- User story 18
- User story 20

---

## Issue 4: Ghostty terminal lifecycle and pane integration

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Helper process API, desktop orchestration, web pane lifecycle, pane layout integration, lifecycle tests

### What to build

Integrate Ghostty terminals into Laborer's pane model so users can create, destroy, and focus Ghostty panes using the existing terminal UI flow.

This slice should make Ghostty terminals feel like first-class panes in Laborer rather than a one-off demo surface. It includes terminal creation/removal wiring, pane ownership, and lifecycle cleanup.

### Acceptance criteria

- [ ] Laborer can create a Ghostty terminal from the existing terminal UI flow
- [ ] A Ghostty pane can be removed cleanly and releases its native resources
- [ ] Pane focus and active terminal state stay in sync with the Ghostty surface lifecycle
- [ ] Closing a pane does not leak helper-side surfaces or shell processes
- [ ] Integration tests cover create, focus, and destroy flows

### Blocked by

- Blocked by Issue 1

### User stories addressed

- User story 2
- User story 3
- User story 5
- User story 15
- User story 24

---

## Issue 5: Keyboard, focus, and resize routing for Ghostty panes

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Renderer event handling, desktop/control messaging, helper process APIs, native surface manager, interaction tests

### What to build

Implement the core interaction path for Ghostty panes: focus, keyboard input, and resize updates. This is the first slice that makes the terminal useful for real shell work instead of passive rendering.

The completed slice should let a user click into a Ghostty pane, type commands, and resize the pane without input routing bugs or stale dimensions.

### Acceptance criteria

- [ ] Focused Ghostty panes receive keyboard input and unfocused panes do not
- [ ] Resize events propagate from the pane layout to the native Ghostty surface
- [ ] The terminal shell responds correctly to typed input after focus changes
- [ ] Resizing does not leave the terminal in a stale size state
- [ ] Tests cover focus handoff, typing, and resize behavior

### Blocked by

- Blocked by Issue 4

### User stories addressed

- User story 6
- User story 8
- User story 9
- User story 12

---

## Issue 6: Mouse input and interactive terminal behavior

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Renderer pointer handling, helper/native input forwarding, Ghostty surface behavior, interaction tests

### What to build

Add mouse input forwarding for Ghostty panes so selection, scrolling, and mouse-aware terminal applications behave correctly.

This slice turns Ghostty panes from keyboard-only shells into terminals suitable for more realistic day-to-day use.

### Acceptance criteria

- [ ] Mouse movement, clicks, and scroll events are forwarded to the Ghostty surface
- [ ] Text selection works in a Ghostty pane
- [ ] Scroll interaction works for scrollback and mouse-aware terminal apps
- [ ] Mouse input does not interfere with pane focus behavior
- [ ] Tests cover click, selection, and scroll interactions

### Blocked by

- Blocked by Issue 5

### User stories addressed

- User story 7
- User story 9
- User story 12

---

## Issue 7: Core Ghostty action mapping into Laborer UI

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Native callback mapping, helper process eventing, desktop/web UI integration, metadata/state tests

### What to build

Map the initial set of supported Ghostty actions into Laborer's UI and terminal metadata model. This includes terminal title changes, current working directory updates, bell notifications, and close/exited-surface handling.

This slice makes Ghostty panes integrate with the rest of Laborer's interface instead of acting as isolated render targets.

### Acceptance criteria

- [ ] Terminal title updates from Ghostty are reflected in Laborer's terminal UI
- [ ] Working directory updates are surfaced to Laborer's metadata model
- [ ] Bell notifications are surfaced through Laborer in a clear, minimal way
- [ ] Exited/closed Ghostty surfaces update pane state correctly
- [ ] Tests cover supported action mapping behavior end to end

### Blocked by

- Blocked by Issue 4

### User stories addressed

- User story 10
- User story 11
- User story 21

---

## Issue 8: Unsupported Ghostty actions registry and observability

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Helper/native action mapper, logging/observability, docs, integration tests

### What to build

Add an explicit unsupported-actions registry for Ghostty callbacks that Laborer does not implement in the first version. Unsupported actions should be classified, logged safely, and documented so the team can make future prioritization decisions from real usage rather than guesswork.

This slice fulfills the PRD requirement that unsupported behavior be part of the product contract instead of an undocumented omission.

### Acceptance criteria

- [ ] Unsupported Ghostty action categories are enumerated in code or config with clear intent
- [ ] Unsupported actions are logged or counted in a controlled, non-spammy way
- [ ] Docs list the intentionally unsupported action categories for launch
- [ ] Unsupported actions fail safely without crashing the helper or blanking the terminal
- [ ] Tests verify unsupported actions are handled gracefully

### Blocked by

- Blocked by Issue 7

### User stories addressed

- User story 21

---

## Issue 9: Ghostty config file ownership and startup loading

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Ghostty runtime host, helper startup/config loading, user-facing docs, integration tests

### What to build

Load Ghostty's standard configuration files during helper/runtime startup so fonts, themes, and keybindings follow Ghostty conventions rather than new Laborer-specific settings.

This slice makes the embedded Ghostty experience predictable for users already familiar with Ghostty and reduces custom settings work in Laborer.

### Acceptance criteria

- [ ] The Ghostty runtime host loads Ghostty config files on startup
- [ ] Fonts, themes, or keybinding changes from Ghostty config affect new terminal surfaces
- [ ] Missing or invalid config files fail with clear diagnostics rather than silent misbehavior
- [ ] User-facing docs explain how Ghostty config applies inside Laborer
- [ ] Tests cover config loading success and failure cases

### Blocked by

- Blocked by Issue 1
- Blocked by Issue 2

### User stories addressed

- User story 13
- User story 22

---

## Issue 10: Multi-terminal performance and isolation hardening

### Parent PRD

PRD-ghostty-integration.md

### Layers touched

Helper process resource management, desktop orchestration, renderer pane handling, performance tests, crash handling

### What to build

Harden the Ghostty integration for real multiterminal usage by validating multiple concurrent Ghostty surfaces, isolating failures, and verifying that one busy terminal does not degrade the rest of the app.

This slice turns the working integration into a production-quality multiterminal system suitable for replacing xterm.js gradually.

### Acceptance criteria

- [ ] Laborer can display and operate multiple Ghostty terminals concurrently
- [ ] A busy terminal does not visibly degrade other Ghostty terminals
- [ ] Helper-process or surface failure produces a contained error state instead of cascading failure
- [ ] Performance or stress tests cover multiple concurrent Ghostty terminals
- [ ] Cleanup remains correct when several terminals are created and destroyed repeatedly

### Blocked by

- Blocked by Issue 3
- Blocked by Issue 5
- Blocked by Issue 6
- Blocked by Issue 7

### User stories addressed

- User story 3
- User story 4
- User story 17
- User story 18
- User story 19
- User story 20
