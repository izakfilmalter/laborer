# Laborer — Issues

---

## ~~Issue 34: WorkspaceProvider — worktree directory validation + file watcher scoping~~ ✅ DONE

Enhanced worktree creation with comprehensive post-creation validation (`validateWorktree` checks directory exists, is git work tree, correct branch, isolated toplevel) and file watcher scoping env vars (`WATCHMAN_ROOT`, `CHOKIDAR_USEPOLLING`, `TSC_WATCHFILE`, `TSC_WATCHDIRECTORY`) in `getWorkspaceEnv`. Uses `node:child_process.execFile` + `realpathSync` for cross-runtime testability. 9 integration tests.

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

## ~~Issue 79: Panel keyboard shortcut — resize panes~~ ✅ DONE

Added Ctrl+B, Shift+Arrow keyboard shortcuts for resizing panes. Shift+Right/Down grows the active pane by 5%; Shift+Left/Up shrinks it. Uses react-resizable-panels' imperative `GroupImperativeHandle.setLayout()` API via a new `PanelGroupRegistry` context. Minimum pane size (5%) enforced. Walk-up ancestor search handles nested layouts correctly. Completes the full tmux-style keyboard shortcut system.

---

## ~~Issue 81: Panel responsive layout~~ ✅ DONE

Made the panel system responsive from 1080p to 5K: viewport-aware sidebar sizing (pixel-based defaults/min/max converted to percentages), pixel-aware pane minimums (at least ~100px), auto-switch between split and unified diff views based on container width (ResizeObserver + 500px threshold), larger resize handle hit areas (doubled to 8px), collapsible sidebar below 1280px with toggle button in header bar. Created `useResponsiveLayout` hook for centralized viewport-aware sizing.

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

## ~~Issue 113: Project switcher component~~ ✅ DONE

Created a project switcher Select dropdown at the top of the sidebar. Lists all registered projects plus an "All Projects" option (default). Selecting a specific project filters the Workspace and Task lists to show only items belonging to that project. Controlled component pattern with state lifted to `HomeComponent`. Auto-clears filter if the selected project is removed. Status counts in task tabs reflect the filtered project.

---

## ~~Issue 114: Cross-project workspace dashboard~~ ✅ DONE

Created a cross-project workspace dashboard with a view toggle in the panel header bar. Users switch between terminal panels and dashboard via Terminal/LayoutDashboard icon buttons. Dashboard shows a global overview section (aggregate workspace + task counts), and per-project sections with: project name/repo path, task summary counts (pending/in progress/completed/cancelled with color-coded icons), workspace/task count badges, and workspace rows with status badges, branch names, ports, and terminal counts. All data reactive via LiveStore queries.

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

## ~~Issue 122: Loading state — terminal spawning~~ ✅ DONE

Added loading overlay to terminal pane. Shows centered spinner with "Starting terminal..." text while PTY is spawning and before first WebSocket data arrives. Uses exact terminal background color (`bg-[#09090b]`) for seamless transition. Overlay disappears on first data frame via `hasReceivedData` state/ref tracking. Skipped for stopped terminals (scrollback arrives immediately on reconnection). Consistent with workspace creation loading state (#121).

---

## ~~Issue 123: Loading state — diff computation~~ ✅ DONE

Added a loading spinner to the diff viewer pane that displays while waiting for the first diff computation. Distinguishes `diffRow === null` (loading — DiffService hasn't polled yet) from `diffRow !== null && diffContent === ""` (genuinely no changes). Uses the `Spinner` component consistent with terminal loading (#122). Loading disappears as soon as the first `DiffUpdated` event syncs to LiveStore.

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

## ~~Issue 127: Terminal scroll performance (100k+ lines)~~ ✅ DONE

Increased xterm.js scrollback from 10K to 100K lines. Increased server ring buffer from 1MB to 5MB. Increased WebSocket scrollback chunks from 64KB to 128KB. Added Unicode 11 addon for correct wide-character width calculation. Added scroll/fast-scroll sensitivity tuning. WebGL GPU-accelerated renderer (pre-existing) handles large buffers efficiently.

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

## ~~Issue 134: Drag terminal from sidebar onto empty panel pane~~ ✅ DONE

Added drag-and-drop support using the native HTML5 Drag and Drop API. Terminal items in the sidebar are draggable (carrying `{ terminalId, workspaceId }` as JSON in a custom `application/x-laborer-terminal` MIME type). Empty panel panes (LeafNode with `paneType: "terminal"` and no terminalId) are drop targets. Drop calls `assignTerminalToPane(terminalId, workspaceId, paneId)` for targeted pane assignment. Visual feedback: `ring-2 ring-primary ring-inset bg-primary/5` highlight on valid drop targets during drag-over. Occupied panes reject drops (no `preventDefault` → "not allowed" cursor). Click-to-assign still works unchanged.

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 34 | ~~WorkspaceProvider — directory validation + watcher scoping~~ | ~~#33~~ | Done |
| 35 | ~~WorkspaceProvider — setup scripts~~ | ~~#33~~ | Done |
| 37 | ~~WorkspaceProvider — handle setup failure~~ | ~~#35~~ | Done |
| 38 | ~~WorkspaceProvider — handle dirty git state~~ | ~~#33~~ | Done |
| 39 | ~~WorkspaceProvider — handle git fetch failure~~ | ~~#33~~ | Done |
| 49 | ~~Workspace creation error display~~ | ~~#37~~, ~~#38~~, ~~#39~~, ~~#42~~ | Done |
| 71 | ~~PanelManager — navigate between panes~~ | ~~#67~~ | Done |
| 72 | ~~PanelManager — drag-to-resize~~ | ~~#67~~ | Done |
| 79 | ~~Keyboard shortcut — resize panes~~ | ~~#72~~, ~~#75~~ | Done |
| 81 | ~~Panel responsive layout~~ | ~~#72~~ | Done |
| 88 | Diff viewer — accept/reject annotations | ~~#87~~ | Ready |
| 91 | Diff viewer debounce/throttle | ~~#89~~ | Ready |
| 107 | PRD-generated issues → tasks | ~~#94~~, ~~#100~~ | Ready |
| 108 | Linear task sourcing | ~~#102~~ | Ready |
| 109 | GitHub task sourcing | ~~#102~~ | Ready |
| 110 | Task source picker UI | #108, #109, #103 | Blocked |
| 113 | ~~Project switcher~~ | ~~#26~~ | Done |
| 114 | ~~Cross-project dashboard~~ | ~~#41~~, ~~#104~~ | Done |
| 115 | Tauri system tray | ~~#41~~ | Ready |
| 116 | Tauri global shortcut | #115 | Blocked |
| 117 | Tauri window management | #115 | Blocked |
| 118 | ~~Empty state — no projects~~ | ~~#27~~ | Done |
| 119 | ~~Empty state — no workspaces~~ | ~~#42~~ | Done |
| 120 | ~~Empty state — no terminals~~ | ~~#63~~ | Done |
| 121 | ~~Loading state — workspace creation~~ | ~~#41~~ | Done |
| 122 | ~~Loading state — terminal spawning~~ | ~~#60~~ | Done |
| 123 | ~~Loading state — diff computation~~ | ~~#87~~ | Done |
| 124 | Terminal fidelity — opencode | ~~#60~~ | Ready |
| 125 | Terminal fidelity — claude | ~~#60~~ | Ready |
| 126 | Terminal fidelity — codex | ~~#60~~ | Ready |
| 127 | ~~Terminal scroll performance~~ | ~~#60~~ | Done |
| 131 | Theme consistency audit | ~~#90~~ | Ready |
| 134 | ~~Drag terminal from sidebar onto empty panel~~ | ~~#63~~, ~~#66~~ | Done |
