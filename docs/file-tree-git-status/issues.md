# Issues: Live File Tree with Git Status Decorations

Parent PRD: [PRD.md](./PRD.md)

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Streaming RPC contract + FileTreeService with git ls-files | None | Done |
| 2 | TreePane renders `<FileTree>` from stream data | #1 | Ready |
| 3 | Git status porcelain v2 parser + unit tests | None | Done |
| 4 | Wire git status into FileTreeService and TreePane | #1, #3 | Ready |
| 5 | FileWatcher subscription + debounced refresh | #4 | Blocked |
| 6 | Stream deduplication + lifecycle management | #5 | Blocked |
| 7 | Error states + cancellation + cleanup | #6 | Blocked |
| 8 | Polish + large repo performance | #7 | Blocked |

---

## Issue 1: Streaming RPC contract + FileTreeService with git ls-files

### What to build

The foundational server-side slice: define the streaming RPC contract in the shared package, implement the `FileTreeService` Effect service that runs `git ls-files -z --others --exclude-standard` in a workspace's worktree, and wire the RPC handler to return a `Stream` of `FileTreeSnapshot` objects.

This is the "hello world" tracer bullet. The service emits a single snapshot on subscribe (the initial file listing) and keeps the stream open. No git status, no file watching, no reactivity yet. The goal is to prove the full server-side pipeline: RPC schema -> handler -> service -> git command -> parsed output -> stream emission.

Follow the `Context.Tag + Layer.scoped` pattern from `DiffService`. Add the `fileTree.subscribe` streaming RPC to `LaborerRpcs` in the shared package with an `Effect.Schema` for `FileTreeSnapshot` (`{ files: string[], gitStatus: GitStatusEntry[] }` -- gitStatus will be an empty array in this slice). Register the handler in `handlers.ts` and compose the service layer in `utility-main.ts`.

### Acceptance criteria

- [ ] `FileTreeSnapshot` schema defined in shared package with `files: string[]` and `gitStatus: GitStatusEntry[]`
- [ ] `fileTree.subscribe` streaming RPC added to `LaborerRpcs`, taking `workspaceId: string`
- [ ] `FileTreeService` implemented as `Context.Tag + Layer.scoped` Effect service
- [ ] Service runs `git ls-files -z --others --exclude-standard` in the workspace's worktree directory
- [ ] Null-delimited output is correctly parsed into a `string[]` of relative file paths
- [ ] `GIT_OPTIONAL_LOCKS=0` env var set on the git process to avoid lock contention
- [ ] RPC handler wired in `handlers.ts`, service layer composed in `utility-main.ts`
- [ ] Stream emits one `FileTreeSnapshot` (with `gitStatus: []`) on subscribe and remains open
- [ ] Workspace lookup uses LiveStore to resolve `worktreePath` from `workspaceId`

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 1 (see full directory tree)
- User story 8 (empty directory flattening -- handled by `@pierre/trees`, but needs file list)
- User story 13 (respect .gitignore -- `--exclude-standard` flag)

---

## Issue 2: TreePane renders `<FileTree>` from stream data

### What to build

Wire the client side: replace the empty TreePane placeholder with a real `@pierre/trees` React `<FileTree>` component that subscribes to the `fileTree.subscribe` streaming RPC and renders the file list.

The TreePane component mounts, calls the streaming RPC with the workspace ID, and feeds the `files` array from the first snapshot into `<FileTree files={snapshot.files}>`. Configure `@pierre/trees` with `flattenEmptyDirectories: true`, `sort: true`, and `virtualize: { threshold: 200 }`. Show a loading skeleton until the first snapshot arrives. Clean up the stream subscription on unmount.

No git status decorations in this slice (gitStatus prop will be an empty array). The goal is to see a real file tree in the left panel.

### Acceptance criteria

- [ ] TreePane imports and renders `<FileTree>` from `@pierre/trees/react`
- [ ] Component subscribes to `fileTree.subscribe` RPC on mount with the workspace's ID
- [ ] `files` prop is controlled, driven by the stream snapshot
- [ ] `flattenEmptyDirectories: true`, `sort: true`, `virtualize: { threshold: 200 }` configured
- [ ] Loading skeleton/spinner shown before the first snapshot arrives
- [ ] Stream subscription cleaned up on unmount (panel close)
- [ ] Existing panel toggle (`Ctrl+B then T`), close button, and auto-close on workspace removal still work
- [ ] `@pierre/trees` package is properly installed and importable (it was declared but not installed previously)
- [ ] Existing tree panel layout tests still pass

### Blocked by

- Blocked by "Streaming RPC contract + FileTreeService with git ls-files" (#1)

### User stories addressed

- User story 1 (see full directory tree in the left panel)
- User story 8 (empty directory flattening via `flattenEmptyDirectories`)
- User story 15 (loading state for worktree not ready)

---

## Issue 3: Git status porcelain v2 parser + unit tests

### What to build

A pure function that parses `git status -z --porcelain=v2` output into `GitStatusEntry[]` compatible with `@pierre/trees`. This is the highest-value unit test target in the feature -- a standalone, side-effect-free module.

The parser reads null-delimited porcelain v2 output and maps the two-character status codes (index column `x` + working tree column `y`) to `@pierre/trees`' three status types:

- `M` (modified) in either column -> `'modified'`
- `A` or `?` (added/untracked) -> `'added'`
- `D` (deleted) -> `'deleted'`
- `R` (rename) -> `'added'` for new path + `'deleted'` for old path
- Conflict states (`U`, `AA`, `DD`, `UU`, etc.) -> `'modified'`
- If a file appears in both index and working tree, most severe wins: `deleted` > `modified` > `added`

The parser should also handle porcelain v2's multi-line rename entries (the rename source path follows the status line, null-delimited).

### Acceptance criteria

- [ ] `parseGitStatusV2(output: string): GitStatusEntry[]` pure function exported from a module in the server package
- [ ] Correctly parses ordinary changed entries (`1 <XY> ...`)
- [ ] Correctly parses renamed/copied entries (`2 <XY> ... <path>\0<origPath>`)
- [ ] Correctly parses unmerged entries (`u <XY> ...`)
- [ ] Correctly parses untracked entries (`? <path>`)
- [ ] Maps porcelain v2 status codes to `'added' | 'deleted' | 'modified'` per the PRD rules
- [ ] Handles files with spaces and unicode characters in paths
- [ ] Handles partially staged files (different status in index vs working tree) with severity precedence
- [ ] Handles rename entries: `'added'` for new path, `'deleted'` for old path
- [ ] Unit tests cover: simple modified, simple added, simple deleted, untracked, renamed, copied, all conflict types, partially staged, empty output, files with spaces/unicode
- [ ] No side effects -- pure function with no git process spawning

### Blocked by

None -- can start immediately (pure function, no dependencies on other slices).

### User stories addressed

- User story 2 (modified files marked with M)
- User story 3 (added files marked with A)
- User story 4 (deleted files marked with D)
- User story 10 (staged, unstaged, and untracked changes surfaced)

---

## Issue 4: Wire git status into FileTreeService and TreePane

### What to build

Connect the git status parser from issue #3 into the FileTreeService so that snapshots include both `files` and `gitStatus`. On the client, pass the `gitStatus` prop to `<FileTree>` so that `@pierre/trees` renders badge decorations (A/D/M letters, colors, folder propagation dots).

The FileTreeService now runs both `git ls-files` and `git status -z --porcelain=v2` in parallel, parses both outputs, and emits a `FileTreeSnapshot` with populated `files` and `gitStatus` arrays. The TreePane passes `gitStatus` through to `<FileTree>`.

### Acceptance criteria

- [ ] FileTreeService runs `git status -z --porcelain=v2` alongside `git ls-files`
- [ ] Both commands run in parallel (not sequentially) using `Effect.all` or equivalent
- [ ] `parseGitStatusV2` output is included in the `FileTreeSnapshot.gitStatus` field
- [ ] TreePane passes `gitStatus` prop to `<FileTree>`
- [ ] Modified files show blue "M" badge + colored name/icon in the tree
- [ ] Added/untracked files show green "A" badge
- [ ] Deleted files show red "D" badge
- [ ] Folders containing changed descendants show a propagation dot (via `@pierre/trees` built-in `containsGitChange`)
- [ ] Git status colors are legible in both light and dark themes (using `@pierre/trees` CSS variable defaults)

### Blocked by

- Blocked by "Streaming RPC contract + FileTreeService with git ls-files" (#1)
- Blocked by "Git status porcelain v2 parser + unit tests" (#3)

### User stories addressed

- User story 2 (modified files with M badge)
- User story 3 (added files with A badge)
- User story 4 (deleted files with D badge)
- User story 5 (folder propagation indicator)
- User story 10 (staged/unstaged/untracked surfaced)

---

## Issue 5: FileWatcher subscription + debounced refresh

### What to build

Make the file tree reactive. When files change on disk, the tree updates automatically. The FileTreeService subscribes to `FileWatcherClient` events for the workspace's worktree path. File change events trigger a debounced re-run of `git ls-files` + `git status`, and the new snapshot is pushed to the stream.

Follow DiffService's pattern: subscribe to `FileWatcherClient.onFileEvent`, filter for events in the workspace's worktree, debounce at 300ms, then re-compute and push. The debounce ensures that rapid successive file changes (e.g., a build tool writing many files) result in a single git invocation rather than a flood.

### Acceptance criteria

- [ ] FileTreeService subscribes to `FileWatcherClient` for the worktree path when a client subscribes to the stream
- [ ] File change events within the worktree trigger a re-computation of the file list + git status
- [ ] Debounce of 300ms applied to file change events (same as DiffService)
- [ ] New snapshot pushed to the stream after debounced refresh completes
- [ ] Multiple rapid file changes coalesce into a single git invocation
- [ ] File watcher subscription is cleaned up when the stream subscription ends
- [ ] Tree UI updates within ~500ms of a file save (debounce + git execution + render)
- [ ] Expand/collapse state preserved across updates (verified by `@pierre/trees` controlled state management)

### Blocked by

- Blocked by "Wire git status into FileTreeService and TreePane" (#4)

### User stories addressed

- User story 6 (reactive updates when files change)
- User story 9 (preserve expand/collapse state across updates)
- User story 11 (only active when panel is open)
- User story 12 (stream starts on open, stops on close)

---

## Issue 6: Stream deduplication + lifecycle management

### What to build

Add deduplication to the FileTreeService stream and formalize the stream lifecycle. The service should compare new snapshots against the previous one and only push when something actually changed. This prevents redundant renders when a file watcher event fires but the git state hasn't changed (e.g., a `.gitignore`d file was modified, or a log file was appended to).

Also formalize: the stream starts on first subscribe for a workspace, stops when the last subscriber disconnects, and correctly handles multiple open/close cycles (reopening the panel re-establishes a fresh stream without stale data).

### Acceptance criteria

- [ ] FileTreeService compares new snapshot against previous before emitting
- [ ] No emission when file list and git status are identical to the previous snapshot
- [ ] Comparison is efficient (e.g., length check + content hash, not deep equality on large arrays)
- [ ] Closing and reopening the panel starts a fresh stream (no stale data flash)
- [ ] Multiple rapid close/open cycles do not leak subscriptions or git processes
- [ ] Service-level integration tests verify: dedup suppresses redundant emissions, fresh stream on re-subscribe
- [ ] FileWatcher subscription properly torn down on last unsubscribe

### Blocked by

- Blocked by "FileWatcher subscription + debounced refresh" (#5)

### User stories addressed

- User story 6 (reactive updates -- dedup ensures only real changes trigger renders)
- User story 11 (only active when panel open -- lifecycle formalization)
- User story 12 (stream start/stop on panel open/close)

---

## Issue 7: Error states + cancellation + cleanup

### What to build

Handle the unhappy paths: worktree directory doesn't exist yet (workspace still creating), git commands fail (corrupt repo, permission error), workspace is destroyed while the stream is active, and in-flight git processes need to be killed on unsubscribe.

The FileTreeService should emit an error state that the TreePane can render as a user-friendly message. The TreePane should show a loading skeleton when the workspace status is `creating` and the worktree doesn't exist, then transition to the tree when it becomes available.

Cancellation: when the stream subscription ends or the workspace is destroyed, any running `git ls-files` or `git status` process should be killed immediately. Use Effect's interrupt/finalization mechanisms.

### Acceptance criteria

- [ ] TreePane shows loading skeleton when workspace status is `creating`
- [ ] TreePane shows error message when git commands fail (not a crash/blank screen)
- [ ] FileTreeService kills in-flight git processes on stream unsubscribe
- [ ] FileTreeService handles workspace destruction mid-stream gracefully (stream completes, no orphaned processes)
- [ ] If worktree path doesn't exist, service waits or retries rather than crashing
- [ ] Both laborer-created and externally-detected worktrees work correctly
- [ ] No console errors during normal open/close/destroy cycles
- [ ] Effect finalizers properly clean up all resources (file watcher subscription, git processes, stream)

### Blocked by

- Blocked by "Stream deduplication + lifecycle management" (#6)

### User stories addressed

- User story 14 (both worktree types supported)
- User story 15 (loading state for workspace still creating)
- User story 16 (cancel in-flight git commands on workspace destroy)

---

## Issue 8: Polish + large repo performance

### What to build

Performance tuning and polishing pass across the entire feature. This covers all 10 polishing requirements from the PRD.

Key areas:
- Add `useTransition` in TreePane for non-blocking renders on large updates (same pattern as DiffPane)
- Tune virtualization threshold and verify with a large repo (linux kernel scale, 70k+ files)
- Verify initial render is under 200ms for large repos
- Confirm debounce timing feels responsive (<500ms file-save-to-update, no more than 1 git status call/second)
- Ensure `GIT_OPTIONAL_LOCKS=0` is set on all git invocations (should already be from #1, verify)
- Add cancellation of stale in-flight git status calls when a new refresh is triggered (don't wait for the old one)
- Verify all polishing requirements from the PRD pass

### Acceptance criteria

- [ ] `useTransition` wraps snapshot state updates in TreePane
- [ ] Expand/collapse state persists correctly across file list updates (polishing req 1)
- [ ] Debounce: <500ms latency file-save-to-update, max 1 git status call/second (polishing req 2)
- [ ] Loading skeleton transitions smoothly to populated tree (polishing req 3)
- [ ] Git status colors legible in light and dark themes (polishing req 4)
- [ ] Folder propagation dots visible but not distracting at 50% opacity (polishing req 5)
- [ ] Large repo (70k+ files): tree virtualizes correctly, initial render < 200ms (polishing req 6)
- [ ] Close + reopen panel: fresh stream, no stale data flash (polishing req 7)
- [ ] Panel close button and `Ctrl+B then T` cleanly tear down stream (polishing req 8)
- [ ] No console errors/warnings during normal usage (polishing req 9)
- [ ] Rapid file changes (e.g., `git checkout`) produce single debounced update (polishing req 10)
- [ ] Stale in-flight git calls cancelled when new refresh triggered

### Blocked by

- Blocked by "Error states + cancellation + cleanup" (#7)

### User stories addressed

- User story 7 (load quickly for large repos)
