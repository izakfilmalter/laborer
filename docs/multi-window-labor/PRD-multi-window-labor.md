# PRD: Multi-Window Labor Sessions (V1)

## Problem Statement

Laborer currently behaves like a single-window workspace manager. A user can arrange panels inside one app window, but they cannot open multiple independent Laborer windows and treat each one like a separate working context. This breaks an important desktop workflow: developers often spread work across monitors, macOS Spaces, or distinct focus modes, with each window holding a different set of panes, projects, and terminals.

The missing capability is not just "open another shell window." Each Laborer window needs its own persistent panel layout, its own focused pane, its own visible workspace mix, and a stable identity so the app can restore the exact setup later. Without this, users who want one Laborer window for project A and another for project B are forced to collapse everything into one shared pane tree or manually rebuild layouts every time.

## Solution

Add true multi-window support to Laborer. Users can create a new Laborer window with `Cmd+N` (or the platform-equivalent app menu action), and each window owns an independent panel session.

The feature includes:

1. A window creation flow that opens a second Laborer window without disturbing the current one.
2. New windows always start from a blank default session in v1.
3. Per-window panel state, including pane tree, active pane, selected workspaces, and other window-local UI state.
4. Persistent window records so Laborer restores all previously open windows after relaunch.
5. A clear separation between global app state (projects, workspaces, tasks, terminal backends) and window-local presentation state (which panes are open where).
6. Basic window lifecycle handling for create, focus, close/hide, restore, and cleanup.

The intended feel is: Laborer behaves more like a terminal app or IDE where each window is a first-class workspace container, while all windows still participate in the same underlying project/workspace system. V1 is intentionally narrow: create isolated windows, persist them, restore them, and make targeting coherent. It does not attempt advanced pane transfer or window templating.

## User Stories

1. As a user, I want to press `Cmd+N` and open a new Laborer window, so that I can start a fresh working context without disturbing my current layout.
2. As a user, I want each Laborer window to have its own panel arrangement, so that one window can focus on one project and another can focus on something else.
3. As a user, I want each window to remember its own open panes, so that returning to a window feels continuous.
4. As a user, I want each window to track its own active pane, so that focus changes in one window do not affect another.
5. As a user, I want each window to remember which workspaces are visible in its panes, so that I can dedicate windows to different repos or branches.
6. As a user, I want to place Laborer windows on different monitors or Spaces, so that my desktop setup matches how I work.
7. As a user, I want closing or hiding one window to leave my other Laborer windows untouched, so that I do not lose context elsewhere.
8. As a user, I want relaunching Laborer to restore my previously open windows, so that my multi-window setup comes back automatically.
9. As a user, I want restored windows to come back with their prior layouts and pane contents, so that I do not need to rebuild them after every restart.
10. As a user, I want window state restoration to handle missing or deleted workspaces gracefully, so that one bad reference does not prevent the app from loading.
11. As a user, I want global data like projects, tasks, and workspace metadata to stay shared across all windows, so that Laborer still feels like one app.
12. As a user, I want window-local UI state to stay isolated, so that opening or closing a pane in one window does not unexpectedly mutate another window.
13. As a user, I want a menu action for opening a new window, so that the feature is discoverable even if I do not know the shortcut.
14. As a user, I want a newly opened window to start from a sensible blank default layout, so that window creation is predictable.
15. As a user, I want new-window behavior to be consistent every time, so that I do not have to guess whether it cloned my current layout.
16. As a user, I want notifications or deep links that target a workspace to focus the correct window or open one if needed, so that navigation remains coherent in a multi-window world.
17. As a user, I want terminal and agent activity to continue working no matter which window I use, so that multi-window support does not break existing workflows.
18. As a user, I want Laborer to avoid duplicate or conflicting state writes when two windows are open at once, so that my layout data stays reliable.
19. As a user, I want closing the last visible window to follow Laborer's existing desktop behavior, so that multi-window support still feels native to the app.
20. As a developer, I want window identity and window-local state to be explicit in the data model, so that future features like "Move pane to new window" or "Open workspace in new window" have a stable foundation.

## 'Polishing' Requirements

1. Verify that creating a new window feels immediate and does not cause layout flicker in the originating window.
2. Verify that new windows always open with the same default blank session.
3. Verify that restoring multiple windows does not produce duplicate panes, stale active-pane pointers, or invalid selections.
4. Verify that focus-sensitive actions still target the correct window after switching between windows repeatedly.
5. Verify that closing a non-last window preserves its session for restore and does not destroy global workspace data.
6. Verify that keyboard shortcuts and menu actions behave consistently across all open windows.
7. Verify that a corrupted or partially missing saved window record degrades gracefully to a safe default window.
8. Verify that restore remains robust when displays, monitor ordering, or Spaces change between launches.

## Implementation Decisions

### Module 1: Desktop Window Manager

Introduce a desktop-layer window manager responsible for creating, identifying, restoring, focusing, and closing Laborer windows.

- Each window gets a stable `windowId`.
- The desktop shell is the source of truth for native window lifecycle.
- The renderer receives enough boot-time context to know which `windowId` it represents.
- `Cmd+N` and the application menu both route through this layer.
- Closing a non-last window preserves that window session for future restore.

### Module 2: Window Session Model

Separate Laborer's state into:

- **Global state**: projects, workspaces, tasks, terminal records, agent records, shared metadata.
- **Window session state**: pane tree, active pane id, selected pane content, layout sizing, and other presentation state tied to one specific window.

This separation is the core architectural decision. Multi-window support should not be modeled as several views mutating one shared panel tree.

### Module 3: Window Persistence

Persist a collection of saved window sessions.

- Each saved session stores its `windowId`, layout state, and enough window metadata to restore it.
- Persistence must be resilient to schema evolution and missing references.
- Restoration should prefer correctness over perfect fidelity: if a pane cannot be restored, Laborer should repair the window into a valid default state instead of failing.
- V1 restores all previously open windows on relaunch.

### Module 4: Renderer Bootstrapping

At renderer startup, hydrate the window-local session for the current `windowId`.

- The renderer should only read and write the session that belongs to its own window.
- Shared app data continues to flow normally across all windows.
- Selectors, actions, and hotkeys that currently assume a single window must be re-scoped to the active `windowId`.

### Module 5: Window-Aware Navigation and Targeting

Any feature that jumps to a pane or workspace must become window-aware.

- If the target already exists in an open window, Laborer should focus that window when appropriate.
- If the target is not already open, the action should use the current window unless a specific existing flow already requires different behavior.
- The initial scope only needs consistent rules for existing notifications, menu actions, and shortcut-driven window creation.

### Module 6: Default New-Window Behavior

The first implementation should keep new-window behavior simple and predictable:

- Opening a new window creates a fresh default panel session.
- It does not automatically clone the current pane tree.
- It does not automatically seed the new window from the current selection.
- It does not automatically move panes between windows.

### Recommended Delivery Slices

Build this in narrow vertical slices instead of a large horizontal refactor:

1. Create a second native window with a unique `windowId` and a default blank renderer session.
2. Make panel state window-scoped so changes in one window no longer affect another.
3. Persist closed/open window sessions and restore all windows across app relaunch.
4. Make notifications and focus/targeting paths window-aware, preferring existing windows when the target is already open.
5. Refine lifecycle edge cases, invalid restores, and UX polish.

## Testing Decisions

- Good tests should verify externally visible behavior through public interfaces, not implementation details such as internal stores, reducer shapes, or private helper calls.
- The highest-value tests are integration-style tests around window creation, window-scoped layout persistence, restoration, and focus targeting.
- The best TDD shape for this feature is tracer-bullet vertical slices: one failing behavior test, the minimum code to pass it, then the next behavior.
- The first tracer-bullet test should prove that creating a new window yields a distinct `windowId` and an independent blank default panel session.
- Next tests should prove that editing layout in window A does not mutate window B, then that multiple windows restore correctly after restart.
- Repair-path tests should prove that invalid or stale persisted pane references fall back to a valid default window session.
- Desktop integration tests should cover menu/shortcut-driven window creation and native restore flows where the codebase already has prior art for desktop-shell testing.
- Renderer integration tests should cover window-scoped selectors and actions using the same behavior-first style as existing UI state tests.
- Manual verification should still cover multi-monitor placement, Spaces behavior, and subjective feel when several windows are open.

## Out of Scope

- Moving an existing pane from one window to another.
- Dragging tabs or panes between windows.
- Window-specific project/task filtering redesigns beyond what is required for independent panel sessions.
- New collaborative or multi-user synchronization semantics.
- Re-architecting terminal or agent backends unless a small compatibility change is required for window-aware targeting.
- Advanced window management such as named window templates, saved window sets, or "reopen closed window."

## Further Notes

- This feature lays the foundation for future commands like "Open workspace in new window" and "Move pane to new window," but those should be separate follow-up PRDs.
- The most important architectural guardrail is keeping window-local presentation state separate from globally shared app data.
- If implementation complexity grows, favor introducing one deep module around window-session state rather than scattering `windowId` checks throughout the UI.
