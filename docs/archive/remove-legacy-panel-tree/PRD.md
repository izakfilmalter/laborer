# PRD: Remove Legacy Panel Layout Tree (DB Nuke)

## Problem Statement

The panel layout system maintains two parallel representations of the same data: a legacy flat `PanelNode` tree (`LeafNode | SplitNode`) and a hierarchical `WindowLayout` tree (`WindowTab > WorkspaceTileNode > PanelTab > PanelTreeNode`). Every mutation must commit both a legacy event and a hierarchical event, with a `syncLegacyTreeToHierarchical` bridge function translating between them. This dual-write pattern:

1. **Causes focus bugs** -- `handleSetActivePaneId` validates pane IDs against the stale legacy tree. Since hierarchical pane IDs don't exist in the legacy tree, focus silently falls back to a wrong pane, breaking the focus border and keyboard input.
2. **Doubles mutation complexity** -- every split, close, assign-terminal, and close-workspace operation must mutate the legacy tree, commit a legacy event, sync to the hierarchical tree, and commit a second event.
3. **Creates divergence risk** -- the two trees drift out of sync (the root cause of the focus bug), and debugging requires understanding both representations.
4. **Blocks new features** -- panel tabs, dev server as a panel type, and progressive close all had to be implemented in the hierarchical tree while maintaining backward compatibility with the legacy tree.
5. **Inflates code size** -- `use-panel-layout.ts` is ~2000 lines, with roughly half dedicated to legacy tree manipulation and the dual-write bridge.
6. **Redundant schema** -- 5 legacy events, 3 unused hierarchical events, and 3 deprecated columns exist in the LiveStore schema. All 10+ hierarchical events share identical payloads and materializers but are defined separately.
7. **Duplicate utility functions** -- nearly every tree operation exists in two copies: one for `PanelNode` in `layout-utils.ts` and one for `PanelTreeNode` in `window-tab-utils.ts`.
8. **520 lines of manual repair code** -- `repairWindowLayout` and 12+ helper functions do field-by-field validation that could be replaced by Effect Schema decode with defaults.
9. **Confusing type names** -- `PanelLeafNode`, `PanelSplitNode`, `PanelTreeNode` have a "Panel" prefix solely to disambiguate from the legacy `LeafNode`, `SplitNode`, `PanelNode`.

## Solution

Nuke the database and remove the legacy `PanelNode` tree entirely. Make the hierarchical `WindowLayout` the single source of truth. Simultaneously simplify the hierarchical system itself:

- **Delete all legacy code**: types, schemas, events, materializers, utility functions, migration functions, bridge functions. No backward compatibility needed since the DB is wiped.
- **Consolidate events**: Replace 13+ hierarchical events with a single `windowLayoutUpdated` event carrying an optional `reason` string for debugging.
- **Simplify the schema**: The `panelLayout` table becomes two columns: `windowId` (PK) and `windowLayout` (JSON). Drop `layoutTree`, `activePaneId`, `workspaceOrder`, and `activeWindowTabId`.
- **Rename types**: `PanelTreeNode` becomes `PanelNode`, `PanelLeafNode` becomes `LeafNode`, `PanelSplitNode` becomes `SplitNode`. The legacy names are freed by deleting the legacy types.
- **Replace repair code**: Replace the 520-line manual repair system with Effect Schema decode using defaults/transformations.
- **Reorganize utility files**: Consolidate into 3 files by tree level -- `window-layout-utils.ts` (top-level WindowLayout ops), `workspace-tile-utils.ts` (tile tree ops), `panel-tree-utils.ts` (panel split tree ops). Deduplicate `getWorkspaceTileLeaves` and inline trivial wrappers.
- **Simplify focus tracking**: Remove the legacy `activePaneId` column. Focus is derived exclusively from the 3-level hierarchical model (`WindowLayout.activeTabId` > `WorkspaceTileLeaf.activePanelTabId` > `PanelTab.focusedPaneId`). The global `activePaneId` is computed at read time via `resolveActivePaneForWindowTab`.
- **All mutation handlers operate directly on `WindowLayout`**: No more dual-write, no more sync bridge, no more derived legacy tree.
- **TDD approach**: Every module is built using red-green-refactor vertical slices. Tests verify behavior through public interfaces, not implementation details.

## User Stories

1. As a developer, I want clicking a panel to immediately show the focus border on that panel, so that I know which panel has keyboard focus.
2. As a developer, I want focus to follow me when I switch between workspace frames, so that keyboard input goes to the correct terminal.
3. As a developer, I want keyboard shortcuts (Cmd+D to split, Cmd+W to close, Ctrl+B then arrows to navigate) to operate correctly on the panel I'm focused on.
4. As a developer, I want panel tab switches to restore focus to the last-focused pane of the destination tab, so that I can resume typing immediately.
5. As a developer, I want window tab switches to restore focus to the destination tab's last-focused pane, so that switching contexts is seamless.
6. As a developer, I want splitting a pane to focus the new pane and auto-spawn a terminal in it, so that I can start working immediately.
7. As a developer, I want closing a pane to transfer focus to its sibling, so that I never lose keyboard focus after closing.
8. As a developer, I want the sidebar's active workspace highlight to track the workspace I'm working in based on which panel is focused.
9. As a developer, I want the dev server toggle to open a dedicated panel tab, consistent with how other pane types work.
10. As a developer, I want directional navigation (Ctrl+B then arrow keys) to work correctly across all panes within a workspace's active panel tab.
11. As a developer, I want pane cycling (o/p keys) to cycle through all visible panes in the active window tab.
12. As a developer, I want pane resize (Shift+arrow keys) to adjust the correct split based on the tree structure.
13. As a developer, I want the close confirmation dialog to appear when I try to close a pane or workspace with running processes.
14. As a developer, I want the layout to persist correctly across app restarts -- stale terminal IDs should be reconciled and new terminals spawned.
15. As a developer, I want assigning a terminal from the sidebar to find or create the right pane in the layout.
16. As a developer, I want fullscreen pane mode to detect when the fullscreened pane no longer exists in the layout.
18. As a developer, I want notification clicks to navigate to the correct workspace and focus the right pane.
19. As a developer, I want a clean fresh tab when starting the app after a DB nuke, so that I can start working immediately.
20. As a developer, I want drag-and-drop reordering of workspace frames to persist correctly.
21. As a developer, I want the codebase to be simpler to understand -- one tree representation, one event type, clear file organization by tree level.
22. As a developer, I want the progressive close chain (Cmd+W) to work: close pane, close panel tab, close workspace, close window tab, close app.
23. As a developer, I want layout repair on startup to use Effect Schema decode rather than 500+ lines of manual field validation.

## 'Polishing' Requirements

- Verify that the focus border (`border-primary` ring) reliably tracks the active panel across all interaction methods: mouse click, keyboard navigation, tab switches, pane splits, pane closes.
- Verify that keyboard shortcuts chain correctly: split then type, close then type, navigate then type -- focus should always be on the correct terminal.
- Verify that the sidebar's active workspace highlight updates in real-time as the user clicks between panels.
- Verify that the app starts cleanly from a cold state (no persisted layout) and from a warm state (persisted layout with stale terminal IDs).
- Verify that removing a workspace from the sidebar correctly closes all its panes and transfers focus to a remaining workspace.
- Verify that the progressive close chain works in order.
- Verify that fullscreen mode enters and exits cleanly, restoring the pane to its original position.
- Verify that the dev server toggle creates and removes panel tabs correctly.
- Ensure no `console.warn` or `console.error` messages related to stale pane IDs, missing nodes, or layout failures during normal operation.
- Verify the empty pane CTA still works for newly created empty panes.
- Confirm that `bun run check` passes (typecheck + format + tests) with zero regressions.

## Implementation Decisions

### Module 1: Rename types and delete legacy type definitions

Delete the legacy types (`LeafNode`, `SplitNode`, `PanelNode`, `PanelLayout`) and their Effect Schemas from `types.ts`. Rename the hierarchical types to take the freed names:

- `PanelLeafNode` -> `LeafNode`
- `PanelSplitNode` -> `SplitNode`
- `PanelTreeNode` -> `PanelNode`

Keep `PanelTab`, `WorkspaceTileLeaf`, `WorkspaceTileSplit`, `WorkspaceTileNode`, `WindowTab`, `WindowLayout` unchanged -- they have no legacy collision.

Update all imports and references across the codebase. This is a mechanical find-and-replace.

### Module 2: Schema -- single event, minimal table

Replace the `panelLayout` state table with two columns: `windowId` (text, PK) and `windowLayout` (JSON `WindowLayout`). Drop `layoutTree`, `activePaneId`, `workspaceOrder`, and `activeWindowTabId`.

Delete all 5 legacy event definitions and their materializers (`layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`, `layoutWorkspacesReordered`).

Delete all 13 hierarchical event definitions and replace with a single event:

```
windowLayoutUpdated: { windowId: string, windowLayout: WindowLayout, reason?: string }
```

The materializer is a single upsert: `panelLayout.insert({ windowId, windowLayout }).onConflict('windowId', 'update', { windowLayout })`.

### Module 3: Reorganize utility files into 3 modules by tree level

Consolidate the scattered utility functions into three files organized by the tree level they operate on:

- **`panel-tree-utils.ts`** -- Pure functions operating on `PanelNode` (the split tree within a single panel tab): split, close, find leaf, find sibling, collect terminal IDs, get leaf IDs, find pane in direction, compute resize.
- **`workspace-tile-utils.ts`** -- Pure functions operating on `WorkspaceTileNode` (the tile tree within a window tab): add/remove workspace, reorder tiles, get tile leaves, find workspace by pane ID.
- **`window-layout-utils.ts`** -- Pure functions operating on `WindowLayout` (the top-level structure): add/remove/switch/rename/reorder window tabs, find terminal location across all tabs, resolve active pane, save focused pane ID, assign terminal, close terminal, remove workspace, reconcile stale terminals, progressive close logic.

Deduplicate `getWorkspaceTileLeaves` (currently defined in both `window-tab-utils.ts` and `workspace-tile-utils.ts`) to a single definition in `workspace-tile-utils.ts`. Inline trivial wrappers like `addWorkspaceToTabUnique` (a one-liner around `moveWorkspace`).

### Module 4: Replace repair code with Effect Schema decode

Replace the 520-line `repairWindowLayout` function and its 12+ helpers with an Effect Schema decode pipeline. Define the `WindowLayout` schema with `Schema.withDefault(...)` and `Schema.optional(...)` annotations that automatically produce valid defaults for missing or malformed fields. A single `Schema.decodeUnknown(WindowLayoutSchema)` call replaces all manual validation.

### Module 5: PanelManager renders `PanelNode` directly

Update the `PanelManager` rendering pipeline to accept the renamed `PanelNode` (`LeafNode | SplitNode`) directly. Since the legacy types are deleted and the hierarchical types are renamed to `LeafNode`/`SplitNode`, the `PanelRenderer` dispatches on `'LeafNode'` and `'SplitNode'` tags.

Remove `convertPanelTreeToLegacy` from `WorkspaceTileLeafFrame` -- pass the `PanelNode` from the active panel tab directly. Remove the `filterTreeByWorkspace` fallback for pre-migration tiles.

### Module 6: All mutation handlers operate on `WindowLayout` directly

Rewrite every mutation handler in `use-panel-layout.ts` to operate directly on the hierarchical `WindowLayout`:

- **`handleSplitPane`**: Use `splitPane` (renamed from `splitPaneInPanelTree`) on the active panel tab's `PanelNode`. Commit `windowLayoutUpdated` with `reason: 'split'`.
- **`handleClosePane`**: Use `closePane` (renamed from `closePaneInPanelTree`). Transfer focus to sibling. Commit `windowLayoutUpdated` with `reason: 'pane-closed'`.
- **`handleSetActivePaneId`**: Use `saveFocusedPaneId` on the hierarchical tree. Commit `windowLayoutUpdated` with `reason: 'focus-changed'`.
- **`handleAssignTerminalToPane`**: Use `assignTerminal` (renamed from `assignTerminalInPanelTree`). Commit `windowLayoutUpdated` with `reason: 'terminal-assigned'`.
- **`handleCloseWorkspace`**: Use `removeWorkspaceFromLayout`. Commit `windowLayoutUpdated` with `reason: 'workspace-closed'`.
- **`handleCloseTerminalPane`**: Use `closeTerminalInWindowLayout` as the sole path.
- **`handleResizePane`**: Rewrite `computeResize` to walk `PanelNode` (the renamed type). Same algorithm, tags are now `'LeafNode'`/`'SplitNode'`.
- **`handleToggleDevServerPane`**: Create/remove a `devServerTerminal` panel tab. No sidebar flags.

Delete `syncLegacyTreeToHierarchical`, `deriveLegacyTreeFromHierarchical`, all legacy event commits, and the `defaultLayout` legacy constant.

### Module 7: Port all consumers to hierarchical tree

Port every consumer of the derived legacy `layout` to use `WindowLayout`:

- **`PanelHotkeys`**: Directional navigation walks `PanelNode` (renamed type). Pane cycling uses `getLeafIds` (renamed from `getPanelTreeLeafIds`). No legacy `layout` prop.
- **`WorkspaceFrames`**: Remove `LegacyWorkspaceFrames`, `flatLayout` prop, `workspaceOrder` prop. The hierarchical tile renderer is the sole path.
- **`WorkspaceFrameHeaderContainer`**: `getScopedActivePaneId` uses hierarchical leaf list.
- **`PanelContent`**: Remove `layout` prop. `workspaceTileLayout` is the sole layout source.

### Module 8: Seeding and reconciliation -- hierarchical only

Simplify seeding to create a `WindowLayout` directly from initial terminal/workspace state. No more `migrateToWindowLayout`. Remove `repairPanelLayoutTree` (replaced by Schema decode in Module 4). Simplify `collectStaleLeaves` to only use hierarchical stale-terminal detection. Simplify reconciliation commits to a single `windowLayoutUpdated` event. Rewrite `useInitialLayout` to return data that directly seeds a `WindowLayout`.

### Module 9: Dead code removal

Final cleanup pass after all modules are complete:

- Delete `layout-migration.ts` entirely.
- Delete all unused functions from `layout-utils.ts`. If nothing remains, delete the file.
- Remove all legacy type exports from `types.ts`.
- Remove or update tests that exclusively test deleted functions.
- Run `bun run check` to verify zero regressions.

## Testing Decisions

Every module is built using **TDD with vertical slices** (red-green-refactor). Tests are written one at a time before implementation, following the tracer bullet approach: write one failing test, make it pass with minimal code, repeat. Never write all tests first then all implementation.

### What makes a good test

Tests verify **behavior through public interfaces**, not implementation details. A good test:
- Calls the public function with inputs and asserts on outputs
- Survives internal refactors (renaming internal helpers, restructuring code)
- Reads like a specification of what the system does
- Uses real modules -- no mocking of internal collaborators

The only things to mock are **system boundaries**: LiveStore commits, terminal spawning, React hooks that read from the store. Internal pure functions are never mocked.

### Modules to test with TDD

**`panel-tree-utils.ts`** (Module 3) -- All pure functions that operate on the `PanelNode` split tree. These are the core algorithms: split, close, find sibling, directional navigation, resize computation, leaf collection, terminal ID collection. Test each function through its public interface with deterministic fixture layouts. Prior art: `window-tab-utils.test.ts` and `panel-tab-utils.test.ts` patterns (local factory functions, `describe` blocks per function, `expect().toEqual()` structural assertions).

**`workspace-tile-utils.ts`** (Module 3) -- Pure functions for the tile tree. Add/remove workspace, reorder, get leaves, find workspace by pane. Prior art: existing `workspace-tile-utils.test.ts`.

**`window-layout-utils.ts`** (Module 3) -- Pure functions for the top-level layout. Window tab CRUD, terminal location search, focus resolution, terminal assignment, workspace removal, progressive close, reconciliation. Prior art: existing `window-tab-utils.test.ts`.

**Schema materializer** (Module 2) -- Verify that `windowLayoutUpdated` materializes correctly using a real in-memory LiveStore. Prior art: `schema.test.ts` in `packages/shared` (Effect vitest integration, real LiveStore adapter).

**Schema decode repair** (Module 4) -- Verify that malformed/partial `WindowLayout` JSON decodes to a valid layout with correct defaults. Pure decode tests, no mocking.

**PanelManager rendering** (Module 5) -- Verify that the renamed types render correctly. Prior art: existing `panel-manager.test.tsx` (component rendering with `@testing-library/react`).

**`use-panel-layout.ts` handlers** (Module 6) -- Verify that each mutation handler produces the correct `WindowLayout` state. Since the hook reads from LiveStore, these tests use mock stores (existing pattern in `use-panel-layout.test.ts`). Focus on: split creates new pane, close transfers focus, assign terminal updates pane, workspace close removes all panes.

### Modules NOT tested (low value)

- The type rename (Module 1) is mechanical find-and-replace verified by `tsc`.
- Dead code removal (Module 9) is verified by `tsc` and `bun run check`.
- Consumer porting (Module 7) is verified by existing integration tests and manual testing.

### Test file organization

Each utility module gets a co-located test file:
- `test/panel-tree-utils.test.ts`
- `test/workspace-tile-utils.test.ts`
- `test/window-layout-utils.test.ts`

Existing test files for the old module names (`window-tab-utils.test.ts`, `panel-tab-utils.test.ts`) are migrated into the new test files. Tests for deleted legacy functions (`layout-utils.test.ts`, `layout-migration.test.ts`) are removed.

## Out of Scope

- **Multi-window focus coordination** -- Each Electron window has its own `WindowLayout` with independent focus tracking. No changes to cross-window behavior.
- **Drag-and-drop pane rearrangement** -- Per-pane drag-and-drop between workspaces is not in scope. Workspace frame drag-and-drop already works on the tile tree.
- **Custom panel tab labels** -- Panel tabs derive labels from their pane type. Custom labels are not in scope.
- **New layout features** -- This PRD is purely about removal and simplification. No new layout capabilities are added.
- **Porting `findPaneInDirection` algorithm** -- This is a mechanical tag-name translation since the tree structure is identical. No new spatial navigation algorithm is needed.

## Further Notes

- The DB nuke means zero backward compatibility constraints. Legacy event definitions, deprecated columns, migration paths, and no-op materializers are all unnecessary.
- The renamed `PanelNode` (formerly `PanelTreeNode`) and the deleted `PanelNode` (legacy) are structurally identical except for tag names and the absence of sidebar flags. Many functions can be ported by changing tag name checks.
- The `computeResize` function uses `buildPath` and `computeResizeFromPath` which walk the split tree using tag checks. These are updated to check `'SplitNode'` (the new tag, formerly `'PanelSplitNode'`).
- The single `windowLayoutUpdated` event with a `reason` field provides the same auditability as 13 separate events while eliminating schema bloat. The `reason` field is optional and purely for debugging.
- The 3-file utility organization (`panel-tree-utils`, `workspace-tile-utils`, `window-layout-utils`) mirrors the 3 levels of the layout tree, making it obvious where to find or add functionality.
- `getWorkspaceTileLeaves` is currently duplicated across two files. It belongs in `workspace-tile-utils.ts` since it operates on the tile tree level.
- All TDD work follows vertical slices: one test, one implementation, repeat. Never horizontal (all tests first, then all implementation).
