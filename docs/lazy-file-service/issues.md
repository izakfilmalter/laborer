# Issues: Lazy File Service

Parent PRD: [docs/lazy-file-service/PRD.md](./PRD.md)

---

## Issue 1: file.list — Lazy per-directory listing (tracer bullet)

### What to build

The foundational vertical slice: define the `FileNode` schema and `file.list` RPC in the shared package, implement `FileService.list()` in the server, wire the RPC handler, and prove it works end-to-end with integration tests.

`FileService.list(workspaceId, dir?)` reads a single directory level from a workspace's worktree using `readdir` with `withFileTypes`. It returns `FileNode[]` where each node has `name`, `path` (relative to worktree root), `absolute`, `type` (`"file"` or `"directory"`), and `ignored` (hardcoded `false` for now — Issue 2 adds gitignore parsing). Results are sorted directories-first, then alphabetically. Noisy directories (node_modules, .git, dist, build, etc.) and OS metadata files (.DS_Store, Thumbs.db) are skipped.

The service looks up the workspace in LiveStore to get the worktree path, validates the workspace is not destroyed, and rejects paths that escape the project directory.

When `dir` is omitted, lists the worktree root. When provided, lists the subdirectory relative to the worktree root.

### TDD plan

Follow red-green-refactor for each behavior:

1. **RED**: Test listing the root of a temp git repo returns files and directories with correct shape (name, path, type). **GREEN**: Implement the minimal `FileService.list()` and RPC handler.
2. **RED**: Test that directories sort before files, and entries within each group are alphabetical. **GREEN**: Add sort logic.
3. **RED**: Test that `node_modules`, `.git`, and build output directories are skipped. **GREEN**: Add directory ignore set.
4. **RED**: Test that `.DS_Store` and `Thumbs.db` files are skipped. **GREEN**: Add file ignore set.
5. **RED**: Test listing a subdirectory returns only that directory's children with correct relative paths. **GREEN**: Add `dir` parameter support.
6. **RED**: Test that a path escaping the worktree root (e.g., `../../etc`) returns an error. **GREEN**: Add path containment check.
7. **RED**: Test listing a non-existent workspace returns NOT_FOUND error. **GREEN**: Add workspace lookup validation.
8. **RED**: Test listing a destroyed workspace returns INVALID_STATE error. **GREEN**: Add status check.

Test setup uses the existing `initRepo()` + `createTempDir()` helpers from `packages/server/test/helpers/git-helpers.ts` and the `TestLaborerStore` layer from `test/helpers/test-store.ts`.

### Acceptance criteria

- [ ] `FileNode` schema defined in `@laborer/shared/rpc` with fields: name, path, absolute, type, ignored
- [ ] `file.list` RPC defined in `LaborerRpcs` with workspaceId (required) + dir (optional) payload
- [ ] `FileService` Effect service created in `@laborer/server` with `list()` method
- [ ] RPC handler wired in `handlers.ts` delegating to `FileService.list()`
- [ ] Directories sorted before files, alphabetical within each group
- [ ] Ignored directories (node_modules, .git, dist, build, out, .next, .nuxt, .svelte-kit, .turbo, .yarn, .pnpm-store, .idea, coverage, .nyc_output, __pycache__, .pytest_cache, .cache, .history, .gradle, target, bin, obj) are skipped
- [ ] OS metadata files (.DS_Store, Thumbs.db) are skipped
- [ ] Path traversal outside worktree root is rejected with error
- [ ] Non-existent workspace returns NOT_FOUND
- [ ] Destroyed workspace returns INVALID_STATE
- [ ] All tests pass via `bun run test` in `packages/server`

### Blocked by

None — can start immediately (this is the tracer bullet).

### User stories addressed

- User story 1: File tree loads instantly
- User story 2: Expanding a directory shows contents within milliseconds
- User story 14: Sort directories first, then files alphabetically
- User story 15: Skip noisy directories
- User story 20: Show gitignored-but-present files

---

## Issue 2: file.list — Gitignore marking

### What to build

Extend `FileService.list()` to parse `.gitignore` and `.ignore` files from the worktree root and mark matching entries with `ignored: true`. This is a thin enhancement to the listing from Issue 1 — entries are still returned (not filtered out), but the `ignored` flag lets the client dim or hide them.

The implementation uses the `ignore` npm package (already a dependency, used by OpenCode) to parse gitignore patterns. Both `.gitignore` and `.ignore` files from the worktree root are loaded. If the workspace is not a git repo, all entries get `ignored: false`.

For directories, the path is tested with a trailing `/` (matching gitignore semantics). For files, the bare relative path is tested.

### TDD plan

1. **RED**: Test that a file matching a `.gitignore` pattern gets `ignored: true`. **GREEN**: Add gitignore parsing with `ignore` package.
2. **RED**: Test that a directory matching a `.gitignore` pattern gets `ignored: true` (trailing `/` semantics). **GREEN**: Add directory-aware gitignore test.
3. **RED**: Test that `.ignore` file patterns are also applied. **GREEN**: Load both files.
4. **RED**: Test that entries not matching any pattern get `ignored: false`. **GREEN**: Verify default behavior.
5. **RED**: Test that missing `.gitignore`/`.ignore` files don't cause errors (all entries get `ignored: false`). **GREEN**: Handle file-not-found gracefully.

### Acceptance criteria

- [ ] `.gitignore` from worktree root is parsed and applied to entries
- [ ] `.ignore` from worktree root is parsed and applied to entries
- [ ] Directory paths are tested with trailing `/` per gitignore semantics
- [ ] Missing gitignore/ignore files are handled gracefully (no error, all entries `ignored: false`)
- [ ] Non-git workspaces return all entries with `ignored: false`
- [ ] Entries are still returned (not filtered) — `ignored` is a flag, not a filter
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 1: file.list — Lazy per-directory listing"

### User stories addressed

- User story 6: See which files are gitignored

---

## Issue 3: file.read — On-demand file content with per-file diff

### What to build

Define the `FileContent` schema and `file.read` RPC, implement `FileService.read()`, wire the RPC handler, and prove it with integration tests.

`FileService.read(workspaceId, filePath)` reads a single file's content from the workspace worktree and computes its diff against HEAD. Returns `FileContent` with:
- `type`: `"text"` or `"binary"`
- `content`: file text (or base64 for images)
- `diff`: optional raw `git diff` output for this file
- `patch`: optional structured patch with hunks (using the `diff` npm library's `structuredPatch()`)
- `encoding`: optional `"base64"` for encoded content
- `mimeType`: optional MIME type for images/binary

The diff is computed by running `git diff -- <file>` first, then falling back to `git diff --staged -- <file>` if empty. For files with diffs, the original content is retrieved via `git show HEAD:<file>` and a structured patch is computed with `structuredPatch()` using `context: Infinity`.

Binary files are detected by extension and flagged without reading content. Images are base64 encoded with their MIME type. Text files are read as UTF-8.

### TDD plan

1. **RED**: Test reading a text file returns `type: "text"` and correct content. **GREEN**: Implement basic file read.
2. **RED**: Test reading a modified tracked file returns diff and patch. **GREEN**: Add `git diff` + `structuredPatch()`.
3. **RED**: Test reading a staged-but-not-committed file returns diff via `--staged` fallback. **GREEN**: Add staged fallback.
4. **RED**: Test reading an unmodified file returns no diff/patch. **GREEN**: Verify empty diff handling.
5. **RED**: Test reading a newly created (untracked) file returns content but no diff. **GREEN**: Handle untracked files.
6. **RED**: Test reading a binary file (e.g., `.exe`) returns `type: "binary"` with empty content. **GREEN**: Add binary extension detection.
7. **RED**: Test reading an image file (e.g., `.png`) returns base64 content with mimeType. **GREEN**: Add image handling.
8. **RED**: Test reading a non-existent file returns empty content. **GREEN**: Handle missing file.
9. **RED**: Test reading a file outside the worktree root is rejected. **GREEN**: Add path containment.
10. **RED**: Test reading from a non-existent workspace returns NOT_FOUND. **GREEN**: Workspace validation.

### Acceptance criteria

- [ ] `FileContent` schema defined with type, content, diff, patch, encoding, mimeType fields
- [ ] `file.read` RPC defined with workspaceId + filePath payload
- [ ] `FileService.read()` reads file content and computes per-file diff against HEAD
- [ ] RPC handler wired in `handlers.ts`
- [ ] Diff computed via `git diff -- <file>`, falling back to `git diff --staged -- <file>`
- [ ] Structured patch computed via `structuredPatch()` with `context: Infinity`
- [ ] Binary files detected by extension, returned with `type: "binary"`
- [ ] Image files returned as base64 with MIME type
- [ ] Non-existent files return `type: "text"` with empty content
- [ ] Path traversal rejected with error
- [ ] Git commands use `-c core.fsmonitor=false`
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 1: file.list — Lazy per-directory listing" (shares FileService and workspace lookup pattern)

### User stories addressed

- User story 7: Read a file and see its diff against HEAD inline
- User story 9: Diff panel shows per-file diffs fetched on-demand
- User story 16: Binary files handled gracefully

---

## Issue 4: file.status — Workspace-level changed file summary

### What to build

Define the `FileInfo` schema and `file.status` RPC, implement `FileService.status()`, and wire the handler.

`FileService.status(workspaceId)` returns a summary of all changed files in a workspace with line-level change counts. It runs three git commands in parallel:
1. `git diff --numstat HEAD` — modified files with added/removed line counts
2. `git ls-files --others --exclude-standard` — untracked (added) files
3. `git diff --name-only --diff-filter=D HEAD` — deleted files

Returns `FileInfo[]` where each entry has `path` (relative), `added` (line count), `removed` (line count), and `status` (`"added"` / `"deleted"` / `"modified"`).

For untracked files, the `added` count is computed by reading the file and counting lines. For deleted files, both `added` and `removed` are 0.

### TDD plan

1. **RED**: Test that a modified file appears with `status: "modified"` and correct line counts. **GREEN**: Implement `git diff --numstat HEAD` parsing.
2. **RED**: Test that a newly created file appears with `status: "added"` and line count. **GREEN**: Add `git ls-files --others` + file reading.
3. **RED**: Test that a deleted file appears with `status: "deleted"`. **GREEN**: Add `git diff --diff-filter=D` parsing.
4. **RED**: Test that a clean working tree returns an empty array. **GREEN**: Handle empty outputs.
5. **RED**: Test that all three types can appear in the same response. **GREEN**: Verify parallel execution and merging.
6. **RED**: Test non-existent workspace returns NOT_FOUND. **GREEN**: Workspace validation.

### Acceptance criteria

- [ ] `FileInfo` schema defined with path, added, removed, status fields
- [ ] `file.status` RPC defined with workspaceId payload
- [ ] `FileService.status()` runs three git commands in parallel
- [ ] Modified files include accurate added/removed line counts
- [ ] Untracked files have `status: "added"` with line count from file content
- [ ] Deleted files have `status: "deleted"` with zero counts
- [ ] Clean working tree returns empty array
- [ ] Git commands use `-c core.fsmonitor=false` and `-c core.quotepath=false`
- [ ] All paths are relative to the worktree root
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 1: file.list — Lazy per-directory listing" (shares FileService)

### User stories addressed

- User story 8: See a summary of all changed files in a workspace

---

## Issue 5: file.watcher.subscribe — Per-workspace watcher event stream

### What to build

Define the `FileWatcherEvent` schema and `file.watcher.subscribe` streaming RPC, implement the server-side handler that bridges events from the existing `FileWatcherClient` sidecar to the client.

When a client calls `file.watcher.subscribe(workspaceId)`:
1. Server looks up the workspace to get the worktree path
2. Subscribes a recursive file watcher on the worktree via `FileWatcherClient.subscribe()`
3. Listens for events via `FileWatcherClient.onFileEvent()`, filtering by subscription ID
4. Streams `FileWatcherEvent { file: string, event: "add" | "change" | "unlink" }` objects to the client (file paths are relative to the worktree root)
5. On stream teardown (client disconnect), unsubscribes the file watcher

This is the event channel that enables client-side invalidation. The client uses these events to decide what to re-fetch — the server does not pre-process or react to them.

### TDD plan

1. **RED**: Test that subscribing to a workspace and creating a file emits an `"add"` event with the correct relative path. **GREEN**: Implement streaming handler with watcher subscription.
2. **RED**: Test that modifying a file emits a `"change"` event. **GREEN**: Verify event type mapping.
3. **RED**: Test that deleting a file emits an `"unlink"` event. **GREEN**: Verify deletion events.
4. **RED**: Test that closing the stream unsubscribes the file watcher (no more events). **GREEN**: Add finalizer that calls `FileWatcherClient.unsubscribe()`.
5. **RED**: Test that subscribing to a non-existent workspace fails with NOT_FOUND. **GREEN**: Add workspace validation.
6. **RED**: Test that events from other subscriptions are not forwarded (subscription ID filtering). **GREEN**: Verify filter logic.

Tests use the `TestFileWatcherClientRecordingWithRecorderLayer` for controlled event injection, and `TestFileWatcherClientRealLayer` for real filesystem integration tests.

### Acceptance criteria

- [ ] `FileWatcherEvent` schema defined with `file` (string) and `event` ("add" | "change" | "unlink")
- [ ] `file.watcher.subscribe` streaming RPC defined with workspaceId payload
- [ ] Handler subscribes a recursive file watcher on the workspace worktree
- [ ] Events are filtered by subscription ID (only events from this workspace's watcher)
- [ ] File paths in events are relative to the worktree root
- [ ] Stream teardown unsubscribes the file watcher via `FileWatcherClient.unsubscribe()`
- [ ] Non-existent workspace returns NOT_FOUND error
- [ ] Destroyed workspace returns INVALID_STATE error
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 1: file.list — Lazy per-directory listing" (needs workspace lookup pattern)

### User stories addressed

- User story 3: File tree updates automatically on file changes
- User story 10: File content auto-refreshes on disk changes
- User story 11: Watcher event stream scoped per workspace
- User story 19: Only visible workspaces consume watcher bandwidth

---

## Issue 6: Client tree pane — Lazy per-directory fetching

### What to build

Replace the current `TreePane`'s streaming full-tree approach with a lazy per-directory model. The new tree pane:

1. Maintains a local store mapping directory paths to their listing state (`{ expanded, loaded, loading, error, children }`)
2. Fetches the root directory listing via `file.list(workspaceId)` on mount
3. Fetches subdirectory listings on expand via `file.list(workspaceId, dir)`
4. Subscribes to `file.watcher.subscribe(workspaceId)` for reactive invalidation
5. When a watcher event arrives, runs `invalidateFromWatcher()` to refresh only affected directories

The `invalidateFromWatcher(event, ops)` function is a pure, testable function (following OpenCode's pattern):
- Ignores `.git/` path changes
- For `"add"` / `"unlink"` events: marks the parent directory as stale and re-fetches if loaded
- For `"change"` events: if the path is a loaded directory node, re-fetches it
- Does NOT re-fetch directories that haven't been expanded/loaded yet

The tree pane continues to use `@pierre/trees` for rendering. The data source changes from a streaming snapshot to lazy per-directory fetch.

### TDD plan

1. **RED**: Unit test `invalidateFromWatcher` — "add" event calls `refreshDir` on parent. **GREEN**: Implement pure function.
2. **RED**: Unit test — "unlink" event calls `refreshDir` on parent. **GREEN**: Add unlink handling.
3. **RED**: Unit test — "change" event on loaded directory calls `refreshDir` on that dir. **GREEN**: Add change handling.
4. **RED**: Unit test — "change" event on unloaded directory does nothing. **GREEN**: Add loaded check.
5. **RED**: Unit test — `.git/` paths are ignored. **GREEN**: Add path filter.
6. **RED**: Integration test — tree pane renders root listing from `file.list` response. **GREEN**: Wire tree store to RPC.
7. **RED**: Integration test — expanding a directory fetches children via `file.list(workspaceId, dir)`. **GREEN**: Add expand handler.

### Acceptance criteria

- [ ] Tree pane uses `file.list` RPC instead of `fileTree.subscribe` streaming RPC
- [ ] Directories are fetched lazily on expand, not eagerly on mount
- [ ] `invalidateFromWatcher` is a pure function with comprehensive unit tests
- [ ] Watcher events only refresh loaded/expanded directories
- [ ] `.git/` path changes are ignored
- [ ] Expand/collapse state is preserved when sibling directories update
- [ ] Tree pane subscribes to `file.watcher.subscribe` on mount and unsubscribes on unmount
- [ ] Loading state shown while directory listing is in flight
- [ ] Error state shown if listing fails
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 1: file.list — Lazy per-directory listing"
- Blocked by "Issue 2: file.list — Gitignore marking"
- Blocked by "Issue 5: file.watcher.subscribe — Per-workspace watcher event stream"

### User stories addressed

- User story 1: File tree loads instantly
- User story 2: Expanding a directory shows contents quickly
- User story 4: Only affected directory refreshes
- User story 12: Graceful handling of workspaces still being created
- User story 14: Sort directories first, then files alphabetically

---

## Issue 7: Client diff pane — On-demand per-file diffs

### What to build

Replace the current `DiffPane`'s LiveStore subscription with on-demand fetching via the new file RPCs.

The new diff pane:

1. Calls `file.status(workspaceId)` to get the list of changed files on open
2. Displays the file list in a sidebar (like the current diff panel)
3. When a file is selected, calls `file.read(workspaceId, filePath)` to get its content + diff
4. Subscribes to `file.watcher.subscribe(workspaceId)` for invalidation
5. When a watcher event arrives for a displayed file, re-fetches via `file.read`
6. When a watcher event indicates an add/delete, re-fetches `file.status` to update the sidebar

The diff rendering continues to use `@pierre/diffs`. The data source changes from a monolithic workspace diff in LiveStore to per-file diffs fetched on demand.

### TDD plan

1. **RED**: Unit test — watcher "change" event on currently-displayed file triggers `file.read` re-fetch. **GREEN**: Implement invalidation hook.
2. **RED**: Unit test — watcher "add" event triggers `file.status` re-fetch for sidebar update. **GREEN**: Add status refresh.
3. **RED**: Unit test — watcher "unlink" event triggers `file.status` re-fetch. **GREEN**: Add delete handling.
4. **RED**: Integration test — diff pane renders file list from `file.status` response. **GREEN**: Wire status RPC.
5. **RED**: Integration test — selecting a file fetches and renders its diff from `file.read`. **GREEN**: Wire read RPC.

### Acceptance criteria

- [ ] Diff pane uses `file.status` for changed file list instead of LiveStore `diffs` table
- [ ] Diff pane uses `file.read` for per-file diff content instead of parsing monolithic workspace diff
- [ ] No LiveStore subscription for diff data
- [ ] Watcher events trigger selective re-fetching (only affected file or status list)
- [ ] File list sidebar updates when files are added/removed
- [ ] Currently displayed file diff updates when file changes on disk
- [ ] Accept/reject hunk interactions continue to work
- [ ] Loading and empty states handled
- [ ] All tests pass

### Blocked by

- Blocked by "Issue 3: file.read — On-demand file content with per-file diff"
- Blocked by "Issue 4: file.status — Workspace-level changed file summary"
- Blocked by "Issue 5: file.watcher.subscribe — Per-workspace watcher event stream"

### User stories addressed

- User story 7: Read a file and see its diff inline
- User story 8: Summary of all changed files
- User story 9: Per-file diffs fetched on-demand
- User story 10: File content auto-refreshes
- User story 17: CPU usage proportional to what's displayed

---

## Issue 8: Simplify branch detection (copy OpenCode VCS pattern)

### What to build

Replace the current `RepositoryWatchCoordinator` + `BranchStateTracker` + multi-subscription state machine with OpenCode's simpler branch detection pattern.

The new approach:
1. The file watcher sidecar already watches the `.git` directory (the existing subscription for the git common dir)
2. Filter watcher events to only those where the file path ends with `HEAD`
3. When a `HEAD` change is detected, run `git rev-parse --abbrev-ref HEAD` to get the current branch
4. If the branch differs from the previous value, commit a LiveStore event to update workspace metadata

This eliminates:
- The `RepositoryWatchCoordinator` with its per-concern debouncing and multi-subscription state
- The `BranchStateTracker` as a separate service
- The `RepositoryEventBus` intermediate layer
- Multiple concurrent watcher subscriptions per project (git dir, worktrees dir, repo root)

The worktree reconciliation concern (`WorktreeReconciler`) is orthogonal — it can continue to be triggered by worktree directory changes through a simpler event filter, or be handled separately.

### TDD plan

1. **RED**: Test that changing the git HEAD (via `git checkout -b`) is detected and emits a branch update. **GREEN**: Implement HEAD watcher + branch detection.
2. **RED**: Test that non-HEAD git changes (e.g., `.git/index`) are ignored. **GREEN**: Add path filter.
3. **RED**: Test that the branch value is correct after detection. **GREEN**: Verify `git rev-parse` parsing.
4. **RED**: Test that a branch switch to the same branch name does not emit a duplicate update. **GREEN**: Add deduplication.

### Acceptance criteria

- [ ] Branch detection works by filtering watcher events for `HEAD` path changes
- [ ] `git rev-parse --abbrev-ref HEAD` is used to resolve the branch name
- [ ] Duplicate branch updates (same branch name) are suppressed
- [ ] Non-HEAD git directory changes are ignored
- [ ] LiveStore workspace metadata is updated on branch change
- [ ] `RepositoryWatchCoordinator` complexity is reduced or eliminated
- [ ] All tests pass

### Blocked by

None — can start immediately (parallel track).

### User stories addressed

- User story 18: Branch detection updates when switching branches

---

## Issue 9: Remove old code + deprecate LiveStore events

### What to build

Clean up the old architecture now that all new code paths are in place. This is a removal-only issue — no new features.

**Remove from server:**
- `DiffService` (`packages/server/src/services/diff-service.ts`)
- `FileTreeService` (`packages/server/src/services/file-tree-service.ts`)
- `RepositoryEventBus` (`packages/server/src/services/repository-event-bus.ts`)
- `RepositoryWatchCoordinator` (if fully replaced by Issue 8, otherwise simplify)
- `BranchStateTracker` (if replaced by Issue 8)
- `visible-workspaces.ts` (visibility gating moved to client)
- Polling interval constants no longer used (`DIFF_POLL_INTERVAL_MS`, `DIFF_EVENT_DEBOUNCE_MS`, `DIFF_EVENT_COOLDOWN_MS`, `FILE_TREE_EVENT_DEBOUNCE_MS`)
- Old RPC handlers for `diff.refresh` and `fileTree.subscribe`
- Old test files for removed services

**Remove from shared schema:**
- `diffs` table definition
- `diff.refresh` RPC definition
- `fileTree.subscribe` RPC definition

**Deprecate in shared schema (keep as no-op for eventlog backward compat):**
- `diffUpdated` event — keep definition, change materializer to `() => []`
- `diffCleared` event — keep definition, change materializer to `() => []`

**Remove from web app:**
- Old `DiffPane` LiveStore subscription code
- Old `TreePane` streaming subscription code
- `FileTreePreloader` component
- `DiffScrollContext` (if no longer needed with per-file approach)

### TDD plan

No new tests. The acceptance criteria is that all existing tests for the NEW services (Issues 1-8) continue to pass, and the build succeeds with no TypeScript errors.

Run `bun run check` (typecheck + format + tests) to verify.

### Acceptance criteria

- [ ] All removed files are deleted from the repository
- [ ] `diffs` table removed from LiveStore schema
- [ ] `v1.DiffUpdated` and `v1.DiffCleared` materializers changed to no-op `() => []`
- [ ] `diff.refresh` and `fileTree.subscribe` RPCs removed
- [ ] Old RPC handlers removed from `handlers.ts`
- [ ] Old service layers removed from `utility-main.ts` composition
- [ ] Web app has no remaining references to removed services/RPCs
- [ ] `bun run check` passes (typecheck + format + tests)
- [ ] No orphaned imports or dead code

### Blocked by

- Blocked by "Issue 6: Client tree pane — Lazy per-directory fetching"
- Blocked by "Issue 7: Client diff pane — On-demand per-file diffs"
- Blocked by "Issue 8: Simplify branch detection"

### User stories addressed

- User story 17: CPU usage proportional to what's displayed (removal of polling)

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | file.list — Lazy per-directory listing (tracer bullet) | None | Ready |
| 2 | file.list — Gitignore marking | Issue 1 | Blocked |
| 3 | file.read — On-demand file content with per-file diff | Issue 1 | Blocked |
| 4 | file.status — Workspace-level changed file summary | Issue 1 | Blocked |
| 5 | file.watcher.subscribe — Per-workspace watcher event stream | Issue 1 | Blocked |
| 6 | Client tree pane — Lazy per-directory fetching | Issues 1, 2, 5 | Blocked |
| 7 | Client diff pane — On-demand per-file diffs | Issues 3, 4, 5 | Blocked |
| 8 | Simplify branch detection (copy OpenCode VCS pattern) | None | Ready |
| 9 | Remove old code + deprecate LiveStore events | Issues 6, 7, 8 | Blocked |

### Parallel execution paths

```
Path A (file service):  1 → 2 ──────────────────→ 6 ──→ 9
                        1 → 3 ──────────────────→ 7 ──↗
                        1 → 4 ──────────────────↗
                        1 → 5 → 6 (also blocks)
                              → 7 (also blocks)

Path B (branch):        8 ──────────────────────────────→ 9
```

Issues 1 and 8 can start immediately in parallel. After Issue 1 completes, Issues 2-5 can proceed in parallel. Issues 6 and 7 can proceed once their respective dependencies are done. Issue 9 is the final cleanup.
