# Issues: Test Coverage Improvement

## Issue 1: Extract TestLaborerStore shared helper

### Parent PRD

PRD-test-coverage.md

### What to build

Extract the `makeTestStore` / `TestLaborerStore` boilerplate into a shared helper module at `packages/server/test/helpers/test-store.ts`. This 15-line block is currently copy-pasted identically across 9 test files. The helper exports `makeTestStore` (the Effect program that creates an in-memory LiveStore with a unique storeId) and `TestLaborerStore` (the scoped Layer).

Update all 9 consumer test files to import from the new helper instead of inlining the boilerplate: `task-manager.test.ts`, `linear-task-importer.test.ts`, `github-task-importer.test.ts`, `prd-task-importer.test.ts`, `workspace-destroy-origin.test.ts`, `worktree-watcher.test.ts`, `project-registry.worktree-detection.test.ts`, `terminal-manager.test.ts` (server), `worktree-reconciler.test.ts`.

See PRD Implementation Decisions > Shared Test Helpers for details.

### Acceptance criteria

- [x] `packages/server/test/helpers/test-store.ts` exists and exports `makeTestStore` and `TestLaborerStore`
- [x] All 9 test files import from the helper -- zero remaining inline `makeTestStore` definitions
- [x] All modified tests pass (`bunx vitest run test/task-manager.test.ts test/github-task-importer.test.ts test/linear-task-importer.test.ts test/prd-task-importer.test.ts test/workspace-destroy-origin.test.ts test/worktree-reconciler.test.ts test/worktree-watcher.test.ts test/project-registry.worktree-detection.test.ts test/terminal-manager.test.ts test/prd-rpc-handlers.test.ts` in `packages/server`)
- [x] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately

### User stories addressed

- User story 1

---

## Issue 2: Extract git repo shared helpers

### Parent PRD

PRD-test-coverage.md

### What to build

Extract the duplicated git repo helper functions into `packages/server/test/helpers/git-helpers.ts`. These functions (`createTempDir`, `git`, `initRepo`) are currently duplicated across 5+ worktree/workspace test files. Also extract the `ensureBunSpawnForNodeTests` shim if needed by multiple files.

Update all consumer test files to import from the shared module.

See PRD Implementation Decisions > Shared Test Helpers for details.

### Acceptance criteria

- [x] `packages/server/test/helpers/git-helpers.ts` exists and exports `createTempDir`, `git`, `initRepo`
- [x] All worktree/workspace test files import from the helper -- zero remaining inline definitions
- [ ] All existing tests pass (`bun run test` in packages/server)
- [x] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately

### User stories addressed

- User story 2

---

## Issue 3: Extract timing shared helpers

### Parent PRD

PRD-test-coverage.md

### What to build

Extract the duplicated `delay` and `waitFor` helper functions into `packages/server/test/helpers/timing-helpers.ts`. These are currently duplicated across async test files that poll for state changes or wait for process events.

Update all consumer test files to import from the shared module.

See PRD Implementation Decisions > Shared Test Helpers for details.

### Acceptance criteria

- [ ] `packages/server/test/helpers/timing-helpers.ts` exists and exports `delay` and `waitFor`
- [ ] All async test files import from the helper -- zero remaining inline definitions
- [ ] All existing tests pass (`bun run test` in packages/server)
- [ ] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately

### User stories addressed

- User story 3

---

## Issue 4: Delete dead/duplicate test files from server

### Parent PRD

PRD-test-coverage.md

### What to build

Remove three test files from `packages/server/test/` that are dead or duplicate code:

1. `terminal-manager.test.ts` -- 508 lines, entirely `describe.skip`'d. Terminal tests live in `packages/terminal` now (Issue #143 migration).
2. `pty-host.test.ts` -- Duplicate of `packages/terminal/test/pty-host.test.ts`. The source code (`pty-host.ts`) lives in the terminal package.
3. `ring-buffer.test.ts` -- Duplicate of `packages/terminal/test/ring-buffer.test.ts`. The source code (`ring-buffer.ts`) lives in the terminal package.

### Acceptance criteria

- [ ] `packages/server/test/terminal-manager.test.ts` is deleted
- [ ] `packages/server/test/pty-host.test.ts` is deleted
- [ ] `packages/server/test/ring-buffer.test.ts` is deleted
- [ ] No remaining `describe.skip` blocks in the server test suite
- [ ] All remaining server tests pass (`bun run test` in packages/server)

### Blocked by

None - can start immediately

### User stories addressed

- User story 5

---

## Issue 5: Migrate worktree/workspace server tests to @effect/vitest

### Parent PRD

PRD-test-coverage.md

### What to build

Migrate 5 worktree/workspace test files in `packages/server/test/` from plain vitest to `@effect/vitest` patterns:

1. `workspace-destroy-origin.test.ts`
2. `workspace-validation.test.ts`
3. `worktree-detector.test.ts`
4. `worktree-reconciler.test.ts`
5. `worktree-watcher.test.ts`

Replace `import { describe, expect, it } from "vitest"` with `import { assert, describe, it } from "@effect/vitest"`. Replace manual `Effect.runPromise` / scope management with `it.effect`, `it.scoped`, or `it.layer` as appropriate. Replace `expect().toBe()` style assertions with `assert.strictEqual`, `assert.deepStrictEqual`, etc.

See PRD Implementation Decisions > @effect/vitest Migration for patterns.

### Acceptance criteria

- [ ] All 5 files import from `@effect/vitest` instead of `vitest`
- [ ] All 5 files use `it.effect` or `it.scoped` instead of manual `Effect.runPromise`
- [ ] All 5 files use `assert` instead of `expect`
- [ ] All tests pass (`bun run test` in packages/server)
- [ ] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately
- Blocked by Issue 2 (git helpers must exist)
- Blocked by Issue 3 (timing helpers must exist)

### User stories addressed

- User story 4
- User story 27

---

## Issue 6: Migrate task/importer server tests to @effect/vitest

### Parent PRD

PRD-test-coverage.md

### What to build

Migrate 4 task-related test files in `packages/server/test/` from plain vitest to `@effect/vitest` patterns:

1. `task-manager.test.ts`
2. `github-task-importer.test.ts`
3. `linear-task-importer.test.ts`
4. `prd-task-importer.test.ts`

Replace `import { describe, expect, it } from "vitest"` with `import { assert, describe, it } from "@effect/vitest"`. Replace manual `runWithTestServices` / `Effect.runPromise` with `it.effect` or `it.scoped`. Replace `expect` with `assert`.

See PRD Implementation Decisions > @effect/vitest Migration for patterns.

### Acceptance criteria

- [ ] All 4 files import from `@effect/vitest` instead of `vitest`
- [ ] All 4 files use `it.effect` or `it.scoped` instead of manual `Effect.runPromise`
- [ ] All 4 files use `assert` instead of `expect`
- [ ] The `runWithTestServices` helper is removed from each file (replaced by `Effect.provide(TestLayer)`)
- [ ] All tests pass (`bun run test` in packages/server)
- [ ] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately

### User stories addressed

- User story 4
- User story 27

---

## Issue 7: Migrate remaining server tests to @effect/vitest

### Parent PRD

PRD-test-coverage.md

### What to build

Migrate the remaining server test files from plain vitest to `@effect/vitest` patterns:

1. `config-service.test.ts`
2. `prd-schema.test.ts`
3. `rpc-config-handlers.test.ts`
4. `project-registry.worktree-detection.test.ts`

Replace manual Effect execution with `it.effect`/`it.scoped` and `expect` with `assert`.

Note: `config-service.test.ts` and `rpc-config-handlers.test.ts` will be rewritten in later issues. This migration can be done first as a stepping stone, or skipped for those files if the rewrite issues are picked up immediately after.

### Acceptance criteria

- [ ] All files import from `@effect/vitest` instead of `vitest`
- [ ] All files use `it.effect` or `it.scoped` instead of manual `Effect.runPromise`
- [ ] All files use `assert` instead of `expect`
- [ ] All tests pass (`bun run test` in packages/server)
- [ ] `bun x ultracite check` passes on all modified files

### Blocked by

None - can start immediately

### User stories addressed

- User story 4
- User story 27

---

## Issue 8: Migrate terminal package tests to @effect/vitest assertions

### Parent PRD

PRD-test-coverage.md

### What to build

Migrate `packages/terminal/test/terminal-manager.test.ts` to use `assert` from `@effect/vitest` instead of `expect` from vitest. This file keeps its custom `runEffect` + shared-scope pattern (justified by the long-lived PtyHostClient layer) but should use `assert` for consistency.

`pty-host.test.ts` and `ring-buffer.test.ts` stay on plain vitest since they don't use Effect.

See PRD Implementation Decisions > @effect/vitest Migration > Exception note.

### Acceptance criteria

- [ ] `terminal-manager.test.ts` imports `assert` from `@effect/vitest`
- [ ] All `expect()` calls in `terminal-manager.test.ts` are replaced with `assert.*` equivalents
- [ ] The custom `runEffect` / `beforeAll` / `afterAll` scope management is preserved (not converted to `it.scoped`)
- [ ] All terminal tests pass (`bun run test` in packages/terminal)
- [ ] `bun x ultracite check` passes

### Blocked by

None - can start immediately

### User stories addressed

- User story 4
- User story 27

---

## Issue 9: Add LiveStore schema tests -- setup + project/workspace events

### Parent PRD

PRD-test-coverage.md

### What to build

Set up the test infrastructure for `packages/shared` and add the first schema materializer tests:

1. Add `vitest.config.ts` to `packages/shared`
2. Add `"test": "vitest run"` script to `packages/shared/package.json`
3. Add `@effect/vitest`, `vitest`, `@livestore/adapter-node` as devDependencies
4. Move `packages/server/test/prd-schema.test.ts` to `packages/shared/test/schema.test.ts`
5. Add tests for project events: `ProjectCreated` inserts, `ProjectRemoved` deletes
6. Add tests for workspace events: `WorkspaceCreated` inserts, `WorkspaceStatusChanged` updates, `WorkspaceDestroyed` deletes

Use `@effect/vitest` patterns. Each test commits an event to an in-memory LiveStore and queries the corresponding table.

See PRD Implementation Decisions > LiveStore Schema Tests.

### Acceptance criteria

- [ ] `packages/shared/vitest.config.ts` exists with correct configuration
- [ ] `packages/shared/package.json` has a `test` script
- [ ] `packages/shared/test/schema.test.ts` exists with project and workspace event tests
- [ ] `prd-schema.test.ts` is removed from `packages/server/test/`
- [ ] All tests pass (`bun run test` in packages/shared)
- [ ] Tests use `@effect/vitest` patterns (`it.effect`, `assert`)
- [ ] `bun x ultracite check` passes

### Blocked by

None - can start immediately

### User stories addressed

- User story 8
- User story 9

---

## Issue 10: Add LiveStore schema tests -- diff, task, PRD, panel layout events

### Parent PRD

PRD-test-coverage.md

### What to build

Expand `packages/shared/test/schema.test.ts` with materializer tests for the remaining active event groups:

1. **Diff events**: `DiffUpdated` upserts (including conflict resolution), `DiffCleared` deletes
2. **Task events**: `TaskCreated` inserts, `TaskStatusChanged` updates, `TaskRemoved` deletes
3. **PRD events**: `PrdCreated` inserts, `PrdStatusChanged` updates, `PrdRemoved` deletes
4. **Panel layout events**: `LayoutSplit` upserts, `LayoutPaneClosed` upserts, `LayoutPaneAssigned` upserts, `LayoutRestored` upserts

Each test commits an event and verifies the table state via query.

### Acceptance criteria

- [ ] Diff event tests (DiffUpdated upsert, DiffCleared delete) pass
- [ ] Task event tests (TaskCreated, TaskStatusChanged, TaskRemoved) pass
- [ ] PRD event tests (PrdCreated, PrdStatusChanged, PrdRemoved) pass
- [ ] Panel layout event tests (LayoutSplit, LayoutPaneClosed, LayoutPaneAssigned, LayoutRestored) pass
- [ ] All tests use `@effect/vitest` patterns
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 9 (shared test infrastructure must exist)

### User stories addressed

- User story 9

---

## Issue 11: Add LiveStore schema tests -- deprecated terminal event no-ops

### Parent PRD

PRD-test-coverage.md

### What to build

Add tests to `packages/shared/test/schema.test.ts` verifying that all 6 deprecated terminal events produce no-op materializers (empty SQL operation arrays). This is a backward-compatibility safety net -- if someone accidentally adds SQL operations to these materializers, the tests catch it.

Events to test: `TerminalSpawned`, `TerminalOutput`, `TerminalStatusChanged`, `TerminalKilled`, `TerminalRemoved`, `TerminalRestarted`.

See PRD Further Notes about the importance of these no-op tests.

### Acceptance criteria

- [ ] All 6 deprecated terminal events are tested
- [ ] Tests verify that committing these events does not modify any table (or verify the materializer returns empty operations)
- [ ] Tests use `@effect/vitest` patterns
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 9 (shared test infrastructure must exist)

### User stories addressed

- User story 10

---

## Issue 12: Rewrite config-service.test.ts through public API

### Parent PRD

PRD-test-coverage.md

### What to build

Rewrite `packages/server/test/config-service.test.ts` to remove the ~365 lines of tests that directly test internal functions (`expandTilde`, `readConfigFile`, `walkUpForConfigs`, `mergeConfigs`). Replace them with integration tests through the `ConfigService` public API (`resolveConfig`, `readGlobalConfig`, `writeProjectConfig`) that exercise the same underlying behavior.

The existing ConfigService integration tests (lines 372-669) are well-designed and should be preserved/migrated. The goal is to maintain the same behavioral coverage while removing implementation-detail coupling.

Use `@effect/vitest` patterns. Use shared test helpers.

See PRD Implementation Decisions > Existing Test Audit and Testing Decisions.

### Acceptance criteria

- [ ] No imports of `expandTilde`, `readConfigFile`, `walkUpForConfigs`, `mergeConfigs` in the test file
- [ ] All tests go through `ConfigService.resolveConfig`, `readGlobalConfig`, or `writeProjectConfig`
- [ ] Tilde expansion, walk-up traversal, config merging, and global fallback behavior are still tested (through the public API)
- [ ] Tests use `@effect/vitest` patterns (`it.effect`, `it.scoped`, `assert`)
- [ ] Tests use shared helpers (TestLaborerStore, git helpers)
- [ ] All tests pass (`bun run test` in packages/server)
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 1 (TestLaborerStore helper)
- Blocked by Issue 2 (git helpers)
- Blocked by Issue 5 or 7 (@effect/vitest migration)

### User stories addressed

- User story 6

---

## Issue 13: Set up RPC test infrastructure + health.check test

### Parent PRD

PRD-test-coverage.md

### What to build

Set up the `RpcTest.makeClient` infrastructure for testing LaborerRpcs endpoints in-memory and write the first tracer-bullet test: `health.check`.

Create `packages/server/test/rpc/` directory with a shared RPC test layer that composes `RpcTest.makeClient(LaborerRpcs)` with the real handler layer and all required service layers (backed by `TestLaborerStore`, real `ConfigService`, real `ProjectRegistry`, etc.). For services that depend on external systems (TerminalClient), create a minimal stub layer.

Write the `health.check` test to prove the infrastructure works end-to-end.

See PRD Implementation Decisions > RPC Integration Tests and the Effect reference `rpc-e2e.ts` pattern.

### Acceptance criteria

- [x] RPC test infrastructure layer is composable and reusable for all endpoint tests
- [x] `health.check` test verifies `{ status: "ok", uptime: number }` response through the in-memory RPC client
- [x] Tests use `@effect/vitest` patterns
- [ ] All tests pass (`bun run test` in packages/server)
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 1 (TestLaborerStore helper)

### User stories addressed

- User story 24

---

## Issue 14: RPC integration tests -- project.add + project.remove

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the project management endpoints using the infrastructure from Issue 13:

1. `project.add` -- registers a git repo, creates a project in LiveStore, triggers worktree detection
2. `project.remove` -- removes a project from LiveStore

Tests use real git repos on the filesystem, real `ProjectRegistry`, and real `WorktreeDetector`/`WorktreeReconciler` layers. Verify results through the RPC response and LiveStore state.

### Acceptance criteria

- [ ] `project.add` test verifies project creation and worktree detection for a real git repo
- [ ] `project.add` test verifies error response for an invalid repo path
- [ ] `project.remove` test verifies project deletion
- [ ] `project.remove` test verifies error response for a nonexistent project
- [ ] Tests use the shared RPC test infrastructure
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)
- Blocked by Issue 2 (git helpers)

### User stories addressed

- User story 13
- User story 14

---

## Issue 15: RPC integration tests -- config.get + config.update

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the config endpoints using the infrastructure from Issue 13. This replaces the existing `rpc-config-handlers.test.ts` which mocks internal services.

1. `config.get` -- resolves config with walk-up traversal, global fallback, and provenance metadata
2. `config.update` -- writes config to project-level file

Tests use real `ConfigService` and real `ProjectRegistry` layers with real filesystem config files. Delete or replace `rpc-config-handlers.test.ts`.

### Acceptance criteria

- [ ] `config.get` test verifies resolved config with correct provenance source metadata
- [ ] `config.get` test verifies error response for a nonexistent project
- [ ] `config.update` test verifies config is written and retrievable
- [ ] `rpc-config-handlers.test.ts` is deleted or fully replaced (no `vi.fn()` mocks remain)
- [ ] Tests use real `ConfigService` and `ProjectRegistry` layers (no `Layer.succeed` stubs)
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)
- Blocked by Issue 2 (git helpers)

### User stories addressed

- User story 7
- User story 15
- User story 16

---

## Issue 16: RPC integration tests -- workspace.create + workspace.destroy

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the workspace lifecycle endpoints:

1. `workspace.create` -- creates a git worktree, allocates a port, runs setup scripts, updates LiveStore
2. `workspace.destroy` -- destroys worktree based on origin (laborer vs. external), frees port, updates LiveStore

Tests use real git repos, real `WorkspaceProvider`, real `PortAllocator`, and a stub `TerminalClient` layer (system boundary). Verify results through RPC responses and LiveStore state.

### Acceptance criteria

- [ ] `workspace.create` test verifies worktree creation, port allocation, and LiveStore workspace record
- [ ] `workspace.create` test verifies error for nonexistent project
- [ ] `workspace.destroy` test verifies laborer-origin workspace has worktree removed
- [ ] `workspace.destroy` test verifies external-origin workspace retains worktree
- [ ] Stub TerminalClient is used (system boundary mock, not internal mock)
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)
- Blocked by Issue 2 (git helpers)

### User stories addressed

- User story 11
- User story 12

---

## Issue 17: RPC integration tests -- task.create + task.updateStatus + task.remove

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the basic task management endpoints:

1. `task.create` -- creates a manual task with optional PRD link
2. `task.updateStatus` -- transitions task status
3. `task.remove` -- deletes a task

Tests use real `TaskManager` layer backed by `TestLaborerStore`. Verify results through RPC responses and LiveStore state.

### Acceptance criteria

- [ ] `task.create` test verifies task creation with all fields
- [ ] `task.create` test verifies optional prdId linkage
- [ ] `task.updateStatus` test verifies status transition
- [ ] `task.remove` test verifies task deletion
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)

### User stories addressed

- User story 17
- User story 18

---

## Issue 18: RPC integration tests -- task.importGithub + task.importLinear

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the task import endpoints:

1. `task.importGithub` -- imports GitHub issues with deduplication and PR filtering
2. `task.importLinear` -- imports Linear issues with deduplication and filter construction

Tests mock `fetch` at the system boundary for GitHub REST API and Linear GraphQL API responses. Use real `GithubTaskImporter`, `LinearTaskImporter`, `TaskManager`, and `ConfigService` layers.

### Acceptance criteria

- [ ] `task.importGithub` test verifies issue import with correct count
- [ ] `task.importGithub` test verifies PR filtering (PRs are skipped)
- [ ] `task.importGithub` test verifies deduplication (existing tasks not re-imported)
- [ ] `task.importLinear` test verifies issue import with correct count
- [ ] `task.importLinear` test verifies deduplication
- [ ] Only `fetch` is mocked (system boundary) -- all internal services are real
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)
- Blocked by Issue 2 (git helpers, for project setup)

### User stories addressed

- User story 19
- User story 20

---

## Issue 19: RPC integration tests -- diff.refresh + editor.open

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for:

1. `diff.refresh` -- computes git diff for a workspace and updates LiveStore
2. `editor.open` -- launches the configured editor for a workspace

Tests use real git repos with actual file changes for diff testing. Editor tests verify the command is constructed correctly (may need to stub `Bun.spawn` at the process boundary to avoid actually launching an editor).

### Acceptance criteria

- [ ] `diff.refresh` test verifies diff content is computed from real git changes and stored in LiveStore
- [ ] `diff.refresh` test verifies error for nonexistent workspace
- [ ] `editor.open` test verifies the correct editor command is used based on config
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)
- Blocked by Issue 2 (git helpers)

### User stories addressed

- User story 21
- User story 23

---

## Issue 20: RPC integration tests -- terminal.spawn + rlph endpoints

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for the endpoints that proxy to the standalone terminal service:

1. `terminal.spawn` -- spawns a terminal in a workspace via TerminalClient
2. `rlph.startLoop` -- starts an RLPH coding loop
3. `rlph.writePRD` -- writes a PRD via RLPH
4. `rlph.review` -- reviews a PR via RLPH
5. `rlph.fix` -- fixes a PR via RLPH

All 5 endpoints delegate to `TerminalClient`, which is a system boundary (separate HTTP service). Provide a stub `TerminalClient` layer that returns canned responses. This is appropriate boundary mocking per the PRD's testing decisions.

### Acceptance criteria

- [ ] `terminal.spawn` test verifies terminal response through RPC
- [ ] `rlph.startLoop` test verifies terminal response through RPC
- [ ] `rlph.writePRD` test verifies terminal response through RPC
- [ ] `rlph.review` test verifies terminal response through RPC
- [ ] `rlph.fix` test verifies terminal response through RPC
- [ ] Stub TerminalClient is used (system boundary mock)
- [ ] Tests use `@effect/vitest` patterns
- [ ] All tests pass

### Blocked by

- Blocked by Issue 13 (RPC test infrastructure)

### User stories addressed

- User story 22
- User story 25

---

## Issue 21: RPC integration tests -- TerminalRpcs (packages/terminal)

### Parent PRD

PRD-test-coverage.md

### What to build

Add in-memory RPC integration tests for all 8 `TerminalRpcs` endpoints in `packages/terminal` using `RpcTest.makeClient`:

1. `terminal.spawn` -- creates new PTY
2. `terminal.write` -- sends input to PTY
3. `terminal.resize` -- resizes PTY
4. `terminal.kill` -- stops PTY
5. `terminal.remove` -- kills and removes terminal
6. `terminal.restart` -- kills and respawns
7. `terminal.list` -- lists all terminals
8. `terminal.events` -- streams lifecycle events

Tests use real `TerminalManager.layer` + `PtyHostClient.layer` (real PTY Host subprocess). The RPC layer adds serialization/deserialization and the handler mapping on top of what `terminal-manager.test.ts` already tests at the service level.

### Acceptance criteria

- [ ] All 8 TerminalRpcs endpoints are tested through `RpcTest.makeClient`
- [ ] Tests use real `PtyHostClient` + `TerminalManager` layers (no service mocking)
- [ ] `terminal.events` streaming test verifies lifecycle events arrive via the RPC stream
- [ ] Tests use `@effect/vitest` patterns (or the custom `runEffect` pattern where needed for shared scope)
- [ ] All tests pass (`bun run test` in packages/terminal)
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 8 (terminal @effect/vitest migration)

### User stories addressed

- User story 26

---

# Summary Table

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Extract TestLaborerStore shared helper | None | Done |
| 2 | Extract git repo shared helpers | None | In Progress |
| 3 | Extract timing shared helpers | None | Ready |
| 4 | Delete dead/duplicate test files from server | None | Ready |
| 5 | Migrate worktree/workspace server tests to @effect/vitest | #1, #2, #3 | Blocked |
| 6 | Migrate task/importer server tests to @effect/vitest | #1 | Ready |
| 7 | Migrate remaining server tests to @effect/vitest | #1 | Ready |
| 8 | Migrate terminal package tests to @effect/vitest assertions | None | Ready |
| 9 | Add LiveStore schema tests -- setup + project/workspace events | None | Ready |
| 10 | Add LiveStore schema tests -- diff, task, PRD, panel layout events | #9 | Blocked |
| 11 | Add LiveStore schema tests -- deprecated terminal event no-ops | #9 | Blocked |
| 12 | Rewrite config-service.test.ts through public API | #1, #2, #5 or #7 | Blocked |
| 13 | Set up RPC test infrastructure + health.check test | #1 | In Progress |
| 14 | RPC integration tests -- project.add + project.remove | #13, #2 | Blocked |
| 15 | RPC integration tests -- config.get + config.update | #13, #2 | Blocked |
| 16 | RPC integration tests -- workspace.create + workspace.destroy | #13, #2 | Blocked |
| 17 | RPC integration tests -- task.create + task.updateStatus + task.remove | #13 | Blocked |
| 18 | RPC integration tests -- task.importGithub + task.importLinear | #13, #2 | Blocked |
| 19 | RPC integration tests -- diff.refresh + editor.open | #13, #2 | Blocked |
| 20 | RPC integration tests -- terminal.spawn + rlph endpoints | #13 | Blocked |
| 21 | RPC integration tests -- TerminalRpcs (packages/terminal) | #8 | Blocked |

**Parallelism opportunities:**
- Issues 1, 2, 3, 4, 8, 9 can all start immediately in parallel
- Issues 5, 6, 7 can start once their helper dependencies land
- Issues 10, 11 can start once #9 lands
- Issues 13-20 can start once #1 (and #2 where noted) land; #14-20 can be parallelized once #13 lands
- Issue 21 can start once #8 lands
