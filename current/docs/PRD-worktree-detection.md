# PRD: Auto-Detect Git Worktrees on Project Add with Live Sync

## Problem Statement

When a developer adds a project to Laborer, the app has no awareness of git worktrees that already exist for that repository. If the developer has been using `git worktree add` manually, or has worktrees left over from a previous Laborer session (e.g., after a database wipe), those worktrees are invisible. The developer must either manually recreate workspaces in Laborer for each existing worktree, or abandon them and start fresh. Additionally, worktrees created or removed outside the app (via the command line) are never reflected in Laborer's workspace list, causing the UI to drift out of sync with reality.

## Solution

When a project is added, Laborer automatically detects all existing git worktrees (including the main worktree) by running `git worktree list --porcelain`, and creates workspace records for each one in a "stopped" state. A filesystem watcher on each registered project's `.git/worktrees/` directory keeps the list live — when worktrees are created or removed outside the app, Laborer reconciles its workspace list by adding or removing records accordingly. Detected workspaces are created without port allocation or setup script execution; the user can activate them manually when ready.

## User Stories

1. As a developer, I want Laborer to detect all existing git worktrees when I add a project, so that I don't have to manually recreate workspaces for worktrees that already exist.
2. As a developer, I want the main worktree (the original checkout directory) to appear as a workspace, so that I can manage all working directories for a project in one place.
3. As a developer, I want detected worktrees to appear in a "stopped" state without consuming a port or running setup scripts, so that I'm not surprised by automatic side effects on detection.
4. As a developer, I want to be able to activate a detected workspace (allocate port, run setup scripts) when I'm ready to work in it, so that I have control over resource usage.
5. As a developer, I want Laborer to automatically add a workspace when I run `git worktree add` from my terminal, so that the app stays in sync without me switching back to it.
6. As a developer, I want Laborer to automatically remove a workspace when I run `git worktree remove` from my terminal, so that stale entries don't clutter the workspace list.
7. As a developer, I want Laborer to reconcile worktrees with existing workspace records by matching on worktree path, so that Laborer-created workspaces aren't duplicated when detected on disk.
8. As a developer, I want detected worktrees to have a base SHA derived from `git merge-base` against the default branch, so that diff tracking works correctly for externally-created worktrees.
9. As a developer, I want to see whether a workspace was created by Laborer or detected from an existing worktree, so that I understand the provenance of each workspace.
10. As a developer, I want the filesystem watcher to run for all registered projects simultaneously, so that I don't miss worktree changes on projects that aren't currently selected in the UI.
11. As a developer, I want the watcher to survive transient filesystem errors and keep monitoring, so that a brief glitch doesn't permanently disable detection.
12. As a developer, I want worktree detection to work regardless of where worktrees are physically located on disk, so that it works with custom worktree directories, the planned global `~/.config/laborer/` directory, or the current `.worktrees/` convention.
13. As a developer, I want the initial detection on project add to complete before the project appears as "ready" in the UI, so that I immediately see all existing worktrees rather than watching them trickle in.
14. As a developer, I want workspace records for auto-removed worktrees to be fully cleaned up (port freed if allocated, terminals stopped), so that resources aren't leaked.
15. As a developer, I want the detection to handle edge cases like detached HEAD worktrees and bare repository worktrees gracefully, so that unusual git configurations don't crash the app.
16. As a developer, I want the live watcher to debounce rapid filesystem changes (e.g., creating multiple worktrees in quick succession), so that reconciliation doesn't thrash.
17. As a developer, I want worktree detection to start automatically for all existing projects when the server boots, so that worktrees created while the server was offline are picked up.

## 'Polishing' Requirements

1. Verify that detected workspaces render consistently with Laborer-created workspaces in the workspace list — same card layout, same status badge positioning, same action button placement.
2. Ensure the "detected" / "external" origin indicator is visually subtle (secondary text or small badge) and doesn't create visual noise in the workspace list.
3. Verify that the "stopped" status badge for detected workspaces is visually distinct from the "stopped" status of a workspace that was manually stopped by the user — consider a different icon or tooltip to indicate "never activated" vs "was running, now stopped."
4. Ensure the activate action on a detected workspace has a clear affordance — button label, icon, and tooltip should communicate what will happen (port allocation, setup script execution).
5. Verify that rapid worktree creation/removal outside the app (e.g., a script that creates 10 worktrees) results in a smooth, non-flickering UI update.
6. Ensure error states from detection failures (e.g., git not found, corrupt `.git/worktrees` directory) surface as informative but non-blocking warnings — they should not prevent the project from being added or other features from working.
7. Verify that the workspace count badge on project cards in the sidebar accurately reflects detected workspaces.
8. Ensure the watcher teardown on project removal is clean — no lingering file descriptors or orphaned event listeners.
9. Verify that the diff service handles detected workspaces with a derived base SHA correctly — diffs should show changes since the merge-base, not since the beginning of time.
10. Ensure that activating a detected workspace whose worktree was removed between detection and activation shows a clear error message rather than failing silently.

## Implementation Decisions

### WorktreeDetector service (new Effect service, server-side)

A new `WorktreeDetector` Effect tagged service that encapsulates git worktree detection. This is a deep module with a simple interface:

- `detect(repoPath: string) -> Effect<readonly DetectedWorktree[]>` — runs `git worktree list --porcelain` in the given repo path and parses the output into structured records.

**`DetectedWorktree` type:**
```
{
  path: string          // absolute filesystem path to the worktree
  head: string          // HEAD commit SHA
  branch: string | null // branch name (null for detached HEAD)
  isMain: boolean       // true for the main working tree (bare: false, not a linked worktree)
}
```

**Parsing `git worktree list --porcelain`:**
The porcelain output format produces blocks separated by blank lines. Each block has lines like:
```
worktree /path/to/worktree
HEAD abc123def456
branch refs/heads/main
```
The main worktree has no `branch` line if it's in detached HEAD state. Linked worktrees follow the same format. The parser handles: detached HEAD (no `branch` line), bare repositories (line starts with `bare`), and prunable worktrees (line starts with `prunable`). Prunable worktrees are excluded from results.

This service has no dependencies on LiveStore or any other Laborer service — it is a pure git interaction module.

### WorktreeReconciler service (new Effect service, server-side)

A new `WorktreeReconciler` Effect tagged service that diffs detected worktrees against existing workspace records and produces the necessary events.

- `reconcile(projectId: string, repoPath: string) -> Effect<ReconcileResult>` — detects worktrees via `WorktreeDetector`, queries existing workspace records from LiveStore, and commits events to add/remove workspaces as needed.

**Reconciliation logic:**
1. Call `WorktreeDetector.detect(repoPath)` to get the set of worktrees on disk.
2. Query `tables.workspaces` filtered by `projectId` to get existing workspace records.
3. Build a map of existing records keyed by `worktreePath`.
4. For each detected worktree NOT in the existing map: derive a base SHA via `git merge-base <default-branch> <HEAD>` (falling back to `HEAD` if merge-base fails), then commit a `workspaceCreated` event with status `"stopped"`, port `0`, origin `"external"`, and the derived base SHA.
5. For each existing workspace record whose `worktreePath` is NOT in the detected set: if the workspace has an allocated port, free it via `PortAllocator`; if it has running terminals, stop them; then commit `workspaceDestroyed`.
6. Existing records that match a detected worktree are left untouched (no update).

**`ReconcileResult` type:**
```
{
  added: number    // count of new workspace records created
  removed: number  // count of stale workspace records destroyed
  unchanged: number // count of existing records that matched
}
```

Dependencies: `WorktreeDetector`, `LaborerStore`, `PortAllocator`.

**Default branch detection:** The reconciler determines the default branch by checking `refs/remotes/origin/HEAD` (via `git symbolic-ref refs/remotes/origin/HEAD`), falling back to a heuristic check for `main` then `master`. This is used as the merge-base target when deriving base SHAs for detected worktrees.

### WorktreeWatcher service (new Effect service, server-side)

A new `WorktreeWatcher` Effect tagged service that watches for worktree changes across all registered projects using filesystem events.

- `watchProject(projectId: string, repoPath: string) -> Effect<void>` — starts watching the `.git/worktrees/` directory for the given project. When changes are detected, triggers `WorktreeReconciler.reconcile()`.
- `unwatchProject(projectId: string) -> Effect<void>` — stops watching the given project.
- `watchAll() -> Effect<void>` — queries all registered projects and starts watching each one. Called on server boot.

**Implementation details:**
- Uses Node.js/Bun `fs.watch` on the `.git/worktrees/` directory. This directory contains a subdirectory for each linked worktree that git manages.
- For the main worktree, no watch is needed — it cannot be added or removed (it is the repo itself).
- Debounces filesystem events with a short delay (500ms) to coalesce rapid changes (e.g., creating multiple worktrees in a script).
- On each debounced trigger, calls `WorktreeReconciler.reconcile()` for the affected project.
- Handles the case where `.git/worktrees/` doesn't exist yet (no linked worktrees have ever been created) by watching `.git/` for creation of the `worktrees` directory, then switching to watching it.
- Wraps the watcher in an Effect `Scope` so teardown is automatic on service shutdown.
- Logs warnings on watcher errors (permission denied, path deleted) but continues attempting to watch.

Dependencies: `WorktreeReconciler`, `ProjectRegistry`.

### Schema changes (shared package)

**New `origin` column on `workspaces` table:**
- Column: `origin`, type `text`, default value `"laborer"`.
- Values: `"laborer"` (created by Laborer's normal workspace flow) or `"external"` (detected from existing git worktree).
- This is a non-breaking additive change. Existing materialized rows will have the default value.

**New event field:**
- `v1.WorkspaceCreated` event schema gains an `origin` field: `Schema.optionalWith(Schema.String, { default: () => "laborer" })`. This preserves backward compatibility with existing events in the eventlog that lack this field.

**Port handling:**
- The `port` column on `workspaces` currently has type `integer` with no nullable option. For detected workspaces that haven't been activated, port will be `0` to indicate "not allocated." This avoids a schema migration and is easy to check in the UI.
- The UI should hide the port display when port is `0`.

**Types update:**
- `WorkspaceOrigin` literal type: `"laborer" | "external"`.
- `Workspace` class gains an `origin: WorkspaceOrigin` field.

### ProjectRegistry integration (modify existing service)

- After `addProject` commits the `projectCreated` event, it calls `WorktreeReconciler.reconcile()` to perform the initial detection. This happens synchronously within the `addProject` flow so that by the time the RPC response is returned, all existing worktrees have workspace records.
- After `addProject` succeeds, it calls `WorktreeWatcher.watchProject()` to start live watching.
- `removeProject` calls `WorktreeWatcher.unwatchProject()` before committing `projectRemoved` to stop the watcher cleanly.
- `ProjectRegistry` gains dependencies on `WorktreeReconciler` and `WorktreeWatcher`.

### Server boot integration

- On server startup, after the `LaborerStore` layer is built and all projects are restored, the `WorktreeWatcher.watchAll()` method is called. This iterates all registered projects and starts a filesystem watcher for each one. It also runs an initial reconciliation pass for each project to catch any worktree changes that happened while the server was offline.

### UI updates (web app)

**Workspace list changes:**
- Workspace cards for `origin: "external"` display a subtle badge or secondary text indicating the workspace was detected from an existing worktree (e.g., a small "Detected" label or a different icon variant).
- When port is `0`, the port display is hidden.
- Stopped workspaces with `origin: "external"` that have never been activated show an "Activate" button. Activating allocates a port, runs setup scripts, and transitions status to `"running"`.

**Activate workspace RPC:**
- A new `workspace.activate` RPC endpoint that takes a `workspaceId`, allocates a port, runs setup scripts, updates the workspace status to `"running"`, and updates the port on the record.
- This is distinct from `workspace.create` — it operates on an existing workspace record rather than creating a new worktree.

**Workspace card action changes:**
- The existing "Destroy" action on external workspaces should only remove the Laborer workspace record and free resources — it should NOT run `git worktree remove` or `git branch -D`, since the worktree was not created by Laborer. A confirmation dialog should make this clear.
- For Laborer-created workspaces, the destroy behavior remains unchanged (removes the worktree and branch).

## Testing Decisions

Good tests verify external behavior through the public interface, not implementation details. Tests should set up realistic scenarios (real git repos in temporary directories, in-memory LiveStore) and assert observable outcomes.

### WorktreeDetector tests

Test the public `detect` method against real git repositories.

Scenarios to cover:
- Detect worktrees in a repo with no linked worktrees (only main worktree returned)
- Detect worktrees in a repo with one linked worktree (main + linked)
- Detect worktrees in a repo with multiple linked worktrees
- Handle detached HEAD worktrees (branch is null in result)
- Exclude prunable worktrees from results
- Return correct `isMain` flag for the main worktree
- Handle a repo where `.git/worktrees/` doesn't exist (no linked worktrees created yet)
- Error handling when `git` is not available or the path is not a git repo

Prior art: `packages/server/test/workspace-validation.test.ts` — uses temporary directories with real git repos.

### WorktreeReconciler tests

Test the public `reconcile` method with an in-memory LiveStore and real git repos.

Scenarios to cover:
- Fresh project with no existing workspaces: creates workspace records for all detected worktrees
- Project with existing Laborer-created workspaces that match detected worktrees: leaves them untouched
- Project with existing workspace records for worktrees that no longer exist on disk: removes the stale records
- Mixed scenario: some worktrees are new, some match existing records, some are stale
- Workspace records are created with status `"stopped"`, port `0`, and origin `"external"`
- Base SHA is correctly derived via merge-base for each detected worktree
- When merge-base fails (e.g., orphan branch), falls back to HEAD
- Port is freed when removing a workspace that had a port allocated
- Main worktree is included in reconciliation

Prior art: `packages/server/test/terminal-manager.test.ts` — uses in-memory LiveStore with mock dependencies.

### WorktreeWatcher tests

Test the watcher lifecycle and debouncing behavior.

Scenarios to cover:
- `watchProject` starts watching and triggers reconciliation when a worktree is added via `git worktree add`
- `watchProject` triggers reconciliation when a worktree is removed via `git worktree remove`
- `unwatchProject` stops the watcher and no further reconciliation occurs
- `watchAll` starts watchers for all registered projects
- Rapid filesystem changes are debounced into a single reconciliation call
- Watcher handles `.git/worktrees/` directory not existing initially, then being created
- Watcher survives the watched directory being briefly unavailable

Prior art: `packages/server/test/terminal-manager.test.ts` — uses real filesystem operations with Effect scopes for cleanup.

### Schema tests

Test that the new `origin` column and port `0` handling work correctly through materializers.

Scenarios to cover:
- `workspaceCreated` event without `origin` field materializes with default `"laborer"` origin
- `workspaceCreated` event with `origin: "external"` materializes correctly
- Workspace with port `0` queries correctly from the table
- `workspaceDestroyed` event cleans up workspaces regardless of origin

Prior art: the in-memory LiveStore pattern from `packages/server/test/terminal-manager.test.ts`.

### ProjectRegistry integration tests

Test that project lifecycle triggers worktree detection and watcher management.

Scenarios to cover:
- `addProject` for a repo with existing worktrees results in workspace records being created
- `addProject` for a repo with no worktrees only creates a workspace for the main worktree
- `removeProject` stops the watcher for that project
- Initial detection completes before `addProject` returns its response

Prior art: `packages/server/test/workspace-validation.test.ts`.

### UI component tests

Test workspace list rendering with the new origin and activation features.

Scenarios to cover:
- Workspace card renders "Detected" indicator for external-origin workspaces
- Workspace card hides port display when port is `0`
- Activate button appears on stopped external workspaces
- Destroy action on external workspaces does not mention git worktree removal in confirmation text
- Workspace count badge on project cards includes detected workspaces

Prior art: no frontend component tests exist yet. Use Vitest + React Testing Library. Follow the existing `packages/server/vitest.config.ts` pattern for configuration.

## Out of Scope

- **Activating/starting detected workspaces**: While the workspace record is created and the UI shows an activate button, the full implementation of the `workspace.activate` RPC (port allocation, setup script execution, status transition) is a follow-up concern. The PRD defines the interface but the activation flow can be implemented incrementally.
- **Branch change detection within existing worktrees**: The watcher only detects worktree add/remove, not branch switches within an existing worktree (e.g., `git checkout` inside a worktree). Updating the branch name on workspace records for checkout events is out of scope.
- **Worktree pruning**: Automatically running `git worktree prune` to clean up stale worktree references is not part of this feature. The detection uses `git worktree list` which already excludes prunable entries.
- **Bare repository support**: Bare repos have no main worktree. Detection in bare repos is not supported — the `isMain` worktree is always expected.
- **Remote/network worktrees**: Only local filesystem worktrees are detected. Network-mounted or containerized worktrees are out of scope.
- **Migration of worktree directory locations**: This feature is orthogonal to the global worktree config PRD. Detection works with whatever paths `git worktree list` reports, regardless of location.

## Further Notes

- The `git worktree list --porcelain` command is available in git 2.7+ (released January 2016). This is a safe minimum version assumption.
- The `.git/worktrees/` directory is managed by git itself and contains metadata for each linked worktree. Watching this directory is reliable because git creates/removes subdirectories atomically. However, the main worktree is NOT represented in this directory — it's implicit from the repo itself. This is why we run a full `git worktree list` on each filesystem event rather than trying to parse the directory contents directly.
- Port `0` as a sentinel for "not allocated" is used instead of making the column nullable to avoid a schema migration. The PortAllocator already starts allocating from a configured base port (well above 0), so there is no collision risk.
- The `workspace.activate` RPC is intentionally defined in this PRD even though its full implementation is out of scope. This ensures the schema and data model support the activation flow from the start, avoiding a second schema change later.
- When the server boots and runs `watchAll()`, the initial reconciliation pass may create or remove workspace records. This is expected and handles the case where worktrees were created/removed while the server was offline. The LiveStore sync will propagate these changes to all connected browser tabs.
- The destroy behavior difference between Laborer-created and external workspaces is important: destroying an external workspace only removes the Laborer record, while destroying a Laborer-created workspace also removes the git worktree and branch. The `origin` column makes this distinction possible at the point of destruction.
