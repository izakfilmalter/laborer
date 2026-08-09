# PRD: Lazy File Service — On-Demand Tree, Diffs, and Watcher Events

## Problem Statement

The current file tree and diff panel architecture is over-engineered and fragile. It relies on full-repo recursive directory walks for the tree, polling-based workspace-level git diffs stored in LiveStore, and complex orchestration between the file watcher sidecar, DiffService, FileTreeService, and the web client.

Specific problems:

1. **Full-tree snapshots are expensive.** Every file change triggers a full recursive `readdir` of the entire worktree (potentially tens of thousands of files) plus a full `git status`. This is wasteful when only one directory changed.

2. **Polling-based diffs waste resources.** The DiffService polls `git diff` every 5 seconds for every active workspace, even when nothing has changed. The event-driven refresh path adds a second codepath with its own debouncing and cooldown logic.

3. **LiveStore is the wrong abstraction for ephemeral data.** Diff content is transient — it changes with every file save and has no value as a persistent event log. Storing it in LiveStore means every diff update is an event that gets persisted, synced, and materialized. This adds latency and complexity for data that should be fetched on-demand.

4. **The streaming FileTreeService is complex.** Each tree subscription manages its own file watcher subscription, debounce timer, abort controller, and dedup state. The lifecycle management is error-prone and the stream-per-workspace model means the server holds state for every open tree panel.

5. **No per-file diff granularity.** The current model computes a single monolithic workspace diff. The UI then parses this into per-file hunks. OpenCode's approach of including the diff inline with `File.read()` is simpler and more composable — the client gets exactly the data it needs for the file it's displaying.

## Solution

Replace the current architecture with OpenCode's lazy, on-demand file service pattern. The core insight is: **don't push data to the client — let the client pull what it needs, and use watcher events only for invalidation.**

The new architecture has three layers:

1. **File Service (server)** — stateless request/response RPCs for `file.list(dir)`, `file.read(path)`, and `file.status(workspaceId)`. No polling, no LiveStore, no streaming snapshots. Each call runs the minimal git/fs operation and returns the result.

2. **Watcher Event Stream (server → client)** — one streaming RPC per active workspace that forwards file change events (`add`/`change`/`unlink`) from the existing file watcher sidecar. The client uses these events for invalidation only — not for data.

3. **Client-side Invalidation (web)** — when a watcher event arrives, the client decides what to reload: if an open file changed, re-fetch its content; if a file was added/removed, refresh the affected parent directory listing. This replaces the server-side full-tree recomputation.

The file watcher sidecar (`@laborer/file-watcher`) remains as a separate utility process for architectural consistency with the terminal and MCP sidecars. The FileWatcherClient on the server continues to bridge events from the sidecar. What changes is everything downstream of the event fan-out.

## User Stories

1. As a developer, I want the file tree to load instantly when I open a workspace panel, so that I can navigate files without waiting for a full directory scan.

2. As a developer, I want to expand a directory in the file tree and see its contents within milliseconds, so that navigation feels responsive.

3. As a developer, I want the file tree to update automatically when I save a file, create a file, or delete a file, so that the tree always reflects the current filesystem state.

4. As a developer, I want only the affected directory to refresh when a file changes, so that expanding/collapsing state for other directories is preserved.

5. As a developer, I want to see git status decorations (added/modified/deleted) on files in the tree, so that I can see what has changed at a glance.

6. As a developer, I want to see which files are gitignored, so that I can distinguish between tracked and untracked files in the tree.

7. As a developer, I want to read a file and see its diff against HEAD inline, so that I can review changes for a single file without computing a workspace-wide diff.

8. As a developer, I want to see a summary of all changed files in a workspace (with line counts), so that the diff panel sidebar can show a file list.

9. As a developer, I want the diff panel to show per-file diffs fetched on-demand, so that opening a large workspace doesn't block on a monolithic diff computation.

10. As a developer, I want file content to auto-refresh when the file changes on disk, so that the diff panel always shows the latest state.

11. As a developer, I want the watcher event stream to be scoped per workspace, so that inactive workspaces generate zero network traffic.

12. As a developer, I want the system to handle workspaces that are still being created gracefully, so that the tree retries until the worktree directory exists.

13. As a developer, I want git processes to be cancelled when I close a panel, so that no orphaned subprocesses linger.

14. As a developer, I want the file tree to sort directories first, then files alphabetically, so that the listing is predictable and scannable.

15. As a developer, I want the file tree to skip noisy directories (node_modules, .git, dist, build), so that the tree is not overwhelmed with irrelevant entries.

16. As a developer, I want the file service to handle binary files gracefully, so that images are returned as base64 and binary files are flagged without attempting to read their content as text.

17. As a developer, I want the diff data to be computed lazily rather than polled, so that CPU usage is proportional to what I'm actually looking at.

18. As a developer, I want the branch detection to update when I switch branches, so that the workspace header reflects the current branch without polling.

19. As a developer, I want multiple workspaces open simultaneously where only visible ones consume watcher bandwidth, so that N workspaces don't mean N times the event processing.

20. As a developer, I want the file tree to show gitignored-but-present files (like `.reference/` or `data/`), so that the tree reflects the actual filesystem, not just git-tracked files.

## Polishing Requirements

1. Verify that expanding a deeply nested directory path works correctly and each level is fetched lazily without visual jank.

2. Confirm that closing and reopening the tree pane does not leak watcher subscriptions or leave orphaned git processes.

3. Ensure the diff panel handles edge cases: empty diffs, binary files, deleted files, newly created files, renamed files.

4. Verify that the file tree preserves expand/collapse state when a sibling directory's contents change.

5. Confirm that gitignore parsing correctly handles nested `.gitignore` files and `.ignore` files.

6. Ensure file paths with spaces and unicode characters are handled correctly in all RPCs.

7. Verify that the client-side watcher invalidation does not cause unnecessary re-renders (e.g., refreshing a directory that has the same contents).

8. Confirm that the transition from old to new architecture doesn't break LiveStore schema evolution (deprecated events need no-op materializers).

9. Ensure error states are properly surfaced in the UI: workspace not found, worktree not ready, git not installed, permission denied.

10. Verify that the file service respects the AGENTS.md code standards: explicit types, arrow functions, const by default, proper error handling.

## Implementation Decisions

### Architecture: Three-Layer Model

The system is structured as three independent layers:

**Layer 1 — File Service (server, `@laborer/server`)**

A new `FileService` Effect service with three stateless operations:

- `list(workspaceId, dir?)` — reads a single directory level using `readdir` with `withFileTypes`. Returns `FileNode[]` where each node has `name`, `path` (relative), `absolute`, `type` (file/directory), and `ignored` (boolean from `.gitignore` / `.ignore` parsing). Sorts directories first, then files alphabetically. Skips ignored directories (node_modules, .git, dist, etc.) and OS metadata files (.DS_Store, Thumbs.db). When `dir` is omitted, lists the worktree root.

- `read(workspaceId, filePath)` — reads file content and computes per-file diff against HEAD. Returns `FileContent` with `type` (text/binary), `content`, optional `diff` (raw git diff output), and optional `patch` (structured patch with hunks). Handles binary files (flagged without content), images (base64 encoded with mime type), and text files. Runs `git diff -- <file>` then falls back to `git diff --staged -- <file>` if the first is empty. Uses the `diff` npm library's `structuredPatch()` for the structured representation.

- `status(workspaceId)` — returns the list of changed files with line-level change counts. Runs `git diff --numstat HEAD` for modified files, `git ls-files --others --exclude-standard` for untracked/added files, and `git diff --name-only --diff-filter=D HEAD` for deleted files. Returns `FileInfo[]` with `path`, `added`, `removed`, and `status` (added/deleted/modified).

All three operations look up the workspace in LiveStore (for the worktree path), validate state, and run git with `-c core.fsmonitor=false` for consistency with the watcher stack.

**Layer 2 — Watcher Event Stream (server → client)**

A new streaming RPC `file.watcher.subscribe(workspaceId)` that:

1. Looks up the workspace to get the worktree path
2. Subscribes a recursive file watcher on the worktree via the existing `FileWatcherClient` (which talks to the sidecar)
3. Listens for events via `FileWatcherClient.onFileEvent()`, filtering by subscription ID
4. Streams `{ file: string, event: "add" | "change" | "unlink" }` objects to the client
5. On stream teardown (client disconnect), unsubscribes the file watcher

This replaces the current model where the server internally reacts to watcher events to recompute tree snapshots and diffs. Events now flow through to the client for invalidation.

**Layer 3 — Client-Side Invalidation (web app)**

A pure function `invalidateFromWatcher(event, ops)` that processes incoming watcher events:

- Ignores `.git/` path changes (those are handled by branch detection, not the file tree)
- For `"change"` events: if the file is currently displayed (open tab / diff view), re-fetches its content via `file.read`. If the path is a loaded directory, refreshes that directory listing.
- For `"add"` / `"unlink"` events: refreshes the parent directory listing so the new/removed entry appears/disappears. If the file is open, re-fetches it.

The tree pane maintains a local store (React state or atom) mapping directory paths to their listing state (`{ expanded, loaded, loading, error, children }`). Directories are listed lazily — fetched only on first expand. The store is keyed by workspace so multiple workspaces don't interfere.

### Data Layer Changes

**Remove from LiveStore:**
- `diffs` table definition
- `diffUpdated` event definition
- `diffCleared` event definition
- Materializers for `v1.DiffUpdated` and `v1.DiffCleared`

**Important:** Because the LiveStore eventlog is immutable and append-only, the event definitions must be retained as no-op materializers (returning `[]`) to satisfy backward compatibility. Old events in the eventlog still need to decode successfully. Only the table and active materializer logic are removed.

**Remove from RPC definitions:**
- `diff.refresh` RPC
- `fileTree.subscribe` streaming RPC

**Add to RPC definitions:**
- `file.list` — request/response, takes `workspaceId` and optional `dir`, returns `FileNode[]`
- `file.read` — request/response, takes `workspaceId` and `filePath`, returns `FileContent`
- `file.status` — request/response, takes `workspaceId`, returns `FileInfo[]`
- `file.watcher.subscribe` — streaming RPC, takes `workspaceId`, streams `FileWatcherEvent` objects

### Schema Definitions (shared package)

New types in `@laborer/shared/rpc`:

```
FileNode: { name, path, absolute, type: "file" | "directory", ignored: boolean }
FileContent: { type: "text" | "binary", content, diff?, patch?, encoding?, mimeType? }
FileInfo: { path, added: number, removed: number, status: "added" | "deleted" | "modified" }
FileWatcherEvent: { file: string, event: "add" | "change" | "unlink" }
```

### Branch Detection Simplification

Replace the current `RepositoryWatchCoordinator` + `BranchStateTracker` approach with OpenCode's simpler pattern:

- The file watcher sidecar watches the `.git` directory (filtering to only `HEAD` changes)
- When a `HEAD` change event arrives via the watcher stream, the server runs `git rev-parse --abbrev-ref HEAD` to get the current branch
- If the branch changed, commit a LiveStore event to update workspace metadata

This eliminates the need for separate git-dir watchers, worktree-dir watchers, debounce timers per concern, and the entire coordinator state machine.

### Multi-Workspace Performance

For workspaces that are not currently visible:
- No watcher event stream is active (the client doesn't subscribe)
- No polling occurs (there is no polling in the new model)
- The file watcher sidecar may still have subscriptions for branch detection, but event processing is minimal (only `HEAD` file changes)

For workspaces that are visible:
- One watcher event stream is active
- File tree listings are fetched lazily per directory on expand
- Diffs are fetched on-demand per file when displayed
- File status is fetched on-demand when the diff panel opens

### Services Removed

- `DiffService` — replaced by `FileService.read()` and `FileService.status()`
- `FileTreeService` — replaced by `FileService.list()`
- `RepositoryWatchCoordinator` — replaced by simplified branch detection via watcher events
- `BranchStateTracker` — absorbed into the simplified branch detection
- `RepositoryEventBus` — no longer needed, events flow directly from FileWatcherClient to the streaming RPC
- `visible-workspaces.ts` — no longer needed, visibility gating moves to the client
- Polling interval constants for diff and file tree (`DIFF_POLL_INTERVAL_MS`, `DIFF_EVENT_DEBOUNCE_MS`, `DIFF_EVENT_COOLDOWN_MS`, `FILE_TREE_EVENT_DEBOUNCE_MS`)

### Services Retained

- `FileWatcherClient` — still bridges events from the file-watcher sidecar, but now also powers the `file.watcher.subscribe` streaming RPC
- `WorktreeReconciler` — still discovers worktrees via git
- `WorktreeWatcher` — may be simplified or replaced by the general watcher subscription

### Ignore Patterns

File listing uses two levels of ignore:

1. **Directory-level skipping** (hardcoded): `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.yarn`, `.pnpm-store`, `.idea`, `coverage`, `.nyc_output`, `__pycache__`, `.pytest_cache`, `.cache`, `.history`, `.gradle`, `target`, `bin`, `obj`

2. **Gitignore-based marking**: parse `.gitignore` and `.ignore` files from the worktree root. Entries matching these patterns get `ignored: true` in the response but are still listed (the client can dim them or hide them based on user preference).

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior through the public API, not implementation details. A test should:
- Call the public method/RPC and assert on the response shape and content
- Use real git repositories (created in temp directories) rather than mocking git
- Verify error cases (workspace not found, worktree not ready, permission denied)
- Not test internal caching, debouncing, or state management details

### Modules to Test

**FileService (integration tests):**
- `list()` — create a temp git repo with known structure, verify directory listing, sort order, ignored flag, type classification
- `list()` — verify ignored directories are skipped (node_modules, .git, etc.)
- `list()` — verify gitignore parsing marks entries as ignored
- `read()` — read a text file, verify content and diff against HEAD
- `read()` — read a binary file, verify type is "binary"
- `read()` — read an image file, verify base64 encoding and mime type
- `read()` — read a file with no changes, verify no diff/patch
- `read()` — read a newly created (untracked) file, verify diff shows all lines as added
- `status()` — modify, add, and delete files, verify the returned list matches
- `status()` — clean working tree returns empty array
- Error cases: workspace not found, worktree path doesn't exist, file outside project directory

**Watcher Event Stream (integration tests):**
- Subscribe to workspace, create a file, verify "add" event arrives
- Subscribe to workspace, modify a file, verify "change" event arrives
- Subscribe to workspace, delete a file, verify "unlink" event arrives
- Unsubscribe (close stream), verify no more events and watcher is cleaned up
- Subscribe to workspace that doesn't exist, verify error

**Client-Side Invalidation (unit tests):**
- `invalidateFromWatcher` with "add" event calls `refreshDir` on parent directory
- `invalidateFromWatcher` with "change" event on loaded file calls `loadFile`
- `invalidateFromWatcher` with "change" event on loaded directory calls `refreshDir`
- `invalidateFromWatcher` with "unlink" event calls `refreshDir` on parent directory
- `.git/` paths are ignored
- Files not in the store and not open are not loaded

### Prior Art

- `packages/server/test/file-tree-service.test.ts` — existing tree service tests (temp git repo pattern)
- `packages/server/test/diff-service-event-consumer.test.ts` — existing diff service tests
- `packages/server/test/parse-git-status-v2.test.ts` — git output parsing tests
- `.reference/opencode/packages/opencode/test/file/watcher.test.ts` — OpenCode watcher tests
- `.reference/opencode/packages/app/src/context/file/watcher.test.ts` — OpenCode client invalidation tests

## Out of Scope

1. **File editing/writing** — this PRD covers read-only file operations. File editing (write, rename, delete) is a separate concern.

2. **Full-text search / file search** — OpenCode has `File.search()` with fuzzy matching. This is a separate feature.

3. **LSP integration** — symbol search, go-to-definition, etc. are orthogonal.

4. **Snapshot/undo system** — OpenCode's Snapshot service for session-level diffs and revert. Not part of this migration.

5. **File watcher sidecar changes** — the `@laborer/file-watcher` package stays as-is. We're only changing how the server consumes and exposes its events.

6. **Tree virtualization** — the existing `@pierre/trees` component handles rendering. This PRD changes the data source, not the rendering.

7. **Accept/reject hunk interactions** — the diff panel's hunk-level accept/reject UI stays as-is. This PRD changes how diff data is fetched, not how it's rendered.

## Further Notes

### Migration Strategy

This is a breaking change to the data flow. The recommended approach is:

1. **Add the new services and RPCs first** (additive, no existing code changes)
2. **Wire up the new client-side components** alongside the old ones (feature flag or parallel rendering)
3. **Remove the old code paths** once the new ones are validated
4. **Clean up deprecated LiveStore events** (convert materializers to no-ops)

This allows incremental validation rather than a big-bang cutover.

### Performance Expectations

- **Tree listing**: single `readdir` call per directory, ~1-5ms per directory. Initial root listing shows top-level structure immediately.
- **File read + diff**: one `fs.readFile` + up to two `git diff` calls, ~10-50ms per file.
- **File status**: three git commands in parallel (`diff --numstat`, `ls-files --others`, `diff --name-only --diff-filter=D`), ~50-200ms for a typical repo.
- **Watcher events**: sub-millisecond fan-out from sidecar through server to client. Client-side invalidation is synchronous (just marks directories as stale).

### Reference Implementation

The target architecture is directly modeled on OpenCode's file service:
- `.reference/opencode/packages/opencode/src/file/index.ts` — `File.list()`, `File.read()`, `File.status()`
- `.reference/opencode/packages/opencode/src/file/watcher.ts` — watcher event definitions
- `.reference/opencode/packages/app/src/context/file/watcher.ts` — client-side invalidation
- `.reference/opencode/packages/app/src/context/file/tree-store.ts` — lazy tree store
- `.reference/opencode/packages/opencode/src/project/vcs.ts` — simplified branch detection
