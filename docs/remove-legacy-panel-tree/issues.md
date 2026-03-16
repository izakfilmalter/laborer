# Issues: Remove Legacy Panel Layout Tree

Parent PRD: [PRD.md](./PRD.md)

---

## Issue 1: PanelManager renders PanelTreeNode directly

**Status:** done

### What to build

Update the `PanelManager` rendering pipeline to accept and render `PanelTreeNode` (`PanelLeafNode | PanelSplitNode`) directly, instead of requiring a conversion from legacy `PanelNode` (`LeafNode | SplitNode`). This is the foundation that all other slices depend on.

- Update `PanelRenderer` to dispatch on `'PanelLeafNode'` and `'PanelSplitNode'` tags instead of `'LeafNode'` and `'SplitNode'`.
- Update `LeafPaneRenderer` to accept `PanelLeafNode` instead of `LeafNode`. The sidebar flags (`devServerOpen`, `devServerTerminalId`, `diffOpen`) are not present on `PanelLeafNode` and should be removed from the rendering logic.
- Update `SplitPanelRenderer` to accept `PanelSplitNode` instead of `SplitNode`.
- In `WorkspaceTileLeafFrame`, pass the `PanelTreeNode` from the active panel tab directly to `PanelManager` instead of calling `convertPanelTreeToLegacy`. Remove the `filterTreeByWorkspace` fallback for pre-migration tiles.
- Update `PanelContent` and `WorkspaceFrame` props to accept `PanelTreeNode` instead of `PanelNode` for the sub-layout.
- Update `panel-manager.test.tsx` to use `PanelTreeNode` fixtures.

See PRD Module 1: "PanelTreeNode rendering pipeline".

### Acceptance criteria

- [ ] `PanelManager` accepts `PanelTreeNode | undefined` as its `layout` prop
- [ ] `PanelRenderer` dispatches on `'PanelLeafNode'` / `'PanelSplitNode'` tags
- [ ] `LeafPaneRenderer` renders `PanelLeafNode` without referencing `devServerOpen`, `devServerTerminalId`, or `diffOpen`
- [ ] `WorkspaceTileLeafFrame` passes `PanelTreeNode` to `PanelManager` without calling `convertPanelTreeToLegacy`
- [ ] `WorkspaceFrame` props use `PanelTreeNode` for `subLayout`
- [ ] Existing panel rendering behavior is preserved (terminals render, splits work, empty panes show CTA)
- [ ] `panel-manager.test.tsx` passes with `PanelTreeNode` fixtures
- [ ] `getLeafNodes` in `WorkspaceFrame` is replaced with a `PanelTreeNode`-aware leaf collection

### Blocked by

None - can start immediately.

### User stories addressed

- User story 1 (focus border tracks active panel)
- User story 2 (focus follows between workspace frames)
- User story 3 (keyboard shortcuts operate on correct panel)

---

## Issue 2: Schema: no-op legacy materializers and remove deprecated columns

**Status:** done

### What to build

Update the LiveStore schema to stop reading/writing the deprecated legacy columns (`layoutTree`, `activePaneId`, `workspaceOrder`) and make legacy event materializers no-ops.

- Remove the `layoutTree`, `activePaneId`, and `workspaceOrder` columns from the `panelLayout` state table definition.
- Make materializers for legacy events (`v1.LayoutSplit`, `v1.LayoutPaneClosed`, `v1.LayoutPaneAssigned`, `v1.LayoutRestored`, `v1.LayoutWorkspacesReordered`) into no-ops that do not fail. Old events in the eventlog must still rematerialize without errors.
- Keep the legacy event definitions in the schema (LiveStore eventlog is immutable).
- Verify the already-defined hierarchical events (`windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned`) have correct materializers that write to `windowLayout` and `activeWindowTabId`.

See PRD Module 5: "Schema changes".

### Acceptance criteria

- [ ] `layoutTree`, `activePaneId`, and `workspaceOrder` columns are removed from the `panelLayout` table definition
- [ ] Legacy event materializers are no-ops (e.g., no SQL update)
- [ ] Legacy event definitions still exist in the schema
- [ ] `windowLayoutSplit`, `windowLayoutPaneClosed`, `windowLayoutPaneAssigned` materializers correctly update `windowLayout` and `activeWindowTabId`
- [ ] `schema.test.ts` passes — old events rematerialize without errors
- [ ] `hierarchical-layout-types.test.ts` passes

### Blocked by

None - can start immediately.

### User stories addressed

- User story 19 (clean upgrade for legacy-only users)

---

## Issue 3: handleSetActivePaneId uses hierarchical focus only

**Status:** done

### What to build

Rewrite `handleSetActivePaneId` to save focus exclusively via the hierarchical tree's `saveFocusedPaneId` and commit `windowLayoutPaneAssigned` instead of `layoutPaneAssigned`. Remove the legacy `activePaneId` column dependency.

- `handleSetActivePaneId` calls `saveFocusedPaneId(persistedWindowLayout, paneId)` and commits `windowLayoutPaneAssigned`.
- `persistedActivePaneId` is derived from `resolveActivePaneForWindowTab` on the hierarchical tree instead of reading the legacy `activePaneId` column.
- `PanelActionsProvider` receives `activePaneId` derived from the hierarchical tree.
- `activeWorkspaceId` is derived from the workspace tile leaf that contains the focused pane.
- Remove all `layoutPaneAssigned` commits from focus-restoration callbacks (`commitWindowTabSwitchWithFocus`, `commitPanelTabSwitchWithFocus`, `handleCloseWindowTab`, `handleAssignTerminalToPane` step 3).
- Update `use-panel-layout.test.ts` to verify focus changes commit hierarchical events.

See PRD Module 3: "Focus tracking consolidation" and the focus border fix analysis from the original bug investigation.

### Acceptance criteria

- [ ] `handleSetActivePaneId` commits `windowLayoutPaneAssigned` (not `layoutPaneAssigned`)
- [ ] `persistedActivePaneId` is derived from `resolveActivePaneForWindowTab` on the hierarchical tree
- [ ] `activeWorkspaceId` is derived from the workspace tile leaf containing the focused pane
- [ ] No code in `use-panel-layout.ts` commits `layoutPaneAssigned`
- [ ] Focus border correctly shifts when clicking between workspace frames
- [ ] Panel tab switches restore focus to the destination tab's `focusedPaneId`
- [ ] Window tab switches restore focus to the destination tab's last-focused pane
- [ ] `use-panel-layout.test.ts` passes with updated assertions

### Blocked by

- Blocked by "PanelManager renders PanelTreeNode directly"
- Blocked by "Schema: no-op legacy materializers and remove deprecated columns"

### User stories addressed

- User story 1 (focus border tracks active panel)
- User story 2 (focus follows between workspace frames)
- User story 4 (panel tab switches restore focus)
- User story 5 (window tab switches restore focus)
- User story 8 (sidebar active workspace highlight)

---

## Issue 4: handleSplitPane operates on hierarchical tree

**Status:** done

### What to build

Rewrite `handleSplitPane` to split panes directly on the `PanelTreeNode` within the active panel tab of the hierarchical `WindowLayout`, instead of mutating the legacy tree and syncing.

- Use `splitPaneInPanelTree` (already in `window-tab-utils.ts`) on the active panel tab's `panelLayout`.
- Find the workspace containing the pane by searching workspace tile leaves.
- Use `findNewPanelTreeLeaf` to identify the newly created pane.
- Update `focusedPaneId` on the panel tab to the new pane.
- Commit `windowLayoutSplit` instead of `layoutSplit`.
- Auto-spawn terminal in the new pane using the hierarchical `assignTerminalInPanelTree`.
- Remove the `syncLegacyTreeToHierarchical` call and legacy `layoutSplit` commit.
- Add tests for `splitPaneInPanelTree` in `window-tab-utils.test.ts`.

See PRD Module 2: "handleSplitPane" section.

### Acceptance criteria

- [ ] `handleSplitPane` commits `windowLayoutSplit` (not `layoutSplit`)
- [ ] `handleSplitPane` does not call `syncLegacyTreeToHierarchical`
- [ ] Split creates a new pane in the correct panel tab's `PanelTreeNode`
- [ ] Focus transfers to the new pane after split
- [ ] Auto-spawned terminal is assigned to the new pane via hierarchical tree
- [ ] Adjacent insertion optimization works (same-direction splits don't nest)
- [ ] Agent pane splits auto-run the agent command
- [ ] `splitPaneInPanelTree` has unit tests in `window-tab-utils.test.ts`

### Blocked by

- Blocked by "Schema: no-op legacy materializers and remove deprecated columns"
- Blocked by "handleSetActivePaneId uses hierarchical focus only"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 6 (splitting focuses new pane and spawns terminal)

---

## Issue 5: handleClosePane operates on hierarchical tree

**Status:** done

### What to build

Rewrite `handleClosePane` to close panes directly on the `PanelTreeNode` within the active panel tab, instead of mutating the legacy tree and syncing.

- Use `closePaneInPanelTree` (already in `window-tab-utils.ts`) on the active panel tab's `panelLayout`.
- Use `findSiblingPaneIdInPanelTree` (already in `window-tab-utils.ts`) to determine focus transfer target before closing.
- Kill terminals associated with the closing pane via `collectTerminalIdsFromPanelTree`.
- Commit `windowLayoutPaneClosed` instead of `layoutPaneClosed`.
- Handle the "all panes closed" edge case by removing the panel tab or showing empty state.
- Remove the `syncLegacyTreeToHierarchical` call and legacy `layoutPaneClosed` commit.

See PRD Module 2: "handleClosePane" section.

### Acceptance criteria

- [ ] `handleClosePane` commits `windowLayoutPaneClosed` (not `layoutPaneClosed`)
- [ ] `handleClosePane` does not call `syncLegacyTreeToHierarchical`
- [ ] Focus transfers to sibling pane after close
- [ ] Terminals associated with the closed pane are killed
- [ ] Closing the last pane in a panel tab handles the edge case correctly
- [ ] `findSiblingPaneIdInPanelTree` has unit tests

### Blocked by

- Blocked by "Schema: no-op legacy materializers and remove deprecated columns"
- Blocked by "handleSetActivePaneId uses hierarchical focus only"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 7 (closing transfers focus to sibling)
- User story 13 (close confirmation for running processes)

---

## Issue 6: handleAssignTerminalToPane uses hierarchical tree

**Status:** done

### What to build

Rewrite `handleAssignTerminalToPane` to assign terminals directly on the hierarchical tree, removing the legacy `computeTerminalPaneAssignment` and `commitAssignment` dual-write pattern.

- The fast path (terminal already in the hierarchical layout) already works — it navigates to the terminal's exact location via `findTerminalLocation`.
- The fallback path (new terminal assignment) should use `assignTerminalInPanelTree` within `updateWorkspaceTileLeaf` directly, committing `windowLayoutPaneAssigned`.
- Remove `commitAssignment` helper that commits `layoutPaneAssigned` and calls `syncLegacyTreeToHierarchical`.
- Ensure workspace-in-active-tab enforcement (`addWorkspaceToTabUnique`) still works.

See PRD Module 2: "handleAssignTerminalToPane" section.

### Acceptance criteria

- [ ] Terminal assignment commits `windowLayoutPaneAssigned` (not `layoutPaneAssigned`)
- [ ] `commitAssignment` helper is removed
- [ ] Fast path (terminal already exists) navigates correctly
- [ ] Fallback path assigns terminal to correct pane in hierarchical tree
- [ ] Workspace is added to active tab if not present
- [ ] `syncLegacyTreeToHierarchical` is not called

### Blocked by

- Blocked by "Schema: no-op legacy materializers and remove deprecated columns"
- Blocked by "handleSetActivePaneId uses hierarchical focus only"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 15 (sidebar terminal assignment works)

---

## Issue 7: handleCloseWorkspace and handleCloseTerminalPane use hierarchical tree

**Status:** done

### What to build

Rewrite `handleCloseWorkspace` and `handleCloseTerminalPane` to operate exclusively on the hierarchical tree.

- **`handleCloseWorkspace`**: Use `removeWorkspaceFromLayout` (already exists) and `collectTerminalIdsFromTileTree` to kill terminals. Commit `windowLayoutPaneClosed`. Remove legacy `layoutPaneClosed` commits and `closeWorkspacePanes` usage.
- **`handleCloseTerminalPane`**: Remove the legacy fast-path (`findLeafByTerminalId` on `persistedLayoutTree`). Use `closeTerminalInWindowLayout` (already exists) as the sole path. It searches all tabs/workspaces/panel-tabs for the terminal.

See PRD Module 2: "handleCloseWorkspace" and "handleCloseTerminalPane" sections.

### Acceptance criteria

- [ ] `handleCloseWorkspace` commits only hierarchical events
- [ ] `handleCloseWorkspace` does not reference `persistedLayoutTree` or `defaultLayout`
- [ ] Terminals belonging to the workspace are killed
- [ ] `handleCloseTerminalPane` uses `closeTerminalInWindowLayout` as the sole path
- [ ] `handleCloseTerminalPane` does not reference `persistedLayoutTree` or `defaultLayout`
- [ ] Closing a terminal from the sidebar works when the terminal is in a non-active panel tab

### Blocked by

- Blocked by "handleClosePane operates on hierarchical tree"
- Blocked by "handleAssignTerminalToPane uses hierarchical tree"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 13 (close confirmation for running processes)
- User story 17 (auto-close review/diff when workspace removed)

---

## Issue 8: handleToggleDevServerPane as panel tab toggle

**Status:** done

### What to build

Rewrite `handleToggleDevServerPane` to create/remove a dedicated `devServerTerminal` panel tab instead of using the legacy sidebar flags (`devServerOpen`, `devServerTerminalId`) on `LeafNode`.

- Toggling ON adds a new panel tab with `paneType: 'devServerTerminal'` to the workspace's tab list, spawns a terminal with `autoRun: true`, and assigns it to the pane.
- Toggling OFF removes the `devServerTerminal` panel tab and optionally kills the terminal.
- Remove all references to `devServerOpen`, `devServerTerminalId`, and `replaceNode` from this handler.
- The handler no longer reads from or writes to the legacy `layoutTree` column.

See PRD Module 2: "handleToggleDevServerPane" section.

### Acceptance criteria

- [ ] Toggle ON creates a `devServerTerminal` panel tab with auto-spawned terminal
- [ ] Toggle OFF removes the `devServerTerminal` panel tab
- [ ] No references to `devServerOpen`, `devServerTerminalId`, or `replaceNode`
- [ ] No legacy event commits
- [ ] Dev server terminal renders correctly in its own panel tab
- [ ] Re-toggling ON reconnects to existing dev server terminal if still running

### Blocked by

- Blocked by "handleSplitPane operates on hierarchical tree"
- Blocked by "handleClosePane operates on hierarchical tree"

### User stories addressed

- User story 9 (dev server toggle opens a panel tab)

---

## Issue 9: handleResizePane walks PanelTreeNode

**Status:** done

### What to build

Rewrite `computeResize` (and its helpers `buildPath`, `computeResizeFromPath`, `getResizeDelta`) to walk `PanelTreeNode` instead of legacy `PanelNode`. The algorithm is identical — only tag name checks change (`'PanelSplitNode'` instead of `'SplitNode'`, `'PanelLeafNode'` instead of `'LeafNode'`).

- Port `computeResize` to accept `PanelTreeNode` as root.
- Port `buildPath` to walk `PanelTreeNode`.
- `handleResizePane` uses the active panel tab's `PanelTreeNode` instead of `persistedLayoutTree ?? defaultLayout`.
- The imperative `groupHandle.setLayout()` call remains unchanged.

See PRD Module 2: "handleResizePane" section.

### Acceptance criteria

- [ ] `computeResize` accepts `PanelTreeNode` as root parameter
- [ ] `handleResizePane` does not reference `persistedLayoutTree` or `defaultLayout`
- [ ] Keyboard resize (Shift+arrow) adjusts the correct split
- [ ] Existing resize behavior is preserved
- [ ] Unit tests for `computeResize` updated to use `PanelTreeNode` fixtures

### Blocked by

- Blocked by "PanelManager renders PanelTreeNode directly"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 12 (pane resize works)

---

## Issue 10: Port index.tsx consumers to hierarchical tree

**Status:** done

### What to build

Port all consumers of the derived `layout` (`PanelNode`) in `index.tsx` to use the hierarchical `WindowLayout` directly.

- **`activeWorkspaceId` derivation**: Resolve from the active window tab's workspace tile leaves + `activePanelTabId` instead of `findNodeById(layout, activePaneId)`.
- **`getPanePrState`**: Use `findTerminalLocation` or walk workspace tile leaves to find the workspace containing a pane.
- **Fullscreen auto-exit**: Check pane existence via hierarchical tree (`findPanelTreeLeaf` across all panel tabs).
- **Auto-close review/diff**: Check workspace existence via `getWorkspaceTileLeaves` instead of `getLeafNodes`.
- **`toggleReviewPane` / `toggleDiffPane`**: Resolve workspace from pane via hierarchical tree.
- **Close gate logic**: Port `computeClosePaneGateAction` and `computeCloseWorkspaceAction` to use `collectTerminalIdsFromPanelTree` and `shouldConfirmClosePanelTab`.
- **`gatedCloseTerminalPane`**: Use `findTerminalLocation` instead of `findLeafByTerminalId`.
- **`handleNotificationClicked`**: Use `findWorkspaceLocation` + `resolveActivePaneForWindowTab`.
- Remove the `layout` return value from `usePanelLayout()` (or stop consuming it in index.tsx).

See PRD Module 4: "Consumer porting" section.

### Acceptance criteria

- [ ] `index.tsx` does not import or use `findNodeById`, `getLeafNodes`, `findLeafByTerminalId`, `computeClosePaneGateAction`, or `computeCloseWorkspaceAction` from `layout-utils`
- [ ] `activeWorkspaceId` is derived from the hierarchical tree
- [ ] Fullscreen auto-exit checks hierarchical tree
- [ ] Review/diff auto-close checks hierarchical tree
- [ ] Close gate dialogs work correctly with hierarchical tree
- [ ] Notification clicks navigate to correct workspace
- [ ] All existing behaviors preserved

### Blocked by

- Blocked by "PanelManager renders PanelTreeNode directly"
- Blocked by "handleSetActivePaneId uses hierarchical focus only"

### User stories addressed

- User story 8 (sidebar active workspace highlight)
- User story 13 (close confirmation)
- User story 16 (fullscreen mode works)
- User story 17 (auto-close review/diff)
- User story 18 (notification clicks navigate correctly)

---

## Issue 11: Port PanelHotkeys to hierarchical tree

**Status:** done

### What to build

Port the `PanelHotkeys` component to use the hierarchical `WindowLayout` tree instead of the legacy `PanelNode` layout.

- Workspace resolution (`findNodeById(layout, activePaneId)` for split/tab/diff/review shortcuts): Derive `activeWorkspaceId` from the hierarchical tree's workspace tile leaf context.
- Directional navigation (`findPaneInDirection`): Port to walk `PanelTreeNode`. The algorithm is identical to the legacy version — only tag name checks change.
- Pane cycling (`leafPaneIds` for o/p keys): Use `getPanelTreeLeafIds` on the active panel tab's `PanelTreeNode` instead of `getLeafIds` on the legacy layout.
- Remove the `layout` and `leafPaneIds` props from `PanelHotkeys`. Accept `windowLayout` or derive needed data from context.

See PRD Module 4: "PanelHotkeys" section.

### Acceptance criteria

- [ ] `PanelHotkeys` does not accept a `PanelNode` layout prop
- [ ] Directional navigation (Ctrl+B then arrows / Cmd+Option+arrows) works correctly
- [ ] Pane cycling (o/p keys) cycles through all visible panes
- [ ] Workspace resolution for split/tab shortcuts works correctly
- [ ] `findPaneInDirection` ported to `PanelTreeNode` with unit tests

### Blocked by

- Blocked by "PanelManager renders PanelTreeNode directly"
- Blocked by "handleSetActivePaneId uses hierarchical focus only"

### User stories addressed

- User story 3 (keyboard shortcuts operate correctly)
- User story 10 (directional navigation)
- User story 11 (pane cycling)
- User story 12 (pane resize via keyboard)

---

## Issue 12: Seeding and reconciliation: hierarchical only

**Status:** done

### What to build

Simplify the seeding and reconciliation logic to operate exclusively on the hierarchical `WindowLayout`, removing all legacy tree paths.

- **Seeding**: Rewrite the seed effect to create a `WindowLayout` directly from the initial terminal/workspace state. Remove `migrateToWindowLayout`. Users with legacy-only data get a fresh `WindowLayout` with one empty tab.
- **Reconciliation**: Remove `collectStaleLeaves` dual-path logic. Use only `getStaleTerminalLeavesHierarchical`. Remove `commitReconciledLayouts` dual-write (legacy + hierarchical). Commit only `windowLayoutRestored`.
- **Repair**: Remove `repairPanelLayoutTree`. Only `repairWindowLayout` is needed.
- **useInitialLayout**: Either change its return type or convert its output to `WindowLayout` at the call site.
- Remove `persistedLayoutTree`, `rawPersistedActivePaneId`, `persistedWorkspaceOrder`, `persistedLayoutRepair`, and all associated `useMemo`/`useEffect` blocks.

See PRD Module 6: "Seeding and reconciliation".

### Acceptance criteria

- [ ] `use-panel-layout.ts` does not reference `persistedLayoutTree`, `rawPersistedActivePaneId`, or `persistedWorkspaceOrder`
- [ ] `migrateToWindowLayout` is not called
- [ ] `repairPanelLayoutTree` is not called
- [ ] `reconcileLayout` (legacy) is not called
- [ ] Seeding creates a `WindowLayout` directly
- [ ] Reconciliation only uses hierarchical stale-terminal detection
- [ ] App starts cleanly from cold state (no persisted layout)
- [ ] App starts cleanly from warm state (persisted hierarchical layout with stale terminal IDs)
- [ ] Legacy-only users get a fresh empty tab

### Blocked by

- Blocked by "handleSetActivePaneId uses hierarchical focus only"
- Blocked by "handleSplitPane operates on hierarchical tree"
- Blocked by "handleClosePane operates on hierarchical tree"
- Blocked by "handleAssignTerminalToPane uses hierarchical tree"
- Blocked by "handleCloseWorkspace and handleCloseTerminalPane use hierarchical tree"

### User stories addressed

- User story 14 (layout persists across restarts)
- User story 19 (clean upgrade for legacy-only users)

---

## Issue 13: Remove LegacyWorkspaceFrames and flatLayout prop

**Status:** done

### What to build

Remove the legacy rendering path entirely from `WorkspaceFrames`.

- Remove `LegacyWorkspaceFrames` component and all its internal helpers (`getWorkspaceIds`, `sortWorkspaceLayouts`, `filterTreeByWorkspace` usage).
- Remove the `layout` / `flatLayout` prop from `WorkspaceFrames`, `WorkspaceTileRenderer`, `WorkspaceTileResizableChild`, `WorkspaceTileLeafFrame`.
- Remove the `workspaceOrder` prop from `WorkspaceFrames` and `PanelContent`.
- `WorkspaceTileLeafFrame` no longer needs the `filterTreeByWorkspace` fallback — panel tabs are always present.
- Remove the `layout` prop from `PanelContent`. The `workspaceTileLayout` prop is the sole layout source.
- Update `WorkspaceFrameHeaderContainer` to use `getScopedActivePaneId` based on hierarchical leaf list instead of legacy `getLeafNodes`.

See PRD Module 4: "WorkspaceFrames" and "PanelContent" sections.

### Acceptance criteria

- [ ] `LegacyWorkspaceFrames` component is removed
- [ ] `WorkspaceFrames` does not accept a `layout` (PanelNode) prop
- [ ] `PanelContent` does not accept a `layout` prop or `workspaceOrder` prop
- [ ] `WorkspaceTileLeafFrame` does not accept a `flatLayout` prop
- [ ] `filterTreeByWorkspace` is not called anywhere in workspace-frames
- [ ] `sortWorkspaceLayouts` and `getWorkspaceIds` are not called
- [ ] Workspace frames render correctly from the hierarchical tile layout
- [ ] Workspace frame reorder (drag-and-drop) still works

### Blocked by

- Blocked by "PanelManager renders PanelTreeNode directly"
- Blocked by "Port index.tsx consumers to hierarchical tree"
- Blocked by "Seeding and reconciliation: hierarchical only"

### User stories addressed

- User story 20 (drag-and-drop reorder persists correctly)

---

## Issue 14: Dead code removal

**Status:** open

### What to build

Remove all dead code left over from the legacy tree removal. This is a cleanup pass after all other issues are complete.

- **layout-migration.ts**: Remove `migrateToWindowLayout`, `deriveLegacyTreeFromHierarchical`, `convertPanelTreeToLegacy`, `convertPanelTree`, `collectSidebarFlags`, and all internal helpers. Delete the file if empty.
- **layout-utils.ts**: Remove all functions that are no longer imported anywhere (`splitPane`, `closePane`, `replaceNode`, `computeTerminalPaneAssignment`, `reconcileLayout`, `repairPanelLayoutTree`, `filterTreeByWorkspace`, `findNodeById`, `findLeafByTerminalId`, `findSiblingPaneId`, `findNewLeafAfterSplit`, `getFirstLeafId`, `getStaleTerminalLeaves`, `getTerminalIdsToRemove`, `getWorkspaceTerminalIds`, `closeWorkspacePanes`, `sortWorkspaceLayouts`, `getWorkspaceIds`, `getScopedActivePaneId`, `computeClosePaneGateAction`, `computeCloseWorkspaceAction`, `shouldConfirmClose`, `shouldConfirmCloseWorkspace`, `findPaneInDirection`, `buildPath`, `ensureValidActivePaneId`). Keep functions still used by other code (e.g., `isWorkspaceFrameData`, `WORKSPACE_FRAME_TYPE`).
- **use-panel-layout.ts**: Remove `syncLegacyTreeToHierarchical`, all legacy event imports (`layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`, `layoutWorkspacesReordered`), the `defaultLayout` legacy constant, and `DEFAULT_NEW_WINDOW_LAYOUT`.
- **types.ts**: Deprecate or remove `LeafNode`, `SplitNode`, `PanelNode`, `PanelNodeSchema`, `LeafNodeSchema`, `SplitNodeSchema`, `PanelLayout`, `PanelLayoutSchema` exports if no external consumers exist.
- **Test files**: Remove or update tests that exclusively test legacy functions: `layout-utils.test.ts` (prune dead function tests), `layout-migration.test.ts` (remove if all functions deleted), `use-panel-layout.test.ts` (remove legacy event assertions).
- Remove unused imports across all files.

See PRD Module 7: "Legacy code removal".

### Acceptance criteria

- [ ] No code in the web app imports from `layout-migration.ts` (file can be deleted)
- [ ] `layout-utils.ts` only contains functions that are still actively used
- [ ] No legacy event names (`layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`) are committed anywhere in the app
- [ ] `syncLegacyTreeToHierarchical` is removed
- [ ] `LeafNode`, `SplitNode`, `PanelNode` types are deprecated or removed
- [ ] All tests pass
- [ ] `bun run check` passes (typecheck + format + tests)

### Blocked by

- Blocked by all other issues (1-13)

### User stories addressed

N/A - cleanup issue.
