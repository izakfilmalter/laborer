# Issues: Multi-Window Labor Sessions (V1)

## Issue 1: Window Identity Plumbing

## What to build

Introduce stable `windowId` plumbing so every Laborer window has an explicit identity and the renderer can tell which native window it belongs to. This is the foundational tracer bullet for all later multi-window work.

## Acceptance criteria

- [x] Each created Laborer window is assigned a stable `windowId`
- [x] The renderer can read the current window's `windowId` during bootstrap
- [x] Tests cover the boot path that associates a renderer instance with the correct `windowId`

## Blocked by

None - can start immediately

## User stories addressed

- User story 1
- User story 13
- User story 20

## Issue 2: New Window Command

## What to build

Add the narrow end-to-end flow for opening a second Laborer window from `Cmd+N` and the application menu. The new window should open without disturbing the current one and should participate in the new window identity model.

## Acceptance criteria

- [x] `Cmd+N` opens a new Laborer window
- [x] An application menu action opens a new Laborer window
- [x] Opening a new window does not close, reset, or steal layout state from the originating window

## Blocked by

- Blocked by "Window Identity Plumbing"

## User stories addressed

- User story 1
- User story 13
- User story 14
- User story 15

## Issue 3: Panel Layout Storage by Window

## What to build

Replace the current single-session panel layout persistence model with a window-scoped model keyed by `windowId`. This issue only changes storage and materialization semantics; it does not yet change all renderer read/write call sites.

## Acceptance criteria

- [x] Panel layout persistence is keyed by `windowId` instead of one global default session id
- [x] Existing layout events/materializers support multiple independent window-scoped layout rows
- [x] Tests cover storing two different panel sessions without either one overwriting the other

## Blocked by

- Blocked by "Window Identity Plumbing"

## User stories addressed

- User story 2
- User story 3
- User story 4
- User story 12
- User story 20

## Issue 4: Renderer Reads Only Its Own Session

## What to build

Update the renderer boot and selector path so each window reads only the panel session for its own `windowId`. This makes multi-window rendering safe before write paths are fully updated.

## Acceptance criteria

- [x] A renderer instance hydrates only the panel session matching its `windowId`
- [x] Active-pane selection is derived from the current window's session only
- [x] Tests cover two windows reading different persisted panel sessions correctly

## Blocked by

- Blocked by "Panel Layout Storage by Window"

## User stories addressed

- User story 2
- User story 3
- User story 4
- User story 12

## Issue 5: Renderer Writes Only Its Own Session

## What to build

Update panel actions and layout mutations so every split, close, assign, and reorder operation writes back only to the current window's session. This is the key isolation slice that prevents cross-window corruption.

## Acceptance criteria

- [x] Splitting or closing panes in one window updates only that window's persisted panel session
- [x] Pane assignment and workspace reorder operations are scoped to the current window
- [x] Tests prove that edits in window A do not mutate window B

## Blocked by

None - completed

## User stories addressed

- User story 2
- User story 3
- User story 4
- User story 5
- User story 12
- User story 18

## Issue 6: Default Blank Session Seeding

## What to build

Define and implement the v1 default new-window session. Every newly opened window should start from the same predictable blank default session rather than cloning or inferring context from the current window.

## Acceptance criteria

- [x] A newly opened window always starts from the same blank default panel session
- [x] New-window creation does not clone the current pane tree
- [x] Tests cover repeated window creation producing the same default starting session

## Blocked by

None - completed

## User stories addressed

- User story 14
- User story 15

## Issue 7: Persist Window Records

## What to build

Persist the set of Laborer windows as first-class records rather than treating the app as a single remembered main window. This should include enough metadata to restore all windows in a future launch.

## Acceptance criteria

- [x] Laborer persists multiple window records rather than a single main-window record
- [x] Persisted window records contain enough identity and restoration metadata to reopen the session set later
- [x] Tests cover saving and reloading multiple window records from disk

## Blocked by

None - completed

## User stories addressed

- User story 8
- User story 9
- User story 19

## Issue 8: Restore All Windows on Relaunch

## What to build

Restore all previously open Laborer windows on relaunch, wiring persisted window records to the correct window-scoped panel sessions.

## Acceptance criteria

- [ ] Relaunch restores all previously open windows, not just one
- [ ] Each restored window hydrates the correct persisted panel session
- [ ] Tests cover a multi-window relaunch flow end-to-end

## Blocked by

None - ready

## User stories addressed

- User story 8
- User story 9

## Issue 9: Invalid Session Repair

## What to build

Harden restore so invalid, stale, or partially corrupt window-session data repairs into a valid default state instead of breaking app startup.

## Acceptance criteria

- [ ] Invalid or stale pane references do not prevent window restoration
- [ ] A broken window session falls back to a safe default session for that window
- [ ] Tests cover at least one corrupted restore record and one stale pane reference case

## Blocked by

- Blocked by "Restore All Windows on Relaunch"

## User stories addressed

- User story 10

## Issue 10: Preserve Closed Window Sessions

## What to build

Implement the agreed v1 close semantics: closing a non-last window preserves its session for future restore instead of deleting it immediately.

## Acceptance criteria

- [ ] Closing a non-last window does not delete its persisted session
- [ ] Preserved closed-window sessions are restored on relaunch
- [ ] Tests cover closing one of multiple windows and later restoring it

## Blocked by

None - ready

## User stories addressed

- User story 7
- User story 8
- User story 19

## Issue 11: Focus Existing Window for Open Workspace

## What to build

Make workspace-targeting flows window-aware so Laborer focuses the already-open window when a target workspace is already visible elsewhere, instead of duplicating that workspace into the current window.

## Acceptance criteria

- [ ] When a targeted workspace is already open in another window, Laborer focuses that existing window
- [ ] The targeting path does not create a duplicate pane for an already-open workspace in v1
- [ ] Tests cover at least one notification or action resolving to an existing window

## Blocked by

None - can start immediately

## User stories addressed

- User story 16
- User story 17

## Issue 12: Multi-Window UX Hardening

## What to build

Do a final pass on multi-window edge cases and user feel without expanding scope. Focus on monitor changes, Spaces behavior, focus correctness, and state integrity under repeated switching.

## Acceptance criteria

- [ ] Manual verification covers multi-monitor and Spaces restore behavior
- [ ] Focus-sensitive actions continue targeting the correct window after repeated switches
- [ ] No known window-isolation regressions remain after end-to-end verification of the v1 flow

## Blocked by

- Blocked by "Restore All Windows on Relaunch"
- Blocked by "Invalid Session Repair"
- Blocked by "Preserve Closed Window Sessions"
- Blocked by "Focus Existing Window for Open Workspace"

## User stories addressed

- User story 6
- User story 18
- User story 19

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Window Identity Plumbing | None | Done |
| 2 | New Window Command | 1 | Done |
| 3 | Panel Layout Storage by Window | 1 | Done |
| 4 | Renderer Reads Only Its Own Session | 3 | Done |
| 5 | Renderer Writes Only Its Own Session | 4 | Done |
| 6 | Default Blank Session Seeding | 4 | Done |
| 7 | Persist Window Records | 1 | Done |
| 8 | Restore All Windows on Relaunch | None | Ready |
| 9 | Invalid Session Repair | 8 | Blocked |
| 10 | Preserve Closed Window Sessions | None | Ready |
| 11 | Focus Existing Window for Open Workspace | 5 | Ready |
| 12 | Multi-Window UX Hardening | 8, 9, 10, 11 | Blocked |
