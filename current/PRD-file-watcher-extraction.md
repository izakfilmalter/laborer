# PRD: File Watcher Service Extraction

## Problem Statement

The file watcher system (FileWatcher + RepositoryEventBus) currently lives inside `@laborer/server`. This means filesystem watching — a resource-intensive, long-running concern — is tightly coupled to the main server process. If the server restarts during development, all active filesystem watchers are torn down and must be re-established. This mirrors the same problem that motivated the terminal service extraction: separating long-lived I/O concerns into independent processes that survive server restarts.

## Solution

Extract the low-level file watching and event normalization into a standalone `@laborer/file-watcher` service, following the same architectural pattern used for `@laborer/terminal`. The new service runs as its own HTTP server process, manages filesystem watchers, normalizes events through the RepositoryEventBus, and streams events to the main server via Effect RPC.

The server's `RepositoryWatchCoordinator` remains in the server — it continues to orchestrate which directories to watch and how to react to events (worktree reconciliation, branch tracking, etc.) — but delegates the actual filesystem watching to the file-watcher service via RPC.

## User Stories

1. As a developer, I want the file watcher to run as a separate process, so that filesystem watching survives server restarts during development.
2. As a developer, I want to subscribe to a directory for file change events via RPC, so that the main server can request watching without managing watcher lifecycle directly.
3. As a developer, I want to unsubscribe from a watched directory via RPC, so that watcher resources are released when a project is removed.
4. As a developer, I want to receive a stream of normalized file events (add/change/delete) via RPC, so that the main server can react to filesystem changes in real time.
5. As a developer, I want to pass ignore patterns when subscribing to a directory, so that noisy directories (node_modules, .git, dist) are filtered before events reach the server.
6. As a developer, I want the file-watcher service to support both `fs.watch` and `@parcel/watcher` backends with automatic fallback, so that the service works across platforms with optimal performance.
7. As a developer, I want a health check endpoint on the file-watcher service, so that the desktop app can monitor its status.
8. As a developer, I want the file-watcher service to run on a configurable port (FILE_WATCHER_PORT), so that it doesn't conflict with other services.
9. As a developer, I want the server's RepositoryWatchCoordinator to work with the file-watcher service via a FileWatcherClient, so that the coordinator's behavior is preserved without change.
10. As a developer, I want the server's DiffService to receive file events from the file-watcher service, so that event-driven diff invalidation continues to work.
11. As a developer, I want the desktop app's sidecar manager to manage the file-watcher service lifecycle, so that it starts/stops with the application.
12. As a developer, I want existing file-watcher and event-bus tests to move to the new package, so that test coverage is preserved.
13. As a developer, I want the FileWatcherClient to retry connections with exponential backoff, so that the server handles temporary file-watcher service unavailability gracefully.
14. As a developer, I want to list all active watch subscriptions via RPC, so that debugging and monitoring are possible.
15. As a developer, I want the file-watcher service to update ignore patterns for an active subscription, so that config changes take effect without re-subscribing.

## 'Polishing' Requirements

1. Verify that all existing server tests that depend on FileWatcher and RepositoryEventBus pass with the new architecture (either using the client or with test stubs).
2. Verify that the coordinator's debounced refresh behavior (worktree reconciliation, branch tracking) works correctly with the RPC-based event stream.
3. Ensure the DiffService's event-driven invalidation still triggers within acceptable latency (sub-500ms from file change to diff refresh start).
4. Verify clean shutdown: file-watcher service tears down all OS-level watchers when stopped.
5. Verify the desktop app correctly manages the file-watcher sidecar lifecycle (start, health check, restart on crash).
6. Verify that `bun run check` passes (typecheck + format + tests) for all affected packages.

## Implementation Decisions

### Architecture

- **Option A chosen**: Move only FileWatcher + RepositoryEventBus to the new service. The RepositoryWatchCoordinator stays in the server.
- The new service is a standalone HTTP server following the `@laborer/terminal` pattern.
- The server communicates with the file-watcher service via Effect RPC (HTTP protocol).

### RPC Contract (FileWatcherRpcs)

The file-watcher service exposes these RPC endpoints:

- **`watcher.subscribe`** — Start watching a directory. Accepts path, optional ignore globs, optional recursive flag. Returns a subscription ID.
- **`watcher.unsubscribe`** — Stop watching by subscription ID. Releases the underlying OS watcher.
- **`watcher.updateIgnore`** — Update ignore patterns for an active subscription.
- **`watcher.list`** — List all active subscriptions (subscription ID, path, ignore patterns).
- **`watcher.events`** — Streaming RPC that pushes normalized file events (add/change/delete with fileName, absolutePath, subscriptionId) to the subscriber. The stream stays open until the client disconnects.

### Error Type

- `FileWatcherRpcError` (tagged `'FileWatcherRpcError'`, fields: `message`, optional `code`).
- Error codes: `SUBSCRIBE_FAILED`, `NOT_FOUND`, `INTERNAL_ERROR`.

### Event Model

Events streamed via `watcher.events` use a schema with:
- `subscriptionId` — which subscription generated this event
- `type` — `'add' | 'change' | 'delete'`
- `fileName` — relative path of the changed file
- `absolutePath` — full path of the changed file

The event normalization (including `existsSync` inference for fs.watch backend and native kind mapping for @parcel/watcher) happens inside the file-watcher service, so the server receives clean, classified events.

### Modules to Build/Modify

1. **`packages/file-watcher/`** — New package scaffold (package.json, tsconfig.json, tsdown.config.ts, vitest.config.ts)
2. **`packages/file-watcher/src/main.ts`** — Standalone HTTP server on FILE_WATCHER_PORT
3. **`packages/file-watcher/src/services/file-watcher.ts`** — Moved from server, unchanged
4. **`packages/file-watcher/src/services/watcher-manager.ts`** — New service managing subscriptions (maps subscription IDs to FileWatcher instances + RepositoryEventBus normalization)
5. **`packages/file-watcher/src/rpc/handlers.ts`** — RPC handler layer for FileWatcherRpcs
6. **`packages/shared/src/rpc.ts`** — Add FileWatcherRpcs group, FileWatcherRpcError, event schemas
7. **`packages/env/src/server.ts`** — Add FILE_WATCHER_PORT (default 2104)
8. **`packages/shared/src/desktop-bridge.ts`** — Add `'file-watcher'` to SidecarName
9. **`packages/server/src/services/file-watcher-client.ts`** — New RPC client service (like TerminalClient)
10. **`packages/server/src/services/repository-watch-coordinator.ts`** — Replace direct FileWatcher/RepositoryEventBus usage with FileWatcherClient
11. **`packages/server/src/services/diff-service.ts`** — Subscribe to file events via FileWatcherClient instead of RepositoryEventBus directly
12. **`packages/server/src/main.ts`** — Remove FileWatcher.layer + RepositoryEventBus.layer, add FileWatcherClient.layer

### FileWatcherClient Design

The FileWatcherClient follows the TerminalClient pattern:
- Builds an RPC client for FileWatcherRpcs using `RpcClient.make`
- Subscribes to `watcher.events()` stream as a background scoped fiber
- Maintains an in-memory RepositoryEventBus (local to the server) that receives events from the RPC stream and fans them out to server-side subscribers (DiffService, etc.)
- Provides methods: `subscribe(path, ignore, recursive)`, `unsubscribe(subscriptionId)`, `onFileEvent(handler)`, `updateIgnore(subscriptionId, ignore)`
- Retry with exponential backoff if the file-watcher service disconnects

### What Stays in Server

- `RepositoryWatchCoordinator` — orchestration logic, debouncing, git metadata interpretation
- `BranchStateTracker` — git branch refresh
- `WorktreeReconciler` — worktree discovery and LiveStore updates
- `RepositoryIdentity` — canonical path resolution
- `ConfigService` — config resolution (watch ignore patterns passed to file-watcher via client)

## Testing Decisions

Good tests verify external behavior through public interfaces. They should not depend on implementation details like internal data structures, timer values, or private method calls.

### Modules to Test

1. **FileWatcher service (unit tests)** — Move `file-watcher.test.ts` to `packages/file-watcher/test/`. Tests backend selection, fallback behavior, and ignore option handling using mock drivers. Prior art: existing `packages/server/test/file-watcher.test.ts`.

2. **RepositoryEventBus (unit tests)** — Move `repository-event-bus.test.ts` to `packages/file-watcher/test/`. Tests event normalization, ignore rules, subscribe/unsubscribe, publish fanout. Prior art: existing `packages/server/test/repository-event-bus.test.ts`.

3. **RPC handlers (integration tests)** — New `packages/file-watcher/test/rpc-integration.test.ts`. Tests all FileWatcherRpcs endpoints via in-memory RPC. Prior art: `packages/terminal/test/rpc-integration.test.ts`.

4. **FileWatcherClient (integration tests)** — New `packages/server/test/file-watcher-client.test.ts`. Tests the server-side RPC client connecting to a mock or in-process file-watcher service. Prior art: terminal event stream subscription pattern in `TerminalClient`.

5. **Coordinator adaptation** — Verify existing `repository-watch-coordinator.test.ts` and `repository-watch-coordinator-hardening.test.ts` pass with the new client-based approach. May need test layer updates to provide FileWatcherClient instead of FileWatcher + RepositoryEventBus.

## Out of Scope

- Moving `RepositoryWatchCoordinator`, `BranchStateTracker`, `WorktreeReconciler`, or `ConfigService` to the file-watcher package (they have deep LiveStore dependencies)
- Desktop app sidecar manager implementation changes (just adding the type; the actual sidecar management is a separate concern)
- WebSocket-based event streaming (using HTTP RPC streaming, same as terminal events)
- Vite/web proxy configuration for the file-watcher service (not needed — no browser client)
- Legacy `WorktreeWatcher` service (`worktree-watcher.ts`) — already superseded, not part of this extraction

## Further Notes

- The file-watcher service has no LiveStore dependency — it is purely a filesystem watcher with RPC interface.
- The `@parcel/watcher` native addon dependency moves to the file-watcher package. It should be external in tsdown config (same as `node-pty` is for terminal).
- The `LABORER_FILE_WATCHER_BACKEND` env var (fs vs native) continues to work — it's read inside the FileWatcher service which moves to the new package.
- Port 2104 chosen for FILE_WATCHER_PORT to leave room after TERMINAL_PORT (2102) for future services.
