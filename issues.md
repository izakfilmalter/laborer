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

## ~~Issue 88: Diff viewer — accept/reject annotations~~ ✅ DONE

Added per-hunk accept/reject annotation buttons to the diff viewer using `diffAcceptRejectHunk` from `@pierre/diffs`. Hover over any diff line to see Accept (green, Check icon) and Reject (red, X icon) buttons. Accept keeps additions; reject keeps deletions. Both convert the hunk to context lines. State tracked per-file in component state, resets when underlying diff changes. Uses `enableHoverUtility` + `renderHoverUtility` from the `FileDiff` React component.

---

## ~~Issue 91: Diff viewer debounce/throttle for rapid changes~~ ✅ DONE

Added `useDebouncedValue` hook (300ms trailing-edge debounce with 500ms max wait) to the diff viewer. Raw diff content from LiveStore is debounced before reaching `parsePatchFiles` and `FileDiff` rendering. Rapid intermediate values are skipped entirely. Combined debounce pending + transition pending into a single "Updating..." indicator. Empty state uses un-debounced content to avoid flash. Generic hook in `hooks/use-debounced-value.ts` is reusable.

---

## ~~Issue 107: PRD-generated issues become tasks~~ ✅ DONE

### Parent PRD

PRD.md

### What to build

After `rlph prd` completes and creates issues (in Linear or GitHub), those issues should automatically appear as tasks in LiveStore. Monitor the rlph prd terminal output or poll the issue tracker for new issues.

Watched `rlph prd` terminals from the server after spawn, waited for terminal completion via the terminal-service event stream, fetched the terminal scrollback over the terminal WebSocket, parsed GitHub issue URLs and Linear issue keys from rlph output, and imported missing tasks into LiveStore with `source = "prd"`. Added parser/importer tests covering GitHub links, Linear keys, ANSI-stripped output, and duplicate externalId deduping.

### Blocked by

- Blocked by #94, #100

### User stories addressed

- User story 15

---

## ~~Issue 108: Linear task sourcing~~ ✅ DONE

### Parent PRD

PRD.md

### What to build

Implement fetching tasks from Linear's API based on the project's rlph configuration. Import Linear issues as tasks in LiveStore with source = "linear".

Added `LinearTaskImporter` on the server plus a new `task.importLinear` RPC endpoint. The importer resolves the project's Laborer config, reads the configured rlph TOML file (defaulting to `.rlph/config.toml`), extracts the Linear team/project/label settings, fetches eligible issues from Linear's GraphQL API, dedupes against existing Linear-sourced tasks, and creates new LiveStore tasks with `source = "linear"` and `externalId = identifier` (for example `ENG-123`). Missing config, missing API key, and Linear API failures all surface as typed `RpcError`s. Added integration tests covering successful import with duplicate skipping and Linear API error handling.

### Acceptance criteria

- [x] Fetch tasks from Linear API using project's rlph config
- [x] Tasks created in LiveStore with source = "linear" and externalId
- [x] Handle API errors gracefully
- [x] Tests: mock Linear API → tasks imported; API error → handled

### Blocked by

- Blocked by ~~#102~~

### User stories addressed

- User story 7

---

## ~~Issue 109: GitHub task sourcing~~ ✅ DONE

### Parent PRD

PRD.md

### What to build

Implement fetching issues from GitHub's API for the project's repository. Import GitHub issues as tasks in LiveStore with source = "github".

Added `GithubTaskImporter` on the server plus a new `task.importGithub` RPC endpoint. The importer resolves the repo's `remote.origin.url`, validates GitHub remotes (`git@github.com:owner/repo.git` and `https://github.com/owner/repo.git`), fetches open issues from the GitHub REST API, skips pull requests, dedupes against existing GitHub-sourced tasks, and creates new LiveStore tasks with `source = "github"` and `externalId = html_url`. API/network/remote errors surface as typed `RpcError`s. Added integration tests covering successful import, duplicate skipping, pull request filtering, and GitHub API failure handling.

### Blocked by

- Blocked by #102

### User stories addressed

- User story 7

---

## ~~Issue 110: Task source picker UI~~ ✅ DONE

### Parent PRD

PRD.md

### What to build

Create a UI component to select the task source: Linear, GitHub, or Manual. Selecting Linear or GitHub triggers a fetch from that source. Manual shows the create task form.

Added a task source picker above the task list with Manual, Linear, and GitHub tabs. Manual keeps the create-task dialog available, while Linear/GitHub selections auto-import tasks for the active project, expose a manual Sync action, and filter the task list to the selected source. Added helper tests covering source filtering and import gating.

### Acceptance criteria

- [x] Dropdown or tabs for source selection
- [x] Linear → fetches and displays Linear tasks
- [x] GitHub → fetches and displays GitHub issues
- [x] Manual → shows create task form
- [x] Tests: select source → correct tasks displayed; switch source → list updates

### Blocked by

- Blocked by ~~#108~~, ~~#109~~, ~~#103~~

### User stories addressed

- User story 7

---

## ~~Issue 113: Project switcher component~~ ✅ DONE

Created a project switcher Select dropdown at the top of the sidebar. Lists all registered projects plus an "All Projects" option (default). Selecting a specific project filters the Workspace and Task lists to show only items belonging to that project. Controlled component pattern with state lifted to `HomeComponent`. Auto-clears filter if the selected project is removed. Status counts in task tabs reflect the filtered project.

---

## ~~Issue 114: Cross-project workspace dashboard~~ ✅ DONE

Created a cross-project workspace dashboard with a view toggle in the panel header bar. Users switch between terminal panels and dashboard via Terminal/LayoutDashboard icon buttons. Dashboard shows a global overview section (aggregate workspace + task counts), and per-project sections with: project name/repo path, task summary counts (pending/in progress/completed/cancelled with color-coded icons), workspace/task count badges, and workspace rows with status badges, branch names, ports, and terminal counts. All data reactive via LiveStore queries.

---

## ~~Issue 115: Tauri system tray~~ ✅ DONE

Added system tray icon to the Tauri desktop shell. Tray shows app icon, tooltip with running workspace count (updated reactively from LiveStore via `useTrayWorkspaceCount` hook + `update_tray_workspace_count` Tauri command), right-click context menu with "Show Laborer" and "Quit" actions. Left-click brings window to front. Enabled `tray-icon` Cargo feature.

---

## ~~Issue 116: Tauri global shortcut~~ ✅ DONE

Registered a global keyboard shortcut (Cmd+Shift+L on macOS, Ctrl+Shift+L on Windows/Linux) via `tauri-plugin-global-shortcut` v2. Shortcut handler calls `focus_main_window` (extracted shared helper) to unminimize, show, and focus the main window from anywhere in the OS. Rust-side registration in `.setup()` — no frontend JavaScript changes needed. Extracted `focus_main_window` helper also refactored tray icon click and "Show Laborer" menu handlers to eliminate duplication.

---

## ~~Issue 117: Tauri window management~~ ✅ DONE

Implemented minimize-to-tray behavior and window state persistence. Closing the window hides it to the system tray instead of quitting (via `WindowEvent::CloseRequested` intercept with `api.prevent_close()` + `window.hide()`). Tray icon click restores the window. Window position, size, and maximized/fullscreen state persisted across restarts via `tauri-plugin-window-state`. Window starts hidden (`visible: false`) so plugin restores position before showing.

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

## ~~Issue 131: Theme consistency audit~~ ✅ DONE

Defined semantic CSS custom properties (`--success`, `--warning`, `--info`) in both light and dark modes, mapped to Tailwind via `@theme inline`. Replaced ~48 hard-coded Tailwind color scale references across 14 files with semantic tokens (`text-success`, `bg-warning/10`, `text-info`, etc.). Fixed `hsl()` color-space mismatch bug in sidebar.tsx, replaced `bg-[#09090b]` arbitrary hex with `bg-background`, replaced `bg-white` in slider with `bg-background`, replaced `bg-black/10` overlays with `bg-foreground/10`. All status indicators now use centralized theme tokens — no more `dark:` variant overrides needed.

---

## ~~Issue 134: Drag terminal from sidebar onto empty panel pane~~ ✅ DONE

Added drag-and-drop support using the native HTML5 Drag and Drop API. Terminal items in the sidebar are draggable (carrying `{ terminalId, workspaceId }` as JSON in a custom `application/x-laborer-terminal` MIME type). Empty panel panes (LeafNode with `paneType: "terminal"` and no terminalId) are drop targets. Drop calls `assignTerminalToPane(terminalId, workspaceId, paneId)` for targeted pane assignment. Visual feedback: `ring-2 ring-primary ring-inset bg-primary/5` highlight on valid drop targets during drag-over. Occupied panes reject drops (no `preventDefault` → "not allowed" cursor). Click-to-assign still works unchanged.

---

## ~~Issue 135: Terminal package scaffold~~ ✅ DONE

Created `@laborer/terminal` workspace package at `packages/terminal/` with Bun HTTP server entry point on `TERMINAL_PORT` (default 3001). Package includes `package.json`, `tsconfig.json`, `vitest.config.ts`, and `src/main.ts` with health check route. Added `TERMINAL_PORT` to `@laborer/env/server`. `turbo dev` discovers both server and terminal service as independent persistent tasks.

---

## ~~Issue 136: Move PTY Host + PtyHostClient to terminal package~~ ✅ DONE

Copied PTY Host (`pty-host.ts`), PtyHostClient (`services/pty-host-client.ts`), and RingBuffer (`lib/ring-buffer.ts`) from `@laborer/server` to `@laborer/terminal`. Wired `PtyHostClient.layer` into the terminal service's Effect layer tree. Added `node-pty` dependency to terminal package. Ported test files. Server originals remain until Issues #138-#143. Terminal: 46 tests pass. Server: 61 tests pass.

---

## ~~Issue 137: Terminal RPC contract~~ ✅ DONE

Defined `TerminalRpcs` RPC group in `@laborer/shared/rpc` with 7 endpoints (spawn, write, resize, kill, remove, restart, list). `TerminalInfo` response schema includes id, workspaceId, command, args, cwd, status. `TerminalRpcError` tagged error class for terminal-service-specific errors. All types compile and are importable from `@laborer/server` and `@laborer/terminal`.

---

## ~~Issue 138: Move + simplify TerminalManager~~ ✅ DONE

Moved TerminalManager from `@laborer/server` to `@laborer/terminal` with significant simplifications. Removed all LiveStore and WorkspaceProvider dependencies. `spawn()` accepts full payload (command, args, cwd, env, cols, rows, workspaceId). Stopped terminals retained in memory with config for restart. Lifecycle events emitted via `PubSub.unbounded<TerminalLifecycleEvent>()` (Spawned, StatusChanged, Exited, Removed, Restarted). All state in-memory via `Ref<Map<string, ManagedTerminal>>`. 9 integration tests, 55 total terminal package tests pass.

---

## ~~Issue 139: Terminal RPC handlers~~ ✅ DONE

Implemented `TerminalRpcsLive` handler layer in `packages/terminal/src/rpc/handlers.ts` for all 7 `TerminalRpcs` endpoints (spawn, write, resize, kill, remove, restart, list). Each handler delegates to `TerminalManager`. Wired into terminal service's `main.ts` at `POST /rpc` using `RpcServer.layerProtocolHttp` + `RpcSerialization.layerJson`. Added `TerminalManager.layer` to the layer tree. `toTerminalInfo` helper maps TerminalRecord to TerminalInfo schema. 55 terminal tests + 61 server tests pass.

---

## ~~Issue 140: Move terminal WebSocket route to terminal package~~ ✅ DONE

Moved `terminal-ws.ts` from `@laborer/server` to `@laborer/terminal` and wired into the terminal service's layer tree at `GET /terminal?id=...`. Extended the WebSocket protocol with three status control messages: `{"type":"status","status":"running"}` on connect, `{"type":"status","status":"stopped","exitCode":N}` on PTY exit, `{"type":"status","status":"restarted"}` on restart. Uses `PubSub.subscribe` + `Effect.forkScoped` for scope-managed lifecycle event consumption. Existing PTY I/O and flow control unchanged.

---

## Issue 141: Update Vite proxy + web app WebSocket hook

### Parent PRD

PRD-terminal-extraction.md

### What to build

Update the web app to connect terminal WebSockets directly to the terminal service. Update `vite.config.ts` to proxy `/terminal` to `TERMINAL_PORT` instead of the server port. Update `use-terminal-websocket.ts` to parse incoming control messages (`{"type":"status",...}`) and expose the terminal's derived status (running/stopped/restarted) to consumers. Update `terminal-pane.tsx` to use the WebSocket-derived status instead of the LiveStore `queryDb(terminals)` query for determining `isRunning`, showing the "Process exited" banner, and clearing the xterm.js buffer on restart. The LiveStore query can remain temporarily (removed in Issue #144) but should no longer drive these UI decisions.

### Acceptance criteria

- [x] Vite proxy routes `/terminal` WebSocket to `TERMINAL_PORT`
- [x] `use-terminal-websocket.ts` parses `{"type":"status",...}` control messages
- [x] Hook exposes `terminalStatus: "running" | "stopped" | "restarted"` alongside connection status
- [x] `terminal-pane.tsx` uses WebSocket-derived status for isRunning, exit banner, restart buffer clear
- [x] Terminal pane connects directly to terminal service (verified via network inspector)
- [x] Flow control ack frames still work correctly

### Blocked by

- ~~Blocked by #140~~

### User stories addressed

- User story 6, 15, 21

### Status: Done

Updated `vite.config.ts` to proxy `/terminal` to `localhost:3001` (terminal service). Rewrote `use-terminal-websocket.ts` to parse JSON status control messages and expose `terminalStatus` state, removing the `isRunning` prop. Updated `terminal-pane.tsx` to derive `isRunning` from WebSocket-derived status and removed LiveStore `queryDb(terminals)` dependency for terminal status decisions.

---

## Issue 142: Terminal event stream RPC

### Parent PRD

PRD-terminal-extraction.md

### What to build

Add a streaming RPC endpoint `terminal.events()` to the terminal service that pushes terminal lifecycle events to subscribers. The TerminalManager's internal `PubSub` (added in Issue #138) feeds this stream. Events include: `spawned` (with terminal info), `statusChanged` (with id and new status), `exited` (with id and exit code), `removed` (with id), and `restarted` (with id). Use Effect RPC's streaming capabilities (Effect.Stream) for the endpoint. Add the `terminal.events` RPC definition to the `TerminalRpcs` contract in `@laborer/shared`.

### Acceptance criteria

- [x] `terminal.events` streaming RPC is defined in the shared contract
- [x] Terminal service exposes the streaming endpoint
- [x] Subscribing to the stream and spawning a terminal yields a "spawned" event
- [x] Killing a terminal yields "exited" and "statusChanged" events
- [x] Restarting a terminal yields a "restarted" event
- [x] Removing a terminal yields a "removed" event
- [x] Multiple subscribers receive the same events independently

### Blocked by

- Blocked by ~~#139~~

### User stories addressed

- User story 8

---

## Issue 143: Server TerminalClient + remove server terminal modules

### Parent PRD

PRD-terminal-extraction.md

### What to build

Add a `TerminalClient` Effect service to `@laborer/server` that acts as an RPC client connecting to the terminal service at `http://localhost:${TERMINAL_PORT}`. Subscribe to `terminal.events()` on startup to track which terminal IDs belong to which workspace (maintaining an in-memory workspace->terminal ID map). Update the server's `main.ts` layer tree: remove `PtyHostClient.layer`, `TerminalManager.layer`, and `TerminalWsRouteLive`; add `TerminalClient.layer`. Update server RPC handlers so that `rlph.startLoop`, `rlph.writePRD`, `rlph.review`, and `rlph.fix` delegate terminal spawning to `TerminalClient`. Implement `killAllForWorkspace` by iterating tracked terminal IDs and calling `TerminalClient.kill()` for each. Remove `node-pty` from server's `package.json`. The server should log a warning and retry if the terminal service is unreachable on startup, not crash.

### Acceptance criteria

- [x] `TerminalClient` Effect service exists in the server package
- [x] Server connects to terminal service via Effect RPC HTTP client
- [x] Server subscribes to `terminal.events()` and tracks workspace->terminal mapping
- [x] Server `main.ts` no longer includes PtyHostClient, TerminalManager, or TerminalWsRoute layers
- [x] rlph commands (startLoop, writePRD, review, fix) spawn terminals through the terminal service
- [x] `killAllForWorkspace` kills terminals via TerminalClient
- [x] `node-pty` is removed from server's package.json
- [x] Server starts gracefully even if terminal service is temporarily unreachable

### Blocked by

- Blocked by ~~#142~~

### User stories addressed

- User story 12, 20

---

## ~~Issue 144: Web app LiveStore terminal query replacement~~ ✅ DONE

Replaced all `queryDb(terminals, ...)` LiveStore subscriptions in `terminal-list.tsx`, `workspace-dashboard.tsx`, and `routes/index.tsx` with the `useTerminalList()` polling hook that fetches from the terminal service via `terminal.list` RPC. Added `/terminal-rpc` Vite proxy rule rewriting to `/rpc` on port 3001. Removed `ptySessionRef` from `TerminalItemProps` (not in `TerminalInfo` type). `terminal-pane.tsx` `v1.TerminalRestarted` listener was already removed in Issue #141. Terminal list updates reactively via 2-second polling.

---

## ~~Issue 145: LiveStore terminal schema deprecation~~ ✅ DONE

### Parent PRD

PRD-terminal-extraction.md

### What to build

Deprecate all terminal-related events and remove the `terminals` table from the active LiveStore schema. Convert materializers for `v1.TerminalSpawned`, `v1.TerminalStatusChanged`, `v1.TerminalKilled`, `v1.TerminalRemoved`, and `v1.TerminalRestarted` to no-ops (following the existing pattern used for `v1.TerminalOutput`). Remove the `terminals` table definition from the schema's state tables. Remove any remaining terminal event commits from server code (if any survived Issue #143). Existing eventlogs containing these events must still load without errors — the no-op materializers ensure backward compatibility.

### Acceptance criteria

- [x] All terminal event materializers are no-ops (return empty arrays)
- [x] `terminals` table is removed from the active schema state
- [x] No code commits terminal events to LiveStore anywhere in the codebase
- [x] App starts cleanly with existing eventlogs that contain old terminal events
- [x] No `queryDb(terminals, ...)` calls exist anywhere in the codebase
- [x] `v1.TerminalOutput` no-op pattern is followed for all deprecated events

Removed remaining terminal event commits from legacy server modules and tests (`packages/server/src/services/terminal-manager.ts`, `packages/server/test/terminal-manager.test.ts`). Added legacy terminal-table query guards so deprecated modules don't throw when `terminals` is absent from active state. Verified server startup against existing persisted eventlogs: LiveStore restores state and the server reaches `Listening on http://localhost:3000` without terminal-event materialization failures.

### Blocked by

- ~~Blocked by #144~~

### User stories addressed

- User story 14

---

## Issue 146: Grace period reconnection + orphan detection

### Status: Done

### Parent PRD

PRD-terminal-extraction.md

### What to build

Add a configurable grace period timer to the terminal service's `TerminalManager` (default 60 seconds, configurable via `TERMINAL_GRACE_PERIOD_MS` env var). When a terminal's last WebSocket subscriber disconnects, start the grace timer. If a new WebSocket subscriber connects within the grace period, cancel the timer and replay the ring buffer for seamless reconnection. If the grace period expires with no subscribers, kill the terminal. Also handle orphaned spawns: if a terminal is spawned via RPC but no WebSocket subscriber connects within the grace period, kill it. Add tests for grace period behavior (survive within window, cleanup after expiry).

### Acceptance criteria

- [x] Grace period timer starts when last WebSocket subscriber disconnects
- [x] Reconnecting within the grace period cancels the timer and replays ring buffer
- [x] Terminal is killed after grace period expires with no subscribers
- [x] Spawned terminals with no WebSocket subscriber within grace period are killed
- [x] Grace period is configurable via `TERMINAL_GRACE_PERIOD_MS` env var (default 60s)
- [x] Terminals survive server restarts during development (grace period covers the restart window)
- [x] Grace period tests pass (survive within window, cleanup after expiry)

### Blocked by

- ~~Blocked by #140~~

### User stories addressed

- User story 1, 9, 10

Added grace-period lifecycle management to `TerminalManager`: orphan timers now start on spawn, disconnect timers start when the last WebSocket subscriber leaves, reconnects cancel pending timers, and expired timers kill still-running terminals with no subscribers. Added `TERMINAL_GRACE_PERIOD_MS` env validation (default `60000`) and three integration tests covering orphan cleanup, reconnect-within-window survival, and disconnect-expiry cleanup.

---

## Issue 147: Terminal extraction polish + integration verification

### Parent PRD

PRD-terminal-extraction.md

### What to build

End-to-end verification and polish pass for the full terminal service extraction. Verify keystroke-to-output latency is not degraded (still under 50ms). Verify `turbo dev` starts both server and terminal service reliably as independent processes. Verify that editing server code restarts only the server — terminal service and all running terminals are unaffected. Verify the terminal service's `--watch` mode only reacts to changes within `packages/terminal/`. Verify graceful shutdown of the terminal service kills all PTY processes and the PTY Host child process. Verify the web app shows a clear "Terminal service unavailable" error if the terminal service is unreachable. Verify cross-tab terminal state consistency (multiple browser tabs see the same terminal list). Verify the `dotenv -e ../../.env.local` pattern works for both services.

### Acceptance criteria

- [ ] Keystroke-to-output latency < 50ms (no regression from RPC hop)
- [ ] `turbo dev` starts both services; server restart does not restart terminal service
- [ ] Terminal service `--watch` only triggers on terminal package file changes
- [ ] Graceful shutdown kills all PTYs without orphans
- [ ] Web app shows "Terminal service unavailable" when terminal service is down
- [ ] Multiple browser tabs show consistent terminal state
- [ ] `.env.local` loads correctly for both server and terminal service
- [ ] Ring buffer replay on reconnection works correctly (no missing output)
- [ ] All terminal UI states render correctly: loading, connected, disconnected, exited, restarting

### Blocked by

- ~~Blocked by #144, #145, #146~~

### User stories addressed

- Polishing requirements 1-12

---

## ~~Issue 148: Focused pane border fix~~ ✅ DONE

Replaced the glitched `ring-2 ring-primary ring-inset` active pane indicator with a solid `border-2 border-primary` on the focused pane. Non-active panes get `border-2 border-transparent` to maintain consistent sizing and prevent layout shift when focus changes. Drag-over drop target highlight also uses border instead of ring. Extracted border class computation via `if/else if` to satisfy Biome's `noNestedTernary` rule.

---

## ~~Issue 149: Focus auto-transfer on pane close~~ ✅ DONE

Added `findSiblingPaneId(root, paneId)` utility to `layout-utils.ts` that resolves the nearest sibling leaf before `closePane()` mutates the tree. Uses existing `findParent` and `getEdgeLeaf` helpers. Updated `handleClosePane` in `routes/index.tsx` to compute the sibling before closing, then set `activePaneId` to the sibling (or null if last pane). Only transfers focus when the closing pane IS the active pane. Created web app test infrastructure (vitest.config.ts, test/ directory) with 17 unit tests covering all edge cases.

---

## Issue 150: Guaranteed active pane invariant

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

Enforce the invariant: "there is always exactly one focused pane when at least one pane exists." On initial layout seed, set `activePaneId` to the first leaf pane ID. On layout restore from LiveStore persistence, validate that `activePaneId` points to an existing leaf; if not, fall back to the first leaf. The `handleSetActivePaneId` function should not accept `null` when panes exist. After any close operation that leaves panes remaining, verify `activePaneId` is valid (defense-in-depth on top of Issue #149's auto-transfer).

### Acceptance criteria

- [ ] Initial layout seed sets `activePaneId` to the first leaf pane ID
- [ ] Layout restore with stale `activePaneId` (pointing to removed pane) falls back to first leaf
- [ ] Layout restore with valid `activePaneId` preserves it
- [ ] After any close operation with remaining panes, `activePaneId` is a valid leaf ID
- [ ] `activePaneId` is `null` only when zero panes exist
- [ ] Tests: seed layout → activePaneId set; restore with stale ID → falls back

### Blocked by

- Blocked by #149

### User stories addressed

- User story 5

---

## ~~Issue 151: Cmd+W shortcut — close active pane~~ ✅ DONE

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

Register Cmd+W (Meta+W) as a direct keyboard shortcut that closes the currently focused pane. Three layers of work:

1. **Tauri interception**: Prevent Cmd+W from reaching the native `CloseRequested` handler. Try the web-layer approach first: add a `window.addEventListener("keydown")` listener that catches Meta+W and calls `event.preventDefault()`. If Tauri still fires `CloseRequested`, fall back to registering Cmd+W via `tauri-plugin-global-shortcut` on the Rust side and emitting a Tauri event to the webview.

2. **React hotkey**: Register Meta+W using `@tanstack/react-hotkeys` (single-key shortcut, not prefix sequence). Handler calls `actions.closePane(activePaneId)` when a pane is focused.

3. **xterm.js passthrough**: Update the terminal's `attachCustomKeyEventHandler` to detect Meta+W and return `false`, preventing xterm.js from consuming it so it bubbles to the document-level hotkey handler. Follow the existing pattern used for Ctrl+B prefix mode.

The existing Ctrl+B, X shortcut remains unchanged.

Implemented direct Cmd+W close-pane behavior in the panel hotkey layer using `Meta+W`, plus a window-level keydown preventDefault guard so the shortcut closes panes instead of triggering native window close. Updated xterm.js custom key handler to pass through Cmd+W when terminal has focus, preserving existing Ctrl+B prefix shortcuts.

### Blocked by

- Blocked by #149

### User stories addressed

- User story 1, 9, 10, 11

---

## ~~Issue 152: Cmd+W close-app confirmation dialog~~ ✅ DONE

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

When Cmd+W is pressed and no panes exist, show an AlertDialog asking "Close Laborer?" instead of silently doing nothing. The dialog uses the existing `alert-dialog.tsx` component with controlled `open` state (no trigger button — opened programmatically from the Cmd+W handler). Title: "Close Laborer?". Description: "The window will be hidden to the system tray. Your workspaces will continue running." Actions: "Cancel" (dismisses dialog) and "Close" (hides window to tray via Tauri window API). Follow the existing destructive confirmation pattern used by project removal, workspace destruction, and task removal dialogs.

Added a controlled close-app `AlertDialog` opened programmatically from the Cmd+W hotkey path when no active pane exists. The dialog uses the exact copy from the PRD, supports Escape and Cancel dismissal, and the Close action hides the Tauri window to the system tray via `@tauri-apps/api/window`. Ctrl+B, X behavior is unchanged and does not trigger the dialog.

### Acceptance criteria

- [x] Cmd+W with no panes opens the close-app AlertDialog
- [x] Dialog shows title "Close Laborer?" and descriptive text about tray behavior
- [x] "Cancel" button dismisses the dialog without hiding the window
- [x] "Close" button hides the window to the system tray
- [x] Escape key dismisses the dialog
- [x] Dialog does not appear when at least one pane exists
- [x] Ctrl+B, X with no panes does NOT trigger the dialog (only Cmd+W does)

### Blocked by

- ~~Blocked by #151~~

### User stories addressed

- User story 6, 7, 8

---

## Issue 153: Cmd+W close panel — polish & verification

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

End-to-end verification and polish pass for the full Cmd+W close panel feature. Verify all polishing requirements from the PRD across the complete integration.

### Acceptance criteria

- [ ] Border renders correctly at all split nesting depths (1 through 5+)
- [ ] Border does not overlap or conflict with ResizableHandle drag handles
- [ ] Cmd+W works after multiple rapid presses (closing several panes in succession)
- [ ] Close-app AlertDialog can be dismissed with Escape or clicking Cancel
- [ ] Close-app AlertDialog does not appear when there is at least one pane
- [ ] Focus auto-transfer works when closing the only child in a nested split (tree collapse scenario)
- [ ] Border disappears when no panes exist (empty layout state)
- [ ] Drag-over drop target highlight still works correctly on empty panes alongside the new border style
- [ ] Cmd+W does not interfere with Cmd+W in web inspector or dev tools when they are focused
- [ ] Active pane border does not flicker during layout transitions (split, close, resize)

### Blocked by

- Blocked by ~~#148~~, ~~#149~~, ~~#150~~, ~~#151~~, ~~#152~~

### User stories addressed

- Polishing requirements 1-9

---

## ~~Issue 154: Config Service — resolve config with walk-up + global default~~ ✅ DONE

Created `ConfigService` Effect tagged service in `packages/server/src/services/config-service.ts` with `resolveConfig(projectRepoPath, projectName)` and `readGlobalConfig()` methods. Walk-up directory resolution from project root through ancestors to global `~/.config/laborer/laborer.json`. Closest-wins merge with provenance metadata per field. Tilde expansion, malformed JSON handling (logged, skipped), auto-creation of `~/.config/laborer/`. 28 integration tests covering all resolution scenarios.

---

## ~~Issue 155: Config Service — write project config~~ ✅ DONE

### Parent PRD

PRD-global-worktree-config.md

Added `writeProjectConfig(projectRepoPath, updates)` to `ConfigService`. The method reads existing project-level `laborer.json` as a raw object, merges only explicitly provided fields, preserves unknown fields for round-trip safety, and writes atomically via temp file + rename. Also added integration tests covering file creation, non-clobbering merge behavior, unknown field preservation, and explicit `undefined` update handling.

---

## ~~Issue 156: WorkspaceProvider — use ConfigService for worktree path + setup scripts~~ ✅ DONE

### Parent PRD

PRD-global-worktree-config.md

### What to build

Wire the `ConfigService` (Issue #154) into `WorkspaceProvider` to replace the hardcoded worktree directory and the old config reader. Remove the `WORKTREE_DIR` constant (currently `.worktrees`), the `readProjectConfig` function, the `LaborerConfig` interface, and the `CONFIG_FILE` constant from `workspace-provider.ts`. The worktree path computation changes from `resolve(project.repoPath, ".worktrees", slug)` to `resolve(resolvedConfig.worktreeDir, slug)` where `resolvedConfig.worktreeDir` is an absolute path with `~` already expanded. Setup scripts are read from the resolved config's `setupScripts` field. Rename all remaining `.laborer.json` references in the codebase to `laborer.json`.

### Acceptance criteria

- [x] `WORKTREE_DIR` constant, `readProjectConfig`, `LaborerConfig`, and `CONFIG_FILE` are removed from workspace-provider.ts
- [x] WorkspaceProvider depends on ConfigService for worktree directory resolution
- [x] Worktree path is `<resolvedConfig.worktreeDir>/<branchSlug>` (not `<repoPath>/.worktrees/<branchSlug>`)
- [x] Setup scripts are read from ConfigService resolved config
- [x] All `.laborer.json` references in runtime code are renamed to `laborer.json`
- [x] ConfigService is added to WorkspaceProvider's layer dependencies
- [x] Tests verify worktree creation uses the resolved config path
- [x] Tests verify setup scripts come from the resolved config

### Blocked by

- ~~Blocked by #154~~

### User stories addressed

- User story 1, 2, 5, 11, 13

---

## ~~Issue 157: Config RPC endpoints + project settings modal~~ ✅ DONE

Added `config.get` + `config.update` RPC methods (shared contract + server handlers) and shipped a new `ProjectSettingsModal` (gear icon on each project card) for editing worktree directory, setup scripts, and rlph config with per-field provenance labels and save toasts.

### Parent PRD

PRD-global-worktree-config.md

### What to build

Add two new RPC endpoints to the `LaborerRpcs` group and build a project settings modal in the frontend.

**RPC layer**: Add `config.get` (payload: `{ projectId: string }`, returns resolved config with provenance) and `config.update` (payload: `{ projectId: string, config: { worktreeDir?: string, setupScripts?: string[], rlphConfig?: string } }`) to the shared RPC definitions. Implement server handlers that look up the project via `ProjectRegistry.getProject`, then delegate to `ConfigService.resolveConfig` and `ConfigService.writeProjectConfig` respectively.

**Frontend**: Build a `ProjectSettingsModal` component using the existing `Dialog` primitive. Entry point is a gear icon (`Settings` from lucide-react) on each project card in `ProjectList`, placed next to the existing delete icon. On open, fetches resolved config via `config.get` RPC query. Form fields:
- **Worktree directory**: text input with resolved path, placeholder showing default, helper text showing provenance
- **Setup scripts**: editable list of strings with add/remove buttons per entry
- **rlph config**: text input

Save button calls `config.update` mutation with only changed fields. Toast notification on success/failure. Uses the standard `LaborerClient.mutation` / `useAtomSet` pattern.

### Acceptance criteria

- [x] `config.get` RPC defined in shared contract with provenance in response schema
- [x] `config.update` RPC defined in shared contract with partial config payload
- [x] Server handlers for both RPCs delegate to ConfigService via ProjectRegistry
- [x] `config.get` returns error for non-existent project
- [x] `config.update` returns error for non-existent project
- [x] Gear icon appears on each project card next to the delete icon
- [x] Clicking gear icon opens the settings modal
- [x] Modal displays resolved config values fetched via `config.get`
- [x] Provenance labels show which file each value comes from
- [x] Worktree directory field is editable with placeholder showing default
- [x] Setup scripts field is an editable list with add/remove functionality
- [x] rlph config field is editable
- [x] Save writes changed fields via `config.update` RPC
- [x] Toast confirms successful save or shows error

### Blocked by

- ~~Blocked by #155, #156~~

### User stories addressed

- User story 7, 8, 9, 10, 11, 12

---

## Issue 158: Config + settings polish & edge cases

### Status: In Progress

### Parent PRD

PRD-global-worktree-config.md

### What to build

Polish pass and edge case handling for the full config system and settings modal. Verify and fix:

- `~/.config/laborer/` auto-creation works on first launch (no prior config exists)
- Tilde expansion works correctly on macOS and Linux
- Config is re-read on each worktree creation (not cached between creates)
- Settings modal has proper ARIA attributes and keyboard navigation (tab between fields, Enter to save, Escape to cancel)
- Gear icon visual balance with existing delete icon (spacing, alignment, visual weight)
- Provenance display is subtle (secondary text or tooltip, not prominent)
- Setup scripts editor handles edge cases: empty list, scripts with special characters, very long commands
- Error messages from config parse failures are user-friendly
- Name collision scenario: two projects with same name share worktree base dir gracefully

Add tests: RPC handler tests for `config.get` and `config.update` error paths. Frontend component tests for the settings modal (opens on click, displays values, save triggers RPC, toasts on success/failure).

### Acceptance criteria

- [ ] Auto-creation of `~/.config/laborer/` works on clean machine (no prior config)
- [ ] `~` expansion produces correct absolute path on macOS and Linux
- [ ] Config is not cached between worktree creations (fresh read each time)
- [x] Modal form fields have proper labels and ARIA attributes
- [x] Keyboard navigation works: Tab between fields, Enter to save, Escape to cancel
- [ ] Gear icon spacing and alignment is visually balanced with delete icon
- [ ] Provenance text is visually subtle (secondary color, smaller text)
- [x] Setup scripts: empty list saves correctly, special characters preserved, long commands don't break layout
- [ ] Malformed config file shows user-friendly error message in toast
- [ ] RPC handler tests cover error paths (non-existent project, malformed input)
- [ ] Frontend component tests cover modal open, display, save, and toast behaviors

### Blocked by

- ~~Blocked by #157~~

### User stories addressed

- User story 6, 16, 17, 18

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
| 88 | ~~Diff viewer — accept/reject annotations~~ | ~~#87~~ | Done |
| 91 | ~~Diff viewer debounce/throttle~~ | ~~#89~~ | Done |
| 107 | ~~PRD-generated issues → tasks~~ | ~~#94~~, ~~#100~~ | Done |
| 108 | ~~Linear task sourcing~~ | ~~#102~~ | Done |
| 109 | ~~GitHub task sourcing~~ | ~~#102~~ | Done |
| 110 | ~~Task source picker UI~~ | ~~#108~~, ~~#109~~, ~~#103~~ | Done |
| 113 | ~~Project switcher~~ | ~~#26~~ | Done |
| 114 | ~~Cross-project dashboard~~ | ~~#41~~, ~~#104~~ | Done |
| 115 | ~~Tauri system tray~~ | ~~#41~~ | Done |
| 116 | ~~Tauri global shortcut~~ | ~~#115~~ | Done |
| 117 | ~~Tauri window management~~ | ~~#115~~ | Done |
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
| 131 | ~~Theme consistency audit~~ | ~~#90~~ | Done |
| 134 | ~~Drag terminal from sidebar onto empty panel~~ | ~~#63~~, ~~#66~~ | Done |
| 135 | ~~Terminal package scaffold~~ | ~~None~~ | Done |
| 136 | ~~Move PTY Host + PtyHostClient to terminal package~~ | ~~#135~~ | Done |
| 137 | ~~Terminal RPC contract~~ | ~~None~~ | Done |
| 138 | ~~Move + simplify TerminalManager~~ | ~~#136~~ | Done |
| 139 | ~~Terminal RPC handlers~~ | ~~#137~~, ~~#138~~ | Done |
| 140 | ~~Move terminal WebSocket route to terminal package~~ | ~~#139~~ | Done |
| 141 | ~~Update Vite proxy + web app WebSocket hook~~ | ~~#140~~ | Done |
| 142 | ~~Terminal event stream RPC~~ | ~~#139~~ | Done |
| 143 | ~~Server TerminalClient + remove server terminal modules~~ | ~~#142~~ | Done |
| 144 | ~~Web app LiveStore terminal query replacement~~ | ~~#141~~, ~~#143~~ | Done |
| 145 | ~~LiveStore terminal schema deprecation~~ | ~~#144~~ | Done |
| 146 | ~~Grace period reconnection + orphan detection~~ | ~~#140~~ | Done |
| 147 | Terminal extraction polish + integration verification | ~~#144~~, ~~#145~~, ~~#146~~ | Ready |
| 148 | ~~Focused pane border fix~~ | ~~None~~ | Done |
| 149 | ~~Focus auto-transfer on pane close~~ | ~~None~~ | Done |
| 150 | ~~Guaranteed active pane invariant~~ | ~~#149~~ | Done |
| 151 | ~~Cmd+W shortcut — close active pane~~ | ~~#149~~ | Done |
| 152 | ~~Cmd+W close-app confirmation dialog~~ | ~~#151~~ | Done |
| 153 | Cmd+W close panel — polish & verification | ~~#148~~, ~~#149~~, ~~#150~~, ~~#151~~, ~~#152~~ | Ready |
| 154 | ~~Config Service — resolve config with walk-up + global default~~ | ~~None~~ | Done |
| 155 | ~~Config Service — write project config~~ | ~~#154~~ | Done |
| 156 | ~~WorkspaceProvider — use ConfigService for worktree path + setup scripts~~ | ~~#154~~ | Done |
| 157 | ~~Config RPC endpoints + project settings modal~~ | ~~#155~~, ~~#156~~ | Done |
| 158 | Config + settings polish & edge cases | ~~#157~~ | In Progress |
| 159 | ~~WorktreeDetector + schema origin + initial detection on project add~~ | ~~None~~ | Done |
| 160 | ~~UI for detected workspaces~~ | ~~#159~~ | Done |
| 161 | ~~Live filesystem watcher + server boot reconciliation~~ | ~~#159~~ | Done |
| 162 | ~~Origin-aware destroy behavior~~ | ~~#160~~ | Done |
| 163 | Worktree detection polish & edge cases | #161, #162 | Blocked |
| 164 | Sidebar max-width removal | None | Ready |
| 165 | Workspace card two-row header + text clamping | None | Ready |
| 166 | Detected worktree feature parity | None | Ready |
| 167 | Sidebar & workspace card polish | #164, #165, #166 | Blocked |

---

## Issue 159: WorktreeDetector + schema origin + initial detection on project add

### Status: Done

### Parent PRD

PRD-worktree-detection.md

### What to build

This is the foundational tracer bullet for worktree detection. Build the end-to-end path from adding a project to having workspace records appear in LiveStore for all existing git worktrees.

**Schema changes**: Add an `origin` column (text, default `"laborer"`) to the `workspaces` table. Add `origin` as an optional field on the `v1.WorkspaceCreated` event schema with `Schema.optionalWith(Schema.String, { default: () => "laborer" })` for backward compatibility. Add `WorkspaceOrigin` literal type (`"laborer" | "external"`) to `types.ts` and add `origin: WorkspaceOrigin` to the `Workspace` class.

**WorktreeDetector service**: New Effect tagged service (`@laborer/WorktreeDetector`) with a single `detect(repoPath)` method. Runs `git worktree list --porcelain`, parses the output into `DetectedWorktree[]` records (path, head, branch, isMain). Handles detached HEAD (branch = null), excludes prunable worktrees. No LiveStore dependency — pure git interaction. See "WorktreeDetector service" section in PRD for full parsing details.

**WorktreeReconciler service**: New Effect tagged service (`@laborer/WorktreeReconciler`) with a `reconcile(projectId, repoPath)` method. Calls WorktreeDetector.detect, queries existing workspace records from LiveStore, diffs by worktreePath. Creates `workspaceCreated` events for new worktrees (status `"stopped"`, port `0`, origin `"external"`, base SHA derived via `git merge-base`). Removes stale workspace records via `workspaceDestroyed` (freeing ports if allocated). Determines default branch via `git symbolic-ref refs/remotes/origin/HEAD` with fallback to main/master. See "WorktreeReconciler service" section in PRD for full reconciliation logic.

**ProjectRegistry integration**: After `addProject` commits the `projectCreated` event, call `WorktreeReconciler.reconcile()` so that by the time the RPC response is returned, all existing worktrees have workspace records.

**Tests**: WorktreeDetector tests with real temporary git repos (no linked worktrees, one linked, multiple linked, detached HEAD, prunable exclusion). WorktreeReconciler tests with in-memory LiveStore (fresh project creates records, existing records matched by path, stale records removed, mixed scenario, base SHA derivation, port=0 for detected). ProjectRegistry integration tests (addProject with worktrees creates records, addProject with no worktrees creates main worktree record). Follow existing test patterns from `workspace-validation.test.ts` and `terminal-manager.test.ts`.

### Acceptance criteria

- [x] `origin` column added to `workspaces` table with default `"laborer"`
- [x] `v1.WorkspaceCreated` event schema includes optional `origin` field (backward compatible)
- [x] `WorkspaceOrigin` type and `Workspace.origin` field added to types.ts
- [x] `WorktreeDetector.detect(repoPath)` returns correct `DetectedWorktree[]` for repos with 0, 1, and multiple linked worktrees
- [x] Main worktree is included in detection results with `isMain: true`
- [x] Detached HEAD worktrees return `branch: null`
- [x] Prunable worktrees are excluded from results
- [x] `WorktreeReconciler.reconcile()` creates workspace records for detected worktrees not in LiveStore
- [x] Created records have status `"stopped"`, port `0`, origin `"external"`
- [x] Base SHA derived via `git merge-base` against default branch, falling back to HEAD
- [x] `WorktreeReconciler.reconcile()` removes stale workspace records (worktree no longer on disk)
- [x] Existing workspace records matching by worktree path are left untouched
- [x] `addProject` triggers initial reconciliation before returning the RPC response
- [x] WorktreeDetector tests pass (8+ scenarios with real git repos)
- [x] WorktreeReconciler tests pass (6+ scenarios with in-memory LiveStore)
- [x] ProjectRegistry integration tests pass

### Blocked by

None - can start immediately

### User stories addressed

- User story 1, 2, 3, 7, 8, 12, 13, 15

---

## ~~Issue 160: UI for detected workspaces~~ ✅ DONE

### Parent PRD

PRD-worktree-detection.md

### What to build

Update the frontend workspace list and project cards to render detected (external) workspaces correctly. This slice makes the backend work from Issue #159 visible to the user.

**Workspace card changes**: When a workspace has `origin: "external"`, display a subtle "Detected" badge or secondary label on the card (similar visual weight to how branch names are displayed — monospace, muted color). When `port` is `0`, hide the port display entirely rather than showing "Port: 0". The existing status badge system already handles `"stopped"` status — verify it renders correctly for detected workspaces.

**Project card workspace count**: The workspace count badge on project cards in the sidebar should include detected workspaces in the count. Verify the existing LiveStore query already counts them (it should, since they're in the same `workspaces` table).

**Workspace dashboard**: The cross-project dashboard should include detected workspaces in its per-project workspace rows. Verify port display is hidden when port is `0`.

**Types**: Import and use the new `WorkspaceOrigin` type from `@laborer/shared/types` in frontend components.

### Acceptance criteria

- [x] Workspace cards for `origin: "external"` display a "Detected" indicator (badge or secondary text)
- [x] Workspace cards for `origin: "laborer"` do not display any origin indicator (it's the default)
- [x] Port display is hidden when port is `0`
- [x] Workspace count badge on project cards includes detected workspaces
- [x] Cross-project dashboard shows detected workspaces in workspace rows
- [x] Dashboard hides port when port is `0`
- [x] Stopped status badge renders correctly for detected workspaces
- [x] No visual regression for existing Laborer-created workspaces

### Blocked by

- ~~Blocked by #159~~

### User stories addressed

- User story 3, 9

### Status: Done

Workspace cards now show a subtle monospace "Detected" indicator for external workspaces, while Laborer-created workspaces remain unchanged. Port metadata is hidden whenever `port` is `0` in both workspace cards and dashboard rows, and detected workspaces are included in existing workspace counts and status rendering.

---

## ~~Issue 161: Live filesystem watcher + server boot reconciliation~~ ✅ DONE

### Parent PRD

PRD-worktree-detection.md

### What to build

Build the WorktreeWatcher service that keeps workspace records in sync with actual worktrees on disk, and wire it into the server boot sequence.

**WorktreeWatcher service**: New Effect tagged service (`@laborer/WorktreeWatcher`) with three methods: `watchProject(projectId, repoPath)`, `unwatchProject(projectId)`, and `watchAll()`. Uses Bun/Node `fs.watch` on `.git/worktrees/` for each project. Debounces filesystem events with 500ms delay to coalesce rapid changes. On each debounced trigger, calls `WorktreeReconciler.reconcile()`. Handles `.git/worktrees/` not existing yet by watching `.git/` for creation of the `worktrees` subdirectory. Wraps watchers in Effect `Scope` for automatic teardown. Logs warnings on watcher errors but continues monitoring. See "WorktreeWatcher service" section in PRD for full details.

**ProjectRegistry integration**: After `addProject` completes initial detection (Issue #159), call `WorktreeWatcher.watchProject()` to start live watching. Before `removeProject` commits `projectRemoved`, call `WorktreeWatcher.unwatchProject()` to stop the watcher. Add `WorktreeWatcher` as a dependency of `ProjectRegistry`.

**Server boot integration**: On server startup after LaborerStore is built, call `WorktreeWatcher.watchAll()` which queries all registered projects and starts watching each one. This also runs an initial reconciliation pass per project to catch worktree changes that happened while the server was offline.

**Auto-removal**: When a worktree disappears from `git worktree list` output, the reconciler (from Issue #159) already handles removal. Verify that port is freed and workspace record is destroyed for auto-removed worktrees.

**Tests**: WorktreeWatcher tests with real git repos (watch + add worktree triggers reconciliation, watch + remove worktree triggers reconciliation, unwatch stops further reconciliation, watchAll starts watchers for all projects, debounce coalesces rapid changes, handles missing .git/worktrees/ directory). Follow `terminal-manager.test.ts` patterns for Effect scope cleanup.

### Acceptance criteria

- [x] `WorktreeWatcher.watchProject()` starts filesystem watching on `.git/worktrees/`
- [x] Adding a worktree via `git worktree add` triggers reconciliation and creates a workspace record
- [x] Removing a worktree via `git worktree remove` triggers reconciliation and removes the workspace record
- [x] Port is freed when auto-removing a workspace that had a port allocated
- [x] `WorktreeWatcher.unwatchProject()` stops the watcher — no further reconciliation occurs
- [x] `WorktreeWatcher.watchAll()` starts watchers for all registered projects
- [x] Server boot runs `watchAll()` with initial reconciliation for all projects
- [x] Rapid filesystem changes (e.g., 5 worktree adds in 1 second) are debounced into fewer reconciliation calls
- [x] Watcher handles `.git/worktrees/` not existing initially, then being created when first worktree is added
- [x] Watcher survives transient filesystem errors and continues monitoring
- [x] `addProject` starts watching after initial detection
- [x] `removeProject` stops watching before removing the project
- [x] WorktreeWatcher tests pass (7+ scenarios)

### Blocked by

- ~~Blocked by #159~~

### User stories addressed

- User story 5, 6, 10, 11, 14, 16, 17

### Status: Done

Implemented `WorktreeWatcher` as a scoped Effect service with per-project `fs.watch` subscriptions, 500ms debounce, reconciliation triggers, and automatic teardown. Wired watcher lifecycle into `ProjectRegistry` (`addProject` starts watching, `removeProject` un-watches first), and added startup `watchAll()` reconciliation inside the watcher layer so restored projects are reconciled on boot. Added integration tests for add/remove triggers, `unwatchProject`, `watchAll`, and the missing `.git/worktrees/` bootstrap case.

---

## ~~Issue 162: Origin-aware destroy behavior~~ ✅ DONE

### Parent PRD

PRD-worktree-detection.md

### What to build

Modify workspace destruction to behave differently based on the workspace's `origin` field, and update the frontend confirmation dialog to reflect this.

**WorkspaceProvider changes**: In the `destroyWorktree` method, check the workspace's `origin` field. When `origin` is `"external"`: skip `git worktree remove --force` and `git branch -D` steps — only free the port (if allocated, i.e., port > 0), stop running terminals, and commit `workspaceDestroyed`. When `origin` is `"laborer"`: behavior is unchanged (remove worktree, delete branch, free port, destroy record).

**Frontend confirmation dialog**: Update the workspace destroy confirmation dialog in `workspace-list.tsx` to show different text based on origin. For Laborer-created workspaces: current text (mentions removing the git worktree and branch). For external/detected workspaces: text should clarify that only the Laborer record will be removed, not the actual git worktree on disk (e.g., "This will remove the workspace from Laborer. The git worktree at <path> will not be affected.").

### Acceptance criteria

- [x] Destroying an external workspace does NOT run `git worktree remove` or `git branch -D`
- [x] Destroying an external workspace frees port if port > 0
- [x] Destroying an external workspace commits `workspaceDestroyed` event
- [x] Destroying a Laborer-created workspace still removes the git worktree and branch (no regression)
- [x] Confirmation dialog for external workspaces says the git worktree will not be affected
- [x] Confirmation dialog for Laborer-created workspaces shows existing text (mentions worktree/branch removal)
- [x] Tests verify origin-aware destroy behavior for both origins

### Blocked by

- ~~Blocked by #160~~

### User stories addressed

- User story 9, 14

### Status: Done

Workspace destruction is now origin-aware. External workspaces skip git worktree/branch deletion and only remove the Laborer record while still freeing any allocated port. Laborer-created workspaces keep the existing destructive cleanup flow. Added integration tests for both origin paths and updated the workspace destroy confirmation copy so detected workspaces clearly state that on-disk worktrees are untouched.

---

## Issue 163: Worktree detection polish & edge cases

### Parent PRD

PRD-worktree-detection.md

### What to build

End-to-end polish and verification pass for the complete worktree detection feature. Address all polishing requirements from the PRD and verify edge cases across the full integration.

**Visual polish**: Verify detected workspaces render consistently with Laborer-created workspaces (same card layout, status badge positioning, action button placement). Ensure the "Detected" origin indicator is visually subtle. Verify the "stopped" badge for detected workspaces is distinguishable from manually-stopped workspaces (consider a tooltip like "Never activated — detected from existing git worktree"). Verify workspace count badges accurately reflect detected workspaces.

**Rapid change handling**: Verify rapid worktree creation/removal (e.g., a script creating 10 worktrees) results in smooth, non-flickering UI updates. The debouncing in the watcher (Issue #161) handles the server side — verify the LiveStore sync propagation to the frontend is also smooth.

**Error handling**: Ensure detection failures (git not found, corrupt `.git/worktrees/`, permission errors) surface as informative but non-blocking warnings. They should not prevent project add or other features from working. Verify watcher teardown on project removal is clean (no lingering file descriptors).

**Diff service**: Verify the diff service handles detected workspaces with derived base SHAs correctly — diffs should show changes since the merge-base, not since the beginning of time.

**Edge cases**: Verify behavior when activating a detected workspace whose worktree was removed between detection and activation (should show a clear error). Verify stale worktree references (prunable entries) are excluded. Verify detection works with worktrees in various locations (`.worktrees/`, `~/.config/laborer/`, arbitrary paths).

### Acceptance criteria

- [ ] Detected workspaces render consistently with Laborer-created workspaces (card layout, badge positioning)
- [ ] "Detected" indicator is visually subtle (secondary text, not prominent badge)
- [ ] "Stopped" badge for never-activated workspaces has distinguishing tooltip or secondary text
- [ ] Rapid worktree creation/removal results in smooth UI updates (no flicker)
- [ ] Detection failures surface as non-blocking warnings (project add still succeeds)
- [ ] Watcher teardown on project removal is clean (no lingering file descriptors or listeners)
- [ ] Diff service correctly shows diffs from merge-base for detected workspaces
- [ ] Workspace count badges accurately include detected workspaces
- [ ] Detection works with worktrees in various filesystem locations
- [ ] Error when activating a workspace whose worktree was removed shows clear message

### Blocked by

- Blocked by ~~#160~~, #161, #162

### User stories addressed

- Polishing requirements 1-10

---

## Issue 164: Sidebar max-width removal

### Parent PRD

PRD-sidebar-workspace-ux.md

### What to build

Remove the sidebar's restrictive max-width cap and allow users to resize it up to 90% of the viewport width. Change the `useResponsiveLayout` hook so that `sidebarMax` returns a flat `"90%"` string instead of computing a pixel-to-percent value capped at 760px. Remove the absolute pixel cap from `computeSidebarPx`. Keep the current minimum (~220px at 1080p) and default (~280px at 1080p) unchanged. The remaining 10% ensures the main content panel always has some visible width.

### Acceptance criteria

- [ ] Sidebar `maxSize` is `"90%"` at all viewport widths
- [ ] The 760px absolute cap in `computeSidebarPx` is removed
- [ ] Sidebar minimum and default sizes are unchanged
- [ ] Sidebar can be resized smoothly from minimum to 90% without layout jank
- [ ] ResizableHandle drag handle works correctly at the new maximum width
- [ ] Main content panel maintains a usable minimum width when sidebar is at 90%

### Blocked by

None — can start immediately

### User stories addressed

- User story 1, 2, 3

---

## Issue 165: Workspace card two-row header + text clamping

### Parent PRD

PRD-sidebar-workspace-ux.md

### What to build

Restructure the `WorkspaceItem` card header from a single-row layout (branch name + all buttons competing for space) into a two-row layout. Row 1 (info row): GitBranch icon + branch name (line-clamped to 2 lines via Tailwind v4 `line-clamp-2`) + optional "Detected" badge + status badge pushed right. Row 2 (action row): all action buttons (WritePRD, Ralph Loop, Review PR, Fix Findings, expand/collapse, destroy) with `flex-wrap` so buttons wrap naturally at narrow widths. Replace `truncate` with `line-clamp-2` on the branch name span and the worktree path span in `CardContent`. The `CardDescription` (project name) remains below Row 1. Add `overflow-wrap: anywhere` or `break-all` for monospace text that lacks natural break points (e.g., branch names with `/` separators).

### Acceptance criteria

- [ ] Card header is split into two distinct rows: info row and action row
- [ ] Row 1 contains GitBranch icon, branch name, optional "Detected" badge, and status badge
- [ ] Status badge is right-aligned on Row 1
- [ ] Row 2 contains all action buttons with `flex-wrap`
- [ ] Branch name uses `line-clamp-2` instead of `truncate` — wraps up to 2 lines before ellipsis
- [ ] Worktree path uses `line-clamp-2` instead of `truncate` — wraps up to 2 lines before ellipsis
- [ ] Branch names with `/` separators wrap at reasonable break points
- [ ] Card layout looks correct at minimum sidebar width (~220px) and wide sidebar (800px+)
- [ ] Short branch names render without unnecessary clamping
- [ ] Action buttons wrap naturally at narrow widths without overflowing the card

### Blocked by

None — can start immediately

### User stories addressed

- User story 4, 5, 6, 7, 8, 18

---

## Issue 166: Detected worktree feature parity

### Parent PRD

PRD-sidebar-workspace-ux.md

### What to build

Remove the `isActive` conditional gate on all six elements in the `WorkspaceItem` component so that detected (external) worktrees get the same UI as created workspaces. The following elements are currently wrapped in `{isActive && ...}` and should render unconditionally for all non-destroyed workspaces:

1. `WritePrdForm`
2. Start Ralph Loop button
3. `ReviewPrForm`
4. `FixFindingsForm`
5. `CollapsibleTrigger` (expand/collapse chevron)
6. `CollapsibleContent` (terminal list section)

The `isActive` variable may be retained for other purposes (e.g., the "creating" spinner) but should no longer gate these UI elements. The "Detected" label and origin-aware destroy confirmation message remain unchanged. Server-side RPC handlers may reject actions on stopped workspaces — those errors will surface via existing toast error handling with no client-side changes needed.

### Acceptance criteria

- [ ] Detected worktrees show the expand/collapse chevron
- [ ] Detected worktrees can be expanded to reveal the terminal list with "+ New" button
- [ ] Clicking "+ New" on a detected worktree spawns a terminal in the correct worktree directory
- [ ] WritePRD button appears on detected worktrees
- [ ] Ralph Loop button appears on detected worktrees
- [ ] Review PR button appears on detected worktrees
- [ ] Fix Findings button appears on detected worktrees
- [ ] "Detected" label still displays on external worktrees
- [ ] Destroy confirmation still uses the softer message for detected worktrees
- [ ] No regression for Laborer-created workspaces (active workspaces still work as before)

### Blocked by

None — can start immediately

### User stories addressed

- User story 9, 10, 11, 12, 13, 14, 15, 16, 17

---

## Issue 167: Sidebar & workspace card polish

### Parent PRD

PRD-sidebar-workspace-ux.md

### What to build

End-to-end verification and polish pass for the sidebar max-width removal, workspace card two-row header restructure, and detected worktree feature parity. Verify all polishing requirements from the PRD across the complete integration.

### Acceptance criteria

- [ ] Sidebar resizes smoothly from minimum to 90% without layout jank or content shifting
- [ ] ResizableHandle drag handle works correctly at the new maximum width
- [ ] Main content panel maintains a usable minimum width when sidebar is at 90%
- [ ] Branch names with `/` separators wrap at reasonable break points (monospace text)
- [ ] 2-line clamp ellipsis renders correctly for short names (no clamp) and very long names (3+ lines)
- [ ] Action buttons on Row 2 are correctly spaced and aligned across cards of varying content lengths
- [ ] Detected worktree terminal spawning works end-to-end (terminal opens in correct directory)
- [ ] Agent workflow buttons function correctly for detected worktrees in "stopped" state
- [ ] Card layout looks correct at minimum sidebar width (~220px) and very wide sidebar (800px+)
- [ ] "Detected" badge and status badge don't overflow or stack awkwardly at narrow widths

### Blocked by

- Blocked by #164, #165, #166

### User stories addressed

- Polishing requirements 1-10
