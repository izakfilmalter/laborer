# Laborer — Issues

---

## Issue 34: WorkspaceProvider — worktree directory validation + file watcher scoping

### Parent PRD

PRD.md

### What to build

Validate the created worktree directory structure and ensure file watcher isolation. The worktree should be independent from the main repo's file watchers so that multiple workspaces don't exhaust OS file descriptor limits.

### Acceptance criteria

- [ ] Worktree directory validated after creation (exists, is git repo, correct branch)
- [ ] File watcher for workspace is scoped to worktree directory only
- [ ] Main repo watchers unaffected by workspace creation
- [ ] Tests: create worktree → validation passes; verify watcher scope doesn't include main repo

### Blocked by

- Blocked by #33

### User stories addressed

- User story 23

---

## ~~Issue 35: WorkspaceProvider — run setup scripts in worktree~~ ✅ DONE

Implemented setup script execution after worktree creation. Projects define scripts in `.laborer.json` at the project root (`"setupScripts": ["bun install", "cp .env.example .env"]`). Scripts run sequentially in the worktree directory with workspace env vars (PORT, etc.) injected. Non-zero exit code aborts remaining scripts and sets workspace status to "errored".

---

## ~~Issue 37: WorkspaceProvider — handle setup script failure~~ ✅ DONE

Implemented full rollback on setup script failure. When any setup script exits with non-zero code: workspace status set to "errored" in LiveStore, then worktree removed (`git worktree remove --force`), branch deleted (`git branch -D`), port freed via PortAllocator, workspace destroyed in LiveStore. Error returned with script's stdout + stderr. Three extracted functions (`runProjectSetupScripts`, `buildSetupFailureMessage`, `rollbackWorktree`) keep complexity under Biome's limit. Best-effort cleanup — each step continues even if a previous step fails.

---

## ~~Issue 38: WorkspaceProvider — handle dirty git state error~~ ✅ DONE

Implemented pre-check for dirty git state before worktree creation. Runs `git status --porcelain` before any resource allocation. Returns `DIRTY_WORKING_TREE` error with descriptive summary (e.g., "3 modified, 1 untracked") and actionable guidance ("Commit or stash your changes"). No partial worktree, no leaked port — check runs before port allocation.

---

## ~~Issue 39: WorkspaceProvider — handle git fetch failure~~ ✅ DONE

Added `git fetch --all` step to `createWorktree` flow, placed before port allocation (step 3c) so no resources need cleanup on failure. Network failures detected via `detectNetworkError()` heuristic with actionable guidance messages. Error code `GIT_FETCH_FAILED` with raw git stderr + human-readable guidance. Unblocks Issue #49 (workspace creation error display).

---

## ~~Issue 49: Workspace creation error display~~ ✅ DONE

Enhanced Create Workspace form with inline Alert component showing type-specific error display for each workspace creation failure. Each error type (DIRTY_WORKING_TREE, GIT_FETCH_FAILED, SETUP_SCRIPT_FAILED, BRANCH_EXISTS, GIT_WORKTREE_FAILED, etc.) gets a distinct icon, title, the server's error message, and actionable guidance text. Added `extractErrorCode` utility for RPC error code extraction. Submit button changes to "Retry" after error. Toast retained as secondary notification channel. Error auto-clears on retry, dismiss, or dialog close.

---

## ~~Issue 71: PanelManager — navigate between panes~~ ✅ DONE

Implemented directional pane navigation (left/right/up/down) via `findPaneInDirection` algorithm + Ctrl+B arrow key shortcuts. Active pane visual indicator (ring-2 ring-primary) was already in place. Navigation stops at edges.

---

## ~~Issue 72: PanelManager — drag-to-resize panes~~ ✅ DONE

Already implemented via `react-resizable-panels` (shadcn/ui's Resizable components). `ResizableHandle` between panels enables drag-to-resize by default. Minimum pane sizes enforced via `minSize` props: sidebar 15%-40%, internal splits min 5%, diff sidebar min 15%/20%.

---

## Issue 79: Panel keyboard shortcut — resize panes

### Parent PRD

PRD.md

### What to build

Add keyboard shortcuts for resizing panes (e.g., prefix + shift+arrow keys to grow/shrink active pane).

### Acceptance criteria

- [ ] Prefix + resize key → active pane grows/shrinks
- [ ] Minimum size enforced
- [ ] Tests: shortcuts resize pane; minimum enforced

### Blocked by

- ~~Blocked by #72, #75~~

### User stories addressed

- User story 2, 30

---

## Issue 81: Panel responsive layout

### Parent PRD

PRD.md

### What to build

Ensure the panel system works well across different screen sizes from 1080p to 5K. Minimum pane sizes should adapt to screen density. Test at various resolutions.

### Acceptance criteria

- [ ] Layout works at 1080p (minimum usable resolution)
- [ ] Layout takes advantage of 4K/5K space
- [ ] Minimum pane size appropriate for screen density
- [ ] Tests: render at 1080p → all panes visible; render at 5K → uses space well

### Blocked by

- ~~Blocked by #72~~

### User stories addressed

- Polishing requirement 9

---

## Issue 88: Diff viewer — accept/reject annotations

### Parent PRD

PRD.md

### What to build

Enable the accept/reject annotation UI in @pierre/diffs. Users can selectively accept or reject individual changes shown in the diff viewer.

### Acceptance criteria

- [ ] Accept/reject buttons appear per change/hunk
- [ ] Clicking accept/reject updates annotation state
- [ ] Annotation state is tracked (in component state or LiveStore)
- [ ] Tests: accept button works; reject button works; state updates correctly

### Blocked by

- Blocked by #87

### User stories addressed

- User story 31

---

## Issue 91: Diff viewer debounce/throttle for rapid changes

### Parent PRD

PRD.md

### What to build

When an agent is making rapid file changes, the diff viewer may receive many updates per second. Debounce/throttle the rendering to prevent UI lag while still showing recent content.

### Acceptance criteria

- [ ] Rapid diff updates (10+/second) don't cause UI lag
- [ ] Viewer shows most recent diff within reasonable delay (500ms max)
- [ ] No excessive rerenders
- [ ] Tests: rapid updates → no frame drops; last update visible within threshold

### Blocked by

- Blocked by #89

### User stories addressed

- Polishing requirement 3

---

## Issue 107: PRD-generated issues become tasks

### Parent PRD

PRD.md

### What to build

After `rlph prd` completes and creates issues (in Linear or GitHub), those issues should automatically appear as tasks in LiveStore. Monitor the rlph prd terminal output or poll the issue tracker for new issues.

### Acceptance criteria

- [ ] After rlph prd completes, resulting issues appear as tasks in LiveStore
- [ ] Tasks have source = "prd" and correct externalId
- [ ] Tests: run rlph prd → new tasks in LiveStore with correct source and metadata

### Blocked by

- Blocked by #94, #100

### User stories addressed

- User story 15

---

## Issue 108: Linear task sourcing

### Parent PRD

PRD.md

### What to build

Implement fetching tasks from Linear's API based on the project's rlph configuration. Import Linear issues as tasks in LiveStore with source = "linear".

### Acceptance criteria

- [ ] Fetch tasks from Linear API using project's rlph config
- [ ] Tasks created in LiveStore with source = "linear" and externalId
- [ ] Handle API errors gracefully
- [ ] Tests: mock Linear API → tasks imported; API error → handled

### Blocked by

- Blocked by #102

### User stories addressed

- User story 7

---

## Issue 109: GitHub task sourcing

### Parent PRD

PRD.md

### What to build

Implement fetching issues from GitHub's API for the project's repository. Import GitHub issues as tasks in LiveStore with source = "github".

### Acceptance criteria

- [ ] Fetch issues from GitHub API for project repo
- [ ] Tasks created in LiveStore with source = "github" and externalId
- [ ] Handle API errors gracefully
- [ ] Tests: mock GitHub API → tasks imported; API error → handled

### Blocked by

- Blocked by #102

### User stories addressed

- User story 7

---

## Issue 110: Task source picker UI

### Parent PRD

PRD.md

### What to build

Create a UI component to select the task source: Linear, GitHub, or Manual. Selecting Linear or GitHub triggers a fetch from that source. Manual shows the create task form.

### Acceptance criteria

- [ ] Dropdown or tabs for source selection
- [ ] Linear → fetches and displays Linear tasks
- [ ] GitHub → fetches and displays GitHub issues
- [ ] Manual → shows create task form
- [ ] Tests: select source → correct tasks displayed; switch source → list updates

### Blocked by

- Blocked by #108, #109, #103

### User stories addressed

- User story 7

---

## Issue 113: Project switcher component

### Parent PRD

PRD.md

### What to build

Create a project switcher UI (dropdown or sidebar) that lets the user switch the active project context. Switching projects filters the workspace list and task list to that project.

### Acceptance criteria

- [ ] Project dropdown/sidebar shows all registered projects
- [ ] Selecting a project → workspace list and task list filter to that project
- [ ] "All Projects" option shows everything
- [ ] Tests: switch project → lists filter; all projects → everything shown

### Blocked by

- Blocked by #26

### User stories addressed

- User story 12

---

## Issue 114: Cross-project workspace dashboard

### Parent PRD

PRD.md

### What to build

Create a dashboard view that shows all workspaces across all projects with their status, and task status summaries per project. Gives the developer a high-level overview.

### Acceptance criteria

- [ ] Dashboard shows all workspaces from all projects
- [ ] Workspace status visible (with badges)
- [ ] Task summary per project (pending/in_progress/completed counts)
- [ ] Tests: multiple projects → all workspaces visible; counts correct

### Blocked by

- Blocked by #41, #104

### User stories addressed

- User story 12, 24

---

## Issue 115: Tauri system tray

### Parent PRD

PRD.md

### What to build

Add a system tray icon to the Tauri desktop shell. The tray shows the number of running workspaces and provides quick actions (show window, quit).

### Acceptance criteria

- [ ] System tray icon visible when app is running
- [ ] Tray shows running workspace count
- [ ] "Show" action brings window to front
- [ ] "Quit" action closes the app
- [ ] Tests: manual verification — tray visible, count updates, actions work

### Blocked by

- Blocked by #41

### User stories addressed

- User story 21

---

## Issue 116: Tauri global shortcut

### Parent PRD

PRD.md

### What to build

Register a global keyboard shortcut that brings the Laborer window to the front from anywhere in the OS.

### Acceptance criteria

- [ ] Global shortcut registered (configurable, default Cmd+Shift+L on macOS)
- [ ] Shortcut focuses the Laborer window
- [ ] Works from any application
- [ ] Tests: manual verification — shortcut focuses window from another app

### Blocked by

- Blocked by #115

### User stories addressed

- User story 21

---

## Issue 117: Tauri window management

### Parent PRD

PRD.md

### What to build

Implement minimize-to-tray behavior. Closing the window minimizes to system tray instead of quitting. Clicking the tray icon restores the window.

### Acceptance criteria

- [ ] Close window → minimize to tray (not quit)
- [ ] Click tray icon → restore window
- [ ] Window state (position, size) persisted
- [ ] Tests: manual verification — close minimizes, tray click restores

### Blocked by

- Blocked by #115

### User stories addressed

- User story 21

---

## ~~Issue 118: Empty state — no projects~~ ✅ DONE

Added first-launch empty state experience. Two complementary changes: (1) sidebar ProjectList empty state enhanced with `<AddProjectForm />` CTA button inside `EmptyContent`, (2) main content area shows `WelcomeEmptyState` component (full-height centered, FolderGit2 icon, "Welcome to Laborer" title, guidance text, AddProjectForm CTA) instead of the panel system when no projects exist. Both disappear reactively via LiveStore query when a project is added.

---

## ~~Issue 119: Empty state — no workspaces~~ ✅ DONE

Enhanced workspace list empty state with `CreateWorkspaceForm` CTA button inside `EmptyContent`. When no active workspaces exist, the empty state now includes a "Create Workspace" button (dialog trigger) in addition to the guidance text. Follows the exact same pattern as Issue #118 (no-projects empty state with `AddProjectForm` CTA). Empty state disappears reactively via LiveStore query when a workspace is created.

---

## ~~Issue 120: Empty state — no terminals~~ ✅ DONE

Enhanced empty terminal pane with guided CTA. Empty panes show a "Spawn Terminal" button that spawns a terminal and assigns it to the specific pane. Workspace resolution: pre-assigned > single-active > user-selected dropdown. No workspaces → guidance-only text. Uses `EmptyContent` component for CTA area, consistent mutation pattern with `terminal.spawn` RPC.

---

## ~~Issue 121: Loading state — workspace creation~~ ✅ DONE

Added loading indicators for workspace creation. Create Workspace form dialog shows spinner on submit button, indeterminate progress bar, descriptive status message, disables inputs, and prevents dialog dismissal during submission. Workspace list uses spinning Loader2 icon (replacing pulsing dot) in status badge for "creating" status and shows "Setting up workspace..." message with spinner in card content.

---

## Issue 122: Loading state — terminal spawning

### Parent PRD

PRD.md

### What to build

Show a loading indicator while a terminal is being spawned (between RPC call and first output). The terminal pane should show a spinner until the PTY is connected.

### Acceptance criteria

- [ ] Terminal pane shows loading while PTY is starting
- [ ] First output → loading disappears, terminal renders
- [ ] Tests: spawn terminal → loading visible; output arrives → loading gone

### Blocked by

- Blocked by #60

### User stories addressed

- Polishing requirement 8

---

## Issue 123: Loading state — diff computation

### Parent PRD

PRD.md

### What to build

Show a loading indicator in the diff viewer while the initial diff is being computed. After the first diff is received, the loading disappears.

### Acceptance criteria

- [ ] Diff viewer shows loading until first diff received
- [ ] Loading disappears when diff content available
- [ ] Tests: open diff viewer → loading; diff arrives → content shown

### Blocked by

- Blocked by #87

### User stories addressed

- Polishing requirement 8

---

## Issue 124: Terminal fidelity — opencode TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the opencode agent's TUI output. Test colors, Unicode characters, cursor positioning, progress indicators, and interactive prompts.

### Acceptance criteria

- [ ] opencode TUI renders correctly in xterm.js
- [ ] Colors, Unicode, cursor positioning all work
- [ ] Progress indicators animate correctly
- [ ] Interactive prompts are usable
- [ ] Tests: render sample opencode output → visual verification; interactive elements work

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 125: Terminal fidelity — claude agent TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the Claude Code agent's TUI output.

### Acceptance criteria

- [ ] Claude Code TUI renders correctly in xterm.js
- [ ] All visual elements (colors, formatting, tool output) display properly
- [ ] Tests: render sample claude output → visual verification

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 126: Terminal fidelity — codex agent TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the Codex agent's TUI output.

### Acceptance criteria

- [ ] Codex TUI renders correctly in xterm.js
- [ ] All visual elements display properly
- [ ] Tests: render sample codex output → visual verification

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 127: Terminal scroll performance (100k+ lines)

### Parent PRD

PRD.md

### What to build

Ensure xterm.js handles large terminal buffers (100k+ lines) without UI lag. Configure the scrollback buffer size appropriately and test scroll performance.

### Acceptance criteria

- [ ] 100k+ lines in terminal → no UI lag
- [ ] Scrolling is smooth
- [ ] Memory usage reasonable
- [ ] Tests: load 100k lines → measure frame rate during scroll; no dropped frames

### Blocked by

- Blocked by #60

### User stories addressed

- Polishing requirement 10

---

## Issue 131: Theme consistency audit

### Parent PRD

PRD.md

### What to build

Audit all custom components (terminal chrome, diff viewer, panel dividers, status badges) to ensure they use shadcn/ui theme tokens consistently. No hard-coded colors. Dark mode works throughout. Visual integration between terminal panes, diff viewers, and panel chrome should be seamless.

### Acceptance criteria

- [ ] All custom components use oklch theme variables (no hard-coded hex/rgb)
- [ ] Dark mode renders correctly across all components
- [ ] Terminal background matches app theme
- [ ] Diff viewer colors complement the theme
- [ ] Panel dividers and chrome are visually consistent
- [ ] Tests: visual audit / snapshot tests; toggle theme → all components update

### Blocked by

- Blocked by #90

### User stories addressed

- Polishing requirement 11

---

## Issue 134: Drag terminal from sidebar onto empty panel pane

### Parent PRD

PRD.md

### What to build

Add drag-and-drop support so users can drag a terminal item from the sidebar terminal list onto an empty panel pane to assign that terminal to that pane. Currently, clicking a terminal in the sidebar auto-finds an empty pane or creates a new split — there is no way to target a specific pane. This feature gives users precise control over which pane displays which terminal.

**Drag source**: Make each `TerminalItem` in the terminal list (`apps/web/src/components/terminal-list.tsx`) draggable, carrying `{ terminalId, workspaceId }` as drag data.

**Drop target**: Make empty `LeafNode` panes in `PaneContent` (`apps/web/src/panels/panel-manager.tsx`) accept drops. An empty pane is a `LeafNode` with `paneType: "terminal"` and no `terminalId` set. When an empty pane receives a drop, it should fill the entire pane with that terminal — no splitting required.

**Assignment action**: Use the existing `panelActions.assignTerminalToPane(terminalId, workspaceId, paneId)` which already supports targeted pane assignment via the `paneId` parameter. The plumbing exists; only the drag-and-drop UI needs to be built.

**Visual feedback**: Show a visual drop indicator (highlight border, background tint) on valid drop targets when dragging. Show a "not allowed" indicator on panes that already have content assigned.

A lightweight DnD library (e.g., `@dnd-kit/core` + `@dnd-kit/utilities`) or the native HTML5 Drag and Drop API should be used. Prefer `@dnd-kit` for accessibility (keyboard-based drag) and better React integration.

### Acceptance criteria

- [ ] Terminal items in the sidebar terminal list are draggable (mouse and keyboard)
- [ ] Empty panel panes (LeafNode with no terminalId) are valid drop targets
- [ ] Dropping a terminal onto an empty pane calls `assignTerminalToPane(terminalId, workspaceId, paneId)` — terminal fills the pane
- [ ] Panes that already have a terminal assigned are not valid drop targets (or show a "replace" indicator)
- [ ] Visual drag feedback: dragged item has a drag preview, drop targets highlight on drag-over
- [ ] Layout is persisted to LiveStore after drop (via existing `layoutPaneAssigned` event flow)
- [ ] Dragging does not interfere with existing click-to-assign behavior in the sidebar
- [ ] Keyboard accessibility: drag-and-drop can be performed via keyboard (if using @dnd-kit)
- [ ] Tests: drag terminal onto empty pane → terminal renders in that pane; drag onto occupied pane → rejected or replaced; layout persisted after drop; click-to-assign still works

### Blocked by

- Blocked by #63 (done), #66 (done)

### User stories addressed

- User story 1, 6

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 34 | WorkspaceProvider — directory validation + watcher scoping | #33 | Ready |
| 35 | ~~WorkspaceProvider — setup scripts~~ | ~~#33~~ | Done |
| 37 | ~~WorkspaceProvider — handle setup failure~~ | ~~#35~~ | Done |
| 38 | ~~WorkspaceProvider — handle dirty git state~~ | ~~#33~~ | Done |
| 39 | ~~WorkspaceProvider — handle git fetch failure~~ | ~~#33~~ | Done |
| 49 | ~~Workspace creation error display~~ | ~~#37~~, ~~#38~~, ~~#39~~, ~~#42~~ | Done |
| 71 | ~~PanelManager — navigate between panes~~ | ~~#67~~ | Done |
| 72 | ~~PanelManager — drag-to-resize~~ | ~~#67~~ | Done |
| 79 | Keyboard shortcut — resize panes | ~~#72~~, ~~#75~~ | Ready |
| 81 | Panel responsive layout | ~~#72~~ | Ready |
| 88 | Diff viewer — accept/reject annotations | ~~#87~~ | Ready |
| 91 | Diff viewer debounce/throttle | ~~#89~~ | Ready |
| 107 | PRD-generated issues → tasks | ~~#94~~, ~~#100~~ | Ready |
| 108 | Linear task sourcing | ~~#102~~ | Ready |
| 109 | GitHub task sourcing | ~~#102~~ | Ready |
| 110 | Task source picker UI | #108, #109, #103 | Blocked |
| 113 | Project switcher | ~~#26~~ | Ready |
| 114 | Cross-project dashboard | ~~#41~~, ~~#104~~ | Ready |
| 115 | Tauri system tray | ~~#41~~ | Ready |
| 116 | Tauri global shortcut | #115 | Blocked |
| 117 | Tauri window management | #115 | Blocked |
| 118 | ~~Empty state — no projects~~ | ~~#27~~ | Done |
| 119 | ~~Empty state — no workspaces~~ | ~~#42~~ | Done |
| 120 | ~~Empty state — no terminals~~ | ~~#63~~ | Done |
| 121 | ~~Loading state — workspace creation~~ | ~~#41~~ | Done |
| 122 | Loading state — terminal spawning | ~~#60~~ | Ready |
| 123 | Loading state — diff computation | ~~#87~~ | Ready |
| 124 | Terminal fidelity — opencode | ~~#60~~ | Ready |
| 125 | Terminal fidelity — claude | ~~#60~~ | Ready |
| 126 | Terminal fidelity — codex | ~~#60~~ | Ready |
| 127 | Terminal scroll performance | ~~#60~~ | Ready |
| 131 | Theme consistency audit | ~~#90~~ | Ready |
| 134 | Drag terminal from sidebar onto empty panel | ~~#63~~, ~~#66~~ | Ready |
