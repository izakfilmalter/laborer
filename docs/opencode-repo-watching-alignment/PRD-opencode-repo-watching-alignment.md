# PRD: OpenCode Alignment for Repository Identity, Watcher Backend, and Event Pipeline

## Problem Statement

Laborer's repo-watching architecture now broadly matches the shape of OpenCode's design, but the implementation still diverges in a few important places that affect robustness, scalability, and parity with the reference model. The biggest remaining gap is the watcher backend: Laborer still relies on plain `fs.watch`, which forces best-effort add/delete inference, makes ignored-path filtering noisier than necessary, and is more vulnerable to platform-specific watcher edge cases than OpenCode's native watcher stack.

There are also model-level gaps. Laborer computes a logical repository identity during registration, but it does not persist that identity on the project record, so duplicate detection still requires re-resolving every stored project. Its ignore model is centralized but narrower and less configurable than OpenCode's. Its repository event bus is in place, but downstream consumption is still relatively thin compared to OpenCode's end-to-end invalidation flow. As a result, Laborer is directionally correct, but not yet at full OpenCode-style parity for resilience, efficiency, or extensibility.

From the developer's point of view, this follow-up should make the repo-watching stack feel more production-ready: watcher behavior should be less backend-dependent, repository dedup should be cheap and explicit, ignored files should be filtered consistently and early, and repo file events should be solid enough to support future indexing, diagnostics, and UI refresh features without another architectural rewrite.

## Solution

Bring Laborer's implementation closer to OpenCode's mature repo model in three focused areas: persist canonical repository identity on the project model, replace the default watcher backend with a more robust native implementation behind the existing `FileWatcher` service boundary, and strengthen the file-event pipeline so ignore handling and downstream consumption look more like a first-class platform capability than a thin utility bus.

The work should preserve the architecture that is already in place - Effect services, scoped watcher lifecycle, git-driven reconciliation, and normalized repository events - while tightening the implementation details where OpenCode is still stronger. The target outcome is not a line-by-line port. It is an OpenCode-shaped system adapted to Laborer: explicit repo identity on persisted project state, backend-agnostic watcher abstractions with a native default, clearer watcher-level ignore behavior, better event semantics, and a path for future repo-aware features to consume one stable internal event source.

## User Stories

1. As a developer, I want Laborer to persist canonical repository identity on project records, so that duplicate detection does not need to re-resolve every saved project.
2. As a developer, I want linked worktrees and the main checkout to share one durable logical repository identifier, so that project grouping stays stable across restarts and re-registration.
3. As a developer, I want Laborer to use a robust native watcher backend by default, so that repo watching behaves more consistently across platforms than plain `fs.watch`.
4. As a developer, I want watcher setup to apply ignore rules as early as possible, so that noisy paths are filtered before they create unnecessary downstream work.
5. As a developer, I want repository file events to carry a stable internal shape even if the underlying watcher backend changes, so that downstream services do not need backend-specific logic.
6. As a developer, I want add/change/delete semantics to come from the watcher backend where possible, so that event classification is less best-effort during heavy churn.
7. As a developer, I want watcher recovery behavior to remain scoped and automatic, so that transient filesystem or git metadata problems do not permanently degrade repo syncing.
8. As a developer, I want repository identity and known checkout/worktree paths to be represented explicitly in project state, so that later repo-aware features can reuse that state instead of rediscovering it ad hoc.
9. As a developer, I want ignore rules to be configurable and extensible, so that Laborer can suppress workspace-specific noise without changing code.
10. As a developer, I want repository file events to be consumed by real downstream invalidation flows, so that the event bus is not just infrastructure but part of the product behavior.
11. As a developer, I want startup restoration to rebuild repo watching from persisted canonical identity, so that watcher boot does not depend on re-deriving everything from only raw paths.
12. As a developer, I want tests to verify native-watcher integration, persisted identity behavior, ignore filtering, and downstream event consumption, so that parity work is proven rather than assumed.

## 'Polishing' Requirements

1. Ensure project registration remains instant enough that persisting extra identity metadata does not make add-project UX feel slower.
2. Confirm watcher warnings remain actionable and non-blocking when the native backend is unavailable or temporarily degraded.
3. Verify ignored directories stay quiet under dependency installs, build output churn, and editor temp-file noise.
4. Ensure file add/delete events are not mislabeled during rapid save, rename, or branch-switch scenarios when the backend can provide stronger semantics.
5. Confirm startup restore produces the same visible workspace set before and after the identity persistence changes.
6. Verify the event pipeline stays backend-agnostic from the point of view of downstream Laborer services.
7. Ensure fallback behavior is explicit if the preferred native watcher backend cannot be used on a platform or in CI.
8. Confirm parity work does not regress externally managed worktree behavior or existing branch refresh timing.

## Implementation Decisions

- Persist logical repository identity on the `projects` record, not just in transient resolution results. At minimum, store a stable canonical repo identifier plus the canonical common git directory so dedupe and startup restore can operate on persisted identity.
- Keep `RepositoryIdentity` as the authoritative place that derives canonical repo facts from git, but extend its output so persisted project state can include the fields needed for durable identity.
- Maintain backward compatibility for existing stored projects by introducing a migration or lazy backfill path that populates missing persisted identity fields on read or startup.
- Preserve `FileWatcher` as the service boundary, but swap its default implementation from plain `fs.watch` to a robust native backend similar to OpenCode's approach.
- Support an explicit fallback implementation behind the same `FileWatcher` contract so the rest of the repo-watching stack does not depend directly on any one watcher library.
- Move ignore behavior closer to watcher subscription where the backend supports it. The event bus should still keep centralized ignore semantics, but watcher-level filtering should suppress obvious noise earlier.
- Expand ignore configuration so default patterns remain centralized while project or app configuration can append additional ignores without changing code.
- Preserve the normalized repository event model, but prefer backend-native add/update/delete distinctions when available instead of inferring from path existence checks.
- Keep repo-root file watching and git-metadata watching as separate concerns. The native backend change should not collapse the distinction between repository content invalidation and git-state refresh.
- Extend project registration and startup bootstrap to use persisted repository identity when deciding whether a project already exists and how watchers should be restored.
- Introduce an explicit project-level representation of known checkout/worktree paths if that materially simplifies dedupe, restore, or downstream repo-aware features. If added now, it should be part of the project/repository model rather than implicit state hidden in watcher code.
- Add at least one real downstream consumer path for repository file events beyond tests, such as invalidation hooks for future diff/indexing/diagnostics state, so the event bus remains part of a meaningful product flow.
- Keep the current scoped cleanup and recovery model in `RepositoryWatchCoordinator`; parity work should strengthen backend behavior, not regress the current recovery guarantees.
- Preserve git as the source of truth for repository structure. A stronger watcher backend is an invalidation mechanism, not a replacement for git-driven reconciliation.

## Testing Decisions

- Add integration tests for the native `FileWatcher` implementation that exercise real add/change/delete events and verify the expected normalized event kinds reach the repository event bus.
- Keep deterministic service-layer tests for watcher recovery and event fanout so backend parity work does not reintroduce flakiness.
- Add tests for persisted repository identity on project registration, duplicate detection across linked worktrees, and startup restore using stored identity fields rather than only raw paths.
- Test ignore behavior at both watcher-level and event-bus-level boundaries, ensuring noisy directories are filtered before downstream refresh work when supported by the backend.
- Add fallback tests proving that if the preferred watcher backend is unavailable, Laborer can still operate through the fallback `FileWatcher` implementation without changing coordinator behavior.
- Add tests that validate backend-native delete/add semantics are preserved through the normalized repository event model.
- Add a startup migration/backfill test for projects created before persisted identity fields existed.
- Add at least one integration test for a real downstream consumer of repository file events, so the event pipeline is exercised end to end rather than only through direct bus subscriptions.
- Continue using real temporary git repositories for identity, worktree, and startup flows, and continue using deterministic stubbed watcher layers for lifecycle and recovery edge cases.

## Out of Scope

- Rebuilding Laborer's repo-watching architecture from scratch; this PRD is about closing parity gaps, not replacing the current design.
- Shipping a full user-facing file tree refresh or indexing product in the same change unless a thin downstream consumer is needed to validate the event pipeline.
- Redesigning project/workspace UI or changing externally managed worktree UX semantics.
- Supporting non-git repositories.
- Introducing polling as the preferred steady-state watcher strategy.

## Further Notes

- OpenCode's advantage is not only its watcher backend choice. It also persists project identity more explicitly and applies ignore logic closer to the watcher boundary. Laborer should close those gaps together rather than treating the backend swap as the whole story.
- Laborer already has a stronger scoped recovery story than the reference in some areas. That should be preserved as a deliberate implementation advantage.
- The best rollout path is likely phased: first persist repository identity, then land the native watcher backend and fallback contract, then strengthen ignore configuration and downstream event consumers.
- Success should be measured by three outcomes: cheaper and clearer dedupe, more reliable watcher semantics under churn, and a repo event pipeline that is clearly ready for future repo-aware features.
