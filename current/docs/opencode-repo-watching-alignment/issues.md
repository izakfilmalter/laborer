# OpenCode Repo-Watching Alignment — Issues

---

## Issue 1: Persist canonical repository identity on project records

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Shared schema, server persistence, repository identity service, project registration flow, startup restore, integration tests

### What to build

Persist the logical repository identity that Laborer already derives during canonical resolution. Project records should store enough canonical identity to support direct dedupe and startup restore without re-resolving every saved project from only `repoPath`.

This slice should extend the persisted project model, wire the new fields through `RepositoryIdentity` and `ProjectRegistry`, and provide a safe migration or backfill path for projects created before the new fields existed.

### Acceptance criteria

- [x] Project records persist canonical repository identity fields needed for direct dedupe and restore
- [x] Adding a linked worktree path or alternate repo path dedupes by persisted logical identity instead of rescanning every project
- [x] Existing persisted projects are migrated or lazily backfilled without data loss
- [x] Startup restore can operate from persisted identity fields rather than only raw paths
- [x] Integration tests cover new-project writes and legacy-project backfill behavior

### Blocked by

None - can start immediately

### User stories addressed

- User story 1
- User story 2
- User story 8
- User story 11
- User story 12

---

## Issue 2: Native watcher backend behind the FileWatcher service boundary

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Server Effect services, watcher backend integration, dependency setup, lifecycle management, integration tests

### What to build

Replace the default `fs.watch` implementation behind `FileWatcher` with a more robust native watcher backend, while preserving the existing service contract and scoped lifecycle behavior. The watcher layer should still support fallback behavior so the rest of the repo-watching stack remains backend-agnostic.

This slice should focus on infrastructure parity: backend selection, subscription lifecycle, teardown behavior, and compatibility with the existing `RepositoryWatchCoordinator`.

### Acceptance criteria

- [x] `FileWatcher` uses a native watcher backend by default behind the same public service interface
- [x] A fallback implementation exists and can be selected without changing coordinator code
- [x] Repository and git-metadata subscriptions still clean up correctly on project removal and server shutdown
- [x] Watcher behavior remains compatible with existing coordinator recovery logic
- [x] Integration tests cover native backend subscribe/unsubscribe behavior and fallback operation

### Blocked by

- Blocked by #1 only if persisted identity changes are needed for coordinated rollout

### User stories addressed

- User story 3
- User story 5
- User story 6
- User story 7
- User story 12

---

## Issue 3: Stronger watcher-boundary ignore model and configuration

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Watcher backend, repository event bus, configuration, coordinator wiring, integration tests

### What to build

Strengthen ignore handling so Laborer can suppress noisy directories earlier and more flexibly, closer to the watcher subscription boundary. The centralized ignore model should remain authoritative, but watcher-capable backends should avoid sending obvious noise downstream in the first place.

This slice should also make ignore configuration extensible so Laborer can append project- or app-specific noisy path patterns without code changes.

### Acceptance criteria

- [x] Default ignore rules remain centralized and are applied consistently across watcher and event-bus boundaries
- [x] Watcher-capable backends suppress ignored paths before downstream invalidation work when possible
- [x] Ignore configuration can be extended without editing source code
- [x] Ignored paths do not trigger branch refresh, worktree reconciliation, or repo event fanout
- [x] Integration tests cover dependency installs, build output churn, and custom ignore additions

### Blocked by

- Blocked by #2

### User stories addressed

- User story 4
- User story 5
- User story 9
- User story 12

---

## Issue 4: Backend-native repository event semantics and normalized fanout

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

FileWatcher, RepositoryEventBus, RepositoryWatchCoordinator, downstream event consumers, integration tests

### What to build

Upgrade the repository file-event pipeline so add/change/delete semantics come from the watcher backend where possible instead of best-effort inference from `rename` events. Laborer should still expose the same normalized repository event shape, but the semantics should be stronger and less backend-dependent.

This slice should keep the event bus stable while improving how events are produced and validated, and it should establish a clear compatibility layer for any remaining fallback watcher behavior.

### Acceptance criteria

- [x] Native watcher events map cleanly into Laborer's normalized add/change/delete event model
- [x] Fallback watcher behavior still produces the normalized event shape with explicit best-effort semantics where needed
- [x] Event fanout remains backend-agnostic for downstream services
- [x] Delete/add classification is more accurate under rename and churn-heavy scenarios than the current `fs.watch` implementation
- [x] Integration tests cover add, change, delete, rename-heavy churn, and fallback semantics

### Blocked by

- Blocked by #2

### User stories addressed

- User story 5
- User story 6
- User story 7
- User story 10
- User story 12

---

## Issue 5: Startup restore and project lifecycle based on persisted identity

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Project registry, startup bootstrap, repository identity, watcher orchestration, persistence, integration tests

### What to build

Update project lifecycle and startup restore so they use persisted canonical identity as the durable source for rehydrating repo watchers and registration state. This should reduce reliance on raw path-only re-resolution and make restarts clearer and cheaper.

This slice should ensure watcher boot, dedupe checks, and restore behavior all operate coherently with the new persisted project identity model.

### Acceptance criteria

- [x] Project add flow writes persisted identity fields and uses them immediately for lifecycle operations
- [x] Server startup restores watchers using persisted canonical identity
- [x] Legacy persisted projects remain bootable through migration or lazy backfill
- [x] Startup restore produces the same visible workspaces and branch state as fresh registration
- [x] Integration tests cover restart flows for both migrated and newly created project records

### Blocked by

None - Issue #1 is complete

### User stories addressed

- User story 1
- User story 2
- User story 8
- User story 11
- User story 12

---

## Issue 6: Downstream repository event consumers and end-to-end invalidation

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Repository event bus, downstream repo-aware services, invalidation flow, integration tests

### What to build

Turn the repository event bus into a real end-to-end platform capability by wiring at least one downstream consumer path that performs meaningful invalidation or refresh work. The goal is to prove that the event pipeline supports product behavior, not just internal fanout.

This slice should choose one thin but real downstream consumer path - for example diff invalidation, diagnostics invalidation, or future indexing hooks - and verify it stays backend-agnostic.

### Acceptance criteria

- [x] At least one production downstream service consumes normalized repository file events
- [x] The consumer performs meaningful invalidation or refresh work rather than only logging events
- [x] Event consumption does not introduce duplicate watcher ownership or tight backend coupling
- [x] End-to-end tests verify that repo file changes drive the expected downstream invalidation behavior
- [x] The event bus remains reusable for future repo-aware features

### Blocked by

- Blocked by #3, #4

### User stories addressed

- User story 5
- User story 10
- User story 12

---

## Issue 7: Parity hardening and regression coverage

### Parent PRD

PRD-opencode-repo-watching-alignment.md

### Layers touched

Server test suite, watcher integration tests, migration coverage, diagnostics/logging, CI coverage reporting

### What to build

Harden the finished alignment work with targeted regression coverage that exercises migration, native/fallback backend behavior, ignore filtering, persisted identity, and end-to-end invalidation. This is the final parity pass that proves the new implementation behaves like a durable platform layer rather than a fragile feature slice.

### Acceptance criteria

- [x] Tests cover persisted identity migration/backfill and direct dedupe behavior
- [x] Tests cover native backend operation and fallback backend behavior
- [x] Tests cover ignore filtering at watcher and event-bus boundaries
- [x] Tests cover at least one end-to-end downstream invalidation path driven by repo file events
- [x] Coverage reporting clearly includes the updated repo-watching implementation areas

### Blocked by

- Blocked by #1, #2, #3, #4, #5, #6

### User stories addressed

- User story 12
