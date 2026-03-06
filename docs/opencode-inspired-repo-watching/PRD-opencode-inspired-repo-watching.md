# PRD: OpenCode-Inspired Repository Watching and Worktree Tracking

## Problem Statement

Laborer already detects and reconciles git worktrees, but its repository watching model is narrower and less hardened than the approach used by OpenCode. Today, repository registration is not fully canonicalized, path comparisons can drift across symlinks or alternate path representations, and server-side watching relies on basic filesystem primitives with limited recovery behavior. That creates room for duplicate project records, false add/remove reconciliation, stale branch or worktree state, and watcher fragility when git metadata directories are recreated or moved.

From the developer's point of view, repository-aware features should feel trustworthy: adding any directory inside a repo should resolve to the same project, linked worktrees should appear and disappear reliably, branch and repo metadata should stay in sync, and watcher failures should degrade gracefully without forcing the user to manually repair state.

## Solution

Adopt the full repository-state and repository-watching patterns OpenCode uses and apply them to Laborer's server architecture. Laborer should treat git itself as the source of truth for repo state, use canonical repository identity based on the checkout root and shared git directory, watch both repository content and git metadata with a robust native watcher backend, and translate raw watch events into debounced refresh and reconciliation passes instead of trying to infer correctness from individual events.

The new design introduces a repository identity layer, a durable watch coordinator, a repo file-event pipeline, and clearer separation between filesystem events, git metadata refresh, file-state invalidation, and workspace reconciliation. These modules should be expressed as Effect services and composed with Layers, not ad hoc classes or singletons. Worktree detection remains driven by `git worktree list --porcelain`, but it becomes worktree-aware in the same way OpenCode is: canonical paths, explicit common git directory handling, scoped lifecycle management for watchers and cached repo state, and repo-wide file change events that other Laborer features can consume.

## User Stories

1. As a developer, I want Laborer to resolve any added directory to a canonical repository identity, so that adding the repo root, a nested folder, or a symlinked path does not create duplicate projects.
2. As a developer, I want Laborer to understand the difference between a checkout root and a shared git directory, so that linked worktrees are modeled as part of the same logical repository.
3. As a developer, I want worktree detection to stay accurate when git stores metadata in a common directory, so that external worktree creation and removal are always associated with the correct project.
4. As a developer, I want Laborer to canonicalize all repo and worktree paths before storing or comparing them, so that symlinks and path representation differences do not create false additions or removals.
5. As a developer, I want watcher setup and teardown to be tied to project lifecycle, so that removing a project always releases associated watchers and subscriptions.
6. As a developer, I want Laborer to use a robust cross-platform watcher backend for repository and git metadata changes, so that worktree sync is less fragile than plain `fs.watch`.
7. As a developer, I want watcher subscriptions to recover when watched directories are deleted and recreated, so that git metadata churn does not permanently disable syncing.
8. As a developer, I want watch events to be debounced and coalesced, so that scripts creating or removing many worktrees do not cause reconciliation thrash.
9. As a developer, I want Laborer to re-run git-based detection after relevant watch events, so that git remains the source of truth instead of raw filesystem event interpretation.
10. As a developer, I want branch metadata to refresh when HEAD-related git metadata changes, so that the UI does not show stale branch names.
11. As a developer, I want repository status checks that drive critical decisions to bypass potentially stale git fsmonitor state, so that resets, reconciliation, and validation are correct.
12. As a developer, I want initial project registration to perform canonical discovery and an initial repo refresh before the project is considered ready, so that the UI starts from a consistent state.
13. As a developer, I want externally created worktrees to keep their existing behavior in Laborer, so that better watching does not change the user-facing contract for detected workspaces.
14. As a developer, I want the main checkout and linked worktrees to be tracked under one logical project, so that project grouping remains stable even when worktrees live outside the main repo directory.
15. As a developer, I want watcher failures to surface as warnings with automatic retry or resubscribe behavior, so that temporary filesystem issues are non-fatal.
16. As a developer, I want Laborer to keep watcher ignores explicit and configurable, so that noisy directories do not flood the system with irrelevant events.
17. As a developer, I want Laborer to separate repository watching from workspace process watcher configuration, so that server-side correctness and child-process resource tuning can evolve independently.
18. As a developer, I want branch, worktree, and repository identity state to live in one coherent server-side model, so that later features like repo indexing or branch-aware UI can build on the same foundation.
19. As a developer, I want project bootstrapping after server restart to restore watchers for all known repositories and immediately refresh git-backed state, so that offline changes are reconciled on startup.
20. As a developer, I want tests to cover real git repositories, linked worktrees, symlinked paths, and watcher recovery, so that the new repository model is proven against realistic edge cases.
21. As a developer, I want Laborer to emit normalized repository file-change events, so that future features can respond to add/change/delete activity without each feature owning its own watcher.
22. As a developer, I want repository file watching to use a shared ignore model, so that build outputs, dependency folders, and git internals do not trigger unnecessary refresh work.
23. As a developer, I want repository file-change handling to remain eventually consistent under heavy churn, so that save storms or branch switches do not corrupt project state.
24. As a developer, I want the watcher architecture to support later file indexing, diff invalidation, and diagnostics refresh, so that Laborer can build more repo-aware features on top of one event source.

## 'Polishing' Requirements

1. Verify that adding a subdirectory of an already-registered repo results in a clear, non-confusing UX message rather than a duplicate project card.
2. Ensure repository and workspace lists update smoothly during rapid worktree churn without flicker, duplicate rows, or temporary negative counts.
3. Confirm that warnings about watcher degradation are visible in diagnostics or logs but do not interrupt normal UI flows.
4. Verify that branch indicators update promptly after branch switches in both the main checkout and linked worktrees.
5. Ensure startup reconciliation after server boot feels immediate enough that users do not observe stale worktree lists for long.
6. Confirm that path canonicalization behavior is invisible to the user except where it prevents duplication or stale state.
7. Verify that ignored directories do not produce noisy logs or unnecessary reconciliation work.
8. Ensure project removal fully tears down watcher resources and does not leak file descriptors or timers.
9. Confirm that repositories with no linked worktrees still behave correctly and do not spam retries for missing metadata directories.
10. Verify that failure messages for invalid or corrupted git repositories remain actionable and distinct from transient watch failures.

## Implementation Decisions

- The architecture should be implemented explicitly as Effect services with tagged interfaces and Layer-based composition. Long-lived watcher-owning services should be `scoped`, pure git/query modules should remain ordinary services, and no major repository-state module in this feature should be introduced as a free-floating singleton.
- Introduce a deep `RepositoryIdentity` Effect service that resolves and returns canonical repository metadata for any user-supplied path. Its public contract should include the canonical checkout root, canonical common git directory, whether the current path is the main checkout or a linked worktree, and a stable logical repository identifier.
- Define that logical repository identity from git-backed facts rather than user-entered paths. At minimum, the model should use canonicalized `show-toplevel`, canonicalized `git-common-dir`, and a stable git-derived identifier so that all worktrees for the same repo collapse into one project.
- Store canonical repo and worktree paths only. All reconciliation and deduplication should compare normalized real paths, never raw user input.
- Keep `git worktree list --porcelain` as the authoritative worktree enumeration mechanism. Do not infer worktree membership from directory watching alone. This behavior should sit behind a dedicated `WorktreeReconciler` Effect service boundary.
- Add a scoped `RepositoryWatchCoordinator` Effect service that owns all watcher lifecycle for a registered repository. It should subscribe to the canonical checkout root when file watching is enabled and separately subscribe to the canonical common git directory for metadata changes that affect branch and worktree state.
- Prefer a mature native watcher backend similar to OpenCode's approach rather than relying exclusively on plain `fs.watch`. The watcher layer should be abstracted, but the intended product direction is repo-wide watching by default rather than a metadata-only feature flag.
- Treat watch events as invalidation signals only. A watch event should schedule refresh work, not mutate project or workspace state directly.
- Split refresh work into separate Effect services: `WorktreeReconciler` for worktree reconciliation, `BranchStateTracker` for branch metadata refresh, and `RepositoryStateRefresher` for repository file-state invalidation and downstream fanout. This keeps the watcher layer simple and the refresh semantics explicit.
- Add scoped watcher disposal so that project removal, server shutdown, and test teardown all use the same cleanup path exposed by the scoped services.
- Add startup bootstrapping that restores watchers for all known repositories and immediately runs a git-backed refresh before accepting the repository state as current.
- When reading git state for correctness-sensitive operations, disable fsmonitor where appropriate to avoid stale answers from git's own caching layer.
- Keep ignore rules centralized. The watcher layer should own an explicit ignore list for irrelevant directories and allow configuration to extend it without changing reconciliation logic.
- Introduce a normalized repository event model for file add/change/delete notifications. The watcher backend may emit platform-specific payloads, but Laborer should expose a stable internal event shape through a `RepositoryEventBus` Effect service that downstream services can consume.
- Add a repository event bus or equivalent publisher layer so multiple features can subscribe to file-change activity without duplicating watchers. This should be managed by Effect rather than hidden global emitters.
- Maintain a lightweight per-repository cache of known file-state metadata only where it improves user-visible performance or reduces repeated expensive scans; git remains the source of truth for repo status, while watcher-driven caches are treated as invalidatable accelerators. If introduced now, it should be its own Effect service rather than state embedded in unrelated watcher code.
- Preserve the existing external-worktree UX contract: externally detected workspaces remain stopped until activated, and destructive operations continue to distinguish between Laborer-managed and externally managed worktrees.
- Keep workspace process environment tuning separate from repository watching. Child-process watcher environment variables remain a performance and resource control concern, not the source of truth for repo state.
- Roll out the broader repository watcher in phases if needed: first canonical repository identity and improved watcher lifecycle, then full downstream consumption of repository file events by indexing, diff, or diagnostics features.
- The expected Layer graph should be clear in implementation: git/platform adapters at the bottom, repository identity and event services above them, watcher coordination and refresh services above those, and project/workspace orchestration services consuming that stack at the edge.

## Testing Decisions

- Good tests verify observable repository behavior through public Effect services: canonical project registration, accurate worktree reconciliation, branch refresh, and watcher recovery. Tests should instantiate behavior through test Layers and avoid asserting internal timer or subscription implementation details except where lifecycle is the behavior under test.
- Test the repository identity module against real git repositories created in temporary directories. Cover repo root input, nested path input, symlinked path input, linked worktree input, and repositories with shared git metadata.
- Test worktree reconciliation with real `git worktree add` and `git worktree remove` flows, asserting that canonical path matching prevents duplicate or stale workspaces.
- Test watcher coordination with realistic filesystem changes, including creation of the worktree metadata directory after watcher startup, deletion and recreation of watched directories, and bursts of multiple worktree operations.
- Test repository file-event fanout with real add/change/delete operations in watched repos, asserting that normalized events are emitted and ignored paths stay quiet.
- Test branch refresh behavior by switching branches and detached HEAD states, then asserting that the externally visible branch state updates correctly.
- Test startup bootstrapping by seeding persisted projects, mutating worktrees while the server is offline, then verifying that server startup reconciles the latest state.
- Test that correctness-sensitive git reads behave properly even when git fsmonitor is configured, focusing on user-visible correctness rather than the exact command line.
- Test ignore behavior by generating noise in ignored directories and asserting that no unnecessary repo refreshes or workspace mutations occur.
- Test heavy-churn scenarios such as branch switches, dependency installation, and generated-file bursts to ensure event coalescing prevents unstable or excessive downstream refresh work.
- Reuse existing real-git temporary-directory patterns and service-layer integration test structure as prior art, extending them to cover canonicalization, watcher durability, and Layer-based service composition scenarios.

## Out of Scope

- Building a full fuzzy file search UI like OpenCode in this phase.
- Adding a new UI surface for raw filesystem event streams or repository diagnostics beyond lightweight warnings and logs.
- Reworking Laborer's workspace activation, terminal lifecycle, or port allocation flows beyond what is required to preserve current behavior.
- Introducing background polling as the primary sync strategy for all repository state.
- Supporting non-git version control systems.
- Redesigning project grouping or sidebar UX beyond the minimum needed to reflect canonical repo identity.

## Further Notes

- OpenCode's strongest pattern is not just its choice of watcher library; it is the architectural separation between watch signals, git-backed truth, canonical repository identity, and instance-scoped cleanup. Laborer should copy that shape first, then match implementation details where they improve correctness.
- The chosen adoption path is full OpenCode-style repo watching, so the PRD now assumes repo-wide file watching is part of the target architecture rather than a later optional extension.
- For this codebase, that architecture should be translated into explicit Effect services and Layers so the repo-watching stack is testable, scoped, and composable with the rest of the server.
- If platform behavior from a native watcher backend proves problematic, Laborer should preserve the higher-level interfaces so a temporary fallback implementation can be used without changing repository logic.
