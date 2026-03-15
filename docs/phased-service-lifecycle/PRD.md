# PRD: Phased Service Lifecycle Architecture

## Problem Statement

The Laborer desktop app has a startup bottleneck caused by a sequential dependency chain that blocks the UI until all backend services are fully initialized. The current flow is:

1. Electron spawns terminal + file-watcher sidecars in parallel, health-polls them (up to 10s timeout each)
2. Only after both are healthy, spawns the server sidecar
3. The server blocks its own health endpoint until ALL ~25 Effect layers are built — including Docker detection, PR watchers, task importers, and connections to terminal + file-watcher sidecars
4. The renderer's `ServerGate` component blocks all meaningful UI until all three sidecars report healthy
5. Only then does LiveStore begin initializing — opening OPFS, replaying materializers, and performing a **blocking initial sync** with a 5-second timeout
6. Only after LiveStore sync completes does the actual app content render

This creates a worst-case startup time of 10+ seconds before any useful UI appears. The root causes are:

- **All-or-nothing gating:** The UI treats service readiness as binary — everything must be ready or nothing renders
- **Blocking LiveStore sync:** The app explicitly opts into `{ _tag: 'Blocking', timeout: 5000 }` even though LiveStore's default is non-blocking (`{ _tag: 'Skip' }`) and the store can serve locally-cached data immediately
- **Monolithic server layer graph:** The server's health endpoint doesn't respond until every service layer is built, including non-essential ones like Docker detection and PR watchers
- **Eager sidecar connections:** The server blocks startup on connecting to terminal and file-watcher sidecars, even though those connections aren't needed until a user interacts with a terminal or watches a file

VS Code solves this with a 4-phase lifecycle (`Starting → Ready → Restored → Eventually`), delayed service instantiation via proxies, and idle-time batching of non-essential work. GitHub Desktop solves it by rendering a loading state immediately and initializing stores asynchronously. Both approaches ensure the user sees a responsive UI within milliseconds of launch.

## Solution

Adopt a VS Code-inspired 4-phase lifecycle that progressively enables functionality as services come online. The UI renders instantly from locally-cached LiveStore data (OPFS), and services initialize in the background without blocking the user.

The Header displays real-time status indicators for each service and the current lifecycle phase, giving the user visibility into what's happening during startup and ongoing operation.

Key changes:

1. **LiveStore loads locally-first** — switch to non-blocking sync (`{ _tag: 'Skip' }`), render from OPFS cache immediately, sync in background
2. **Replace ServerGate with progressive enablement** — remove the blocking gate, render the full UI shell immediately, disable/loading-state features that need unavailable services
3. **Split server layer graph** — core layers (HTTP, LiveStore, RPC) start fast, deferred layers (Docker, PR watcher, etc.) initialize in the background
4. **Lazy sidecar connections** — server doesn't wait for terminal or file-watcher during startup, connects on first use
5. **Service status in Header** — persistent status indicators showing each service's phase and health

## User Stories

1. As a user, I want to see the app UI within 1 second of launching, so that the app feels responsive and modern
2. As a user, I want to see my last-known workspace list immediately on launch, so that I can orient myself before the server finishes starting
3. As a user, I want to see status indicators in the header showing which services are starting/ready/degraded, so that I understand what's happening during startup
4. As a user, I want the status indicators to show individual service states (server, terminal, file-watcher, LiveStore sync), so that I can diagnose which service is slow or failing
5. As a user, I want status indicators to show a compact "all healthy" state once everything is ready, so that they don't take up unnecessary space during normal operation
6. As a user, I want to click on a status indicator to see more detail about a degraded service, so that I can take action (e.g., restart a sidecar)
7. As a user, I want to navigate between workspaces during startup, so that I'm not blocked from basic navigation while services initialize
8. As a user, I want read-only workspace views to work before the server is fully ready, so that I can see code, diffs, and panel layouts from the local cache
9. As a user, I want write operations (creating workspaces, spawning terminals) to show a clear "connecting..." state rather than failing silently, so that I understand why an action isn't working yet
10. As a user, I want terminal interactions to work as soon as the terminal sidecar is healthy, independent of other services, so that I can start working even if Docker detection is still running
11. As a user, I want the app to recover gracefully if a sidecar crashes during operation, without losing my UI state, so that crashes feel like temporary blips rather than catastrophic failures
12. As a user, I want the app to continue working in a degraded mode if the server goes down temporarily, so that my local state (panel layouts, navigation) is preserved
13. As a user, I want LiveStore to sync in the background after launch, so that my local cache is updated without blocking my workflow
14. As a user, I want to see a subtle sync indicator when LiveStore is catching up, so that I know my data might be slightly stale
15. As a user, I want the app to handle the first-ever launch (empty OPFS cache) gracefully, showing a meaningful onboarding state rather than a broken empty UI
16. As a user, I want Docker-dependent features to appear/enable progressively as Docker detection completes, rather than blocking everything
17. As a user, I want PR status, branch tracking, and other background-fetched data to populate progressively, not block the initial render
18. As a user, I want the header status indicators to animate transitions between states (starting → healthy), so that the experience feels polished rather than jarring
19. As a user, I want error states in the header to persist with a retry action until I dismiss them, so that I don't miss important service failures
20. As a user, I want the lifecycle phases to be invisible during fast startups — if everything is ready in under 500ms, I should never see loading states at all

## 'Polishing' Requirements

1. Verify that the header status indicators collapse smoothly when all services are healthy — they should shrink to a minimal "all good" indicator or disappear entirely after a delay
2. Ensure status indicator animations don't cause layout shifts in the header — use fixed-width containers or absolute positioning
3. Verify that the first-launch experience (empty OPFS) shows appropriate placeholder content rather than empty tables or broken layouts
4. Test that rapid phase transitions (when services start very quickly) don't cause flickering — use minimum display durations for transitional states
5. Ensure that features gated behind a lifecycle phase show consistent loading/disabled states — audit all components for "service not ready" handling
6. Verify that the sync status indicator in the header is subtle enough for normal operation but noticeable enough when sync is actively catching up
7. Test keyboard navigation works correctly with progressively-enabled features — focus should not land on disabled elements
8. Ensure error states in the header are accessible (proper ARIA attributes, screen reader announcements)
9. Verify that the startup improvement is measurable — add telemetry/logging for time-to-first-paint, time-to-interactive, and time-to-fully-ready
10. Test that window restoration (multi-window) works correctly with the phased lifecycle — each window should independently track its own phase progression

## Implementation Decisions

### 4-Phase Renderer Lifecycle

Modeled after VS Code's `LifecyclePhase`, the renderer maintains a forward-only phase state:

| Phase | Name | Trigger | What's Available |
|-------|------|---------|------------------|
| 1 | **Starting** | App shell renders | Local OPFS data, navigation, panel layouts, cached workspace list. No server. |
| 2 | **Ready** | Server health check passes | Core RPCs, LiveStore sync begins in background, workspace CRUD, git operations |
| 3 | **Restored** | All sidecar connections established, LiveStore sync complete | Terminals, file watching, full read/write. UI state fully restored. |
| 4 | **Eventually** | Deferred services initialized (Docker, PR watcher, etc.) | Docker status, PR tracking, background fetch, task importers. Everything. |

Phase transitions are forward-only and irreversible. Components use a `when(phase): Promise<void>` API (backed by a `Barrier` pattern, as VS Code does) to defer work until the appropriate phase.

### Lifecycle Phase Service (Renderer)

A React context + hook system that manages phase state:

- `LifecyclePhaseProvider` — wraps the app root, manages the current phase
- `useLifecyclePhase()` — returns the current phase
- `useWhenPhase(phase)` — returns `true` only after the specified phase is reached
- `useServiceStatus()` — returns per-service health status for the header indicators

Phase transitions are driven by:
- **Starting → Ready:** Server health check succeeds (via sidecar status IPC in production, or HTTP poll in dev)
- **Ready → Restored:** LiveStore sync completes AND terminal + file-watcher sidecars report healthy
- **Restored → Eventually:** Deferred server services report ready (server emits a "fully initialized" event)

### Header Service Status Indicators

The Header gains a service status section with:

- **Individual service indicators:** Compact dots/icons for each service (Server, Terminal, File Watcher, Sync)
- **States:** `starting` (pulsing/animated), `healthy` (green), `degraded` (yellow), `error` (red)
- **Collapsed state:** When all services are healthy, indicators collapse to a single minimal indicator after 2 seconds, or hide entirely
- **Expanded on hover/click:** Shows detailed per-service status with timestamps and retry actions
- **Sync indicator:** Separate subtle indicator for LiveStore sync progress (only visible when actively syncing)

Status data flows from:
- **Electron production:** `desktopBridge.onSidecarStatus()` events (already exists)
- **Dev mode:** HTTP health polling (already exists in ServerGate)
- **LiveStore sync:** `useSyncStatus()` hook from `@livestore/react`
- **Server deferred services:** New IPC/RPC event for server layer initialization progress

### LiveStore Non-Blocking Sync

Change the worker configuration from:
```ts
initialSyncOptions: { _tag: 'Blocking', timeout: 5000 }
```
to:
```ts
// No initialSyncOptions (defaults to { _tag: 'Skip' })
```

This means:
- The store loads from OPFS immediately (fast-path boot reads persisted state database directly)
- WebSocket sync starts in the background
- The React `Suspense` boundary resolves as soon as OPFS is loaded (milliseconds, not seconds)
- UI renders with locally-cached data; background sync updates data reactively via LiveStore's reactive query system
- First-ever launch (empty OPFS) shows empty state — handled by the UI with appropriate onboarding/placeholder content

The `onSyncError` default (`'ignore'`) is kept, meaning sync failures don't crash the app — it continues in offline mode.

### Remove ServerGate Blocking

The current `ServerGate` component blocks all children until all 3 sidecars report healthy. This is replaced by:

1. **Remove the gate entirely** — children render immediately regardless of server status
2. **The `LifecyclePhaseProvider` tracks server readiness** — components that need the server use `useWhenPhase(LifecyclePhase.Ready)` to conditionally enable features
3. **Components handle "not ready" states individually** — buttons show loading spinners, forms are disabled, empty states explain that the server is connecting
4. **The header status indicators replace ServerGate's UI** — the startup progress visualization moves from a blocking overlay to a non-blocking header section

### Server Layer Graph Splitting

The server's ~25 Effect layers are split into two groups that initialize independently:

**Core Layers (build before health endpoint responds):**
- `ServerLive` — HTTP server binding
- `LaborerStoreLive` — LiveStore with SQLite persistence
- `SyncRpcLive` — LiveStore WebSocket sync endpoint
- `RpcLive` — Business RPC endpoint (handlers may return "service not ready" for deferred RPCs)
- `RpcSerialization.layerJson` — JSON wire format
- `CustomRoutesLive` — Health check endpoint
- `ConfigService` — Configuration resolution (needed for most operations)
- `ProjectRegistry` — Project management (needed for workspace operations)
- `RepositoryIdentity` — Git repository identification

**Deferred Layers (initialize in background after health endpoint is live):**
- `TerminalClient` — RPC client to terminal sidecar (lazy connection)
- `FileWatcherClient` — RPC client to file-watcher sidecar (lazy connection)
- `DockerDetection` — Docker CLI availability check
- `DepsImageService` — Docker image management
- `ContainerService` — Container lifecycle
- `WorkspaceProvider` — Workspace CRUD (depends on git operations but can initialize after core)
- `WorktreeDetector` — Git worktree scanning
- `WorktreeReconciler` — Worktree state reconciliation
- `PortAllocator` — Ephemeral port allocation
- `BranchStateTracker` — Branch ahead/behind tracking
- `RepositoryWatchCoordinator` — File watcher coordination
- `WorkspaceSyncService` — Workspace sync orchestration
- `PrWatcher` — GitHub PR status polling
- `BackgroundFetchService` — Periodic git fetch
- `DiffService` — Git diff computation
- `PrdStorageService` — PRD file management
- `TaskManager` — Task tracking
- `LinearTaskImporter` — Linear integration
- `GithubTaskImporter` — GitHub issues integration
- `ReviewCommentFetcher` — PR review comment fetching
- `McpRegistrar` — MCP server registration

The server uses Effect's `Layer.launch` for deferred layers, forking them as background fibers after the core HTTP server starts. The health endpoint responds as soon as core layers are built. RPC handlers for deferred services return a typed "service initializing" error until their layer is ready.

The server emits a "fully initialized" event (via a new RPC stream or WebSocket message) when all deferred layers have completed, triggering the `Restored → Eventually` phase transition in the renderer.

### Lazy Sidecar Connections

`TerminalClient` and `FileWatcherClient` in the server currently connect to their respective sidecars during layer construction (blocking the server's startup). These are changed to:

- **Lazy connection:** The RPC client is constructed immediately (no network call), but the actual WebSocket/HTTP connection to the sidecar is established on first RPC call
- **Retry with backoff:** If the sidecar isn't ready when first called, the client retries with exponential backoff
- **Graceful degradation:** RPCs that depend on an unavailable sidecar return a typed error that the renderer can handle (e.g., showing "Terminal service starting..." instead of a blank terminal panel)

This removes the sequential dependency: the server no longer needs to wait for terminal and file-watcher to be healthy before starting. All three sidecars can boot in parallel.

### Parallel Sidecar Startup

With lazy connections, the `HealthMonitor.spawnServices()` method changes from:
```
1. Spawn terminal + file-watcher in parallel, wait for healthy
2. Then spawn server, wait for healthy
```
to:
```
1. Spawn all three (terminal, file-watcher, server) in parallel
2. Each reports healthy independently
3. Phase transitions happen as each becomes ready
```

This eliminates the sequential spawn bottleneck entirely.

### First-Launch (Empty Cache) Handling

When OPFS has no cached data (first launch or cache cleared):
- The store initializes with empty tables (instant, no materializers to replay)
- The UI shows onboarding/empty-state content appropriate for each view
- Once the server is healthy and sync completes, data populates reactively
- The transition from empty to populated state should be smooth (no full-page re-renders)

### Graceful Degradation Matrix

| Service State | Available Features | Degraded Features | Unavailable Features |
|---|---|---|---|
| **Phase 1 (Starting):** No server | Navigate cached workspaces, view cached diffs/layouts, panel management | — | All server RPCs, terminal, file watching, creating anything |
| **Phase 2 (Ready):** Server only | + Workspace CRUD, git operations, config, project management | Terminal (shows "connecting"), file watching (stale) | Docker, PR tracking, background fetch |
| **Phase 3 (Restored):** All sidecars | + Terminal, file watching, full workspace operations | Docker status, PR tracking | Background data enrichment |
| **Phase 4 (Eventually):** Everything | All features | — | — |

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior (what the user sees and experiences), not implementation details (which Effect layer initialized in which order). A lifecycle phase transition is an observable behavior. An internal `Ref` being set is an implementation detail.

### Integration Tests for Lifecycle Phases

Test that phase transitions happen correctly and that the UI responds appropriately:

1. **Phase 1 (Starting) renders without server:** Mock all network calls to fail. Verify the UI shell renders, header shows "starting" indicators, cached workspace list appears, write-action buttons are disabled.

2. **Phase 1 → 2 transition:** Start with mocked-down server, then simulate server health check succeeding. Verify phase advances, header indicators update, write actions become enabled.

3. **Phase 2 → 3 transition:** Simulate LiveStore sync completion and sidecar health events. Verify terminal and file-watcher features enable.

4. **Phase 3 → 4 transition:** Simulate server "fully initialized" event. Verify Docker status, PR tracking, and other deferred features appear.

5. **Degraded state handling:** Simulate a sidecar crash during Phase 3. Verify the phase doesn't regress, the header shows an error indicator, affected features show error states, and recovery is possible.

6. **First-launch (empty cache):** Clear OPFS, start the app. Verify appropriate empty states render, data populates after sync.

### Startup Time Measurements

Add instrumentation to measure and assert improvements:

1. **Time to first paint (Phase 1):** From `app.whenReady()` to first meaningful render. Target: < 500ms.
2. **Time to interactive (Phase 2):** From `app.whenReady()` to server health check passing. Target: < 2s (down from 5-10s).
3. **Time to fully ready (Phase 4):** From `app.whenReady()` to all deferred services initialized. No strict target — this can take as long as needed since the user is already working.
4. **LiveStore load time:** From worker creation to store ready (OPFS load only, no sync). Target: < 200ms.

Measurements should be logged as structured telemetry events and optionally displayed in dev tools. Prior art: the existing `sendReady(time)` pattern from GitHub Desktop.

### Prior Art for Tests

The existing test infrastructure in `apps/desktop/test/` and the Effect-based service tests in `packages/server/` provide patterns for:
- Mocking IPC handlers
- Simulating sidecar health events
- Testing Effect layer composition

## Out of Scope

- **Changing the sidecar process model:** Terminal, file-watcher, and server remain as separate child processes. No collapsing or adding new sidecars.
- **Replacing the DI system:** Effect Layers remain the DI mechanism for backend services. No VS Code-style `InstantiationService` or `createDecorator`.
- **Rewriting IPC patterns:** The existing `DesktopBridge` interface, preload script, and IPC handler patterns remain unchanged. New events are added for lifecycle phase communication.
- **Changes to terminal or file-watcher service internals:** These services remain as-is. Only the server's connection to them changes (lazy instead of eager).
- **VS Code's `GlobalIdleValue` / Proxy-based delayed instantiation:** Effect's Layer system handles lazy construction differently (via `Layer.launch` for background fibers). We don't need to replicate VS Code's JavaScript Proxy pattern.
- **Offline-first conflict resolution:** LiveStore handles sync conflicts internally. This PRD does not add new conflict resolution logic.
- **Multi-window lifecycle coordination:** Each window manages its own lifecycle phases independently. Cross-window coordination is out of scope.

## Further Notes

### Reference Implementations

- **VS Code lifecycle phases:** `src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts` and `src/vs/workbench/services/lifecycle/common/lifecycle.ts` — the `Barrier`-backed `when(phase)` pattern
- **VS Code delayed instantiation:** `src/vs/platform/instantiation/common/instantiationService.ts` lines 292-385 — `GlobalIdleValue` proxy pattern (conceptual reference, not to be copied directly)
- **VS Code workbench contributions:** `src/vs/workbench/common/contributions.ts` — phased contribution instantiation with idle-time batching
- **LiveStore non-blocking sync:** `.reference/livestore/packages/@livestore/common/src/leader-thread/make-leader-thread-layer.ts` — `initialSyncOptions` defaults to `{ _tag: 'Skip' }`
- **LiveStore email client example:** `.reference/livestore/examples/web-email-client/` — sophisticated example using non-blocking sync with multiple stores
- **GitHub Desktop two-phase loading:** `.reference/desktop/app/src/ui/index.tsx` — `loadInitialState()` pattern with immediate render + async hydration

### Migration Strategy

This is a significant architectural change that should be rolled out incrementally:

1. **Phase 1 (Quick wins):** Switch LiveStore to non-blocking sync, remove ServerGate blocking, add basic header status indicators. This alone should cut perceived startup time by 50%+.
2. **Phase 2 (Server refactor):** Split server layer graph, implement lazy sidecar connections, parallelize sidecar spawning.
3. **Phase 3 (Lifecycle service):** Implement the full 4-phase lifecycle service, wire all components to use phase-aware rendering, add degradation matrix handling.
4. **Phase 4 (Polish):** Add startup telemetry, tune animations, handle edge cases (first launch, cache corruption, etc.).

### Risk: Stale Data on Launch

With non-blocking sync, the UI may briefly show stale data from the OPFS cache. This is acceptable because:
- LiveStore's reactive query system automatically re-renders components when sync updates arrive
- The sync indicator in the header communicates that data is catching up
- For a desktop app where the local cache is typically seconds-old (from the last session), staleness is minimal
- The alternative (5+ seconds of blank screen) is a worse user experience than briefly-stale data
