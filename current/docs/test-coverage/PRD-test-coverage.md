# PRD: Test Coverage Improvement

## Problem Statement

The laborer monorepo has inconsistent test coverage across its packages. While `packages/terminal` has excellent integration tests and `packages/server` has 15 test files, several systemic issues reduce confidence in the test suite:

1. **Zero tests** for `packages/shared` (LiveStore schema materializers, the data layer contract for the entire app).
2. **No `@effect/vitest` usage** despite it being installed and configured. Every test file manually manages `Effect.runPromise`, scopes, and layer composition instead of using `it.effect`, `it.scoped`, and `it.layer`.
3. **Duplicated test infrastructure** -- the `TestLaborerStore` in-memory store pattern is copy-pasted identically across 9 test files, and git repo helpers are duplicated across 5 files.
4. **508 lines of dead test code** -- `packages/server/test/terminal-manager.test.ts` is entirely `describe.skip`'d and hasn't been updated since terminal management moved to the standalone terminal service.
5. **Implementation-detail tests** -- `config-service.test.ts` directly tests internal functions (`expandTilde`, `readConfigFile`, `walkUpForConfigs`, `mergeConfigs`) instead of testing through the `ConfigService` public API. `rpc-config-handlers.test.ts` mocks internal services (`ProjectRegistry`, `ConfigService`) with `vi.fn()` instead of testing through the full service stack.
6. **Missing RPC endpoint integration tests** -- only `config.get` and `config.update` have handler-level tests, and those mock their dependencies. The remaining 17 LaborerRpcs endpoints have no RPC-level tests.

The TypeScript configuration is maximally strict (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), which eliminates many classes of bugs at compile time. Tests should focus exclusively on runtime behavior that the type checker cannot verify: business logic correctness, state transitions, external integration, error handling, and data pipeline correctness.

## Solution

Systematically improve test coverage by:

1. Extracting shared test helpers to eliminate duplication.
2. Migrating all Effect-based tests to `@effect/vitest` patterns.
3. Adding LiveStore schema materializer tests to `packages/shared`.
4. Adding in-memory RPC client integration tests for all 19 LaborerRpcs endpoints.
5. Auditing and rewriting existing tests that violate the project's TDD principles (test through public interfaces, no mocking of internal collaborators).
6. Removing dead test code.

All tests follow the project's TDD philosophy: test observable behavior through public interfaces, mock only at system boundaries (external APIs, filesystem where necessary), and write integration-style tests that exercise real code paths.

## User Stories

1. As a developer, I want a shared `TestLaborerStore` helper, so that I don't have to copy-paste 15 lines of in-memory LiveStore setup into every test file.
2. As a developer, I want shared git repo helpers (`createTempDir`, `git`, `initRepo`), so that worktree/workspace tests have consistent, DRY setup.
3. As a developer, I want shared timing helpers (`delay`, `waitFor`), so that async tests use the same polling and waiting patterns.
4. As a developer, I want tests to use `it.effect` and `it.scoped` from `@effect/vitest`, so that Effect test boilerplate (scope management, `Effect.runPromise`, layer provision) is handled by the framework.
5. As a developer, I want the dead `terminal-manager.test.ts` in `packages/server` removed, so that the test suite has no skipped/misleading tests.
6. As a developer, I want `config-service.test.ts` rewritten to test through the `ConfigService` public API, so that internal refactoring doesn't break tests.
7. As a developer, I want `rpc-config-handlers.test.ts` rewritten to use real service layers instead of mocked `ProjectRegistry`/`ConfigService`, so that tests verify actual integration behavior.
8. As a developer, I want LiveStore schema materializer tests in `packages/shared`, so that the event-to-SQL pipeline is validated where the schema is defined.
9. As a developer, I want tests for all LiveStore event materializers (project CRUD, workspace lifecycle, diff upsert, task CRUD, PRD CRUD, panel layout operations), so that schema changes are caught by tests.
10. As a developer, I want tests verifying that deprecated terminal event materializers are no-ops, so that backward compatibility is maintained.
11. As a developer, I want in-memory RPC integration tests for `workspace.create`, so that worktree creation, port allocation, and setup script execution are verified end-to-end through the RPC contract.
12. As a developer, I want in-memory RPC integration tests for `workspace.destroy`, so that origin-based destroy behavior (laborer vs. external workspaces) is verified through the RPC contract.
13. As a developer, I want in-memory RPC integration tests for `project.add`, so that project registration and worktree detection are verified through the RPC contract.
14. As a developer, I want in-memory RPC integration tests for `project.remove`, so that project removal and associated data cleanup are verified through the RPC contract.
15. As a developer, I want in-memory RPC integration tests for `config.get`, so that config resolution (walk-up, global fallback, provenance metadata) is verified through the RPC contract with real service layers.
16. As a developer, I want in-memory RPC integration tests for `config.update`, so that config writing is verified through the RPC contract with real service layers.
17. As a developer, I want in-memory RPC integration tests for `task.create`, so that manual task creation (with optional PRD link) is verified through the RPC contract.
18. As a developer, I want in-memory RPC integration tests for `task.updateStatus` and `task.remove`, so that task state transitions and deletion are verified through the RPC contract.
19. As a developer, I want in-memory RPC integration tests for `task.importGithub`, so that GitHub issue import (with deduplication and PR filtering) is verified through the RPC contract.
20. As a developer, I want in-memory RPC integration tests for `task.importLinear`, so that Linear issue import (with deduplication and filter construction) is verified through the RPC contract.
21. As a developer, I want in-memory RPC integration tests for `diff.refresh`, so that git diff computation and store update are verified through the RPC contract.
22. As a developer, I want in-memory RPC integration tests for `terminal.spawn`, so that terminal spawning via TerminalClient proxy is verified through the RPC contract.
23. As a developer, I want in-memory RPC integration tests for `editor.open`, so that editor launch behavior is verified through the RPC contract.
24. As a developer, I want in-memory RPC integration tests for `health.check`, so that the uptime response is verified through the RPC contract.
25. As a developer, I want in-memory RPC integration tests for `rlph.startLoop`, `rlph.writePRD`, `rlph.review`, and `rlph.fix`, so that RLPH terminal command orchestration is verified through the RPC contract.
26. As a developer, I want in-memory RPC integration tests for the 8 `TerminalRpcs` endpoints, so that the terminal service's RPC layer is tested end-to-end.
27. As a developer, I want all tests to use `assert` from `@effect/vitest` instead of `expect` from vitest (in Effect-based tests), so that the test assertion style is consistent with the Effect ecosystem.

## 'Polishing' Requirements

1. Verify all tests pass with `bun run test` in each package and at the workspace root.
2. Run `bun x ultracite check` to ensure all test files pass linting and formatting.
3. Confirm no test uses `describe.skip` or `it.skip` -- either fix or remove skipped tests.
4. Confirm no test file imports internal/unexported functions from source modules.
5. Verify that the `TestLaborerStore` helper is imported from the shared helper module in all 9+ files that need it -- no remaining copy-paste instances.
6. Verify that git helper functions (`createTempDir`, `git`, `initRepo`) are imported from the shared helper module in all worktree/workspace tests.
7. Confirm no test mocks internal Effect services with `vi.fn()` -- mocking is limited to system boundaries (`fetch` for external APIs, `process.env` for environment).
8. Verify that all `@effect/vitest` tests use `assert` (not `expect`) for consistency.
9. Ensure test file naming is consistent: `<module-name>.test.ts` for all test files.
10. Confirm the `prd-schema.test.ts` has been moved from `packages/server` to `packages/shared` and removed from the server package.

## Implementation Decisions

### Shared Test Helpers (packages/server/test/helpers/)

Three focused helper modules will be created:

- **`test-store.ts`** -- Exports `makeTestStore` (the Effect program that creates an in-memory LiveStore) and `TestLaborerStore` (the scoped Layer). This replaces the 15-line boilerplate duplicated across 9 test files.
- **`git-helpers.ts`** -- Exports `createTempDir` (creates OS temp directory), `git` (executes git commands via child_process), and `initRepo` (initializes a git repo with an initial commit). These are currently duplicated across 5 worktree/workspace test files.
- **`timing-helpers.ts`** -- Exports `delay` (Promise-based sleep) and `waitFor` (polls a condition with timeout). Currently duplicated across async test files.

### @effect/vitest Migration

All Effect-based test files will be migrated from:
```typescript
import { describe, expect, it } from "vitest"
// ... manual Effect.runPromise, scope management, layer building
```
To:
```typescript
import { assert, describe, it } from "@effect/vitest"
// ... it.effect, it.scoped, it.layer, Effect.provide
```

Key patterns from the Effect reference repository:
- `it.effect("name", () => Effect.gen(function*() { ... }).pipe(Effect.provide(layer)))` for standard tests.
- `it.scoped("name", () => ...)` for tests needing a Scope (acquireRelease resources).
- `it.layer(layer)("group name", (it) => { ... })` for sharing a layer across a describe block.
- `assert.strictEqual`, `assert.deepStrictEqual`, `assert.isTrue` instead of `expect().toBe()`.

Exception: `packages/terminal/test/terminal-manager.test.ts` uses a deliberate shared-scope pattern (`beforeAll`/`afterAll` managing a long-lived PtyHostClient layer) that `it.scoped` cannot replace. This file will keep its custom `runEffect` pattern but should adopt `assert` from `@effect/vitest` for assertions.

### LiveStore Schema Tests (packages/shared)

New test file `packages/shared/test/schema.test.ts` will test the event-to-materializer-to-query pipeline for all active event groups:
- **Project events**: `ProjectCreated` inserts, `ProjectRemoved` deletes
- **Workspace events**: `WorkspaceCreated` inserts, `WorkspaceStatusChanged` updates, `WorkspaceDestroyed` deletes
- **Diff events**: `DiffUpdated` upserts, `DiffCleared` deletes
- **Task events**: `TaskCreated` inserts, `TaskStatusChanged` updates, `TaskRemoved` deletes
- **PRD events**: `PrdCreated` inserts, `PrdStatusChanged` updates, `PrdRemoved` deletes
- **Panel layout events**: `LayoutSplit` upserts, `LayoutPaneClosed` upserts, `LayoutPaneAssigned` upserts, `LayoutRestored` upserts
- **Deprecated terminal events**: All 6 terminal events produce no-op materializers (empty array)

Each test commits an event, queries the corresponding table, and verifies the expected row state. The `prd-schema.test.ts` file will be moved from `packages/server/test/` to `packages/shared/test/` and expanded.

Vitest configuration will be added to `packages/shared` (`vitest.config.ts`, test script in `package.json`).

### RPC Integration Tests (packages/server)

New test file `packages/server/test/rpc-integration.test.ts` (or multiple files grouped by domain) will use `RpcTest.makeClient` from `@effect/rpc` to create an in-memory RPC client that exercises the full handler + service layer stack without HTTP transport.

The pattern:
```typescript
const TestRpcClient = Layer.scoped(
  RpcClient.make(LaborerRpcs)
).pipe(
  Layer.provide([HandlerLayer, ServiceLayers, TestLaborerStore])
)
```

All 19 LaborerRpcs endpoints will be tested through this client. For endpoints that call external APIs (`task.importGithub`, `task.importLinear`), only `fetch` will be mocked (system boundary). For endpoints that proxy to TerminalClient (`terminal.spawn`, `rlph.*`), a stub TerminalClient layer will be provided (system boundary -- it's a separate service communicating over HTTP).

Similarly, a `packages/terminal/test/rpc-integration.test.ts` will test all 8 TerminalRpcs endpoints using the same `RpcTest.makeClient` pattern with the real `TerminalManager.layer` + `PtyHostClient.layer`.

### Existing Test Audit

- **Delete** `packages/server/test/terminal-manager.test.ts` (508 lines, entirely skipped, terminal tests live in `packages/terminal`).
- **Delete** `packages/server/test/pty-host.test.ts` and `packages/server/test/ring-buffer.test.ts` (these are duplicates of the terminal package tests -- the source code lives in `packages/terminal`).
- **Rewrite** `packages/server/test/config-service.test.ts` to remove the ~365 lines testing internal functions. Replace with integration tests through `ConfigService.resolveConfig` and `ConfigService.writeProjectConfig` that exercise the same behavior (tilde expansion, walk-up, merging, global fallback).
- **Rewrite** `packages/server/test/rpc-config-handlers.test.ts` to use the in-memory RPC client pattern with real `ProjectRegistry` and `ConfigService` layers instead of `Layer.succeed` stubs with `vi.fn()`.
- **Migrate** all remaining test files to `@effect/vitest` patterns.

### What NOT to test

- **packages/config** -- Zero runtime code. Only contains `tsconfig.base.json`. No tests needed.
- **packages/env** -- Thin wrappers around `@t3-oss/env-core` + Zod. The validation logic is in third-party libraries. Testing would be testing their code, not ours.
- **Type-level contracts** -- Branded IDs, Schema.Class definitions, RPC contract types. These are enforced by TypeScript's type checker at compile time.
- **Implementation details** -- Internal helper functions, private state, call counts/ordering of internal methods.

## Testing Decisions

### What makes a good test in this codebase

A good test:
- Tests **observable behavior** through the module's **public interface** (Effect service methods, RPC endpoints, LiveStore event/query pipeline).
- Uses **real service layers** composed via Effect's Layer system. The in-memory LiveStore (`TestLaborerStore`) and real git repos are the standard test infrastructure.
- Mocks **only at system boundaries**: `fetch` for external HTTP APIs (GitHub, Linear), `process.env` for environment variables, and stub TerminalClient for the main server's terminal proxy endpoints.
- Describes **what** the system does, not **how** it does it. Test names read like specifications: "workspace.create allocates a port and creates a worktree" not "createWorktree calls PortAllocator.allocate then executes git worktree add".
- **Survives internal refactoring**. Renaming internal functions, restructuring service internals, or changing algorithms should not break tests as long as external behavior is preserved.
- Does not duplicate what the **TypeScript type checker** already catches. No tests for type shapes, branded ID distinctness, or schema structure.

### Modules to be tested

| Module | Test Type | Prior Art |
|--------|-----------|-----------|
| LiveStore schema materializers (shared) | Event commit + table query | `prd-schema.test.ts` (to be moved/expanded) |
| LaborerRpcs (19 endpoints, server) | In-memory RPC client + real service layers | Effect reference: `rpc-e2e.ts`, `RpcTest.makeClient` |
| TerminalRpcs (8 endpoints, terminal) | In-memory RPC client + real PtyHostClient/TerminalManager | Effect reference: `rpc-e2e.ts` |
| ConfigService (server, rewrite) | Effect service integration with real filesystem | Existing `config-service.test.ts` lines 372-669 |

### Prior art for tests

- **Integration with real git repos**: `workspace-destroy-origin.test.ts`, `worktree-reconciler.test.ts`, `project-registry.worktree-detection.test.ts`, `worktree-watcher.test.ts`
- **In-memory LiveStore**: The `TestLaborerStore` pattern used across 9 test files
- **RPC client testing**: Effect reference `packages/platform-node/test/rpc-e2e.ts` and `packages/platform-node/test/fixtures/rpc-schemas.ts`
- **Effect service testing**: `packages/terminal/test/terminal-manager.test.ts` (real layers, real subprocess, public interface)
- **Black-box subprocess testing**: `packages/terminal/test/pty-host.test.ts` (IPC protocol testing)

## Out of Scope

- **Frontend tests** (`apps/web`) -- This PRD focuses on `packages/` only.
- **Performance/benchmark tests** -- Out of scope; this is about correctness coverage.
- **E2E browser tests** -- No Playwright/Cypress-style tests.
- **packages/config tests** -- No runtime code to test.
- **packages/env tests** -- Third-party validation logic.
- **CI/CD pipeline changes** -- Test infrastructure only; CI integration is separate.
- **Code coverage metrics/thresholds** -- Focus is on meaningful test quality, not coverage percentages.

## Further Notes

- The `packages/terminal/test/` files (`pty-host.test.ts`, `ring-buffer.test.ts`, `terminal-manager.test.ts`) are already excellent and should be treated as the gold standard for this codebase. The PTY host test in particular is a model black-box integration test.
- The `ensureBunSpawnForNodeTests` shim pattern in `workspace-destroy-origin.test.ts` may be needed in other test files that use `Bun.spawn` internally but run under Node.js via vitest. This should be included in the shared git helpers if needed.
- The deprecated terminal events in `packages/shared/schema.ts` have no-op materializers. Testing these no-ops is important for backward compatibility -- if someone accidentally adds SQL operations to these materializers, the test should catch it.
- The `RpcTest.makeClient` approach from the Effect reference is preferred over spinning up a real HTTP server because it tests the handler + service integration without the overhead and complexity of HTTP transport. The HTTP transport layer is Effect's responsibility, not ours.
- When writing RPC tests for endpoints that need a `TerminalClient` (like `terminal.spawn`, `rlph.*`), create a minimal stub layer that returns canned responses. This is a system boundary mock (the terminal service is a separate process), not an internal collaborator mock.
