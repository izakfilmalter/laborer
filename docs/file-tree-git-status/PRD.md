# PRD: Live File Tree with Git Status Decorations

## Problem Statement

The file tree panel added in commit `6106197` is a layout shell with no data. It renders a "Files" header and an empty body. Users cannot see the contents of their workspace worktree or understand which files have changed since the workspace was created.

The original plan was to follow the DiffService pattern and push file tree data through LiveStore (server -> event -> SQLite table -> reactive query). This is overkill. A full file listing for a large repo can be tens of thousands of entries. Persisting that in the eventlog and materializing it into SQLite on every change creates unnecessary storage and CPU overhead for data that is inherently ephemeral -- it only matters while the workspace is open.

VS Code solves this well: the file explorer shows all files with git status decorations (badges, colors) that update reactively via file watchers and debounced `git status` calls. We need the same thing, but without a database in the middle.

## Solution

Build a live file tree that shows all files in a workspace's worktree directory, decorated with git status indicators (modified, added, deleted), using `@pierre/trees` for rendering and a streaming RPC for data transport. No LiveStore persistence.

The server runs `git ls-files` (for the full file list) and `git status` (for change metadata) in the workspace's worktree, then streams snapshots to the client over the existing Effect RPC MessagePort channel. File watcher events trigger debounced re-computation. The client feeds the data directly into the `@pierre/trees` React component's `files` and `gitStatus` props.

## User Stories

1. As a developer, I want to see the full directory tree of my workspace's worktree in the left panel, so that I can understand the project structure at a glance.

2. As a developer, I want files that have been modified since the workspace was created to be visually marked with an "M" badge and a distinct color, so that I can quickly identify what has changed.

3. As a developer, I want newly added files to be marked with an "A" badge and a green color, so that I can distinguish new files from modifications.

4. As a developer, I want deleted files to be marked with a "D" badge and a red color, so that I can see what was removed without switching to the diff view.

5. As a developer, I want folders that contain changed files to show a propagation indicator (dot), so that I can navigate to changes in deeply nested directories without expanding everything.

6. As a developer, I want the file tree to update reactively when files change on disk, so that I see current state without manually refreshing.

7. As a developer, I want the file tree to load quickly even for large repositories (10k+ files), so that opening the panel does not block the UI.

8. As a developer, I want empty directories to be flattened (e.g., `src/components/` shown as one row when `components/` has no siblings), so that the tree is compact and navigable.

9. As a developer, I want the tree to preserve my expand/collapse state when the file list updates, so that I do not lose my place when files change.

10. As a developer, I want staged, unstaged, and untracked changes to all be surfaced in the tree decorations, so that I have full visibility into the git working state.

11. As a developer, I want the file tree to only be active (consuming resources) when the panel is open, so that background CPU and memory use are minimal when I am not looking at it.

12. As a developer, I want the tree data stream to start immediately when I open the panel and stop when I close it, so that there is no persistent background polling for an ephemeral view.

13. As a developer, I want the file tree to respect `.gitignore` by default (not showing ignored files), so that the tree matches what git tracks.

14. As a developer, I want the file tree to work correctly for both laborer-created worktrees and externally-detected worktrees, so that all workspace types are supported.

15. As a developer, I want the tree to handle the case where the worktree directory does not exist yet (workspace still creating), showing an appropriate empty/loading state.

16. As a developer, I want the file tree to cancel in-flight git commands when the workspace is destroyed, so that there are no orphaned processes.

## 'Polishing' Requirements

1. Verify that expand/collapse state persists correctly across file list updates (no jarring resets).
2. Ensure the debounce timing feels responsive but does not cause excessive git invocations (target: <500ms latency from file save to tree update, no more than 1 git status call per second).
3. Confirm that the loading state (spinner or skeleton) renders immediately when the panel opens and transitions smoothly to the populated tree.
4. Verify that the git status colors are legible in both light and dark themes using `@pierre/trees`' built-in CSS variable system.
5. Confirm that folder propagation dots are visible but not distracting (50% opacity as `@pierre/trees` implements).
6. Test with a large repository (linux kernel scale, 70k+ files) to ensure the tree virtualizes correctly and initial render is under 200ms.
7. Verify that closing and reopening the panel re-establishes the stream without stale data flashing.
8. Ensure the panel close button and keyboard shortcut (`Ctrl+B then T`) cleanly tear down the stream subscription.
9. Confirm that no console errors or warnings appear during normal open/close/update cycles.
10. Verify that the tree handles rapid file changes (e.g., `git checkout` switching many files) gracefully with a single debounced update rather than a flood of intermediate states.

## Implementation Decisions

### Data Transport: Streaming RPC (not LiveStore)

File tree data will use a streaming RPC endpoint over the existing MessagePort channel, following the pattern established by `terminal.events` and `watcher.events`. This avoids persisting ephemeral file listings in the LiveStore eventlog.

Rationale: The terminal output system was previously migrated away from LiveStore events for the same reason -- high-frequency, ephemeral data that bloats the eventlog. The `terminalOutput` event in the schema is already deprecated with a comment pointing to the dedicated channel.

### Git Commands

Two git commands provide all needed data:

- **`git ls-files -z`**: Produces the full list of tracked files (null-delimited for safe parsing). Combined with `--others --exclude-standard` to include untracked files.
- **`git status -z --porcelain=v2`**: Produces structured status output with two-character status codes (index column + working tree column), enabling the full staged/unstaged/untracked model.

The server parses `git status -z --porcelain=v2` output to produce `GitStatusEntry[]` compatible with `@pierre/trees`' `gitStatus` prop. Since `@pierre/trees` currently supports three status types (`added`, `deleted`, `modified`), the full porcelain v2 status codes will be mapped down:

- Index or working tree `M` (modified) -> `modified`
- Index or working tree `A` or `?` (added/untracked) -> `added`
- Index or working tree `D` (deleted) -> `deleted`
- Rename (`R`) -> `added` (for the new path) + `deleted` (for the old path, if shown)
- Conflict states -> `modified` (conservative fallback)

If a file appears in both index and working tree, the most "severe" status wins (deleted > modified > added).

### Server-Side Module: FileTreeService

A new `FileTreeService` Effect service following the same `Context.Tag + Layer.scoped` pattern as `DiffService`. Key behaviors:

- **On-demand activation**: Unlike DiffService which bootstraps polling for all active workspaces on startup, FileTreeService only starts watching when a client subscribes to the streaming RPC. This is because the file tree is only needed when the panel is open.
- **FileWatcher integration**: Subscribes to `FileWatcherClient` events for the worktree path. File change events trigger a debounced refresh (300ms debounce, matching DiffService).
- **Deduplication**: Compares new file list + status against the previous snapshot. Only pushes to the stream when something actually changed (similar to DiffService's content comparison).
- **Cancellation**: When the stream subscription ends (client disconnects or panel closes), the service stops the file watcher subscription and kills any in-flight git processes for that workspace.
- **Error handling**: If git commands fail (e.g., worktree not ready), the service emits an error state that the client can render as a message rather than crashing.

### RPC Contract

New streaming RPC added to `LaborerRpcs`:

- **`fileTree.subscribe`**: Takes `workspaceId`. Returns a `Stream` of `FileTreeSnapshot` objects, each containing `{ files: string[], gitStatus: GitStatusEntry[] }`. The first emission is the initial snapshot; subsequent emissions are pushed on change.

### Client-Side Integration

The `TreePane` component will:

1. Call the `fileTree.subscribe` streaming RPC with the workspace ID when mounted.
2. Feed `files` and `gitStatus` directly to the `@pierre/trees` React `<FileTree>` component as controlled props.
3. Use `useTransition` for non-blocking renders on large updates (same pattern as DiffPane).
4. Show a loading skeleton until the first snapshot arrives.
5. Clean up the stream subscription on unmount (panel close).

### `@pierre/trees` Configuration

The `<FileTree>` component will be configured with:
- `flattenEmptyDirectories: true` (compact tree like VS Code)
- `virtualize: { threshold: 200 }` (virtualized rendering for large repos)
- Controlled `files` and `gitStatus` props (driven by stream data)
- `sort: true` (alphabetical, folders first)

### Folder Propagation

`@pierre/trees` already implements folder propagation via `containsGitChange()`. When any descendant file has a git status, ancestor folders get a `data-item-contains-git-change` attribute and render a dot indicator at 50% opacity in the modified color. Deleted files also propagate (unlike VS Code, where deleted files do not propagate -- but since we are showing the full tree of tracked files, a deleted file still appears in the tree from `git ls-files`).

### No Click Action (Phase 1)

Clicking a file in the tree will have no action in this phase. Opening files in the editor will be a follow-up feature.

## Testing Decisions

Good tests for this feature verify external behavior: given a set of files and git status data, the correct tree renders with correct decorations. Tests should not assert on internal service state or git command construction.

### Modules to Test

1. **Git status parser** (server-side): Given raw `git status -z --porcelain=v2` output, produces correct `GitStatusEntry[]`. This is a pure function and the highest-value unit test target. Test edge cases: renames, conflicts, partially staged files, untracked files, files with spaces/unicode in paths.

2. **FileTreeService stream behavior** (server-side): Given a mock git executor and file watcher, verify that the service emits correct snapshots on initial subscribe and on file change events. Verify deduplication (no emission when nothing changed). Verify cleanup on unsubscribe.

3. **TreePane rendering** (client-side): Given mock stream data, verify the `<FileTree>` component receives correct `files` and `gitStatus` props. Verify loading state renders before first snapshot. Verify cleanup on unmount. These tests should mock the RPC layer, not git.

4. **`computeSidePanelSizes` integration**: The existing test suite for panel sizing already covers tree pane layout. No new tests needed for sizing.

### Prior Art

- `apps/web/test/workspace-frames-tree-panel.test.tsx` -- existing tests for tree panel layout positioning
- `packages/server/src/services/diff-service.ts` -- DiffService is the template for FileTreeService's lifecycle and dedup patterns (though it uses LiveStore rather than streaming RPC)
- `.reference/pierre/packages/trees/test/` -- @pierre/trees has its own git-status feature tests that validate badge rendering and propagation

## Out of Scope

- **File click actions** (open in editor, navigate to diff): Deferred to a follow-up PRD.
- **Context menu** (rename, delete, new file): Not planned for this phase.
- **Drag and drop**: Not needed for a read-only file explorer.
- **Search/filter within the tree**: `@pierre/trees` supports this, but wiring it up is deferred.
- **Staged vs unstaged visual distinction**: `@pierre/trees` only supports three status types (`added`, `deleted`, `modified`). Adding a staged/unstaged visual split (e.g., different shades or separate sections) would require upstream changes to `@pierre/trees`. For now, we map the full git status down to these three types. A follow-up could contribute richer status types upstream.
- **`.gitignore` file decoration**: VS Code dims ignored files. `@pierre/trees` does not have an `ignored` status type. Ignored files are simply excluded from the file list.
- **Inline file rename**: `@pierre/trees` supports this, but it requires write operations that are out of scope.
- **Persisting expand/collapse state across sessions**: Expand state is transient per panel open. LiveStore persistence of tree UI state is not worth the complexity.

## Further Notes

### Relationship to Existing DiffService

The DiffService will continue to exist unchanged. It serves a different purpose: providing full patch content for the diff viewer. The FileTreeService provides a lightweight file listing + status summary. They share the same FileWatcher infrastructure but are otherwise independent.

In the future, clicking a file in the tree could scroll the diff pane to that file's diff, creating a coordinated navigation experience. But that is out of scope for this PRD.

### `@pierre/trees` Git Status Capabilities

`@pierre/trees` v0.0.1-beta.3 has a built-in `git-status` feature that is well-suited to our needs:

- **Types**: `GitStatusEntry = { path: string; status: 'added' | 'deleted' | 'modified' }`
- **React prop**: `gitStatus?: GitStatusEntry[]` on the `<FileTree>` component
- **File decorations**: Badge letters (A/D/M) + status-specific colors applied to icon, name, and badge
- **Folder propagation**: `containsGitChange()` on item instances, rendering a dot at 50% opacity
- **CSS variables**: Full cascade with override points (`--trees-git-added-color-override`, etc.)
- **Colors**: Green for added, blue for modified, red for deleted (both light and dark themes)
- **Caching**: Git status map is signature-keyed and only rebuilt when the status array or data loader changes

The library handles all rendering concerns. The server only needs to provide `string[]` (file paths) and `GitStatusEntry[]` (status entries).

### Performance Considerations

- `git ls-files` is fast even on huge repos (linux kernel: ~75k files in <100ms)
- `git status` is the heavier operation but is well-optimized in modern git
- The server should use `GIT_OPTIONAL_LOCKS=0` environment variable to avoid lock contention with concurrent git operations (same technique VS Code uses)
- `@pierre/trees` has been benchmarked against the linux kernel file tree and handles it efficiently with virtualization
- The streaming RPC uses MessagePort structured clone, which handles large arrays efficiently

### VS Code Architecture Reference

VS Code's approach was studied in depth. Key patterns adopted:
- **File watcher + debounced refresh** (not polling) as the primary reactivity mechanism
- **`git status -z` with null-delimited parsing** for safe path handling
- **Decoration propagation to parent folders** (VS Code calls this "bubble")
- **Cancellation of in-flight status calls** when a new one is requested

Key patterns NOT adopted:
- **Decoration provider abstraction**: VS Code has a generic `FileDecorationProvider` API because it supports multiple extensions decorating the same file. We have a single source of decorations (git status), so we pass them directly as props.
- **Separate staged/unstaged resource groups**: VS Code's Source Control panel has four resource groups (Merge, Index, WorkingTree, Untracked). `@pierre/trees` has a simpler model. We map down to three statuses.
- **Optimistic UI updates**: VS Code updates the UI optimistically for stage/unstage operations before `git status` completes. We do not have stage/unstage operations, so this is unnecessary.
- **Theme color indirection**: VS Code uses `ThemeColor` references resolved by the theme engine. `@pierre/trees` uses CSS variables with a similar override cascade, which is sufficient.
