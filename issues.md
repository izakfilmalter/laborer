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

## Issue 140: Move terminal WebSocket route to terminal package

### Parent PRD

PRD-terminal-extraction.md

### What to build

Move `terminal-ws.ts` from `@laborer/server` to `@laborer/terminal` and wire it into the terminal service's layer tree at `GET /terminal?id=...`. Extend the WebSocket protocol with control messages per the PRD: send `{"type":"status","status":"running"}` on initial connect, `{"type":"status","status":"stopped","exitCode":N}` when the PTY exits, and `{"type":"status","status":"restarted"}` when a terminal is restarted. The existing raw text frame PTY I/O and flow control ack messages remain unchanged. Register callbacks from TerminalManager to push status events to active WebSocket subscribers.

### Acceptance criteria

- [ ] `GET /terminal?id=...` WebSocket endpoint is live on the terminal service
- [ ] Connecting to a terminal WebSocket receives ring buffer scrollback replay
- [ ] `{"type":"status","status":"running"}` is sent on successful WebSocket connection
- [ ] `{"type":"status","status":"stopped","exitCode":N}` is sent when PTY exits
- [ ] `{"type":"status","status":"restarted"}` is sent when terminal is restarted
- [ ] Raw PTY I/O text frames and flow control ack frames work unchanged
- [ ] WebSocket connects to terminal service port directly (not through server)

### Blocked by

- Blocked by ~~#139~~

### User stories addressed

- User story 6, 11, 15, 21

---

## Issue 141: Update Vite proxy + web app WebSocket hook

### Parent PRD

PRD-terminal-extraction.md

### What to build

Update the web app to connect terminal WebSockets directly to the terminal service. Update `vite.config.ts` to proxy `/terminal` to `TERMINAL_PORT` instead of the server port. Update `use-terminal-websocket.ts` to parse incoming control messages (`{"type":"status",...}`) and expose the terminal's derived status (running/stopped/restarted) to consumers. Update `terminal-pane.tsx` to use the WebSocket-derived status instead of the LiveStore `queryDb(terminals)` query for determining `isRunning`, showing the "Process exited" banner, and clearing the xterm.js buffer on restart. The LiveStore query can remain temporarily (removed in Issue #144) but should no longer drive these UI decisions.

### Acceptance criteria

- [ ] Vite proxy routes `/terminal` WebSocket to `TERMINAL_PORT`
- [ ] `use-terminal-websocket.ts` parses `{"type":"status",...}` control messages
- [ ] Hook exposes `terminalStatus: "running" | "stopped" | "restarted"` alongside connection status
- [ ] `terminal-pane.tsx` uses WebSocket-derived status for isRunning, exit banner, restart buffer clear
- [ ] Terminal pane connects directly to terminal service (verified via network inspector)
- [ ] Flow control ack frames still work correctly

### Blocked by

- Blocked by #140

### User stories addressed

- User story 6, 15, 21

---

## Issue 142: Terminal event stream RPC

### Parent PRD

PRD-terminal-extraction.md

### What to build

Add a streaming RPC endpoint `terminal.events()` to the terminal service that pushes terminal lifecycle events to subscribers. The TerminalManager's internal `PubSub` (added in Issue #138) feeds this stream. Events include: `spawned` (with terminal info), `statusChanged` (with id and new status), `exited` (with id and exit code), `removed` (with id), and `restarted` (with id). Use Effect RPC's streaming capabilities (Effect.Stream) for the endpoint. Add the `terminal.events` RPC definition to the `TerminalRpcs` contract in `@laborer/shared`.

### Acceptance criteria

- [ ] `terminal.events` streaming RPC is defined in the shared contract
- [ ] Terminal service exposes the streaming endpoint
- [ ] Subscribing to the stream and spawning a terminal yields a "spawned" event
- [ ] Killing a terminal yields "exited" and "statusChanged" events
- [ ] Restarting a terminal yields a "restarted" event
- [ ] Removing a terminal yields a "removed" event
- [ ] Multiple subscribers receive the same events independently

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

- [ ] `TerminalClient` Effect service exists in the server package
- [ ] Server connects to terminal service via Effect RPC HTTP client
- [ ] Server subscribes to `terminal.events()` and tracks workspace->terminal mapping
- [ ] Server `main.ts` no longer includes PtyHostClient, TerminalManager, or TerminalWsRoute layers
- [ ] rlph commands (startLoop, writePRD, review, fix) spawn terminals through the terminal service
- [ ] `killAllForWorkspace` kills terminals via TerminalClient
- [ ] `node-pty` is removed from server's package.json
- [ ] Server starts gracefully even if terminal service is temporarily unreachable

### Blocked by

- Blocked by #142

### User stories addressed

- User story 12, 20

---

## Issue 144: Web app LiveStore terminal query replacement

### Parent PRD

PRD-terminal-extraction.md

### What to build

Replace all LiveStore `queryDb(terminals, ...)` subscriptions in the web app with RPC calls to the terminal service. Update `terminal-list.tsx` to fetch terminal list via `terminal.list()` RPC (through a Vite proxy rule for the terminal RPC endpoint) instead of LiveStore. Use React Query, SWR, or polling for reactivity. Update `workspace-dashboard.tsx` terminal counts to use the same RPC data source. Update `routes/index.tsx` initial panel layout generation to query running terminals via RPC instead of LiveStore. Remove the `v1.TerminalRestarted` event stream listener from `terminal-pane.tsx` (replaced by WebSocket control messages in Issue #141). Add a Vite proxy rule for the terminal service's RPC endpoint if not already present.

### Acceptance criteria

- [ ] `terminal-list.tsx` fetches terminal list from terminal service RPC, not LiveStore
- [ ] `workspace-dashboard.tsx` gets terminal counts from terminal service RPC
- [ ] `routes/index.tsx` queries running terminals from terminal service RPC for layout generation
- [ ] `terminal-pane.tsx` no longer listens to `v1.TerminalRestarted` LiveStore event stream
- [ ] No `queryDb(terminals, ...)` calls remain in the web app
- [ ] Terminal list updates reactively when terminals are spawned or killed (via polling or push)
- [ ] Vite proxy routes terminal RPC requests to TERMINAL_PORT

### Blocked by

- Blocked by #141, #143

### User stories addressed

- User story 7, 14, 16, 22, 23, 24

---

## Issue 145: LiveStore terminal schema deprecation

### Parent PRD

PRD-terminal-extraction.md

### What to build

Deprecate all terminal-related events and remove the `terminals` table from the active LiveStore schema. Convert materializers for `v1.TerminalSpawned`, `v1.TerminalStatusChanged`, `v1.TerminalKilled`, `v1.TerminalRemoved`, and `v1.TerminalRestarted` to no-ops (following the existing pattern used for `v1.TerminalOutput`). Remove the `terminals` table definition from the schema's state tables. Remove any remaining terminal event commits from server code (if any survived Issue #143). Existing eventlogs containing these events must still load without errors — the no-op materializers ensure backward compatibility.

### Acceptance criteria

- [ ] All terminal event materializers are no-ops (return empty arrays)
- [ ] `terminals` table is removed from the active schema state
- [ ] No code commits terminal events to LiveStore anywhere in the codebase
- [ ] App starts cleanly with existing eventlogs that contain old terminal events
- [ ] No `queryDb(terminals, ...)` calls exist anywhere in the codebase
- [ ] `v1.TerminalOutput` no-op pattern is followed for all deprecated events

### Blocked by

- Blocked by #144

### User stories addressed

- User story 14

---

## Issue 146: Grace period reconnection + orphan detection

### Parent PRD

PRD-terminal-extraction.md

### What to build

Add a configurable grace period timer to the terminal service's `TerminalManager` (default 60 seconds, configurable via `TERMINAL_GRACE_PERIOD_MS` env var). When a terminal's last WebSocket subscriber disconnects, start the grace timer. If a new WebSocket subscriber connects within the grace period, cancel the timer and replay the ring buffer for seamless reconnection. If the grace period expires with no subscribers, kill the terminal. Also handle orphaned spawns: if a terminal is spawned via RPC but no WebSocket subscriber connects within the grace period, kill it. Add tests for grace period behavior (survive within window, cleanup after expiry).

### Acceptance criteria

- [ ] Grace period timer starts when last WebSocket subscriber disconnects
- [ ] Reconnecting within the grace period cancels the timer and replays ring buffer
- [ ] Terminal is killed after grace period expires with no subscribers
- [ ] Spawned terminals with no WebSocket subscriber within grace period are killed
- [ ] Grace period is configurable via `TERMINAL_GRACE_PERIOD_MS` env var (default 60s)
- [ ] Terminals survive server restarts during development (grace period covers the restart window)
- [ ] Grace period tests pass (survive within window, cleanup after expiry)

### Blocked by

- Blocked by #140

### User stories addressed

- User story 1, 9, 10

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

- Blocked by #144, #145, #146

### User stories addressed

- Polishing requirements 1-12

---

## Issue 148: Focused pane border fix

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

Replace the glitched `ring-2 ring-primary ring-inset` active pane indicator with a solid `border-2 border-primary` on the focused pane. Non-active panes get `border-2 border-transparent` to maintain consistent sizing and prevent layout shift when focus changes. Update the drag-over drop target highlight to use border instead of ring for consistency. The change is in `LeafPaneRenderer` in `panel-manager.tsx`.

### Acceptance criteria

- [ ] Active pane shows `border-2 border-primary` on all four edges
- [ ] Non-active panes show `border-2 border-transparent` (no layout shift on focus change)
- [ ] Border renders correctly at all split nesting depths (1 through 5+)
- [ ] Border does not overlap or conflict with ResizableHandle drag handles
- [ ] Drag-over drop target highlight uses border instead of ring
- [ ] Border is consistent across all pane types (terminal, diff, empty)
- [ ] Border disappears when no panes exist (empty layout state)

### Blocked by

None - can start immediately

### User stories addressed

- User story 2, 3, 12, 13

---

## Issue 149: Focus auto-transfer on pane close

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

When a pane is closed, automatically transfer focus to the nearest sibling pane in the same parent split. Add a new `findSiblingPaneId(root, paneId)` utility function in `layout-utils.ts` that resolves the target pane ID before the close operation mutates the tree. Update `handleClosePane` in the route component to compute the sibling before calling `closePane()`, then set `activePaneId` to that sibling. If the closing pane is the first child, focus the next sibling. If it's the last or middle child, focus the previous sibling. If no siblings exist (closing the last pane), set `activePaneId` to `null`. Add unit tests for `findSiblingPaneId` following the existing `layout-utils.test.ts` patterns.

### Acceptance criteria

- [ ] `findSiblingPaneId(root, paneId)` returns the correct sibling leaf ID for various tree configurations
- [ ] Closing first child focuses next sibling
- [ ] Closing last child focuses previous sibling
- [ ] Closing middle child focuses previous sibling
- [ ] Closing deeply nested pane focuses nearest sibling in parent split
- [ ] Closing the last pane sets `activePaneId` to `null`
- [ ] Focus transfer works with the existing Ctrl+B, X shortcut
- [ ] Unit tests for `findSiblingPaneId` pass (edge cases: single leaf root, nested splits, flat splits with 3+ children)

### Blocked by

None - can start immediately

### User stories addressed

- User story 4, 5

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

## Issue 151: Cmd+W shortcut — close active pane

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

Register Cmd+W (Meta+W) as a direct keyboard shortcut that closes the currently focused pane. Three layers of work:

1. **Tauri interception**: Prevent Cmd+W from reaching the native `CloseRequested` handler. Try the web-layer approach first: add a `window.addEventListener("keydown")` listener that catches Meta+W and calls `event.preventDefault()`. If Tauri still fires `CloseRequested`, fall back to registering Cmd+W via `tauri-plugin-global-shortcut` on the Rust side and emitting a Tauri event to the webview.

2. **React hotkey**: Register Meta+W using `@tanstack/react-hotkeys` (single-key shortcut, not prefix sequence). Handler calls `actions.closePane(activePaneId)` when a pane is focused.

3. **xterm.js passthrough**: Update the terminal's `attachCustomKeyEventHandler` to detect Meta+W and return `false`, preventing xterm.js from consuming it so it bubbles to the document-level hotkey handler. Follow the existing pattern used for Ctrl+B prefix mode.

The existing Ctrl+B, X shortcut remains unchanged.

### Acceptance criteria

- [ ] Cmd+W closes the active pane when a pane is focused
- [ ] Cmd+W works when xterm.js terminal has focus
- [ ] Cmd+W does not trigger native window close/hide when panes exist
- [ ] Cmd+W closes empty panes (no terminal assigned)
- [ ] Existing Ctrl+B, X shortcut still works
- [ ] Cmd+W works after multiple rapid presses (closing several panes in succession)
- [ ] Native window close button (red dot) still hides to tray as before
- [ ] Cmd+Q still quits the app as before

### Blocked by

- Blocked by #149

### User stories addressed

- User story 1, 9, 10, 11

---

## Issue 152: Cmd+W close-app confirmation dialog

### Parent PRD

PRD-cmd-w-close-panel.md

### What to build

When Cmd+W is pressed and no panes exist, show an AlertDialog asking "Close Laborer?" instead of silently doing nothing. The dialog uses the existing `alert-dialog.tsx` component with controlled `open` state (no trigger button — opened programmatically from the Cmd+W handler). Title: "Close Laborer?". Description: "The window will be hidden to the system tray. Your workspaces will continue running." Actions: "Cancel" (dismisses dialog) and "Close" (hides window to tray via Tauri window API). Follow the existing destructive confirmation pattern used by project removal, workspace destruction, and task removal dialogs.

### Acceptance criteria

- [ ] Cmd+W with no panes opens the close-app AlertDialog
- [ ] Dialog shows title "Close Laborer?" and descriptive text about tray behavior
- [ ] "Cancel" button dismisses the dialog without hiding the window
- [ ] "Close" button hides the window to the system tray
- [ ] Escape key dismisses the dialog
- [ ] Dialog does not appear when at least one pane exists
- [ ] Ctrl+B, X with no panes does NOT trigger the dialog (only Cmd+W does)

### Blocked by

- Blocked by #151

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

- Blocked by #148, #149, #150, #151, #152

### User stories addressed

- Polishing requirements 1-9

---

## Issue 154: Config Service — resolve config with walk-up + global default

### Parent PRD

PRD-global-worktree-config.md

### What to build

Create a new `ConfigService` Effect tagged service in the server package that reads and resolves `laborer.json` config files using a walk-up directory resolution strategy. The service provides a `resolveConfig(projectRepoPath, projectName)` method that:

1. Looks for `laborer.json` at the project root directory
2. Walks up parent directories looking for `laborer.json` files
3. Falls back to the global config at `~/.config/laborer/laborer.json`
4. Applies hardcoded defaults (`worktreeDir` = `~/.config/laborer/<projectName>`)

Config values merge with closest-to-project-root winning. Each resolved value carries provenance metadata (the file path it came from, or "default"). Supports `~` expansion in `worktreeDir` paths. Also provides a `readGlobalConfig()` method for reading just the global config.

The config schema is: `{ worktreeDir?: string, setupScripts?: string[], rlphConfig?: string }`.

Auto-creates `~/.config/laborer/` directory if it doesn't exist when reading the global config.

### Acceptance criteria

- [ ] `ConfigService` is an Effect tagged service with `resolveConfig` and `readGlobalConfig` methods
- [ ] Walk-up resolution finds `laborer.json` in ancestor directories (project root checked first)
- [ ] Project-root config overrides ancestor config (closest-wins merging)
- [ ] Global config at `~/.config/laborer/laborer.json` is used as fallback
- [ ] Hardcoded default `worktreeDir` = `~/.config/laborer/<projectName>` when no config files set it
- [ ] `~` in `worktreeDir` is expanded to the home directory
- [ ] Provenance metadata indicates the source file path for each resolved value
- [ ] Malformed JSON in config files is handled gracefully (logged, skipped)
- [ ] Missing config files are handled gracefully (not an error)
- [ ] `~/.config/laborer/` directory is auto-created if it doesn't exist
- [ ] Integration tests with real temp directories cover all resolution scenarios

### Blocked by

None - can start immediately

### User stories addressed

- User story 2, 3, 4, 5, 6, 14, 16, 17

---

## Issue 155: Config Service — write project config

### Parent PRD

PRD-global-worktree-config.md

### What to build

Add a `writeProjectConfig(projectRepoPath, updates)` method to the `ConfigService` (Issue #154). This method reads the existing `laborer.json` at the project root, merges the provided partial updates, and writes the result back. If no `laborer.json` exists at the project root, creates one. Only writes fields that are explicitly provided in the updates — does not write `undefined` or default values. Preserves unknown fields in the existing file (round-trip safe). Uses atomic write (write to temp file, rename) to avoid partial writes.

### Acceptance criteria

- [ ] `writeProjectConfig` creates `laborer.json` at project root if it doesn't exist
- [ ] `writeProjectConfig` merges updates with existing config (doesn't clobber unrelated fields)
- [ ] Only explicitly provided fields are written (no default values injected)
- [ ] Unknown fields in the existing file are preserved after write
- [ ] Atomic write prevents partial/corrupt files
- [ ] Tests verify creation, merge, and field preservation behaviors

### Blocked by

- Blocked by #154

### User stories addressed

- User story 12, 15

---

## Issue 156: WorkspaceProvider — use ConfigService for worktree path + setup scripts

### Parent PRD

PRD-global-worktree-config.md

### What to build

Wire the `ConfigService` (Issue #154) into `WorkspaceProvider` to replace the hardcoded worktree directory and the old config reader. Remove the `WORKTREE_DIR` constant (currently `.worktrees`), the `readProjectConfig` function, the `LaborerConfig` interface, and the `CONFIG_FILE` constant from `workspace-provider.ts`. The worktree path computation changes from `resolve(project.repoPath, ".worktrees", slug)` to `resolve(resolvedConfig.worktreeDir, slug)` where `resolvedConfig.worktreeDir` is an absolute path with `~` already expanded. Setup scripts are read from the resolved config's `setupScripts` field. Rename all remaining `.laborer.json` references in the codebase to `laborer.json`.

### Acceptance criteria

- [ ] `WORKTREE_DIR` constant, `readProjectConfig`, `LaborerConfig`, and `CONFIG_FILE` are removed from workspace-provider.ts
- [ ] WorkspaceProvider depends on ConfigService for worktree directory resolution
- [ ] Worktree path is `<resolvedConfig.worktreeDir>/<branchSlug>` (not `<repoPath>/.worktrees/<branchSlug>`)
- [ ] Setup scripts are read from ConfigService resolved config
- [ ] All `.laborer.json` references in the codebase are renamed to `laborer.json`
- [ ] ConfigService is added to WorkspaceProvider's layer dependencies
- [ ] Tests verify worktree creation uses the resolved config path
- [ ] Tests verify setup scripts come from the resolved config

### Blocked by

- Blocked by #154

### User stories addressed

- User story 1, 2, 5, 11, 13

---

## Issue 157: Config RPC endpoints + project settings modal

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

- [ ] `config.get` RPC defined in shared contract with provenance in response schema
- [ ] `config.update` RPC defined in shared contract with partial config payload
- [ ] Server handlers for both RPCs delegate to ConfigService via ProjectRegistry
- [ ] `config.get` returns error for non-existent project
- [ ] `config.update` returns error for non-existent project
- [ ] Gear icon appears on each project card next to the delete icon
- [ ] Clicking gear icon opens the settings modal
- [ ] Modal displays resolved config values fetched via `config.get`
- [ ] Provenance labels show which file each value comes from
- [ ] Worktree directory field is editable with placeholder showing default
- [ ] Setup scripts field is an editable list with add/remove functionality
- [ ] rlph config field is editable
- [ ] Save writes changed fields via `config.update` RPC
- [ ] Toast confirms successful save or shows error

### Blocked by

- Blocked by #155, #156

### User stories addressed

- User story 7, 8, 9, 10, 11, 12

---

## Issue 158: Config + settings polish & edge cases

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
- [ ] Modal form fields have proper labels and ARIA attributes
- [ ] Keyboard navigation works: Tab between fields, Enter to save, Escape to cancel
- [ ] Gear icon spacing and alignment is visually balanced with delete icon
- [ ] Provenance text is visually subtle (secondary color, smaller text)
- [ ] Setup scripts: empty list saves correctly, special characters preserved, long commands don't break layout
- [ ] Malformed config file shows user-friendly error message in toast
- [ ] RPC handler tests cover error paths (non-existent project, malformed input)
- [ ] Frontend component tests cover modal open, display, save, and toast behaviors

### Blocked by

- Blocked by #157

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
| 107 | PRD-generated issues → tasks | ~~#94~~, ~~#100~~ | Ready |
| 108 | Linear task sourcing | ~~#102~~ | Ready |
| 109 | GitHub task sourcing | ~~#102~~ | Ready |
| 110 | Task source picker UI | #108, #109, #103 | Blocked |
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
| 140 | Move terminal WebSocket route to terminal package | ~~#139~~ | Ready |
| 141 | Update Vite proxy + web app WebSocket hook | #140 | Blocked |
| 142 | Terminal event stream RPC | ~~#139~~ | Ready |
| 143 | Server TerminalClient + remove server terminal modules | #142 | Blocked |
| 144 | Web app LiveStore terminal query replacement | #141, #143 | Blocked |
| 145 | LiveStore terminal schema deprecation | #144 | Blocked |
| 146 | Grace period reconnection + orphan detection | #140 | Blocked |
| 147 | Terminal extraction polish + integration verification | #144, #145, #146 | Blocked |
| 148 | Focused pane border fix | None | Ready |
| 149 | Focus auto-transfer on pane close | None | Ready |
| 150 | Guaranteed active pane invariant | #149 | Blocked |
| 151 | Cmd+W shortcut — close active pane | #149 | Blocked |
| 152 | Cmd+W close-app confirmation dialog | #151 | Blocked |
| 153 | Cmd+W close panel — polish & verification | #148, #149, #150, #151, #152 | Blocked |
| 154 | Config Service — resolve config with walk-up + global default | None | Ready |
| 155 | Config Service — write project config | #154 | Blocked |
| 156 | WorkspaceProvider — use ConfigService for worktree path + setup scripts | #154 | Blocked |
| 157 | Config RPC endpoints + project settings modal | #155, #156 | Blocked |
| 158 | Config + settings polish & edge cases | #157 | Blocked |
