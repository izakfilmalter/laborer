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

## Issue 136: Move PTY Host + PtyHostClient to terminal package

### Parent PRD

PRD-terminal-extraction.md

### What to build

Move the PTY Host child process (`pty-host.ts`), the IPC client (`services/pty-host-client.ts`), and the ring buffer (`lib/ring-buffer.ts`) from `@laborer/server` to `@laborer/terminal`. Wire `PtyHostClient` into the terminal service's Effect layer tree in `main.ts`. Move `node-pty` dependency to the terminal package's `package.json`. Port `pty-host.test.ts` and `ring-buffer.test.ts` to `packages/terminal/test/`. The moved modules should be largely unchanged — this is a mechanical extraction.

### Acceptance criteria

- [ ] `pty-host.ts`, `pty-host-client.ts`, `ring-buffer.ts` exist in `packages/terminal/src/`
- [ ] `PtyHostClient.layer` is wired into the terminal service's layer tree
- [ ] PTY Host child process spawns successfully when terminal service starts
- [ ] `node-pty` is a dependency of `@laborer/terminal` (not `@laborer/server`)
- [ ] `pty-host.test.ts` and `ring-buffer.test.ts` pass in the new package
- [ ] Terminal service starts and PTY Host logs "ready" on startup

### Blocked by

- Blocked by #135

### User stories addressed

- User story 17, 18, 19

---

## Issue 137: Terminal RPC contract

### Parent PRD

PRD-terminal-extraction.md

### What to build

Define a new `TerminalRpcs` RPC group in `@laborer/shared` using the `@effect/rpc` pattern (matching the existing `LaborerRpcs` pattern). Define RPCs for: `terminal.spawn` (accepts command, args, cwd, env, cols, rows; returns id), `terminal.write`, `terminal.resize`, `terminal.kill`, `terminal.remove`, `terminal.restart`, and `terminal.list` (returns array of terminal state objects). Define request/response schemas using Effect Schema. The `workspaceId` is passed as opaque metadata at spawn time. No streaming endpoint yet (that's Issue #142).

### Acceptance criteria

- [ ] `TerminalRpcs` RPC group is defined in `@laborer/shared`
- [ ] All 7 RPC endpoints have typed payload and response schemas
- [ ] `TerminalSpawnPayload` includes command, args, cwd, env, cols, rows, workspaceId
- [ ] `TerminalInfo` response schema includes id, workspaceId, command, status
- [ ] Types compile and are importable from both `@laborer/server` and `@laborer/terminal`
- [ ] Shared `TerminalRpcError` tagged error class defined

### Blocked by

None - can start immediately

### User stories addressed

- User story 5, 7

---

## Issue 138: Move + simplify TerminalManager

### Parent PRD

PRD-terminal-extraction.md

### What to build

Move `TerminalManager` from `@laborer/server` to `@laborer/terminal` and simplify it per the PRD's "Modified Module: TerminalManager" section. Remove all LiveStore dependencies (event commits and table reads). Remove the `WorkspaceProvider` dependency — env vars and cwd are now passed at spawn time via the RPC payload. Add stopped terminal retention: when a PTY exits, keep the terminal entry in the in-memory map with status "stopped" (preserving command and config so restart works). Add lifecycle event emission via Effect `PubSub` — emit events for spawned, status changed, exited, removed, restarted. Update the spawn interface to accept the full spawn payload (command, args, cwd, env, cols, rows, workspaceId) instead of just workspaceId. Port `terminal-manager.test.ts` with updated assertions (no LiveStore, test event emission and stopped retention).

### Acceptance criteria

- [ ] TerminalManager has no dependency on `LaborerStore` or `WorkspaceProvider`
- [ ] `spawn()` accepts full payload: command, args, cwd, env, cols, rows, workspaceId
- [ ] Stopped terminals remain in memory with their config (command, env, cwd)
- [ ] `restart()` works for stopped terminals using retained config
- [ ] Lifecycle events are emitted via PubSub (spawned, statusChanged, exited, removed, restarted)
- [ ] `terminal-manager.test.ts` passes in the new package with updated assertions
- [ ] `listTerminals()` returns both running and stopped terminals

### Blocked by

- Blocked by #136

### User stories addressed

- User story 5, 12, 13

---

## Issue 139: Terminal RPC handlers

### Parent PRD

PRD-terminal-extraction.md

### What to build

Implement RPC handlers in `packages/terminal/src/rpc/handlers.ts` for all terminal operations defined in the `TerminalRpcs` contract (Issue #137). Each handler delegates to `TerminalManager`. Wire the RPC handlers into the terminal service's `main.ts` layer tree at `POST /rpc` using `RpcServer.layerProtocolHttp`. Follow the same handler pattern as the existing `LaborerRpcsLive` in the server package (destructured payload, `Effect.gen`, yield service tag).

### Acceptance criteria

- [ ] RPC handlers implemented for spawn, write, resize, kill, remove, restart, list
- [ ] `POST /rpc` endpoint is live on the terminal service
- [ ] Can spawn a terminal via RPC and it appears in `terminal.list()` response
- [ ] Can write to, resize, kill, remove, and restart terminals via RPC
- [ ] Errors return typed `TerminalRpcError` responses
- [ ] RPC serialization (JSON) is wired into the layer tree

### Blocked by

- Blocked by #137, #138

### User stories addressed

- User story 5, 7, 12, 13

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

- Blocked by #139

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

- Blocked by #139

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
| 136 | Move PTY Host + PtyHostClient to terminal package | ~~#135~~ | Ready |
| 137 | Terminal RPC contract | None | Ready |
| 138 | Move + simplify TerminalManager | #136 | Blocked |
| 139 | Terminal RPC handlers | #137, #138 | Blocked |
| 140 | Move terminal WebSocket route to terminal package | #139 | Blocked |
| 141 | Update Vite proxy + web app WebSocket hook | #140 | Blocked |
| 142 | Terminal event stream RPC | #139 | Blocked |
| 143 | Server TerminalClient + remove server terminal modules | #142 | Blocked |
| 144 | Web app LiveStore terminal query replacement | #141, #143 | Blocked |
| 145 | LiveStore terminal schema deprecation | #144 | Blocked |
| 146 | Grace period reconnection + orphan detection | #140 | Blocked |
| 147 | Terminal extraction polish + integration verification | #144, #145, #146 | Blocked |
