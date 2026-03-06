# OpenCode-Inspired Repository Watching — Issues

---

## Issue 1: Canonical repository identity tracer bullet

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server Effect services, git integration, project registration flow, persistence/deduplication behavior, integration tests

### What to build

Create the first end-to-end slice for canonical repository identity. When a user adds a project using a repo root, nested path, or symlinked path, Laborer should resolve the canonical checkout root and common git directory through a dedicated Effect service and register only one logical project for that repository.

This slice should wire the new repository identity service into project add flow, persist canonical paths, and prevent duplicate logical projects caused by alternate path representations. It should also establish the Layer/service shape the rest of the repo-watching stack will build on.

### Acceptance criteria

- [x] Adding a repo root registers a project using canonical repository metadata rather than raw user input
- [x] Adding a nested directory inside an already-registered repo does not create a duplicate project
- [x] Adding a symlinked path to an already-registered repo does not create a duplicate project
- [x] Repository identity is exposed through an Effect tagged service and wired through Layers
- [x] Integration tests cover repo root, nested path, and symlink path registration cases

### Blocked by

None - can start immediately

### User stories addressed

- User story 1
- User story 2
- User story 4
- User story 12
- User story 14
- User story 20

---

## Issue 2: Canonical worktree reconciliation with shared git dir support

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server Effect services, git worktree detection, workspace reconciliation, persistence, integration tests

### What to build

Extend the existing worktree detection and reconciliation flow so it operates on canonicalized worktree paths and shared git metadata, following the repository identity established in Issue 1. Linked worktrees should reconcile under the same logical project even when they live outside the main checkout root.

This slice should keep `git worktree list --porcelain` as the source of truth, move the behavior behind an explicit `WorktreeReconciler` Effect service boundary, and ensure path comparisons use normalized real paths.

### Acceptance criteria

- [x] Worktree reconciliation uses canonical repo identity and canonical worktree paths
- [x] Linked worktrees living outside the main checkout still reconcile under the correct project
- [x] Reconciliation does not create duplicate workspaces due to path representation differences
- [x] Worktree reconciliation is exposed through an Effect tagged service boundary
- [x] Real-git integration tests cover shared git dir and canonical path matching cases

### Blocked by

- Blocked by #1

### User stories addressed

- User story 3
- User story 4
- User story 9
- User story 13
- User story 14
- User story 18
- User story 20

---

## Issue 3: Scoped repository watcher coordinator

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server Effect services, native watcher integration, project lifecycle, shutdown cleanup, integration tests

### What to build

Introduce a scoped `RepositoryWatchCoordinator` Effect service that owns long-lived watcher lifecycle for each registered repository. It should subscribe to the canonical checkout root for repo-wide file watching and to the canonical common git directory for git metadata changes, with automatic cleanup on project removal and server shutdown.

This slice should replace the assumption that `fs.watch` is enough with an abstracted watcher backend aligned with the OpenCode model, while preserving clean Layer-based ownership of subscriptions and teardown.

### Acceptance criteria

- [x] Each registered project gets a scoped watcher coordinator tied to its lifecycle
- [x] The coordinator watches both the canonical repo root and canonical common git dir
- [x] Removing a project tears down its watchers cleanly
- [x] Server shutdown tears down watcher resources cleanly through scoped service disposal
- [x] Integration tests verify watcher setup and teardown through public service behavior

### Blocked by

- Blocked by #1

### User stories addressed

- User story 5
- User story 6
- User story 15
- User story 17
- User story 18
- User story 19
- User story 20

---

## Issue 4: Git metadata refresh for branch and worktree changes

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server Effect services, watcher event handling, branch state, workspace reconciliation, integration tests

### What to build

Build the first watcher-driven refresh path: git metadata changes should invalidate state and trigger the appropriate refresh services instead of mutating state directly. Branch-related changes should refresh branch state, and worktree-related git metadata changes should schedule reconciliation.

This slice should add the `BranchStateTracker` behavior and connect git-dir watcher signals to git-backed refresh logic so branch indicators and worktree state stay current without depending on UI focus.

### Acceptance criteria

- [x] Git metadata watch events trigger git-backed refresh work instead of direct state mutation
- [x] Branch changes update externally visible branch state through a dedicated service boundary
- [x] Worktree metadata changes trigger reconciliation through the watcher coordinator
- [x] Debouncing/coalescing prevents repeated rapid metadata events from thrashing refresh work
- [x] Integration tests cover branch switch and external worktree add/remove scenarios

### Blocked by

- Blocked by #2, #3

### User stories addressed

- User story 7
- User story 8
- User story 9
- User story 10
- User story 15
- User story 18
- User story 19
- User story 20

---

## Issue 5: Repo-wide file events with normalized event bus and ignores

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server Effect services, watcher backend, internal event fanout, config/ignore handling, integration tests

### What to build

Add the repo-wide file event pipeline that makes this a full OpenCode-style watcher system rather than a git-metadata-only implementation. Repository file add/change/delete activity should be normalized into a stable internal event shape and published through a `RepositoryEventBus` Effect service for downstream consumers.

This slice should also centralize ignore handling so dependency folders, build output, and git internals do not generate noisy downstream work.

### Acceptance criteria

- [x] Repo-wide file watching emits normalized add/change/delete events through an Effect-managed event bus
- [x] The event bus can be consumed by downstream services without creating duplicate watchers
- [x] Ignore rules suppress git internals and other configured noisy paths
- [x] Watcher events are treated as invalidation signals and not as direct source-of-truth state
- [x] Integration tests cover file add/change/delete events and ignored-path behavior

### Blocked by

- Blocked by #3

### User stories addressed

- User story 6
- User story 8
- User story 16
- User story 21
- User story 22
- User story 23
- User story 24

---

## Issue 6: Startup bootstrap and project lifecycle integration

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server boot sequence, project registry, watcher orchestration, worktree state, integration tests

### What to build

Integrate the new repository service stack into project lifecycle and server startup. Adding a project should resolve canonical identity, perform initial git-backed refresh, and start the scoped watcher coordinator before the project is considered ready. Server boot should restore watchers for all known repositories and reconcile offline changes.

This slice makes the new architecture the default path through the app rather than a standalone service graph.

### Acceptance criteria

- [x] Project add flow performs canonical discovery and initial refresh before returning ready state
- [x] Project add starts the repository watcher coordinator for the resolved logical repo
- [x] Server boot restores watchers for all persisted projects
- [x] Server boot reconciles worktree and branch state that changed while offline
- [x] Integration tests cover project add and server restart flows through public APIs

### Blocked by

- Blocked by #1, #3, #4

### User stories addressed

- User story 5
- User story 12
- User story 18
- User story 19
- User story 20

---

## Issue 7: Correctness hardening for fsmonitor, recovery, and churn

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Git command execution, watcher recovery behavior, diagnostics/logging, integration tests

### What to build

Harden the repo-watching stack for correctness-sensitive and failure-heavy cases. Critical git reads should bypass stale fsmonitor state where appropriate, watcher subscriptions should recover from deleted and recreated directories, and high-churn repo activity should remain eventually consistent without flooding downstream refreshes.

This slice focuses on the non-happy-path behavior that makes the OpenCode-inspired architecture production-safe.

### Acceptance criteria

- [x] Correctness-sensitive git reads disable fsmonitor where needed
- [x] Watched directories can be deleted and recreated without permanently breaking sync
- [x] Heavy churn scenarios are coalesced into stable refresh behavior
- [x] Watcher degradation surfaces as warnings or diagnostics without stopping the app
- [x] Integration tests cover recovery and high-churn scenarios

### Blocked by

- Blocked by #4, #5, #6

### User stories addressed

- User story 7
- User story 8
- User story 11
- User story 15
- User story 20
- User story 22
- User story 23

---

## Issue 8: Polish and verification pass for the full repo-watching stack

### Status

In progress

### Parent PRD

PRD-opencode-inspired-repo-watching.md

### Layers touched

Server behavior, diagnostics, project/workspace UX verification, automated tests

### What to build

Run the full verification and polish pass for the OpenCode-inspired repository watching stack. Validate the PRD's polishing requirements end to end, especially duplicate-project prevention, stable workspace updates under churn, branch freshness, warning quality, and teardown cleanliness.

### Acceptance criteria

- [x] Adding nested or symlinked paths produces a clear non-duplicate outcome
- [ ] Repository and workspace state update smoothly during rapid worktree churn
- [x] Branch indicators refresh promptly after branch switches
- [ ] Ignored paths stay quiet and do not trigger noisy refresh work
- [x] Project removal and shutdown leave no lingering watcher resources
- [ ] Diagnostics or warnings for degraded watcher behavior are actionable and non-blocking
- [x] Final end-to-end test coverage reflects the shipped repo-watching behavior

### Blocked by

- Blocked by #1, #2, #3, #4, #5, #6, #7

### User stories addressed

- User story 1
- User story 3
- User story 5
- User story 10
- User story 15
- User story 19
- User story 20
- User story 22
- User story 23
- User story 24
