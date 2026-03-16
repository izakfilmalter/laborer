# PRD: Remove Legacy Panel Layout Tree

## Problem Statement

The panel layout system maintains two parallel representations of the same data: a legacy flat `PanelNode` tree (`LeafNode | SplitNode`) and a hierarchical `WindowLayout` tree (`WindowTab > WorkspaceTileNode > PanelTab > PanelTreeNode`). Every mutation to the layout must commit both a legacy event and a hierarchical event, with a `syncLegacyTreeToHierarchical` bridge function translating between them. This dual-write pattern:

1. **Causes focus bugs** -- when the user clicks a pane, `handleSetActivePaneId` validates the pane ID against the stale legacy tree instead of the hierarchical tree. Since hierarchical pane IDs don't exist in the legacy tree, focus silently falls back to a wrong pane, breaking the focus border and keyboard input.
2. **Doubles mutation complexity** -- every split, close, assign-terminal, and close-workspace operation must mutate the legacy tree, commit a legacy event, then sync the result to the hierarchical tree and commit a second event.
3. **Creates divergence risk** -- the two trees can drift out of sync (and have, causing the focus bug above), and debugging requires understanding both representations.
4. **Blocks new features** -- panel tabs, dev server as a panel type, and progressive close all had to be implemented in the hierarchical tree while maintaining backward compatibility with the legacy tree.
5. **Inflates code size** -- `use-panel-layout.ts` is ~2000 lines, with roughly half dedicated to legacy tree manipulation and the dual-write bridge.

## Solution

Remove the legacy `PanelNode` tree entirely. Make the hierarchical `WindowLayout` the single source of truth for all layout state — mutations, persistence, focus tracking, rendering, and keyboard navigation.

Specifically:
- All mutation handlers operate directly on `PanelTreeNode` within the hierarchical `WindowLayout`.
- The `PanelManager` rendering pipeline accepts `PanelTreeNode` directly instead of converting from `PanelNode`.
- Focus tracking uses the hierarchical tree's `focusedPaneId` on `PanelTab` and `activePanelTabId` on `WorkspaceTileLeaf` instead of a flat `activePaneId` column.
- Legacy events (`layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`) stop being committed. The already-defined hierarchical events (`windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`) are used instead.
- The deprecated `layoutTree`, `activePaneId`, and `workspaceOrder` columns are removed from the `panelLayout` LiveStore schema.
- Users with only legacy data (no `windowLayout`) get a fresh empty `WindowLayout` with one tab.

## User Stories

1. As a developer, I want clicking a panel to immediately show the focus border on that panel, so that I know which panel has keyboard focus.
2. As a developer, I want focus to follow me when I switch between workspace frames (e.g., clicking from "laborer / tabs" to "laborer / main"), so that keyboard input goes to the correct terminal.
3. As a developer, I want keyboard shortcuts (Cmd+D to split, Cmd+W to close, Ctrl+B then arrows to navigate) to operate correctly on the panel I'm focused on, regardless of how the layout was created.
4. As a developer, I want panel tab switches (clicking a different tab within a workspace) to restore focus to the last-focused pane of the destination tab, so that I can resume typing immediately.
5. As a developer, I want window tab switches to restore focus to the destination tab's last-focused pane, so that switching contexts is seamless.
6. As a developer, I want splitting a pane to focus the new pane and auto-spawn a terminal in it, so that I can start working in the new pane immediately.
7. As a developer, I want closing a pane to transfer focus to its sibling, so that I never lose keyboard focus after closing.
8. As a developer, I want the sidebar's active workspace highlight to track the workspace I'm working in based on which panel is focused.
9. As a developer, I want the dev server toggle to open a dedicated panel tab (not a sidebar overlay), consistent with how other pane types work.
10. As a developer, I want directional navigation (Ctrl+B then arrow keys) to work correctly across all panes within a workspace's active panel tab.
11. As a developer, I want pane cycling (o/p keys) to cycle through all visible panes in the active window tab.
12. As a developer, I want pane resize (Shift+arrow keys) to adjust the correct split based on the hierarchical tree structure.
13. As a developer, I want the close confirmation dialog to appear when I try to close a pane or workspace with running processes, regardless of whether it was created via legacy or hierarchical code paths.
14. As a developer, I want the layout to persist correctly across app restarts — stale terminal IDs should be reconciled and new terminals spawned in the same workspaces.
15. As a developer, I want assigning a terminal from the sidebar to work correctly — finding or creating the right pane in the hierarchical layout.
16. As a developer, I want fullscreen pane mode to work correctly, detecting when the fullscreened pane no longer exists in the layout.
17. As a developer, I want the auto-close behavior for review and diff panels to work correctly when a workspace is removed from the layout.
18. As a developer, I want notification clicks to navigate to the correct workspace and focus the right pane, regardless of which window tab or panel tab the workspace is in.
19. As a developer upgrading from a legacy-only layout, I want a clean fresh tab rather than a broken state, so that I can start working immediately.
20. As a developer, I want drag-and-drop reordering of workspace frames to persist correctly in the hierarchical tile tree.

## 'Polishing' Requirements

- Verify that the focus border (the `border-primary` ring) reliably tracks the active panel across all interaction methods: mouse click, keyboard navigation, tab switches, pane splits, pane closes.
- Verify that keyboard shortcuts chain correctly: split then type, close then type, navigate then type — focus should always be on the correct terminal.
- Verify that the sidebar's active workspace highlight updates in real-time as the user clicks between panels.
- Verify that the app starts cleanly from a cold state (no persisted layout) and from a warm state (persisted hierarchical layout with stale terminal IDs).
- Verify that removing a workspace from the sidebar correctly closes all its panes and transfers focus to a remaining workspace.
- Verify that the progressive close chain (Cmd+W) works: close pane, close panel tab, close workspace, close window tab, close app — in that order.
- Verify that fullscreen mode (Cmd+Shift+F) enters and exits cleanly, restoring the pane to its original position.
- Verify that the dev server toggle creates and removes panel tabs correctly, with terminals spawning and stopping as expected.
- Ensure no `console.warn` or `console.error` messages related to stale pane IDs, missing nodes, or layout sync failures during normal operation.
- Verify that all panel tab labels render correctly (Terminal, Agent, Dev Server, Diff, Review).
- Verify that the empty pane CTA ("No terminal assigned — click to select") still works correctly for newly created empty panes.
- Confirm that the LiveStore eventlog remains valid — old events from before this change should not cause errors during rematerialization.

## Implementation Decisions

### Module 1: PanelTreeNode rendering pipeline

The `PanelManager` component currently renders `PanelNode` (`LeafNode | SplitNode`) exclusively. It must be updated to render `PanelTreeNode` (`PanelLeafNode | PanelSplitNode`) directly.

- Rename the recursive `PanelRenderer` to dispatch on `'PanelLeafNode'` and `'PanelSplitNode'` tags instead of `'LeafNode'` and `'SplitNode'`.
- Update `LeafPaneRenderer` to accept `PanelLeafNode` instead of `LeafNode`. The only structural difference is the tag name and the absence of sidebar flags (`devServerOpen`, `devServerTerminalId`, `diffOpen`). Since dev server is promoted to a panel tab, these flags are no longer needed.
- Remove `convertPanelTreeToLegacy` from `WorkspaceTileLeafFrame` — pass the `PanelTreeNode` directly to `PanelManager`.
- Remove the `filterTreeByWorkspace` fallback for pre-migration tiles (tiles with no panel tabs). These tiles no longer exist after the migration cutover.

### Module 2: Hierarchical mutation handlers in use-panel-layout

Rewrite all mutation handlers to operate on the hierarchical `WindowLayout` directly:

- **`handleSplitPane`**: Use `splitPaneInPanelTree` (already added to window-tab-utils) on the active panel tab's `PanelTreeNode`. Update `focusedPaneId` to the new pane. Commit `windowLayoutSplit`.
- **`handleClosePane`**: Use `closePaneInPanelTree` (already exists) on the active panel tab. Transfer focus to sibling via `findSiblingPaneIdInPanelTree` (already added). Commit `windowLayoutPaneClosed`.
- **`handleSetActivePaneId`**: Save focus via `saveFocusedPaneId` on the hierarchical tree. Commit `windowLayoutPaneAssigned`. No more `layoutPaneAssigned`.
- **`handleAssignTerminalToPane`**: Use `assignTerminalInPanelTree` (already exists) within `updateWorkspaceTileLeaf`. Commit `windowLayoutPaneAssigned`.
- **`handleCloseWorkspace`**: Use `removeWorkspaceFromLayout` (already exists). Kill terminals via `collectTerminalIdsFromTileTree`. Commit `windowLayoutPaneClosed`.
- **`handleCloseTerminalPane`**: Use `closeTerminalInWindowLayout` (already exists) as the sole path. Remove the legacy fast-path.
- **`handleResizePane`**: Rewrite `computeResize` to walk `PanelTreeNode` instead of `PanelNode`. The algorithm is identical — only the tag names differ.
- **`handleToggleDevServerPane`**: Rewrite as a panel tab toggle. Opening adds a `devServerTerminal` panel tab to the workspace's tab list. Closing removes it. The `devServerOpen`, `devServerTerminalId` sidebar flags on `LeafNode` are eliminated.

### Module 3: Focus tracking consolidation

Remove the flat `activePaneId` column from the `panelLayout` table. Focus is tracked exclusively within the hierarchical tree:

- `WindowLayout.activeTabId` determines the active window tab.
- `WorkspaceTileLeaf.activePanelTabId` determines the active panel tab per workspace.
- `PanelTab.focusedPaneId` determines the focused pane per panel tab.
- `resolveActivePaneForWindowTab` walks this hierarchy to produce the globally active pane ID.

The `PanelActionsProvider` receives the resolved `activePaneId` and `activeWorkspaceId` from the hierarchical tree's focus state rather than from a separate legacy column.

### Module 4: Consumer porting (index.tsx, PanelHotkeys, workspace-frames)

Port all consumers of the derived `layout` (`PanelNode`) to use the hierarchical tree:

- **`activeWorkspaceId` derivation** (index.tsx): Resolve from the active window tab's workspace tile leaves instead of `findNodeById(layout, activePaneId)`.
- **Pane-to-workspace lookup** (getPanePrState, toggleReviewPane, toggleDiffPane): Use `findTerminalLocation` or walk the workspace tile leaves to find the workspace containing a pane.
- **Fullscreen auto-exit**: Check if the pane exists in any panel tab via the hierarchical tree.
- **Auto-close review/diff**: Check workspace existence via `getWorkspaceTileLeaves` instead of `getLeafNodes`.
- **Close gate logic** (computeClosePaneGateAction, computeCloseWorkspaceAction): Port to hierarchical equivalents using `collectTerminalIdsFromPanelTree` and `shouldConfirmClosePanelTab`.
- **Terminal pane lookup** (gatedCloseTerminalPane): Use `findTerminalLocation` instead of `findLeafByTerminalId`.
- **Notification click handler**: Use `findWorkspaceLocation` + `resolveActivePaneForWindowTab`.
- **PanelHotkeys**: Rewrite `findPaneInDirection` and workspace resolution to walk `PanelTreeNode`. The `leafPaneIds` for cycling is replaced by `getPanelTreeLeafIds`.
- **WorkspaceFrames**: Remove `flatLayout` prop entirely. The hierarchical tile renderer already receives the tile layout directly. Remove `LegacyWorkspaceFrames` code path.
- **WorkspaceFrameHeaderContainer**: Rewrite `getScopedActivePaneId` to use hierarchical leaf list.
- **PanelContent**: Remove `layout` prop. The `workspaceTileLayout` prop is the only layout needed.

### Module 5: Schema changes

- Remove the deprecated `layoutTree`, `activePaneId`, and `workspaceOrder` columns from the `panelLayout` state table definition. Per LiveStore rules, the column definitions cannot be fully deleted if the eventlog contains events that wrote to them. The materializers for legacy events (`v1.LayoutSplit`, `v1.LayoutPaneClosed`, `v1.LayoutPaneAssigned`, `v1.LayoutRestored`, `v1.LayoutWorkspacesReordered`) must become no-ops that do not fail, since old events remain in the eventlog.
- The event definitions themselves must remain in the schema (LiveStore eventlog is immutable and validates event definitions exist). Their materializers become empty statements.
- Begin using the already-defined events: `windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`.

### Module 6: Seeding and reconciliation

- Remove `migrateToWindowLayout`. Users with legacy-only data get a fresh `WindowLayout` with one empty tab.
- Remove `syncLegacyTreeToHierarchical` — the bridge function is no longer needed.
- Remove `repairPanelLayoutTree` — only `repairWindowLayout` is needed.
- Simplify `collectStaleLeaves` to only use `getStaleTerminalLeavesHierarchical`.
- Simplify `commitReconciledLayouts` to only commit hierarchical events.
- Simplify the seed effect to create a `WindowLayout` directly from the initial terminal/workspace state, without going through the legacy `PanelNode` tree.
- `useInitialLayout` hook return type changes from `PanelNode` to data that can be directly used to build a `WindowLayout`.

### Module 7: Legacy code removal

After all modules above are complete, remove dead code:

- `layout-migration.ts`: Remove `migrateToWindowLayout`, `deriveLegacyTreeFromHierarchical`, `convertPanelTreeToLegacy`, `convertPanelTree`, `collectSidebarFlags`, and all internal helpers.
- `layout-utils.ts`: Remove functions that are no longer called. Keep any pure utility functions that are still used (like `isWorkspaceFrameData`, `WORKSPACE_FRAME_TYPE` if used by drag-and-drop).
- `use-panel-layout.ts`: Remove `syncLegacyTreeToHierarchical`, all `persistedLayoutTree` references, all legacy event commits, all `defaultLayout` references that produce legacy `PanelNode` trees.
- Remove `LeafNode`, `SplitNode`, `PanelNode`, `PanelNodeSchema`, `LeafNodeSchema`, `SplitNodeSchema` type exports from `types.ts` (or deprecate them if any external consumers exist).

## Testing Decisions

Tests should verify external behavior — the observable effects of layout mutations on the hierarchical tree — not internal implementation details like which event name is committed.

### Modules to test

**window-tab-utils.ts** — Already has comprehensive tests in `window-tab-utils.test.ts`. New functions added (`splitPaneInPanelTree`, `findPanelTreeLeaf`, `getPanelTreeLeafIds`, `findNewPanelTreeLeaf`, `findSiblingPaneIdInPanelTree`) should have unit tests following the existing patterns in that file.

**use-panel-layout.ts** — The existing `use-panel-layout.test.ts` tests exercise the hook's behavior through mock stores. These tests need to be updated to use hierarchical `WindowLayout` fixtures instead of legacy `PanelNode` fixtures. Test the same behaviors: split creates a new pane, close removes a pane and transfers focus, assign terminal updates the pane, etc.

**PanelManager rendering** — The existing `panel-manager.test.tsx` uses `PanelNode` fixtures. Update to use `PanelTreeNode` fixtures and verify the same rendering outcomes.

**Close gate logic** — The existing `close-pane-gating.test.ts` and `close-confirmation.test.ts` should be updated to test against hierarchical tree structures. The `progressive-close.test.ts` already uses hierarchical types and can serve as prior art.

**Focus consistency** — The existing `focus-consistency.test.ts` already tests focus behavior with hierarchical types. Extend to cover the new `handleSetActivePaneId` flow.

**Schema materializers** — The existing `schema.test.ts` in `packages/shared` should be updated to verify that old legacy events materialize as no-ops without errors, and that the new hierarchical events (`windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`) materialize correctly.

### Prior art

- `test/window-tab-utils.test.ts` — Pure function tests for hierarchical tree operations
- `test/panel-tab-utils.test.ts` — Pure function tests for panel tab operations
- `test/progressive-close.test.ts` — Tests progressive close chain with hierarchical types
- `test/focus-consistency.test.ts` — Tests focus tracking with hierarchical types
- `test/hierarchical-persistence.test.ts` — Tests hierarchical layout persistence

## Out of Scope

- **Porting `findPaneInDirection` algorithm to hierarchical types** can use a mechanical tag-name translation since the tree structure is identical. No new spatial navigation algorithm is needed.
- **Multi-window focus coordination** — This PRD does not change how focus is tracked across Electron windows. Each window has its own `WindowLayout` with independent focus tracking.
- **Drag-and-drop pane rearrangement** — The existing workspace frame drag-and-drop (reorder) already works on the hierarchical tile tree. Per-pane drag-and-drop between workspaces is not in scope.
- **Custom panel tab labels** — Panel tabs derive labels from their pane type. Custom user-editable labels are not in scope.
- **Removing the `PanelNode` type from `types.ts`** — If there are external consumers (e.g., in the desktop app or server), the type can be deprecated but not removed. This should be validated during implementation.

## Further Notes

- The hierarchical `PanelTreeNode` and legacy `PanelNode` are structurally identical except for tag names (`'PanelLeafNode'` vs `'LeafNode'`, `'PanelSplitNode'` vs `'SplitNode'`) and the absence of sidebar flags. Many functions can be ported by changing tag name checks and removing sidebar flag handling.
- Three hierarchical events already exist in the schema but are never committed: `windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`. They have materializers that write to the `windowLayout` column. This PRD activates them.
- The `computeResize` function uses `buildPath` and `computeResizeFromPath` which walk the split tree using tag checks. These need to be updated to check for `'PanelSplitNode'` instead of `'SplitNode'`.
- LiveStore event definitions are immutable — old events in the eventlog must still have valid definitions and working materializers. Legacy event materializers should become no-ops (e.g., `() => sql``SELECT 1```) rather than being deleted.
- The `useInitialLayout` hook currently returns a legacy `PanelNode`. It should be rewritten to return data in a format that can directly seed a `WindowLayout`, or its callers should handle the conversion.
