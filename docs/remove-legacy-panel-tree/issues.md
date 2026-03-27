# Issues: Remove Legacy Panel Layout Tree (DB Nuke)

Parent PRD: [PRD.md](./PRD.md)

---

## Issue 1: Rename hierarchical types and delete legacy type definitions

**Status:** done

### What to build

Delete the legacy types and their Effect Schemas from `types.ts`, then rename the hierarchical types to take the freed names:

- Delete: `LeafNode`, `SplitNode`, `PanelNode`, `PanelLayout`, `LeafNodeSchema`, `SplitNodeSchema`, `PanelNodeSchema`, `PanelLayoutSchema`.
- Rename: `PanelLeafNode` -> `LeafNode`, `PanelSplitNode` -> `SplitNode`, `PanelTreeNode` -> `PanelNode`.
- Update all imports and references across the entire codebase.
- Update the `_tag` discriminant values: `'PanelLeafNode'` -> `'LeafNode'`, `'PanelSplitNode'` -> `'SplitNode'`.

This is a mechanical find-and-replace verified by `tsc`.

### TDD approach

This module is a mechanical rename. TDD is not applicable -- correctness is verified by `tsc` (typecheck) and `bun run check`.

### Acceptance criteria

- [ ] Legacy types `LeafNode`, `SplitNode`, `PanelNode`, `PanelLayout` and their schemas are deleted from `types.ts`
- [ ] Hierarchical types are renamed: `PanelLeafNode` -> `LeafNode`, `PanelSplitNode` -> `SplitNode`, `PanelTreeNode` -> `PanelNode`
- [ ] `_tag` discriminant values updated to `'LeafNode'` and `'SplitNode'`
- [ ] All imports and references updated across the codebase
- [ ] `bun run check` passes (typecheck + format + tests)

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 21 (simpler codebase)

---

## Issue 2: Schema -- single event, minimal table, delete legacy events

**Status:** open

### What to build

Overhaul the LiveStore schema:

- **Delete** all 5 legacy event definitions and materializers: `layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`, `layoutWorkspacesReordered`.
- **Delete** all 13 hierarchical event definitions and materializers: `windowTabCreated`, `windowTabClosed`, `windowTabSwitched`, `windowTabRenamed`, `windowTabsReordered`, `panelTabCreated`, `panelTabClosed`, `panelTabSwitched`, `panelTabsReordered`, `windowLayoutRestored`, `windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`.
- **Create** a single event: `windowLayoutUpdated` with schema `{ windowId: string, windowLayout: WindowLayout, reason?: string }`.
- **Simplify** the `panelLayout` state table to two columns: `windowId` (text, PK) and `windowLayout` (JSON `WindowLayout`). Drop `layoutTree`, `activePaneId`, `workspaceOrder`, and `activeWindowTabId`.
- The materializer is a single upsert: `panelLayout.insert({ windowId, windowLayout }).onConflict('windowId', 'update', { windowLayout })`.

### TDD approach

Use a real in-memory LiveStore (prior art: `schema.test.ts`). Vertical slices:

1. RED: Test that committing `windowLayoutUpdated` with a valid `WindowLayout` persists and is queryable. GREEN: Define the event, table, and materializer.
2. RED: Test that committing a second event for the same `windowId` upserts (overwrites). GREEN: Verify materializer uses `onConflict`.
3. RED: Test that the `reason` field is optional and does not affect materialization. GREEN: Verify schema accepts missing `reason`.
4. RED: Test that querying `panelLayout` returns only `windowId` and `windowLayout` columns. GREEN: Verify table definition.

### Acceptance criteria

- [ ] All 5 legacy event definitions are deleted
- [ ] All 13 hierarchical event definitions are deleted
- [ ] Single `windowLayoutUpdated` event is defined with correct schema
- [ ] `panelLayout` table has only `windowId` and `windowLayout` columns
- [ ] Materializer correctly upserts on `windowId`
- [ ] `reason` field is optional
- [ ] Schema tests pass with real in-memory LiveStore
- [ ] `bun run check` passes

### Blocked by

- Issue 1 (type renames must be done first so schema references the new types)

### User stories addressed

- User story 19 (clean fresh state after DB nuke)
- User story 21 (simpler codebase)

---

## Issue 3: Reorganize utility files into 3 modules by tree level

**Status:** open

### What to build

Consolidate the scattered utility functions into three files organized by the tree level they operate on. Move existing hierarchical utility functions from their current locations into the new structure. Delete legacy-only functions.

- **`panel-tree-utils.ts`** -- Pure functions operating on `PanelNode` (the split tree within a single panel tab): `splitPane`, `closePane`, `findLeaf`, `findSiblingPaneId`, `collectTerminalIds`, `getLeafIds`, `getFirstLeafId`, `findNewLeafAfterSplit`, `findPaneInDirection`, `computeResize`, `buildPath`. Source: renamed functions from `window-tab-utils.ts` (e.g., `splitPaneInPanelTree` -> `splitPane`) plus ported algorithms from `layout-utils.ts` (e.g., `findPaneInDirection`, `computeResize`).
- **`workspace-tile-utils.ts`** -- Pure functions operating on `WorkspaceTileNode`: `addWorkspace`, `removeWorkspace`, `reorderTiles`, `getLeaves`, `findWorkspaceByPaneId`, `buildTilePath`, `collectTerminalIdsFromTileTree`. Deduplicate `getWorkspaceTileLeaves` to a single definition here.
- **`window-layout-utils.ts`** -- Pure functions operating on `WindowLayout`: `addWindowTab`, `removeWindowTab`, `switchWindowTab`, `renameWindowTab`, `reorderWindowTabs`, `findTerminalLocation`, `findWorkspaceLocation`, `resolveActivePaneForWindowTab`, `saveFocusedPaneId`, `assignTerminal`, `closeTerminal`, `removeWorkspaceFromLayout`, `reconcileWindowLayout`, `computeProgressiveCloseAction`, `getStaleTerminalLeaves`.

Inline trivial wrappers (e.g., `addWorkspaceToTabUnique` which is a one-liner around `moveWorkspace`).

Delete `layout-utils.ts` (all functions either ported to new files or deleted as legacy-only). Delete `layout-migration.ts` entirely.

### TDD approach

For each utility file, migrate existing tests alongside the functions. Use vertical slices for any new or ported functions:

**panel-tree-utils.ts** (highest priority -- core algorithms):
1. RED: `splitPane` creates a new leaf as sibling. GREEN: Port from `splitPaneInPanelTree`.
2. RED: `closePane` removes a leaf and promotes sibling. GREEN: Port from `closePaneInPanelTree`.
3. RED: `findSiblingPaneId` returns the adjacent leaf. GREEN: Port from `findSiblingPaneIdInPanelTree`.
4. RED: `findPaneInDirection` navigates to the correct pane. GREEN: Port algorithm from `layout-utils.ts`, adapted for renamed types.
5. RED: `computeResize` adjusts split sizes correctly. GREEN: Port from `layout-utils.ts`, adapted for renamed types.

**workspace-tile-utils.ts**: Migrate existing tests from `workspace-tile-utils.test.ts`. Add tests for any functions that move from other files.

**window-layout-utils.ts**: Migrate existing tests from `window-tab-utils.test.ts`. Add tests for `computeProgressiveCloseAction` and reconciliation functions.

Factory functions in test files should use the renamed types (`LeafNode`, `SplitNode`, `PanelNode`).

### Acceptance criteria

- [ ] `panel-tree-utils.ts` contains all split-tree-level operations
- [ ] `workspace-tile-utils.ts` contains all tile-tree-level operations
- [ ] `window-layout-utils.ts` contains all top-level layout operations
- [ ] `getWorkspaceTileLeaves` exists in exactly one file (`workspace-tile-utils.ts`)
- [ ] `layout-utils.ts` is deleted
- [ ] `layout-migration.ts` is deleted
- [ ] Old utility files (`window-tab-utils.ts`, `panel-tab-utils.ts`) are deleted or emptied
- [ ] All ported functions have tests in the corresponding new test files
- [ ] `findPaneInDirection` and `computeResize` are ported and tested with renamed types
- [ ] `bun run check` passes

### Blocked by

- Issue 1 (type renames)

### User stories addressed

- User story 21 (simpler codebase)

---

## Issue 4: Replace repair code with Effect Schema decode

**Status:** open

### What to build

Replace the ~520-line `repairWindowLayout` function and its 12+ helper functions with an Effect Schema decode pipeline.

Define the `WindowLayout` schema with `Schema.withDefault(...)` and `Schema.optional(...)` annotations that automatically produce valid defaults for missing or malformed fields. A single `Schema.decodeUnknown(WindowLayoutSchema)` call replaces all manual validation.

Handle edge cases:
- Missing `tabs` array -> default to empty array
- Missing `activeTabId` -> default to first tab's ID or `undefined`
- Missing `focusedPaneId` on `PanelTab` -> default to first leaf in the panel tree
- Malformed `WorkspaceTileNode` -> default to a single leaf
- Missing `activePanelTabId` on `WorkspaceTileLeaf` -> default to first panel tab

Delete `repairWindowLayout` and all its helper functions from `window-tab-utils.ts` (or whichever file they end up in after the reorganization).

### TDD approach

Vertical slices testing the decode behavior:

1. RED: Valid `WindowLayout` JSON decodes to itself (round-trip). GREEN: Define schema with decode.
2. RED: Missing `tabs` key decodes to `{ tabs: [], activeTabId: undefined }`. GREEN: Add `Schema.withDefault`.
3. RED: Tab with missing `activeTabId` gets first tab ID as default. GREEN: Add transformation.
4. RED: `PanelTab` with missing `focusedPaneId` gets first leaf ID. GREEN: Add transformation.
5. RED: `WorkspaceTileLeaf` with missing `activePanelTabId` gets first panel tab ID. GREEN: Add transformation.
6. RED: Completely malformed JSON (wrong types, extra fields) decodes to a valid empty layout. GREEN: Add catch-all fallback.

### Acceptance criteria

- [ ] `repairWindowLayout` and all its helper functions are deleted
- [ ] `WindowLayoutSchema` decode handles all edge cases with defaults
- [ ] Valid layouts decode unchanged (round-trip fidelity)
- [ ] Malformed layouts decode to valid layouts with sensible defaults
- [ ] No manual field-by-field validation code remains
- [ ] All decode behaviors are tested
- [ ] `bun run check` passes

### Blocked by

- Issue 1 (type renames)
- Issue 3 (file reorganization -- need to know where the schema lives)

### User stories addressed

- User story 14 (layout persists across restarts)
- User story 23 (Schema decode replaces manual validation)

---

## Issue 5: PanelManager renders renamed types directly

**Status:** open

### What to build

Update the `PanelManager` rendering pipeline to accept and render `PanelNode` (`LeafNode | SplitNode`) with the renamed types.

- `PanelRenderer` dispatches on `'LeafNode'` and `'SplitNode'` tags.
- `LeafPaneRenderer` accepts `LeafNode` without sidebar flags (`devServerOpen`, `devServerTerminalId`, `diffOpen` are gone).
- `WorkspaceTileLeafFrame` passes the `PanelNode` from the active panel tab directly to `PanelManager` without any conversion.
- Remove `convertPanelTreeToLegacy` call. Remove `filterTreeByWorkspace` fallback.

### TDD approach

Vertical slices for rendering behavior:

1. RED: Single `LeafNode` renders a terminal pane with the correct terminal ID. GREEN: Update `PanelRenderer` to dispatch on `'LeafNode'`.
2. RED: `SplitNode` with two children renders two panels in the correct direction. GREEN: Update to dispatch on `'SplitNode'`.
3. RED: Nested splits render correctly (split within a split). GREEN: Verify recursive rendering.
4. RED: Empty pane (no terminal assigned) shows the CTA. GREEN: Verify leaf with no `terminalId`.
5. RED: `WorkspaceTileLeafFrame` passes `PanelNode` to `PanelManager` without conversion. GREEN: Remove `convertPanelTreeToLegacy` call.

Prior art: existing `panel-manager.test.tsx` (component rendering with `@testing-library/react`, mock UI components with `data-testid`).

### Acceptance criteria

- [ ] `PanelManager` accepts `PanelNode | undefined` as its layout prop
- [ ] `PanelRenderer` dispatches on `'LeafNode'` / `'SplitNode'` tags
- [ ] `LeafPaneRenderer` does not reference `devServerOpen`, `devServerTerminalId`, or `diffOpen`
- [ ] `convertPanelTreeToLegacy` is not called anywhere
- [ ] `filterTreeByWorkspace` is not called anywhere
- [ ] Existing rendering behavior preserved
- [ ] Tests pass with renamed type fixtures
- [ ] `bun run check` passes

### Blocked by

- Issue 1 (type renames)

### User stories addressed

- User story 1 (focus border tracks active panel)
- User story 2 (focus follows between workspace frames)

---

## Issue 6: Focus tracking -- hierarchical only

**Status:** open

### What to build

Remove the legacy `activePaneId` column dependency. Focus is tracked exclusively via the 3-level hierarchical model:

- `WindowLayout.activeTabId` -> active window tab
- `WorkspaceTileLeaf.activePanelTabId` -> active panel tab per workspace
- `PanelTab.focusedPaneId` -> focused pane per panel tab

Rewrite `handleSetActivePaneId` to use `saveFocusedPaneId` on the hierarchical tree and commit `windowLayoutUpdated` with `reason: 'focus-changed'`.

Derive `persistedActivePaneId` from `resolveActivePaneForWindowTab` at read time instead of from a column.

Derive `activeWorkspaceId` from the workspace tile leaf containing the focused pane.

Remove all `layoutPaneAssigned` commits from focus-restoration callbacks.

### TDD approach

Vertical slices:

1. RED: Setting active pane ID on a leaf in the current panel tab updates `focusedPaneId`. GREEN: Wire `handleSetActivePaneId` to `saveFocusedPaneId`.
2. RED: Setting active pane ID on a leaf in a different workspace switches `activeTabId` context. GREEN: Handle cross-workspace focus.
3. RED: `resolveActivePaneForWindowTab` returns the correct pane for a single-tab layout. GREEN: Verify derivation.
4. RED: `resolveActivePaneForWindowTab` returns the correct pane after switching window tabs. GREEN: Verify tab-switch focus restoration.
5. RED: `activeWorkspaceId` reflects the workspace containing the focused pane. GREEN: Verify derivation from tile leaves.

### Acceptance criteria

- [ ] `handleSetActivePaneId` commits `windowLayoutUpdated` (not `layoutPaneAssigned`)
- [ ] `persistedActivePaneId` is derived from `resolveActivePaneForWindowTab`
- [ ] `activeWorkspaceId` is derived from the workspace tile leaf containing the focused pane
- [ ] No code commits `layoutPaneAssigned`
- [ ] Focus border shifts correctly when clicking between workspace frames
- [ ] Panel tab switches restore focus to `focusedPaneId`
- [ ] Window tab switches restore focus to last-focused pane
- [ ] `bun run check` passes

### Blocked by

- Issue 2 (schema changes -- need the single event)
- Issue 5 (PanelManager renders renamed types)

### User stories addressed

- User story 1 (focus border)
- User story 2 (focus follows between workspaces)
- User story 4 (panel tab focus restoration)
- User story 5 (window tab focus restoration)
- User story 8 (sidebar active workspace highlight)

---

## Issue 7: Mutation handlers operate on WindowLayout directly

**Status:** open

### What to build

Rewrite all mutation handlers in `use-panel-layout.ts` to operate directly on `WindowLayout`, committing a single `windowLayoutUpdated` event:

- **`handleSplitPane`**: Use `splitPane` on active panel tab's `PanelNode`. Focus new pane. Auto-spawn terminal. Commit `windowLayoutUpdated` with `reason: 'split'`.
- **`handleClosePane`**: Use `closePane`. Transfer focus to sibling. Kill terminal. Commit with `reason: 'pane-closed'`.
- **`handleAssignTerminalToPane`**: Use `assignTerminal`. Commit with `reason: 'terminal-assigned'`.
- **`handleCloseWorkspace`**: Use `removeWorkspaceFromLayout`. Kill terminals. Commit with `reason: 'workspace-closed'`.
- **`handleCloseTerminalPane`**: Use `closeTerminal` as sole path. No legacy fast-path.
- **`handleToggleDevServerPane`**: Create/remove `devServerTerminal` panel tab. No sidebar flags.
- **`handleResizePane`**: Use `computeResize` on active panel tab's `PanelNode`.

Delete `syncLegacyTreeToHierarchical`, `deriveLegacyTreeFromHierarchical`, all legacy event commits, `commitAssignment` helper, `defaultLayout` constant, `DEFAULT_NEW_WINDOW_LAYOUT`.

### TDD approach

Vertical slices per handler (using mock store, prior art: `use-panel-layout.test.ts`):

1. RED: `handleSplitPane` produces a layout with one additional leaf in the active panel tab. GREEN: Wire to `splitPane`.
2. RED: `handleSplitPane` sets `focusedPaneId` to the new leaf. GREEN: Update focus after split.
3. RED: `handleClosePane` removes the leaf and promotes sibling. GREEN: Wire to `closePane`.
4. RED: `handleClosePane` transfers focus to sibling. GREEN: Use `findSiblingPaneId`.
5. RED: `handleAssignTerminalToPane` updates the leaf's `terminalId`. GREEN: Wire to `assignTerminal`.
6. RED: `handleCloseWorkspace` removes all panes for the workspace. GREEN: Wire to `removeWorkspaceFromLayout`.
7. RED: `handleToggleDevServerPane` ON creates a new panel tab. GREEN: Add panel tab with `paneType: 'devServerTerminal'`.
8. RED: `handleToggleDevServerPane` OFF removes the panel tab. GREEN: Remove by panel tab ID.
9. RED: `handleResizePane` adjusts split sizes. GREEN: Wire to `computeResize`.

### Acceptance criteria

- [ ] All handlers commit `windowLayoutUpdated` (no legacy events)
- [ ] `syncLegacyTreeToHierarchical` is deleted
- [ ] `deriveLegacyTreeFromHierarchical` is not called
- [ ] `commitAssignment` helper is deleted
- [ ] `defaultLayout` legacy constant is deleted
- [ ] Each handler operates directly on `WindowLayout`
- [ ] Dev server toggle creates/removes panel tabs (no sidebar flags)
- [ ] All handler behaviors tested
- [ ] `bun run check` passes

### Blocked by

- Issue 2 (schema changes)
- Issue 3 (utility file reorganization)
- Issue 6 (focus tracking)

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 6 (split focuses new pane)
- User story 7 (close transfers focus)
- User story 9 (dev server as panel tab)
- User story 12 (resize works)
- User story 13 (close confirmation)
- User story 15 (terminal assignment)

---

## Issue 8: Port all consumers to hierarchical tree

**Status:** open

### What to build

Port every consumer of the derived legacy `layout` (`PanelNode`) to use `WindowLayout`:

- **`index.tsx`**: `activeWorkspaceId` from workspace tile leaves. Pane-to-workspace lookup via `findTerminalLocation`. Fullscreen auto-exit, auto-close review/diff, close gate logic, notification click handler.
- **`PanelHotkeys`**: Directional navigation walks `PanelNode`. Pane cycling uses `getLeafIds`. Remove legacy `layout` prop.
- **`WorkspaceFrames`**: Remove `LegacyWorkspaceFrames`, `flatLayout` prop, `workspaceOrder` prop. Hierarchical tile renderer is the sole path.
- **`WorkspaceFrameHeaderContainer`**: `getScopedActivePaneId` uses hierarchical leaf list.
- **`PanelContent`**: Remove `layout` prop. `workspaceTileLayout` is the sole source.

### TDD approach

Most consumer porting is verified by existing integration tests and typecheck. Focus TDD on behavioral changes:

1. RED: `PanelHotkeys` directional navigation from a pane finds the correct neighbor. GREEN: Wire to ported `findPaneInDirection`.
2. RED: `PanelHotkeys` pane cycling visits all visible panes. GREEN: Wire to `getLeafIds` on active panel tab.
3. RED: `computeProgressiveCloseAction` returns correct action for each level. GREEN: Verify through public interface.

### Acceptance criteria

- [ ] `index.tsx` does not import from `layout-utils.ts`
- [ ] `PanelHotkeys` does not accept a legacy `PanelNode` layout prop
- [ ] `LegacyWorkspaceFrames` is deleted
- [ ] `WorkspaceFrames` does not accept `layout` or `workspaceOrder` props
- [ ] `PanelContent` does not accept a `layout` prop
- [ ] `filterTreeByWorkspace` is not called anywhere
- [ ] Directional navigation works correctly
- [ ] Pane cycling works correctly
- [ ] Progressive close chain works
- [ ] `bun run check` passes

### Blocked by

- Issue 5 (PanelManager renders renamed types)
- Issue 6 (focus tracking)
- Issue 7 (mutation handlers)

### User stories addressed

- User story 3 (keyboard shortcuts)
- User story 8 (sidebar highlight)
- User story 10 (directional navigation)
- User story 11 (pane cycling)
- User story 13 (close confirmation)
- User story 16 (fullscreen mode)
- User story 17 (auto-close review/diff)
- User story 18 (notification clicks)
- User story 22 (progressive close)

---

## Issue 9: Seeding and reconciliation -- hierarchical only

**Status:** open

### What to build

Simplify seeding and reconciliation to operate exclusively on `WindowLayout`:

- **Seeding**: Create a `WindowLayout` directly from initial terminal/workspace state. No `migrateToWindowLayout`.
- **Reconciliation**: Only hierarchical stale-terminal detection. Single `windowLayoutUpdated` commit.
- **Repair**: Replaced by Schema decode (Issue 4). Remove `repairPanelLayoutTree`.
- **`useInitialLayout`**: Return data that directly seeds a `WindowLayout`.
- Remove `persistedLayoutTree`, `rawPersistedActivePaneId`, `persistedWorkspaceOrder`, and all associated state.

### TDD approach

Vertical slices:

1. RED: Cold start with no persisted layout creates a `WindowLayout` with one tab and the initial workspace. GREEN: Implement seeding.
2. RED: Warm start with persisted layout containing stale terminal IDs detects and replaces them. GREEN: Implement stale-terminal reconciliation.
3. RED: Warm start preserves non-stale terminals unchanged. GREEN: Verify reconciliation preserves valid state.
4. RED: Reconciliation commits a single `windowLayoutUpdated` event. GREEN: Verify single commit.

### Acceptance criteria

- [ ] `use-panel-layout.ts` does not reference `persistedLayoutTree`, `rawPersistedActivePaneId`, or `persistedWorkspaceOrder`
- [ ] `migrateToWindowLayout` is not called
- [ ] `repairPanelLayoutTree` is not called
- [ ] Seeding creates a `WindowLayout` directly
- [ ] Reconciliation only uses hierarchical stale-terminal detection
- [ ] App starts cleanly from cold state
- [ ] App starts cleanly from warm state with stale terminals
- [ ] `bun run check` passes

### Blocked by

- Issue 6 (focus tracking)
- Issue 7 (mutation handlers)

### User stories addressed

- User story 14 (layout persists across restarts)
- User story 19 (clean fresh state)

---

## Issue 10: Dead code removal

**Status:** open

### What to build

Final cleanup pass after all other issues are complete:

- Delete `layout-migration.ts` if not already deleted in Issue 3.
- Delete all unused functions remaining in any utility file.
- Delete all legacy type exports from `types.ts` if not already deleted in Issue 1.
- Remove or update tests that exclusively test deleted functions (`layout-utils.test.ts`, `layout-migration.test.ts`).
- Remove all unused imports across all files.
- Run `bun run format:fix` to clean up formatting.

### TDD approach

Not applicable -- this is a deletion-only cleanup verified by `tsc` and `bun run check`.

### Acceptance criteria

- [ ] `layout-migration.ts` does not exist
- [ ] `layout-utils.ts` does not exist (or contains only non-layout utilities like `isWorkspaceFrameData`)
- [ ] No legacy event names are referenced anywhere in the codebase
- [ ] `syncLegacyTreeToHierarchical` does not exist
- [ ] No legacy types (`LeafNode` with sidebar flags, `PanelNode` as union of old types) exist
- [ ] All tests pass
- [ ] `bun run check` passes with zero regressions

### Blocked by

- All other issues (1-9)

### User stories addressed

- User story 21 (simpler codebase)
