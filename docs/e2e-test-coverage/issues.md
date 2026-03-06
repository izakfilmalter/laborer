# Issues: E2E Test Coverage for apps/web

## Issue 1: Server DATA_DIR env var

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Make the server's data directory configurable via a `DATA_DIR` environment variable so that E2E tests can use a separate SQLite database from development data.

Currently, both `laborer-store.ts` and `sync-backend.ts` in `packages/server` hardcode `const DATA_DIRECTORY = "./data"`. Add a `DATA_DIR` field to `@laborer/env/server` with a default of `"./data"` (preserving current behavior), then update both files to read from this env var instead of their hardcoded constants.

See the PRD "Server DATA_DIR Configuration" section for details.

### Status: COMPLETED

### Acceptance criteria

- [x] `DATA_DIR` env var added to `packages/env/src/server.ts` with default `"./data"`
- [x] `packages/server/src/services/laborer-store.ts` reads `DATA_DIRECTORY` from `env.DATA_DIR` instead of hardcoding `"./data"`
- [x] `packages/server/src/services/sync-backend.ts` reads `DATA_DIRECTORY` from `env.DATA_DIR` instead of hardcoding `"./data"`
- [x] Existing behavior unchanged when `DATA_DIR` is not set (default `"./data"`)
- [x] Setting `DATA_DIR=/tmp/test-data` causes the server to write databases to `/tmp/test-data/`
- [x] Type checks pass (`bun run check-types` in `packages/server` and `packages/env`)
- [x] Existing server tests still pass (`bun run test` in `packages/server`)

### Blocked by

None — can start immediately.

### User stories addressed

- User story 4
- User story 25

---

## Issue 2: Browser-mode file picker fallback

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Modify the `AddProjectForm` component to detect `window.__TAURI__` at runtime and render a text input fallback when Tauri is unavailable. This enables E2E tests to add projects in a plain browser without the native file dialog.

When `__TAURI__` is present (production Tauri app): current behavior — calls `open()` from `@tauri-apps/plugin-dialog`.

When `__TAURI__` is absent (browser-only): render a text input where the user can type/paste a repository path plus a submit button. The form calls the same `project.add` RPC mutation with the entered path.

See the PRD "Browser-Mode File Picker" section for details.

### Status: COMPLETED

### Acceptance criteria

- [x] `AddProjectForm` checks `window.__TAURI__` (or equivalent Tauri detection) at runtime
- [x] When Tauri is absent, renders a text input with a label/placeholder for the repo path and a submit button
- [x] When Tauri is present, behavior is unchanged (native file dialog)
- [x] The text input form calls the same `project.add` RPC mutation with `{ repoPath: inputValue }`
- [x] Success shows a toast with the project name; error shows an error toast (same as current behavior)
- [x] Loading state ("Adding...") shown during submission
- [x] Type checks pass (`bun run check-types` in `apps/web`)
- [x] `bun x ultracite check` passes

### Blocked by

None — can start immediately.

### User stories addressed

- User story 6

---

## Issue 3: Playwright infrastructure + tracer bullet test

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Set up Playwright in `apps/web` with WebKit, create the globalSetup/globalTeardown scripts, page object fixtures, and write ONE end-to-end tracer bullet test that proves the full stack works: navigate to the app, verify it loads, and confirm basic page structure is present.

This is the foundational issue — all other E2E test issues depend on this infrastructure being in place.

See the PRD sections: "Playwright Infrastructure", "Global Setup / Teardown", "E2E Test Organization", "Page Object Pattern".

### Status: COMPLETED

### Acceptance criteria

- [x] `@playwright/test` added as a dev dependency to `apps/web`
- [x] `playwright.config.ts` configured: WebKit browser, `e2e/` test directory, base URL `http://localhost:3001`, 30s test timeout, 10s assertion timeout, 1 retry, screenshots on failure in `e2e/results/`
- [x] `globalSetup.ts` creates a temp directory for `DATA_DIR`, creates a temp git repo with `git init` + initial commit, starts `turbo dev` with `DATA_DIR` env var, polls until all 3 services are healthy (web :3001, server :3000, terminal :3002)
- [x] `globalTeardown.ts` kills the `turbo dev` process tree, removes temp database directory and temp git repo
- [x] `e2e/results/` is added to `.gitignore`
- [x] `test:e2e` script added to `apps/web/package.json`
- [x] `e2e/fixtures/` directory created with skeleton page object helpers (SidebarHelper, PanelHelper, TerminalHelper)
- [x] One tracer bullet test exists: navigates to the app, verifies the page loads (header visible, sidebar present)
- [x] `bun run test:e2e` passes end-to-end
- [x] Temp git repo path is accessible to test files (via env var or Playwright project config)

### Blocked by

- Blocked by Issue 1 (Server DATA_DIR env var)
- Blocked by Issue 2 (Browser-mode file picker fallback)

### User stories addressed

- User story 1
- User story 2
- User story 3
- User story 5
- User story 22
- User story 23
- User story 24
- User story 25

---

## Issue 4: E2E — Add project and verify in sidebar

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that adds a project using the browser-mode text input fallback (Issue 2), then verifies the project appears in the sidebar. This validates the full add-project flow: text input -> RPC mutation -> LiveStore sync -> sidebar rendering.

### Status: COMPLETED

### Acceptance criteria

- [x] Test file `e2e/project-management.spec.ts` created (or appended to)
- [x] Test enters a repo path in the text input fallback (using the temp git repo from globalSetup)
- [x] Test submits the form and waits for the success toast
- [x] Test verifies the project name appears in the sidebar
- [x] Test uses Playwright auto-waiting (no `waitForTimeout`)
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 3 (Playwright infrastructure)

### User stories addressed

- User story 7

---

## Issue 5: E2E — Open and save project settings

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that opens the project settings modal for an existing project, modifies a field (e.g., worktree directory), saves, and verifies the change persists (re-open modal and check the value). This validates the settings flow through the real UI and real backend.

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/project-management.spec.ts`
- [x] Test adds a project first (or uses a project from a prior test in the same file via `test.describe.serial`)
- [x] Test clicks the settings button for the project
- [x] Test modifies a field in the settings modal
- [x] Test saves and waits for the success toast
- [x] Test re-opens settings and verifies the saved value persists
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E)

### User stories addressed

- User story 8

---

## Issue 6: E2E — Delete project

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that deletes a project and verifies it disappears from the sidebar. This validates the delete flow: button click -> confirmation -> RPC mutation -> LiveStore sync -> sidebar re-render.

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/project-management.spec.ts`
- [x] Test adds a project first (or uses a project from a prior test)
- [x] Test clicks the delete button for the project
- [x] Test confirms the deletion (if there's a confirmation dialog)
- [x] Test verifies the project is removed from the sidebar
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E)

### User stories addressed

- User story 7

---

## Issue 7: Delete mock-heavy project-settings-modal.test.tsx

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Delete the existing `test/project-settings-modal.test.tsx` file. This file mocks 6 internal modules and violates the project's TDD principles. Its behavior is now covered by the Playwright E2E test from Issue 5.

### Status: COMPLETED

### Acceptance criteria

- [x] `apps/web/test/project-settings-modal.test.tsx` is deleted
- [x] `bun run test` in `apps/web` still passes (remaining 3 test files unaffected)
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 5 (Project settings E2E — the replacement test must exist first)

### User stories addressed

- User story 21

---

## Issue 8: E2E — Create workspace and verify in sidebar

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that creates a workspace for a project, then verifies the workspace appears in the sidebar. This validates: create workspace dialog -> form submission -> RPC mutation -> worktree creation -> LiveStore sync -> sidebar rendering.

### Status: COMPLETED

### Acceptance criteria

- [x] Test file `e2e/workspace-lifecycle.spec.ts` created
- [x] Test adds a project first (using the temp git repo)
- [x] Test opens the create workspace dialog
- [x] Test optionally enters a branch name
- [x] Test submits and waits for success (workspace appears in sidebar)
- [x] Test verifies the workspace card is visible under the correct project
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E — need a project to create a workspace for) — DONE

### User stories addressed

- User story 9

---

## Issue 9: E2E — Verify workspace status and branch display

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that creates a workspace and verifies the branch name and status indicators are displayed correctly in the sidebar workspace card. This validates that workspace metadata flows from the server through LiveStore to the UI correctly.

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/workspace-lifecycle.spec.ts`
- [x] Test creates a workspace with a known branch name
- [x] Test verifies the branch name is displayed in the workspace card
- [x] Test verifies a status badge/indicator is visible (e.g., "running" or similar)
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 8 (Create workspace E2E)

### User stories addressed

- User story 10

---

## Issue 10: E2E — Destroy workspace

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that destroys a workspace and verifies it disappears from the sidebar. This validates: destroy button -> confirmation (if any) -> RPC mutation -> worktree cleanup -> LiveStore sync -> sidebar re-render.

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/workspace-lifecycle.spec.ts`
- [x] Test creates a workspace first
- [x] Test clicks the destroy button on the workspace card
- [x] Test confirms destruction (if there's a confirmation step)
- [x] Test verifies the workspace is removed from the sidebar
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 8 (Create workspace E2E)

### User stories addressed

- User story 9

---

## Issue 11: E2E — Split panes horizontally and vertically

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that splits a pane horizontally, verifies two panes are visible, then splits one of them vertically, verifying three panes. This validates the recursive panel split system through the real UI.

### Status: COMPLETED

### Acceptance criteria

- [x] Test file `e2e/panel-system.spec.ts` created
- [x] Test clicks the horizontal split button and verifies two panes are rendered
- [x] Test clicks the vertical split button within one pane and verifies three panes are rendered
- [x] Test verifies the pane layout structure visually (panes are side-by-side for horizontal, stacked for vertical)
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 3 (Playwright infrastructure)

### User stories addressed

- User story 11

---

## Issue 12: E2E — Close pane and verify focus transfer

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that splits a pane, then closes one pane and verifies focus transfers to the sibling pane. This validates the close-and-focus-transfer behavior in the real UI (the logic tested at the unit level in `layout-utils.test.ts`).

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/panel-system.spec.ts`
- [x] Test splits a pane to create two panes
- [x] Test closes one pane (via close button or Cmd+W)
- [x] Test verifies only one pane remains
- [x] Test verifies the remaining pane is focused/active
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 11 (Split panes E2E)

### User stories addressed

- User story 12

---

## Issue 13: E2E — Keyboard navigate between panes

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that uses keyboard shortcuts (Ctrl+B prefix then arrow keys) to navigate between panes. This validates the panel keyboard navigation system.

### Status: COMPLETED

### Acceptance criteria

- [x] Test added to `e2e/panel-system.spec.ts`
- [x] Test splits panes to create a multi-pane layout
- [x] Test uses Ctrl+B then arrow key to move focus to an adjacent pane
- [x] Test verifies the active pane changes (e.g., active pane indicator updates)
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 11 (Split panes E2E)

### User stories addressed

- User story 13

---

## Issue 14: E2E — Resize panes via keyboard

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that resizes panes using keyboard shortcuts (Ctrl+B then Shift+arrow) and verifies the pane sizes change. This validates the keyboard-driven resize behavior.

### Acceptance criteria

- [ ] Test added to `e2e/panel-system.spec.ts`
- [ ] Test splits panes to create a multi-pane layout
- [ ] Test captures initial pane sizes (e.g., via bounding box or CSS width)
- [ ] Test uses Ctrl+B then Shift+Arrow to resize
- [ ] Test verifies pane sizes changed from the initial values
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 11 (Split panes E2E)

### User stories addressed

- User story 14

---

## Issue 15: E2E — Open terminal, type command, verify output

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that opens a terminal in a pane, types a command (e.g., `echo hello`), and verifies the output appears. This validates the full terminal pipeline: WebSocket connection -> PTY spawn -> xterm.js rendering.

### Status: COMPLETED

### Acceptance criteria

- [x] Test file `e2e/terminal-interaction.spec.ts` created
- [x] Test creates a workspace (which spawns a terminal)
- [x] Test assigns the terminal to a pane (or it's auto-assigned)
- [x] Test types a command into the terminal pane
- [x] Test verifies the command output appears in the terminal
- [x] Test uses appropriate timeouts for PTY initialization
- [x] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 8 (Create workspace E2E — need a workspace with terminals)

### User stories addressed

- User story 15

---

## Issue 16: E2E — Sidebar search filters projects and workspaces

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that types in the sidebar search box and verifies projects/workspaces are filtered in real-time. This validates the search filtering pipeline.

### Acceptance criteria

- [ ] Test file `e2e/search-navigation.spec.ts` created
- [ ] Test adds at least one project (so there's something to search for)
- [ ] Test types a search query in the sidebar search input (`aria-label="Search projects and workspaces"`)
- [ ] Test verifies matching projects remain visible
- [ ] Test verifies non-matching items are hidden (or a separate project is added to confirm filtering)
- [ ] Test clears search (via clear button or Escape) and verifies all items reappear
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E)

### User stories addressed

- User story 16

---

## Issue 17: E2E — Collapse and expand project groups

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that collapses a project group in the sidebar, verifies its contents are hidden, then expands it and verifies the contents reappear. This validates the collapse/expand behavior and its persistence.

### Acceptance criteria

- [ ] Test added to `e2e/search-navigation.spec.ts`
- [ ] Test adds a project with at least one visible child element (workspace or action buttons)
- [ ] Test clicks the collapse trigger for the project group
- [ ] Test verifies the project's child content is hidden
- [ ] Test clicks the expand trigger
- [ ] Test verifies the child content is visible again
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E)

### User stories addressed

- User story 17

---

## Issue 18: E2E — Toggle dark mode

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that toggles the dark mode switch in the header and verifies the theme changes. This validates the theme toggle mechanism.

### Acceptance criteria

- [ ] Test added to `e2e/search-navigation.spec.ts`
- [ ] Test locates the theme toggle in the header
- [ ] Test clicks the toggle to switch themes
- [ ] Test verifies the theme changed (e.g., `html` element class or `data-theme` attribute changes, or specific CSS property changes)
- [ ] Test toggles back and verifies the original theme is restored
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 3 (Playwright infrastructure — no project needed for this)

### User stories addressed

- User story 18

---

## Issue 19: E2E — Switch to dashboard view and verify summary

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that switches to the dashboard view and verifies the cross-project summary is displayed. This validates the dashboard toggle and rendering.

### Acceptance criteria

- [ ] Test file `e2e/dashboard.spec.ts` created
- [ ] Test adds at least one project (so the dashboard has content)
- [ ] Test clicks the dashboard view toggle button
- [ ] Test verifies the dashboard view is rendered (summary section visible)
- [ ] Test verifies project information appears in the dashboard
- [ ] Test switches back to the panels view and verifies panels are visible again
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 4 (Add project E2E)

### User stories addressed

- User story 19

---

## Issue 20: E2E — Verify workspace status badges in dashboard

### Parent PRD

PRD-e2e-test-coverage.md

### What to build

Write a Playwright E2E test that creates a workspace, switches to the dashboard view, and verifies workspace status badges are displayed correctly. This validates that workspace status flows through to the dashboard rendering.

### Acceptance criteria

- [ ] Test added to `e2e/dashboard.spec.ts`
- [ ] Test adds a project and creates a workspace
- [ ] Test switches to the dashboard view
- [ ] Test verifies the workspace appears under its project in the dashboard
- [ ] Test verifies a status badge is visible on the workspace entry
- [ ] Test passes with `bun run test:e2e`

### Blocked by

- Blocked by Issue 8 (Create workspace E2E)

### User stories addressed

- User story 20
