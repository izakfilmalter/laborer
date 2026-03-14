# Issues: Phased Service Lifecycle Architecture

Parent PRD: [PRD.md](./PRD.md)

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Switch LiveStore to non-blocking sync | None | Done |
| 2 | LiveStore sync status indicator | #1 | Ready |
| 3 | First-launch empty cache handling | #1 | Ready |
| 4 | Lifecycle phase enum and context | None | Done |
| 5 | `useWhenPhase` hook and service status hook | #4 | Done |
| 6 | Remove ServerGate blocking gate | #1, #4 | Done |
| 7 | Wire sidecar status events to lifecycle phase transitions | #5, #6 | Done |
| 8 | Header per-service status dots | #5 | Ready |
| 9 | Header status collapse and expand | #8 | Blocked |
| 10 | Header error state persistence and animations | #8 | Blocked |
| 11 | Disable write actions before Phase 2 (Ready) | #5, #6 | Ready |
| 12 | Progressive feature enablement for Phases 3-4 | #11 | Blocked |
| 13 | Server core layer group (fast health endpoint) | None | Ready |
| 14 | Server deferred layer group (background initialization) | #13 | Blocked |
| 15 | Server "fully initialized" event | #14 | Blocked |
| 16 | Lazy sidecar connections (TerminalClient + FileWatcherClient) | #14 | Blocked |
| 17 | Parallel sidecar spawning | #16 | Blocked |

**Parallelizable starting points:** Issues #1, #4, and #13 can all start immediately and in parallel. #1 and #4 are frontend work, #13 is backend.

---

## Issue 1: Switch LiveStore to non-blocking sync

### What to build

Remove the explicit blocking initial sync from the LiveStore worker configuration. The current worker sets `initialSyncOptions: { _tag: 'Blocking', timeout: 5000 }`, which blocks the store (and therefore all UI behind the Suspense boundary) for up to 5 seconds waiting for the WebSocket sync to complete. LiveStore's default is `{ _tag: 'Skip' }` — the store loads from the local OPFS cache immediately and syncs in the background.

This is a single-line change in `livestore.worker.ts` (remove the `initialSyncOptions` property), but it fundamentally changes the startup contract: the store becomes available in milliseconds from OPFS instead of seconds from network sync. The `Suspense` boundary in `LiveStoreProvider` resolves as soon as OPFS is loaded, not after sync completes.

The `onSyncError` default (`'ignore'`) is kept, so sync failures don't crash the app — it continues in offline mode.

See PRD sections: "LiveStore Non-Blocking Sync", "Risk: Stale Data on Launch".

### TDD approach

Test through the public interface — the store's readiness and the data it serves — not internal sync state.

**Tracer bullet:** Test that the store becomes ready without a server running.

Behaviors to test (RED→GREEN, one at a time):
1. Store loads and becomes ready when no sync backend is reachable (mock WebSocket to fail)
2. Store serves locally-cached data from OPFS immediately after becoming ready
3. Store updates reactively when background sync delivers new data (simulate delayed sync)
4. Store continues operating when sync backend goes offline mid-session

Mock at system boundaries only: WebSocket connection (external), OPFS storage (external). Do not mock LiveStore internals.

### Acceptance criteria

- [ ] `initialSyncOptions` removed from `livestore.worker.ts` (defaults to `{ _tag: 'Skip' }`)
- [ ] Store loads from OPFS cache and becomes usable within milliseconds, without waiting for server
- [ ] Background sync starts automatically when server is available
- [ ] Sync errors are logged but do not crash the app or block the UI
- [ ] Existing reactive queries update automatically when background sync delivers new data
- [ ] Tests verify store readiness without server and reactive updates after sync

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1: See app UI within 1 second of launching
- User story 2: See last-known workspace list immediately on launch
- User story 13: LiveStore syncs in background after launch
- User story 20: Lifecycle phases invisible during fast startups

---

## Issue 2: LiveStore sync status indicator

### What to build

Add a subtle sync status indicator to the header that shows when LiveStore is actively syncing data in the background. This uses `useSyncStatus()` from `@livestore/react` to detect sync state. The indicator is only visible when the store is actively catching up (pulling or pushing events) and hides automatically when sync is idle/caught up.

This gives the user visibility into potential data staleness after the non-blocking sync change in Issue #1. The indicator should be unobtrusive during normal operation — a small icon or subtle animation that doesn't compete with the main service status indicators.

See PRD section: "Header Service Status Indicators" (sync indicator subsection).

### TDD approach

**Tracer bullet:** Test that the sync indicator is visible when the store is actively syncing.

Behaviors to test:
1. Sync indicator renders when sync status is `syncing`/`pulling`
2. Sync indicator hidden when sync status is `idle`/`connected`
3. Sync indicator hidden when no sync backend is configured (local-only mode)
4. Indicator does not cause layout shifts in the header when appearing/disappearing

Mock at system boundaries: LiveStore's `useSyncStatus()` return value.

### Acceptance criteria

- [ ] Sync indicator visible in header during active background sync
- [ ] Sync indicator hidden when sync is idle or caught up
- [ ] Indicator is subtle — small icon or animation, no text, no layout shifts
- [ ] Indicator hidden when no sync backend is configured
- [ ] Tests verify visibility logic based on sync status

### Blocked by

- Blocked by "Switch LiveStore to non-blocking sync" (#1)

### User stories addressed

- User story 14: See a subtle sync indicator when LiveStore is catching up

---

## Issue 3: First-launch empty cache handling

### What to build

When OPFS has no cached data (first-ever launch or cache cleared), the store initializes with empty tables instantly (no materializers to replay). With non-blocking sync from Issue #1, the UI renders immediately with this empty state. Currently, components may render broken empty tables or missing data.

Add appropriate onboarding/placeholder content to key views (workspace list, panel layouts, etc.) that handles the empty store state gracefully. When the server comes online and sync delivers data, the UI should transition smoothly from placeholder to populated state without full-page re-renders — LiveStore's reactive query system handles this naturally.

See PRD section: "First-Launch (Empty Cache) Handling".

### TDD approach

**Tracer bullet:** Test that an empty store renders meaningful placeholder content instead of broken empty tables.

Behaviors to test:
1. Empty workspace list shows onboarding/placeholder content (not an empty table)
2. When data arrives via sync, workspace list updates reactively (no full re-render)
3. Panel layout renders a sensible default when no persisted layout exists
4. No console errors or rendering crashes with empty store

Mock at system boundaries: LiveStore store (use in-memory adapter with empty state).

### Acceptance criteria

- [ ] Workspace list shows onboarding content when store has no projects/workspaces
- [ ] Panel layout renders default layout when no persisted layout exists
- [ ] Data populates reactively when sync delivers events — no full-page re-render
- [ ] No console errors, rendering crashes, or broken UI with empty store
- [ ] Tests verify placeholder rendering and smooth transition to populated state

### Blocked by

- Blocked by "Switch LiveStore to non-blocking sync" (#1)

### User stories addressed

- User story 15: First-ever launch shows meaningful onboarding state

---

## Issue 4: Lifecycle phase enum and context

### What to build

Create the core lifecycle phase system for the renderer. This is a deep module — small public interface (an enum, a context provider, one hook) with the phase transition logic encapsulated inside.

Define a `LifecyclePhase` enum with 4 values: `Starting` (1), `Ready` (2), `Restored` (3), `Eventually` (4). Create a `LifecyclePhaseProvider` React context that manages the current phase and exposes it via `useLifecyclePhase()`. Phase transitions are forward-only and irreversible — once the phase advances, it never regresses (even if a service crashes later).

The provider exposes an `advanceTo(phase)` method (for internal use by phase transition drivers in Issue #7) that only advances if the target phase is greater than the current phase.

Internally, the provider uses a Barrier pattern (inspired by VS Code) — each phase has an associated promise that resolves when that phase is reached. This enables `when(phase): Promise<void>` for imperative code that needs to wait for a phase.

See PRD sections: "4-Phase Renderer Lifecycle", "Lifecycle Phase Service (Renderer)".

### TDD approach

**Tracer bullet:** Test that the phase starts at `Starting` and can advance forward.

Behaviors to test (through public hooks only, not internal barriers):
1. Initial phase is `Starting`
2. `advanceTo(Ready)` changes phase to `Ready`
3. `advanceTo(Starting)` after `Ready` is a no-op (no regression)
4. `advanceTo(Eventually)` skips intermediate phases (jumps forward)
5. `when(phase)` promise resolves when phase is reached
6. `when(phase)` resolves immediately if phase already passed
7. Multiple `advanceTo` calls with the same phase are idempotent

Do not mock internal state. Test through `useLifecyclePhase()` and `when()`.

### Acceptance criteria

- [ ] `LifecyclePhase` enum with `Starting`, `Ready`, `Restored`, `Eventually` values
- [ ] `LifecyclePhaseProvider` context manages current phase
- [ ] `useLifecyclePhase()` hook returns current phase
- [ ] Phase transitions are forward-only — `advanceTo` with a lower phase is a no-op
- [ ] `when(phase)` returns a promise that resolves when the phase is reached (or immediately if already past)
- [ ] Provider wired into root route (renders above all other providers)
- [ ] Tests verify forward-only transitions, `when()` resolution, and idempotency

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1: See app UI within 1 second of launching
- User story 7: Navigate between workspaces during startup
- User story 20: Lifecycle phases invisible during fast startups

---

## Issue 5: `useWhenPhase` hook and service status hook

### What to build

Build two hooks on top of the lifecycle phase context from Issue #4:

1. **`useWhenPhase(phase): boolean`** — Returns `false` until the specified phase is reached, then `true`. Components use this to conditionally render or enable features based on the current lifecycle phase. This is the primary API for phase-aware UI.

2. **`useServiceStatus(): Map<ServiceName, ServiceState>`** — Returns a reactive map of per-service health states (`starting`, `healthy`, `degraded`, `error`). Aggregates data from sidecar status events (Electron IPC or dev polling) and LiveStore sync status. This is the data source for header status indicators and for driving phase transitions.

Both hooks are consumers of the lifecycle context — they don't drive transitions, they react to them.

See PRD sections: "Lifecycle Phase Service (Renderer)", "Header Service Status Indicators" (data flow).

### TDD approach

**Tracer bullet:** Test that `useWhenPhase(Ready)` returns false during Starting and true after Ready.

Behaviors to test:
1. `useWhenPhase(Ready)` returns `false` during `Starting` phase
2. `useWhenPhase(Ready)` returns `true` after phase advances to `Ready`
3. `useWhenPhase(Starting)` returns `true` immediately (always past)
4. `useWhenPhase(Eventually)` returns `false` until `Eventually` phase
5. `useServiceStatus()` reflects sidecar status events (server starting → healthy)
6. `useServiceStatus()` includes sync status from LiveStore
7. `useServiceStatus()` updates reactively when events arrive

Mock at system boundaries: DesktopBridge IPC events (external), health poll responses (external).

### Acceptance criteria

- [ ] `useWhenPhase(phase)` returns boolean based on current lifecycle phase
- [ ] `useServiceStatus()` returns per-service health map
- [ ] Service status aggregates sidecar events and LiveStore sync status
- [ ] Both hooks update reactively when phase transitions or service events occur
- [ ] Tests verify hook return values across phase transitions

### Blocked by

- Blocked by "Lifecycle phase enum and context" (#4)

### User stories addressed

- User story 3: See status indicators showing which services are starting/ready/degraded
- User story 4: Status indicators show individual service states

---

## Issue 6: Remove ServerGate blocking gate

### What to build

Remove the `ServerGate` component from the root route's render tree. Currently, `ServerGate` wraps `LiveStoreProvider` and all route content, blocking everything until all 3 core sidecars report healthy. With non-blocking LiveStore (Issue #1) and the lifecycle phase service (Issue #4), this gate is no longer needed.

Restructure `__root.tsx` so that `LiveStoreProvider` renders immediately (it now loads from OPFS without needing the server). The `LifecyclePhaseProvider` replaces `ServerGate` as the mechanism for tracking service readiness — but it doesn't block rendering.

The `ServerGate` component file can be deleted or retained for reference. The sidecar status subscription logic it contained moves to Issue #7 (wiring status events to lifecycle phases).

See PRD section: "Remove ServerGate Blocking".

### TDD approach

**Tracer bullet:** Test that route content renders without the server running.

Behaviors to test:
1. Root route renders `Header`, `LiveStoreProvider`, and `Outlet` without server running
2. `LiveStoreProvider` loads store from OPFS in Phase 1 (Starting)
3. No blocking overlay or spinner prevents content from rendering
4. Route navigation works during Phase 1

Mock at system boundaries: LiveStore (in-memory adapter), sidecar status (all services `starting`).

### Acceptance criteria

- [ ] `ServerGate` removed from `__root.tsx` render tree
- [ ] `LiveStoreProvider` renders immediately, loads from OPFS
- [ ] Route content (Outlet) renders during Phase 1 without server
- [ ] No blocking overlay prevents interaction
- [ ] Navigation between routes works during startup
- [ ] Tests verify rendering without server available

### Blocked by

- Blocked by "Switch LiveStore to non-blocking sync" (#1)
- Blocked by "Lifecycle phase enum and context" (#4)

### User stories addressed

- User story 1: See app UI within 1 second of launching
- User story 2: See last-known workspace list immediately on launch
- User story 7: Navigate between workspaces during startup
- User story 8: Read-only workspace views work before server ready
- User story 12: App continues in degraded mode if server goes down

---

## Issue 7: Wire sidecar status events to lifecycle phase transitions

### What to build

Connect the sidecar health event sources to the lifecycle phase transition driver. This is where the actual phase transitions happen:

- **Starting → Ready:** Triggered when the server sidecar reports `healthy` (via `onSidecarStatus` IPC in Electron production, or HTTP health poll in dev mode).
- **Ready → Restored:** Triggered when ALL of: (a) terminal sidecar reports `healthy`, (b) file-watcher sidecar reports `healthy`, (c) LiveStore sync status indicates caught up.
- **Restored → Eventually:** Triggered by the server's "fully initialized" event (Issue #15). Until that event system exists, this can be triggered on a timeout or when all deferred RPCs become available.

This issue moves the sidecar status subscription logic from the deleted `ServerGate` into the `LifecyclePhaseProvider` (or a dedicated hook consumed by it). In dev mode, it adapts the existing health polling logic. In Electron production, it subscribes to `desktopBridge.onSidecarStatus()`.

See PRD sections: "Lifecycle Phase Service (Renderer)" (phase transition triggers), "Graceful Degradation Matrix".

### TDD approach

**Tracer bullet:** Test that the phase advances from Starting to Ready when the server reports healthy.

Behaviors to test:
1. Phase stays at `Starting` when no sidecar events received
2. Phase advances to `Ready` when server reports `healthy`
3. Phase does not advance to `Ready` on terminal-only or file-watcher-only healthy events
4. Phase advances to `Restored` when terminal + file-watcher + sync are all ready (after server already healthy)
5. Phase advances to `Restored` even if terminal/file-watcher report healthy before server (events arrive out of order)
6. Phase transitions work in dev mode (health poll) and Electron mode (IPC events)

Mock at system boundaries: DesktopBridge IPC (external), health poll HTTP responses (external), LiveStore sync status (external).

### Acceptance criteria

- [ ] Starting → Ready triggers on server healthy event
- [ ] Ready → Restored triggers on terminal + file-watcher + sync all ready
- [ ] Handles out-of-order events correctly (terminal healthy before server)
- [ ] Works in both Electron production (IPC) and dev mode (HTTP poll)
- [ ] Tests verify each phase transition trigger condition

### Blocked by

- Blocked by "`useWhenPhase` hook and service status hook" (#5)
- Blocked by "Remove ServerGate blocking gate" (#6)

### User stories addressed

- User story 10: Terminal works as soon as terminal sidecar healthy
- User story 11: App recovers gracefully from sidecar crash
- User story 20: Phases invisible during fast startups

---

## Issue 8: Header per-service status dots

### What to build

Rework the existing `ServiceStatusPills` component into lifecycle-phase-aware service status indicators in the header. Each service (Server, Terminal, File Watcher) gets a compact status dot showing its current state: `starting` (pulsing animation), `healthy` (green/solid), `error` (red).

The indicators consume `useServiceStatus()` from Issue #5 for their data. They replace the existing `ServiceStatusPills` which currently iterate `ALL_SIDECAR_NAMES` with a simpler status display. The LiveStore sync indicator from Issue #2 is rendered alongside these but remains visually distinct.

See PRD section: "Header Service Status Indicators" (individual service indicators).

### TDD approach

**Tracer bullet:** Test that each service shows the correct state based on `useServiceStatus()`.

Behaviors to test:
1. Server dot shows `starting` state when server status is `starting`
2. Server dot shows `healthy` state when server status is `healthy`
3. Server dot shows `error` state when server status is `crashed`
4. All three services render independently (server healthy, terminal starting, file-watcher error)
5. MCP service is excluded from the primary indicators (it's not a core service)

Mock: `useServiceStatus()` return values.

### Acceptance criteria

- [ ] Individual status dots for Server, Terminal, File Watcher in header
- [ ] Each dot reflects its service's current state (`starting`/`healthy`/`error`)
- [ ] Dots consume `useServiceStatus()` reactively
- [ ] Pulsing animation for `starting` state
- [ ] Existing `ServiceStatusPills` replaced or refactored
- [ ] Tests verify correct state rendering for each service independently

### Blocked by

- Blocked by "`useWhenPhase` hook and service status hook" (#5)

### User stories addressed

- User story 3: Status indicators showing which services are starting/ready/degraded
- User story 4: Individual service states visible
- User story 18: Animated transitions between states

---

## Issue 9: Header status collapse and expand

### What to build

When all services are healthy, the individual status dots from Issue #8 should collapse to a single minimal indicator (a small green dot or checkmark) after a 2-second delay. This prevents the indicators from taking up header space during normal operation.

Clicking or hovering on the collapsed indicator expands it to show per-service detail: service name, current state, uptime/timestamp, and a "Restart" action for each service. The expanded view also includes the sync status from Issue #2.

The 2-second delay prevents flickering on fast startups where services go from `starting` to `healthy` quickly — the user may never see the expanded state at all.

See PRD section: "Header Service Status Indicators" (collapsed state, expanded on hover/click).

### TDD approach

**Tracer bullet:** Test that indicators collapse to compact form after 2 seconds of all-healthy.

Behaviors to test:
1. Indicators show expanded (per-service dots) when any service is not healthy
2. Indicators collapse to single compact indicator 2 seconds after all services become healthy
3. Clicking compact indicator expands to show per-service detail
4. Expanded view shows service name, state, and restart action
5. Restart action calls `desktopBridge.restartSidecar(name)`
6. If a service goes unhealthy while collapsed, indicators expand immediately (no 2s delay)
7. On fast startup (all healthy within 500ms), user never sees expanded dots — goes straight to compact

Mock at system boundaries: Timer (fake timers for 2s delay), DesktopBridge restart calls.

### Acceptance criteria

- [ ] Individual dots collapse to single compact indicator after 2s of all-healthy
- [ ] Click/hover on compact indicator shows per-service detail popover
- [ ] Detail view shows service name, state, and restart action
- [ ] Restart action triggers `desktopBridge.restartSidecar()`
- [ ] Immediate expansion if any service goes unhealthy while collapsed
- [ ] No flickering on fast startups (minimum display duration)
- [ ] Tests verify collapse timing, expand interaction, and restart action

### Blocked by

- Blocked by "Header per-service status dots" (#8)

### User stories addressed

- User story 5: Compact "all healthy" state
- User story 6: Click on indicator to see detail and take action

---

## Issue 10: Header error state persistence and animations

### What to build

Error states in the header status indicators should persist until the user explicitly dismisses them or the service recovers. This prevents users from missing important failures. Add a dismiss/retry action to error indicators.

Add smooth animated transitions between indicator states (`starting` → `healthy`, `healthy` → `error`, etc.). Use CSS transitions or Framer Motion for the dot color/icon changes.

Implement a minimum display duration (e.g., 300ms) for transitional states to prevent flickering when services transition rapidly (e.g., on fast startup where everything is ready in under 500ms).

See PRD section: "Header Service Status Indicators" (states, collapsed state), Polishing Requirements #1, #2, #4.

### TDD approach

**Tracer bullet:** Test that an error state persists until dismissed.

Behaviors to test:
1. Error indicator persists after service crashes (doesn't auto-dismiss)
2. Dismiss action removes the error indicator
3. Retry action triggers restart and transitions indicator to `starting`
4. No flickering when phases transition in under 500ms (minimum display duration)
5. Animated transitions don't cause layout shifts (fixed-width containers)
6. Recovery from error automatically transitions indicator to `healthy`

Mock at system boundaries: Timers (fake timers for minimum display duration), DesktopBridge restart.

### Acceptance criteria

- [ ] Error states persist until dismissed or service recovers
- [ ] Dismiss and retry actions on error indicators
- [ ] Smooth animated transitions between all states
- [ ] Minimum 300ms display duration for transitional states (no flickering)
- [ ] No layout shifts during transitions (fixed-width containers)
- [ ] Tests verify error persistence, dismiss/retry, and minimum display duration

### Blocked by

- Blocked by "Header per-service status dots" (#8)

### User stories addressed

- User story 18: Animated transitions between states
- User story 19: Error states persist with retry action
- User story 20: Lifecycle phases invisible during fast startups

---

## Issue 11: Disable write actions before Phase 2 (Ready)

### What to build

During Phase 1 (Starting), the server is not yet available, so all write operations that depend on server RPCs should be visually disabled with a clear explanation. This includes: workspace creation buttons, git operation triggers, project creation, and any other server-dependent mutations.

Components use `useWhenPhase(LifecyclePhase.Ready)` to determine whether to enable write actions. When disabled, buttons show a loading spinner or are grayed out, and tooltips explain "Connecting to server..." or similar.

This is an audit-and-update task across all components that trigger server RPCs. The scope is limited to Phase 1 → Phase 2 (Ready) transitions — Phase 3/4 feature gating is in Issue #12.

See PRD sections: "Remove ServerGate Blocking" (components handle "not ready" states individually), "Graceful Degradation Matrix" (Phase 1 row).

### TDD approach

**Tracer bullet:** Test that the create-workspace button is disabled during Phase 1 and enabled in Phase 2.

Behaviors to test:
1. Create-workspace button is disabled and shows "Connecting..." during Phase 1
2. Create-workspace button enables when phase advances to Ready
3. Disabled buttons have appropriate tooltip explaining why they're disabled
4. Form submissions are blocked during Phase 1 (not just visually disabled)
5. Buttons don't flash between disabled/enabled during fast phase transitions

Mock: Lifecycle phase context (set phase directly). Do not mock individual component internals.

### Acceptance criteria

- [ ] All server-dependent write actions disabled during Phase 1
- [ ] Disabled state shows loading spinner or grayed-out appearance
- [ ] Tooltip on disabled elements explains "Connecting to server..."
- [ ] Actions enable immediately when phase advances to Ready
- [ ] No accidental submissions possible during Phase 1 (form-level blocking)
- [ ] Tests verify disable/enable behavior for key actions

### Blocked by

- Blocked by "`useWhenPhase` hook and service status hook" (#5)
- Blocked by "Remove ServerGate blocking gate" (#6)

### User stories addressed

- User story 8: Read-only workspace views work before server ready
- User story 9: Write operations show "connecting..." state

---

## Issue 12: Progressive feature enablement for Phases 3-4

### What to build

Extend the phase-aware degradation from Issue #11 to cover Phases 3 (Restored) and 4 (Eventually):

**Phase 3 (Restored) features:**
- Terminal panel: shows "Terminal service connecting..." placeholder before Phase 3. Renders normally after Restored.
- File watcher: file change indicators may show stale data before Phase 3. After Restored, live updates work.

**Phase 4 (Eventually) features:**
- Docker status banner: hidden or shows "Checking Docker..." before Phase 4. Shows actual Docker status after Eventually.
- PR status indicators: show "Loading..." or skeleton before Phase 4. Populate when PR watcher data arrives.
- Branch ahead/behind counts: populate progressively as background fetch completes.

Each feature uses `useWhenPhase()` to gate its full functionality, showing appropriate loading/placeholder states in earlier phases.

See PRD sections: "Graceful Degradation Matrix" (Phases 3 and 4 rows), "4-Phase Renderer Lifecycle" (what's available at each phase).

### TDD approach

**Tracer bullet:** Test that the terminal panel shows a connecting state before Phase 3.

Behaviors to test:
1. Terminal panel shows "Terminal service connecting..." before Phase 3 (Restored)
2. Terminal panel renders normally after Phase 3
3. Docker status banner hidden or shows placeholder before Phase 4 (Eventually)
4. Docker status banner shows real status after Phase 4
5. PR status shows skeleton/loading before Phase 4
6. PR status populates after Phase 4 without full re-render

Mock: Lifecycle phase context (set phase directly).

### Acceptance criteria

- [ ] Terminal panel shows connecting placeholder before Phase 3
- [ ] Docker status banner gated behind Phase 4
- [ ] PR status and branch tracking populate progressively
- [ ] Each feature transitions smoothly from placeholder to real content
- [ ] No broken UI in any intermediate phase
- [ ] Tests verify feature availability at each phase

### Blocked by

- Blocked by "Disable write actions before Phase 2 (Ready)" (#11)

### User stories addressed

- User story 10: Terminal works as soon as terminal sidecar healthy
- User story 16: Docker features appear progressively
- User story 17: PR status populates progressively

---

## Issue 13: Server core layer group (fast health endpoint)

### What to build

Split the server's monolithic Effect layer graph (currently ~25 layers, all must build before the health endpoint responds) into a "core" group that starts fast.

**Core layers** (build before health endpoint responds):
- `ServerLive` — HTTP server binding
- `LaborerStoreLive` — LiveStore with SQLite persistence
- `SyncRpcLive` — LiveStore WebSocket sync endpoint
- `RpcLive` — Business RPC endpoint
- `RpcSerialization.layerJson` — JSON wire format
- `CustomRoutesLive` — Health check endpoint (`GET /`)
- `ConfigService` — Configuration resolution
- `ProjectRegistry` — Project management
- `RepositoryIdentity` — Git repository identification

Restructure `packages/server/src/main.ts` so that the core layers compose and launch first. The HTTP server starts accepting connections (including the health endpoint) as soon as core layers are built. The remaining ~16 deferred layers are handled in Issue #14.

This is a refactor of the layer composition in `main.ts` — the individual service implementations don't change, only how they're composed and when they're built.

See PRD section: "Server Layer Graph Splitting" (core layers list).

### TDD approach

**Tracer bullet:** Test that the health endpoint responds before all layers finish building.

Behaviors to test:
1. Health endpoint (`GET /`) responds with `{ status: 'ok' }` within 1 second of server start
2. Core RPCs (project list, workspace list, config read) work before deferred layers finish
3. LiveStore sync WebSocket (`GET /rpc`) accepts connections before deferred layers finish
4. Server process starts and becomes healthy without terminal or file-watcher sidecars running

Use the existing test infrastructure in `packages/server/test/rpc/test-layer.ts` — adapt it to test with only core layers provided.

Mock at system boundaries: Sidecar HTTP endpoints (not running).

### Acceptance criteria

- [ ] Health endpoint responds as soon as core layers are built
- [ ] Core RPCs work before deferred layers finish initialization
- [ ] LiveStore sync endpoint accepts connections immediately
- [ ] Server starts without requiring terminal or file-watcher sidecars
- [ ] Layer composition in `main.ts` clearly separates core from deferred
- [ ] Tests verify health and core RPCs without deferred layers

### Blocked by

None — can start immediately.

### User stories addressed

- User story 1: See app UI within 1 second of launching (faster server health = faster Phase 2)

---

## Issue 14: Server deferred layer group (background initialization)

### What to build

The remaining ~16 layers that are not in the core group (Issue #13) are initialized as background fibers after the HTTP server starts accepting connections. These are forked using Effect's concurrency primitives (e.g., `Effect.forkDaemon` or `Layer.launch` in a background fiber).

**Deferred layers:**
- `TerminalClient`, `FileWatcherClient` (lazy connections, Issue #16)
- `DockerDetection`, `DepsImageService`, `ContainerService`
- `WorkspaceProvider`, `WorktreeDetector`, `WorktreeReconciler`
- `PortAllocator`, `BranchStateTracker`, `RepositoryWatchCoordinator`
- `WorkspaceSyncService`, `PrWatcher`, `BackgroundFetchService`
- `DiffService`, `PrdStorageService`, `TaskManager`
- `LinearTaskImporter`, `GithubTaskImporter`, `ReviewCommentFetcher`
- `McpRegistrar`

RPC handlers for deferred services need to handle the case where their backing service isn't ready yet. They should return a typed "service initializing" error (e.g., a tagged `ServiceInitializing` error in the RPC response) that the renderer can interpret and show appropriate loading states.

A `Ref<boolean>` (or similar) per deferred service tracks initialization status, and the RPC handler checks it before dispatching to the service.

See PRD section: "Server Layer Graph Splitting" (deferred layers list, background initialization pattern).

### TDD approach

**Tracer bullet:** Test that a deferred RPC returns "service initializing" error before the layer is ready.

Behaviors to test:
1. RPC for a deferred service returns `ServiceInitializing` error before layer completes
2. Same RPC succeeds after the deferred layer has initialized
3. All deferred layers eventually initialize (no deadlocks or forgotten layers)
4. Deferred layer failure is logged but doesn't crash the server
5. Core RPCs continue working regardless of deferred layer state

Use the existing test layer infrastructure. Provide core layers eagerly and deferred layers with artificial delays to test the transition.

### Acceptance criteria

- [ ] Deferred layers fork as background fibers after core HTTP server starts
- [ ] RPC handlers return typed `ServiceInitializing` error before their layer is ready
- [ ] RPCs succeed normally after their deferred layer initializes
- [ ] Deferred layer failures are logged, don't crash the server
- [ ] Core RPCs unaffected by deferred layer state
- [ ] Tests verify initializing error → success transition for deferred RPCs

### Blocked by

- Blocked by "Server core layer group (fast health endpoint)" (#13)

### User stories addressed

- User story 16: Docker features appear progressively
- User story 17: PR status populates progressively

---

## Issue 15: Server "fully initialized" event

### What to build

Add a mechanism for the server to notify the renderer when all deferred layers have completed initialization. This event triggers the `Restored → Eventually` phase transition in the renderer's lifecycle phase service.

Options for the transport:
- **New RPC stream endpoint:** A streaming RPC that the renderer subscribes to on connection, which emits initialization progress events and a final "fully initialized" event.
- **WebSocket message on the existing sync channel:** Piggyback on the existing LiveStore sync WebSocket connection.
- **Polling endpoint:** A simple `GET /initialization-status` endpoint the renderer polls.

The RPC stream approach is preferred as it fits the existing `@effect/rpc` patterns. The renderer subscribes when it reaches Phase 2 (Ready) and advances to Phase 4 (Eventually) when the event arrives.

See PRD section: "Server Layer Graph Splitting" (server emits "fully initialized" event).

### TDD approach

**Tracer bullet:** Test that the "fully initialized" event fires after all deferred layers complete.

Behaviors to test:
1. Server emits "fully initialized" event when all deferred layers report ready
2. Event is not emitted until ALL deferred layers are ready (partial initialization doesn't trigger it)
3. Renderer receives the event via RPC stream and transitions to Eventually phase
4. If some deferred layers fail, the event still fires (with degraded status) after all have resolved
5. Late-connecting renderers (connected after all layers are ready) receive the event immediately

Mock at system boundaries: Deferred layer initialization (use artificial delays/failures).

### Acceptance criteria

- [ ] Server emits "fully initialized" event when all deferred layers complete
- [ ] Event includes information about which layers succeeded/failed
- [ ] Renderer can subscribe to initialization status via RPC stream
- [ ] Late-connecting clients receive current status immediately
- [ ] Tests verify event timing, partial failure handling, and renderer receipt

### Blocked by

- Blocked by "Server deferred layer group (background initialization)" (#14)

### User stories addressed

- User story 16: Docker features appear progressively (Eventually phase)
- User story 17: PR status populates progressively (Eventually phase)

---

## Issue 16: Lazy sidecar connections (TerminalClient + FileWatcherClient)

### What to build

Change `TerminalClient` and `FileWatcherClient` in the server from eager connections (connect during layer construction, blocking server startup) to lazy connections (connect on first RPC call).

Currently, both services build their `RpcClient` during `Layer.scoped` construction, which establishes HTTP/WebSocket connections to the terminal and file-watcher sidecars. If those sidecars aren't running yet, the server's layer construction blocks or fails.

Change to:
- **Construct immediately:** The layer builds instantly, returning a service object with the same public interface
- **Connect lazily:** The actual RPC client connection is established on the first call to any method (e.g., `spawnInWorkspace`, `subscribe`)
- **Retry with backoff:** If the sidecar isn't available on first call, retry with exponential backoff (matching the existing `Schedule.exponential('1 second')` pattern in FileWatcherClient)
- **Graceful error:** If the sidecar remains unavailable after retries, return a typed error that the renderer can handle (e.g., "Terminal service unavailable")

The event stream subscriptions (TerminalClient subscribes to `rpcClient.terminal.events()`, FileWatcherClient subscribes to `rpcClient.watcher.events()`) should also start lazily — they begin when the connection is first established and reconnect on connection loss.

See PRD section: "Lazy Sidecar Connections".

### TDD approach

**Tracer bullet:** Test that the server starts without the terminal sidecar running.

Behaviors to test:
1. Server layer builds and health endpoint responds without terminal sidecar running
2. Server layer builds and health endpoint responds without file-watcher sidecar running
3. First terminal RPC call (`spawnInWorkspace`) triggers connection to terminal sidecar
4. First file-watcher RPC call (`subscribe`) triggers connection to file-watcher sidecar
5. RPC returns typed error if sidecar is unavailable after retry attempts
6. Connection is re-established automatically if sidecar restarts
7. Event stream subscription starts after first successful connection

Use existing mock layers in `test/helpers/` as reference. Create new mock layers that simulate delayed sidecar availability.

### Acceptance criteria

- [ ] Server starts and responds to health checks without terminal or file-watcher running
- [ ] TerminalClient connects lazily on first RPC call
- [ ] FileWatcherClient connects lazily on first RPC call
- [ ] Retry with exponential backoff when sidecar unavailable
- [ ] Typed error returned to caller when sidecar remains unavailable
- [ ] Event stream subscription starts after connection established
- [ ] Automatic reconnection on sidecar restart
- [ ] Tests verify lazy connection, retry, and error handling

### Blocked by

- Blocked by "Server deferred layer group (background initialization)" (#14)

### User stories addressed

- User story 10: Terminal works as soon as terminal sidecar healthy (independent of other services)
- User story 11: App recovers gracefully from sidecar crash

---

## Issue 17: Parallel sidecar spawning

### What to build

Change the `HealthMonitor.spawnServices()` method from sequential spawning (terminal + file-watcher first, then server) to fully parallel spawning. With lazy sidecar connections from Issue #16, the server no longer needs terminal and file-watcher to be healthy before starting.

Change from:
```
1. Spawn terminal + file-watcher in parallel, wait for both healthy
2. Then spawn server, wait for healthy
```
to:
```
1. Spawn all three (terminal, file-watcher, server) in parallel
2. Each reports healthy independently via status events
3. Renderer lifecycle phases advance as each becomes ready
```

This eliminates the sequential spawn bottleneck. The server can start initializing its core layers while terminal and file-watcher are still booting. Each sidecar's health status is reported independently to the renderer via `onSidecarStatus` events (already wired in Issue #7).

See PRD section: "Parallel Sidecar Startup".

### TDD approach

**Tracer bullet:** Test that all 3 sidecars spawn simultaneously (not sequentially).

Behaviors to test:
1. All 3 sidecars spawn concurrently (server doesn't wait for terminal/file-watcher)
2. Server health reported independently of terminal/file-watcher health
3. Each sidecar emits its own status events independently
4. Total startup time is `max(server, terminal, file-watcher)` not `sum(terminal+file-watcher, server)`
5. If one sidecar fails to start, others continue normally
6. Crash recovery for individual sidecars still works (restart with backoff)

Use the existing `health.test.ts` test infrastructure. Create mock SidecarManager that tracks spawn order and timing.

### Acceptance criteria

- [ ] `spawnServices()` spawns all 3 sidecars in parallel (`Promise.all` or equivalent)
- [ ] No sequential dependency between server and terminal/file-watcher spawning
- [ ] Each sidecar reports healthy independently
- [ ] Individual sidecar failure doesn't block others
- [ ] Crash recovery still works per-sidecar
- [ ] Startup time improved (measured as max not sum)
- [ ] Tests verify parallel spawning and independent status reporting

### Blocked by

- Blocked by "Lazy sidecar connections (TerminalClient + FileWatcherClient)" (#16)

### User stories addressed

- User story 1: See app UI within 1 second of launching (faster sidecar startup)
- User story 11: App recovers gracefully from sidecar crash

---

## Dependency Graph

```
 #1 (LiveStore non-blocking) ─┬─── #2 (Sync indicator)
                               ├─── #3 (Empty cache)
                               └─┐
                                 ├── #6 (Remove ServerGate) ──┐
 #4 (Lifecycle enum/context) ──┐ │                            │
                               ├─┤                            │
                               │ └── #7 (Wire sidecar→phases) │
 #5 (useWhenPhase + status) ──┤                               │
                               ├──── #8 (Header dots) ──┬── #9 (Collapse/expand)
                               │                        └── #10 (Error/animations)
                               └──── #11 (Disable writes) ── #12 (Progressive features)

 #13 (Server core layers) ─── #14 (Server deferred layers) ──┬── #15 (Fully initialized event)
                                                              └── #16 (Lazy connections) ── #17 (Parallel spawning)
```

**Three independent starting tracks:**
1. **Frontend LiveStore:** #1 → #2, #3
2. **Frontend Lifecycle:** #4 → #5 → #8, #11
3. **Backend Server:** #13 → #14 → #15, #16 → #17

Tracks converge at #6 (needs #1 + #4) and #7 (needs #5 + #6).
