# PRD: End-to-End Test Coverage for apps/web

## Problem Statement

The `apps/web` package (a Tauri + Vite + React SPA) has minimal test coverage. The existing 4 test files consist of:

1. **Pure function unit tests** (`layout-utils.test.ts`, `project-settings-modal.helpers.test.ts`, `task-source-picker.test.ts`) — these are well-written, test through public interfaces, and should be kept.
2. **A mock-heavy component test** (`project-settings-modal.test.tsx`) — this violates the project's TDD principles by mocking 6 internal modules (`LaborerClient`, `useAtomSet`, `useAtomValue`, `sonner`, `buildConfigUpdates`, `getSettingsLoadErrorMessage`). It tests implementation details rather than observable behavior and would break on any internal refactoring.

There are **zero end-to-end tests** for any user-facing flow: adding projects, creating workspaces, managing panels, interacting with terminals, searching/filtering, or viewing the dashboard. The app is a complex SPA with a panel system, real-time terminal I/O, LiveStore reactive state, and multiple RPC integrations — all untested at the integration level.

The companion PRD (`docs/test-coverage/PRD-test-coverage.md`) covers `packages/` test coverage and explicitly marks `apps/web` and E2E browser tests as out of scope. This PRD fills that gap.

The TypeScript configuration is maximally strict (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), which eliminates many classes of bugs at compile time. E2E tests should focus exclusively on runtime behavior the type checker cannot verify: user interaction flows, state transitions visible in the UI, service integration, and error handling.

## Solution

Set up Playwright for browser-based E2E testing of `apps/web`, running against the real backend services (server on :3000, terminal service on :3002). Tests run in WebKit to match the Tauri runtime engine on macOS.

Key infrastructure decisions:

1. **Playwright runs against `vite dev`** (localhost:3001) in a real browser — no Tauri shell needed for testing. This covers all React/routing/panel/form/RPC logic.
2. **Real backends** — `turbo dev` starts the server, terminal service, and web app. Tests exercise the full stack for maximum confidence.
3. **Test isolation via separate database** — a `DATA_DIR` environment variable is added to the server so tests use a separate SQLite database from development.
4. **Browser-mode file picker** — the `AddProjectForm` detects `window.__TAURI__` at runtime and falls back to a text input when running in a plain browser, enabling E2E testing of project creation without the native file dialog.
5. **Temp git repos** — Playwright's `globalSetup` creates temporary git repositories for tests to use as projects, cleaned up in `globalTeardown`.

Existing mock-heavy component tests are deleted and replaced by Playwright E2E tests. Pure function Vitest tests are kept as-is.

## User Stories

1. As a developer, I want Playwright configured in `apps/web` with WebKit as the test browser, so that E2E tests match the Tauri runtime engine.
2. As a developer, I want a `globalSetup` script that starts `turbo dev` and waits for all services (web :3001, server :3000, terminal :3002) to be healthy before tests run, so that E2E tests have a reliable environment.
3. As a developer, I want a `globalTeardown` script that stops all services and cleans up temp directories after tests complete, so that test runs don't leak resources.
4. As a developer, I want the server's data directory configurable via a `DATA_DIR` environment variable, so that E2E tests use a separate database from my development data.
5. As a developer, I want the `globalSetup` to create a temporary git repository with an initial commit, so that E2E tests have a real repo to add as a project without polluting the monorepo.
6. As a developer, I want the `AddProjectForm` to detect `window.__TAURI__` and show a text input for the repo path when Tauri is unavailable, so that E2E tests can add projects without the native file dialog.
7. As a developer, I want an E2E test that adds a project via the text input fallback, verifies it appears in the sidebar, and then deletes it, so that the project lifecycle is tested end-to-end.
8. As a developer, I want an E2E test that opens project settings, modifies a field, saves, and verifies the change persists, so that the settings flow is tested through the real UI and real backend.
9. As a developer, I want an E2E test that creates a workspace for a project, verifies it appears in the sidebar with status indicators, and then destroys it, so that the workspace lifecycle is tested end-to-end.
10. As a developer, I want an E2E test that creates a workspace and verifies its branch name and status are displayed correctly in the sidebar, so that workspace metadata rendering is validated.
11. As a developer, I want an E2E test that splits a pane horizontally, verifies two panes are visible, then splits vertically within one, so that the recursive panel split system is validated.
12. As a developer, I want an E2E test that closes a pane and verifies focus transfers to the sibling pane, so that the close-and-focus-transfer behavior is validated in the real UI.
13. As a developer, I want an E2E test that uses keyboard shortcuts (Ctrl+B then arrow keys) to navigate between panes, so that panel keyboard navigation is validated.
14. As a developer, I want an E2E test that resizes panes via keyboard shortcuts (Ctrl+B then Shift+arrow) and verifies the size changes, so that panel resize behavior is validated.
15. As a developer, I want an E2E test that opens a terminal in a pane, types a command, and verifies output appears, so that the terminal WebSocket I/O pipeline is tested end-to-end.
16. As a developer, I want an E2E test that types in the sidebar search box and verifies projects/workspaces are filtered in real-time, so that search filtering is validated.
17. As a developer, I want an E2E test that collapses and expands a project group in the sidebar, so that the collapse/expand persistence is validated.
18. As a developer, I want an E2E test that toggles dark mode and verifies the theme changes, so that the theme switcher is validated.
19. As a developer, I want an E2E test that switches to the dashboard view and verifies the cross-project summary is displayed, so that the dashboard rendering is validated.
20. As a developer, I want an E2E test that verifies workspace status badges (creating, running, stopped, error) render correctly in the dashboard view, so that status visualization is validated.
21. As a developer, I want the mock-heavy `project-settings-modal.test.tsx` deleted, since its behavior is now covered by Playwright E2E tests that exercise the real component stack.
22. As a developer, I want a `bun run test:e2e` script in `apps/web/package.json` that runs the Playwright suite, so that E2E tests are easy to run locally.
23. As a developer, I want Playwright configured with reasonable timeouts, retries, and screenshot-on-failure, so that flaky tests are debuggable.
24. As a developer, I want E2E test files organized in `apps/web/e2e/` with clear naming by feature area, so that the test suite is navigable.
25. As a developer, I want each E2E test to start from a clean state (fresh database, no stale projects), so that tests are independent and don't interfere with each other.

## 'Polishing' Requirements

1. Verify all E2E tests pass with `bun run test:e2e` in `apps/web`.
2. Verify all existing Vitest tests still pass with `bun run test` in `apps/web`.
3. Run `bun x ultracite check` to ensure all new files pass linting and formatting.
4. Confirm no E2E test relies on hardcoded timing (`page.waitForTimeout`) — use Playwright's auto-waiting and locator assertions instead.
5. Confirm screenshot-on-failure is configured and produces useful artifacts.
6. Verify the `globalSetup` reliably detects when all three services are healthy before allowing tests to proceed (health check polling with timeout).
7. Verify `globalTeardown` cleanly stops all processes and removes temp directories even if tests fail or are interrupted.
8. Confirm the text input fallback on `AddProjectForm` is only visible when `window.__TAURI__` is absent — it should not appear in the production Tauri app.
9. Verify E2E tests run in under 5 minutes total on a local machine.
10. Confirm no test uses `page.evaluate` to directly manipulate React state or LiveStore — all interactions go through the UI.
11. Verify the separate test database (`DATA_DIR`) is used correctly and development data is never touched by tests.

## Implementation Decisions

### Playwright Infrastructure

Playwright is installed as a dev dependency in `apps/web`. The configuration (`playwright.config.ts`) specifies:

- **Browser:** WebKit only (matching Tauri's engine on macOS).
- **Base URL:** `http://localhost:3001` (Vite dev server).
- **Test directory:** `e2e/`.
- **Web server:** Not managed by Playwright — instead, `globalSetup` starts `turbo dev` from the monorepo root, which orchestrates all three services. Playwright's `webServer` config is not used because it only supports a single process, while we need three.
- **Timeouts:** 30 seconds per test, 10 seconds for assertions/locators.
- **Retries:** 1 retry on failure (to handle rare flakiness from real service startup timing).
- **Artifacts:** Screenshots on failure, stored in `e2e/results/`.

### Global Setup / Teardown

A `globalSetup.ts` script:

1. Creates a temp directory for the test database (sets `DATA_DIR` env var).
2. Creates a temp git repository with `git init` + an initial commit (stores path for tests to reference).
3. Starts `turbo dev` as a child process with `DATA_DIR` pointing to the temp directory.
4. Polls health endpoints until all three services respond:
   - Web: `GET http://localhost:3001` returns 200.
   - Server: The health check RPC responds.
   - Terminal: `GET http://localhost:3002` responds.
5. Stores process references and temp paths in a global state file for teardown.

A `globalTeardown.ts` script:

1. Kills the `turbo dev` process tree.
2. Removes the temp database directory.
3. Removes the temp git repository.

### Server DATA_DIR Configuration

A new `DATA_DIR` environment variable is added to `@laborer/env/server` with a default of `"./data"` (preserving current behavior). Both `laborer-store.ts` and `sync-backend.ts` in `packages/server` read from this env var instead of their hardcoded `"./data"` constants. The two separate `DATA_DIRECTORY` constants are consolidated into a single source of truth from the env config.

### Browser-Mode File Picker

The `AddProjectForm` component is modified to detect `window.__TAURI__` at runtime:

- **Tauri present:** Current behavior — calls `open()` from `@tauri-apps/plugin-dialog` to show the native folder picker.
- **Tauri absent (browser):** Renders a text input field where the user can type/paste a repository path, plus a submit button. The form still calls the same `project.add` RPC mutation with the entered path.

This is scoped to the file picker only. Other Tauri-specific features (system tray, global shortcuts, window state) gracefully degrade — they simply don't render or activate when `__TAURI__` is absent, which doesn't block any E2E test flows.

### E2E Test Organization

Tests are organized by feature area in `apps/web/e2e/`:

```
e2e/
  project-management.spec.ts    -- Add project, settings, delete
  workspace-lifecycle.spec.ts   -- Create workspace, status, destroy
  panel-system.spec.ts          -- Split, close, navigate, resize
  terminal-interaction.spec.ts  -- Open terminal, type, output
  search-navigation.spec.ts     -- Sidebar search, collapse, dark mode
  dashboard.spec.ts             -- Dashboard view, summary, status badges
  global-setup.ts               -- Service startup, temp repo creation
  global-teardown.ts            -- Cleanup
  fixtures/                     -- Shared test utilities (page objects, helpers)
  results/                      -- Screenshots on failure (gitignored)
```

### Existing Test Audit

- **Delete:** `test/project-settings-modal.test.tsx` — mock-heavy, violates TDD principles, behavior covered by Playwright E2E tests.
- **Keep:** `test/layout-utils.test.ts` — pure function tests, no DOM dependency, fast in Vitest.
- **Keep:** `test/project-settings-modal.helpers.test.ts` — pure function tests for `normalizeSetupScripts`, `buildConfigUpdates`, `getSettingsLoadErrorMessage`.
- **Keep:** `test/task-source-picker.test.ts` — pure function tests for `filterTasksByProjectAndSource`, `canImportTasks`.

### Page Object Pattern

E2E tests use a lightweight page object pattern for reusable interactions:

- **SidebarHelper** — methods for searching, finding projects/workspaces, collapsing/expanding groups.
- **PanelHelper** — methods for splitting, closing, navigating, and resizing panes.
- **TerminalHelper** — methods for typing commands and waiting for output in a terminal pane.

These are helpers, not full page objects — they receive the Playwright `Page` instance and provide convenience methods. They live in `e2e/fixtures/`.

## Testing Decisions

### What makes a good E2E test in this codebase

A good E2E test:

- Exercises a **complete user flow** through the real browser UI, real RPC layer, and real backend services.
- Interacts via **user-visible elements** — clicks buttons, types in inputs, reads text content. Never reaches into React internals, LiveStore state, or RPC payloads directly.
- Uses **Playwright's auto-waiting** and locator assertions (`expect(locator).toBeVisible()`, `expect(locator).toHaveText()`) instead of manual `waitForTimeout` or polling.
- Is **independent** — each test starts from a clean database state and doesn't depend on other tests' side effects.
- Has a **descriptive name** that reads like a user story: "can add a project and see it in the sidebar" not "test project add button click handler".
- Mocks **nothing** — the whole point is exercising the real stack. The only infrastructure concession is the text input fallback for the Tauri file picker.

### What NOT to test with Playwright

- **Pure logic** (layout tree manipulation, helper functions) — these stay in Vitest where they run in milliseconds.
- **Type-level concerns** (branded IDs, schema shapes) — enforced by TypeScript.
- **Implementation details** (which RPC was called, what LiveStore event was committed) — test through UI outcomes only.
- **Task management flows** (create tasks, filter by source, import from Linear/GitHub) — out of scope for this PRD, will be added later.
- **Agent action flows** (write PRD form, review PR form, fix findings form, start loop) — out of scope for this PRD, will be added later.
- **Tauri-native features** (system tray, global shortcuts, window state persistence) — requires Tauri WebDriver, out of scope.

### Modules tested

| Module / Flow | Test Type | File |
|---------------|-----------|------|
| Project management (add, settings, delete) | Playwright E2E | `e2e/project-management.spec.ts` |
| Workspace lifecycle (create, status, destroy) | Playwright E2E | `e2e/workspace-lifecycle.spec.ts` |
| Panel system (split, close, navigate, resize) | Playwright E2E | `e2e/panel-system.spec.ts` |
| Terminal interaction (open, type, output) | Playwright E2E | `e2e/terminal-interaction.spec.ts` |
| Search & navigation (search, collapse, theme) | Playwright E2E | `e2e/search-navigation.spec.ts` |
| Dashboard view (toggle, summary, badges) | Playwright E2E | `e2e/dashboard.spec.ts` |
| Panel layout tree utils (pure functions) | Vitest unit | `test/layout-utils.test.ts` (existing, keep) |
| Settings modal helpers (pure functions) | Vitest unit | `test/project-settings-modal.helpers.test.ts` (existing, keep) |
| Task source picker helpers (pure functions) | Vitest unit | `test/task-source-picker.test.ts` (existing, keep) |

### Prior art

- **Pure function tests:** `test/layout-utils.test.ts` is the gold standard for this package — tests pure tree manipulation through public exports with no mocks.
- **Package-level integration tests:** The companion PRD (`docs/test-coverage/`) established patterns for in-memory RPC client testing and Effect service integration testing in `packages/server` and `packages/terminal`.

## Out of Scope

- **Task management E2E tests** — Create tasks, filter by source (manual/linear/github), import tasks. Will be added in a future PRD once the foundation is solid.
- **Agent action E2E tests** — Write PRD form, review PR form, fix findings form, start ralph loop. Depends on complex backend orchestration; will be added later.
- **Tauri-native feature tests** — System tray, global shortcuts (Cmd+Shift+L), window state persistence. Requires Tauri WebDriver setup, which is a separate effort.
- **Multi-browser testing** — Only WebKit is tested (matching Tauri on macOS). Chromium/Firefox support is not needed for a desktop app.
- **CI/CD pipeline** — This PRD sets up the test infrastructure for local development. CI integration is a separate concern.
- **Visual regression testing** — Screenshot comparison is not in scope. Screenshots are captured on failure for debugging only.
- **Performance testing** — Load times, rendering performance, and WebSocket throughput are not tested.
- **packages/ test coverage** — Covered by the companion PRD at `docs/test-coverage/PRD-test-coverage.md`.

## Further Notes

- The `apps/web` Vitest config (`vitest.config.ts`) uses `jsdom` environment and includes `test/**/*.test.{ts,tsx}`. This config is unchanged — Playwright has its own config file (`playwright.config.ts`) and test directory (`e2e/`). The two test systems coexist independently.
- The `?reset` URL parameter that clears OPFS databases is a web-side mechanism. Since E2E tests use a separate server-side `DATA_DIR`, the web client's OPFS state also needs to be fresh. The `globalSetup` should navigate to `http://localhost:3001?reset` before tests begin to clear any stale client-side state.
- WebSocket-based features (terminal I/O, LiveStore sync) are inherently async. Playwright's locator assertions handle this well, but terminal output assertions may need `expect(locator).toContainText(expected, { timeout: 10_000 })` to account for PTY initialization time.
- The `turbo dev` process starts all three services. If any service fails to start, the `globalSetup` should fail with a clear error message indicating which service didn't respond, rather than timing out silently.
- The existing `data-test/` and `data-test-sync/` directories in `packages/server/` are artifacts from the package-level tests. The E2E `DATA_DIR` should use an OS temp directory (e.g., `os.tmpdir()`) to avoid polluting the repo.
