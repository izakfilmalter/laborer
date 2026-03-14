# Issues: Tabbed Window Layout

Parent PRD: [PRD.md](./PRD.md)

---

## 1. Hierarchical layout types

**Status:** done

### What to build

Define the new TypeScript types and Effect Schema definitions for the hierarchical layout model: `WindowTab`, `WorkspaceTileNode` (leaf + split), `PanelTab`, and the updated `PanelNode` (without sidebar toggle flags). This is types-only — no schema/events/UI changes. The new types coexist alongside the old `PanelNode` types so that migration can reference both.

Key types to introduce:
- `WindowTab`: `{ id, label?, workspaceLayout: WorkspaceTileNode, activePanelTabIds: Record<workspaceId, string>, focusedPaneIds: Record<workspaceId, string> }`
- `WorkspaceTileLeaf`: `{ _tag, id, workspaceId, panelTabs: PanelTab[] }`
- `WorkspaceTileSplit`: `{ _tag, id, direction, children: WorkspaceTileNode[], sizes: number[] }`
- `PanelTab`: `{ id, label?, panelLayout: PanelNode }`
- `WindowLayout`: `{ tabs: WindowTab[], activeTabId: string }`
- Updated `LeafNode`: remove `diffOpen`, `devServerOpen`, `devServerTerminalId` flags

Include Effect Schema definitions with `Schema.suspend` for recursive types, matching the existing pattern for `PanelNodeSchema`.

### Acceptance criteria

- [ ] All new types defined in `packages/shared/src/types.ts` with readonly properties
- [ ] Effect Schema definitions for all new types with proper recursive handling
- [ ] Old `PanelNode` / `LeafNode` / `SplitNode` types preserved (not deleted) for migration compatibility
- [ ] New `LeafNode` variant (or updated type) without sidebar toggle flags
- [ ] Schema round-trip tests: encode -> decode for all new types including deeply nested trees
- [ ] Types compile with no errors (`bun run check` passes)

### Blocked by

None — can start immediately.

### User stories addressed

Foundation for all user stories. No user stories directly demoable.

---

## 2. Layout-utils: window tab operations

**Status:** done

### What to build

Add pure functions to `layout-utils.ts` (or a new companion module) for window tab CRUD operations on the new `WindowLayout` type:

- `addWindowTab(layout, tab?)` — append a new empty window tab, returns updated layout with new tab active
- `removeWindowTab(layout, tabId)` — remove a tab, switch active to nearest sibling
- `switchWindowTab(layout, tabId)` — set active tab
- `switchWindowTabByIndex(layout, index)` — set active tab by position (for Cmd+1-8)
- `switchWindowTabRelative(layout, delta)` — cycle next/previous (for Cmd+Shift+[/])
- `reorderWindowTabs(layout, fromIndex, toIndex)` — drag reorder
- `findWorkspaceLocation(layout, workspaceId)` — find which tab contains a workspace (for sidebar nav)
- `findTerminalLocation(layout, terminalId)` — find tab + workspace + pane for a terminal ID

All functions are pure: input `WindowLayout`, output new `WindowLayout`.

### Acceptance criteria

- [ ] All functions implemented as pure functions with no side effects
- [ ] `addWindowTab` creates an empty tab and makes it active
- [ ] `removeWindowTab` handles: middle tab, first tab, last tab, only tab (returns empty layout)
- [ ] `switchWindowTabByIndex` handles 1-8 mapping and index 9 = last tab
- [ ] `findWorkspaceLocation` searches all tabs' workspace tile trees
- [ ] `findTerminalLocation` searches all tabs > all workspaces > all panel tabs > all pane leaves
- [ ] Unit tests for all functions covering edge cases
- [ ] Tests follow existing `layout-utils.test.ts` patterns (pure input/output)

### Blocked by

- Blocked by "Hierarchical layout types"

### User stories addressed

- User story 1 (multiple workspace arrangements in tabs)
- User story 30 (sidebar terminal navigation)

---

## 3. Layout-utils: workspace tile operations

**Status:** done

### What to build

Add pure functions for workspace tiling within a window tab. These operate on the `WorkspaceTileNode` tree inside a `WindowTab`:

- `addWorkspaceToTab(tab, workspaceId)` — add a workspace as a new tile (leaf) in the tab
- `removeWorkspaceFromTab(tab, workspaceId)` — remove a workspace tile, collapse single-child splits
- `splitWorkspaceTile(tab, workspaceId, direction)` — split a workspace tile to add a new workspace beside it
- `resizeWorkspaceTiles(tab, nodeId, direction, delta)` — adjust sizes between workspace tiles
- `reorderWorkspaceTiles(tab, workspaceOrder)` — drag reorder

These follow the same patterns as the existing `splitPane`/`closePane` but operate on the workspace tile level.

### Acceptance criteria

- [ ] `addWorkspaceToTab` creates a leaf tile or splits the root if workspaces already exist
- [ ] `removeWorkspaceFromTab` collapses parent splits when only one child remains
- [ ] `splitWorkspaceTile` supports both horizontal and vertical directions
- [ ] Same-direction splits flatten (no unnecessary nesting), matching existing panel split behavior
- [ ] `resizeWorkspaceTiles` respects minimum size constraints
- [ ] Unit tests covering: add first workspace, add to existing, remove last, remove middle, split in both directions, resize
- [ ] Tests follow existing `layout-utils.test.ts` patterns

### Blocked by

- Blocked by "Hierarchical layout types"

### User stories addressed

- User story 8 (tile workspaces horizontally and vertically)
- User story 9 (drag-and-drop workspace rearrangement)

---

## 4. Layout-utils: panel tab operations

**Status:** done

### What to build

Add pure functions for panel tab CRUD within a workspace. These operate on the `PanelTab[]` array inside a `WorkspaceTileLeaf`:

- `addPanelTab(workspace, panelType, options?)` — add a new panel tab, returns updated workspace with new tab active
- `removePanelTab(workspace, tabId)` — remove a tab, switch to nearest sibling
- `switchPanelTab(workspace, tabId)` — set active panel tab
- `switchPanelTabByIndex(workspace, index)` — for Ctrl+1-8
- `switchPanelTabRelative(workspace, delta)` — cycle next/previous
- `reorderPanelTabs(workspace, fromIndex, toIndex)` — drag reorder

Panel tabs contain a `PanelNode` split tree (the existing type), so existing split/close/navigate functions continue to work within a tab's content.

### Acceptance criteria

- [ ] `addPanelTab` creates a tab with a single leaf pane of the specified type
- [ ] `removePanelTab` handles: middle, first, last, only tab
- [ ] `switchPanelTabByIndex` handles 1-8 and 9 = last
- [ ] Panel tab operations do not affect other workspaces in the same window tab
- [ ] Unit tests for all functions covering edge cases
- [ ] Tests follow existing patterns

### Blocked by

- Blocked by "Hierarchical layout types"

### User stories addressed

- User story 10 (workspace tab bar for panels)
- User story 12 (Ctrl+T new panel tab)
- User story 15 (Ctrl+1-8 switch panel tabs)
- User story 16 (Ctrl+Shift+[/] cycle panel tabs)

---

## 5. Schema + LiveStore events for new layout model

**Status:** done

### What to build

Update the LiveStore schema to persist the new hierarchical layout:

- Update the `panel_layout` state table: replace `layoutTree` column's schema with the new `WindowLayout` schema, replace `activePaneId` with `activeWindowTabId`, remove `workspaceOrder` (now embedded in tree)
- Add new events: `windowTabCreated`, `windowTabClosed`, `windowTabSwitched`, `windowTabsReordered`, `panelTabCreated`, `panelTabClosed`, `panelTabSwitched`, `panelTabsReordered`
- Keep existing events (`layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored`, `layoutWorkspacesReordered`) with backward-compatible schema changes — they now carry the full `WindowLayout` tree
- All new events use `Schema.optional()` / `Schema.withDefault()` for any fields not present in old events (LiveStore event schema evolution rules)
- Materializers for all new events using the same upsert pattern

### Acceptance criteria

- [ ] `panel_layout` table schema updated with new column types
- [ ] All new events defined with proper Effect Schema definitions
- [ ] Old events remain decodable (backward-compatible schemas)
- [ ] Materializers for all new events follow existing upsert pattern
- [ ] Schema tests: each new event materializes correctly into `panel_layout` table
- [ ] Tests follow existing `schema.test.ts` patterns (Effect-based `makeTestStore`)
- [ ] `bun run check` passes

### Blocked by

- Blocked by "Hierarchical layout types"

### User stories addressed

Foundation for persistence. No user stories directly demoable.

---

## 6. Layout migration: flat PanelNode to hierarchical WindowLayout

**Status:** done

### What to build

Implement the migration path that converts persisted old-format layouts to the new hierarchical format:

- `migrateToWindowLayout(oldTree: PanelNode, activePaneId: string | null, workspaceOrder: string[] | null)` — wraps the old flat tree into a single `WindowTab` by:
  1. Extracting workspace sub-trees using existing `filterTreeByWorkspace()` / `getWorkspaceIds()`
  2. Creating `WorkspaceTileLeaf` nodes for each workspace
  3. Converting each workspace's panel sub-tree into a single `PanelTab`
  4. Migrating sidebar toggle flags: if `diffOpen` is `true` on a leaf, create an additional `PanelTab` of type diff; same for `devServerOpen`
  5. Respecting `workspaceOrder` for tile ordering
  6. Preserving `activePaneId` mapping to the correct `focusedPaneId` in the new structure

- Integration in `use-panel-layout.ts`: detect old-format tree on load, run migration, commit `layoutRestored` with new format

### Acceptance criteria

- [ ] Single-workspace flat tree migrates to one window tab with one workspace tile and one panel tab
- [ ] Multi-workspace flat tree migrates to one window tab with multiple workspace tiles
- [ ] Leaves with `diffOpen: true` produce an additional diff panel tab
- [ ] Leaves with `devServerOpen: true` produce an additional devServer panel tab
- [ ] `activePaneId` is correctly mapped to the new hierarchy's focus state
- [ ] `workspaceOrder` is respected in tile ordering
- [ ] Round-trip test: migrate old layout, verify structure matches expected new layout
- [ ] Integration test: `usePanelLayout` hook detects old format and migrates

### Blocked by

- Blocked by "Hierarchical layout types"
- Blocked by "Layout-utils: window tab operations"
- Blocked by "Schema + LiveStore events for new layout model"

### User stories addressed

- User story 28 (layout persistence — ensures existing users don't lose their layout on upgrade)

---

## 7. Tab bar component

**Status:** done

### What to build

A shared, presentational `TabBar` React component used at both the window tab level and workspace panel tab level. Props-driven, no layout tree knowledge:

- `items: { id, label, icon?, isDirty?, isActive }[]`
- `onSelect(id)`, `onClose(id)`, `onNew()`, `onReorder(fromIndex, toIndex)`
- `autoHide: boolean` — when true and `items.length <= 1`, render nothing
- `newTabTooltip?: string` — tooltip for the + button
- Active tab visual indicator
- Close button on each tab (with optional dirty indicator)
- Drag-and-drop reordering support (using `@atlaskit/pragmatic-drag-and-drop`, matching existing patterns)
- Overflow: scrollable when tabs exceed available width

### Acceptance criteria

- [ ] Renders nothing when `autoHide` is true and there is 0 or 1 item
- [ ] Renders tab bar with all items when 2+ items (or autoHide is false)
- [ ] Active tab is visually distinct
- [ ] Close button on each tab fires `onClose` with correct ID
- [ ] New tab (+) button fires `onNew`
- [ ] Drag-and-drop reordering fires `onReorder` with correct indices
- [ ] Component tests for: auto-hide behavior, rendering items, close/new callbacks
- [ ] Keyboard shortcut hints shown as tooltips on hover
- [ ] Accessible: tab items are keyboard navigable

### Blocked by

None — can start immediately (purely presentational, no data model dependency).

### User stories addressed

- User story 2 (auto-hide window tab bar)
- User story 11 (auto-hide workspace panel tab bar)
- User story 26 (drag-and-drop tab reordering)

---

## 8. Window tab bar integration

**Status:** done

### What to build

Wire the `TabBar` component into the main work area for window-level tabs. Place it in the toggle row (alongside the existing terminal/grid view icons). Connect it to the new `WindowLayout` state via `usePanelLayout`:

- Render `TabBar` with window tabs from the layout state
- `onSelect` -> `switchWindowTab` layout operation
- `onClose` -> `removeWindowTab` layout operation
- `onNew` -> `addWindowTab` layout operation
- Register hotkeys: `Cmd+N` (new tab), `Cmd+Shift+W` (close tab), `Cmd+1-8` (switch by index), `Cmd+Shift+[/]` (cycle)
- Update `terminal-keys.ts` to bypass `Cmd+N`, `Cmd+Shift+W`, `Cmd+Shift+[`, `Cmd+Shift+]` through xterm

### Acceptance criteria

- [ ] Window tab bar renders in the toggle row area alongside existing icons
- [ ] Tab bar auto-hides with 1 tab, shows with 2+ tabs
- [ ] `Cmd+N` creates a new window tab and switches to it
- [ ] `Cmd+Shift+W` closes the active window tab
- [ ] `Cmd+1-8` switches to tab by index, `Cmd+9` switches to last
- [ ] `Cmd+Shift+[` and `Cmd+Shift+]` cycle through tabs
- [ ] All shortcuts work when a terminal has focus (bypass configured)
- [ ] Layout events are committed to LiveStore on each operation
- [ ] Tests: hotkey integration, event commits

### Blocked by

- Blocked by "Tab bar component"
- Blocked by "Layout-utils: window tab operations"
- Blocked by "Schema + LiveStore events for new layout model"

### User stories addressed

- User story 1 (multiple workspace arrangements in tabs)
- User story 2 (auto-hide tab bar)
- User story 3 (Cmd+N new tab)
- User story 5 (Cmd+1-8 switch tabs)
- User story 6 (Cmd+Shift+[/] cycle tabs)
- User story 7 (Cmd+Shift+W close tab)

---

## 9. Workspace bidirectional tiling UI

**Status:** done

### What to build

Update `workspace-frames.tsx` to render workspaces using the new `WorkspaceTileNode` tree (which supports both horizontal and vertical splits) instead of the current vertical-only `ResizablePanelGroup`. This replaces the `filterTreeByWorkspace` + vertical stacking approach with recursive rendering of the workspace tile tree:

- `WorkspaceTileRenderer`: recursive component that renders `WorkspaceTileLeaf` as `WorkspaceFrame` and `WorkspaceTileSplit` as `ResizablePanelGroup` with correct orientation
- Update drag-and-drop to work with the new tree structure
- Each `WorkspaceFrame` now receives its `PanelTab[]` and renders the active tab's `PanelNode` tree via `PanelManager`

### Acceptance criteria

- [ ] Workspaces can tile both horizontally and vertically (not just vertical stacking)
- [ ] Nested splits work (e.g., two workspaces side-by-side, with a third stacked below one of them)
- [ ] Resize handles work between workspace tiles in both directions
- [ ] Workspace frame headers still show branch name, PR badge, and action icons
- [ ] Drag-and-drop workspace reordering works with the new tree
- [ ] Single workspace renders without unnecessary wrappers
- [ ] Fullscreen mode still works (renders only the fullscreened pane's workspace)

### Blocked by

- Blocked by "Layout-utils: workspace tile operations"
- Blocked by "Schema + LiveStore events for new layout model"
- Blocked by "Layout migration: flat PanelNode to hierarchical WindowLayout"

### User stories addressed

- User story 8 (tile workspaces horizontally and vertically)
- User story 9 (drag-and-drop workspace rearrangement)

---

## 10. Panel tab bar integration

**Status:** pending

### What to build

Wire the shared `TabBar` component into each `WorkspaceFrame` for workspace-level panel tabs. Connect it to the panel tab state within each workspace:

- Render `TabBar` in each workspace frame, below the workspace header
- `onSelect` -> `switchPanelTab` for that workspace
- `onClose` -> `removePanelTab` for that workspace
- `onNew` -> triggers panel type picker (issue #12), then `addPanelTab`
- Register hotkeys: `Ctrl+T` (new tab), `Ctrl+1-8` (switch), `Ctrl+Shift+[/]` (cycle)
- Update `terminal-keys.ts` to bypass `Ctrl+T`, `Ctrl+1-8`, `Ctrl+Shift+[/]` through xterm
- Only the active panel tab's `PanelNode` tree is rendered by `PanelManager`

### Acceptance criteria

- [ ] Panel tab bar renders within each workspace frame
- [ ] Auto-hides with 1 panel tab, shows with 2+ tabs
- [ ] `Ctrl+T` creates a new panel tab in the focused workspace (initially shows type picker)
- [ ] `Ctrl+1-8` switches panel tabs within the focused workspace
- [ ] `Ctrl+Shift+[/]` cycles panel tabs
- [ ] Switching panel tabs preserves terminal state (terminal keeps running in background)
- [ ] All shortcuts work when a terminal has focus
- [ ] Layout events committed on each operation

### Blocked by

- Blocked by "Tab bar component"
- Blocked by "Layout-utils: panel tab operations"
- Blocked by "Workspace bidirectional tiling UI"

### User stories addressed

- User story 10 (workspace tab bar for panels)
- User story 11 (auto-hide panel tab bar)
- User story 12 (Ctrl+T new panel tab)
- User story 15 (Ctrl+1-8 switch)
- User story 16 (Ctrl+Shift+[/] cycle)

---

## 11. Panel type picker component

**Status:** pending

### What to build

A lightweight popover/dropdown component that appears when creating a new panel (via split or new tab). Shows a numbered list of available panel types:

1. Terminal (pre-selected)
2. Diff
3. Review
4. Dev Server

Interaction:
- Arrow keys (up/down) to navigate
- Number keys (1-4) to select directly
- Enter to confirm selection
- Escape to cancel
- Mouse click to select

The picker returns the selected panel type to the caller. It does not create the panel itself — the caller uses the result to call `addPanelTab` or `splitPane` with the chosen type.

### Acceptance criteria

- [ ] Renders a compact list with numbered items and icons
- [ ] Terminal is pre-selected (highlighted) on open
- [ ] Arrow keys move highlight up/down with wrapping
- [ ] Number keys 1-4 immediately select and close
- [ ] Enter confirms current highlight
- [ ] Escape closes without selection
- [ ] Returns the selected `paneType` string or null (cancelled)
- [ ] Component tests for all interaction modes
- [ ] Keyboard focus is trapped within picker while open

### Blocked by

None — can start immediately (purely presentational).

### User stories addressed

- User story 13 (panel type picker with numbered options)
- User story 14 (terminal pre-selected)

---

## 12. Promote diff to first-class panel type

**Status:** pending

### What to build

Make diff a standalone panel type that can be opened in any panel tab or split, rather than a sidebar toggle on a terminal pane:

- Update `PaneContent` dispatch in `panel-manager.tsx` to render `DiffPane` directly for `paneType: 'diff'` leaves (not just as a sidebar within `TerminalPaneWithSidebars`)
- When creating a diff panel (via type picker or `Ctrl+B, D`), default to right-side placement: if splitting, default to horizontal split (split right)
- Remove the `toggleDiffPane` action from `PanelActions` — replace with creating a diff panel tab or split
- Update `Ctrl+B, D` to create a new diff panel (split right) instead of toggling a sidebar
- Update the `DiffPane` component to work standalone (ensure it gets the workspace context it needs without being a child of `TerminalPaneWithSidebars`)

### Acceptance criteria

- [ ] Diff renders correctly as a standalone pane (not inside TerminalPaneWithSidebars)
- [ ] Diff pane receives correct workspace context for showing relevant diffs
- [ ] `Ctrl+B, D` creates a new diff panel in a right-side split
- [ ] Diff appears as option #2 in the panel type picker
- [ ] Selecting diff from picker in a new tab creates a diff tab
- [ ] Selecting diff from picker in a split creates a diff split pane
- [ ] Old layouts with `diffOpen: true` are migrated (handled by migration issue)

### Blocked by

- Blocked by "Panel type picker component"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 24 (first-class panel types)
- User story 25 (diff defaults to right-side)
- User story 34 (Ctrl+B, D creates panel instead of toggling)

---

## 13. Promote review to first-class panel type

**Status:** pending

### What to build

Make review a standalone panel type, same pattern as diff promotion:

- `PaneContent` already renders `ReviewPane` for `paneType: 'review'` — verify it works correctly in the new tab/split context
- Remove `toggleReviewPane` from `PanelActions` — replace with creating a review panel tab or split
- Update `Ctrl+B, R` to create a new review panel (split right) instead of toggling
- Ensure `ReviewPane` works standalone with correct workspace context

### Acceptance criteria

- [ ] Review renders correctly as a standalone pane in tabs and splits
- [ ] `Ctrl+B, R` creates a new review panel in a right-side split
- [ ] Review appears as option #3 in the panel type picker
- [ ] ReviewPane receives correct workspace context
- [ ] Old layouts with review panes continue to work

### Blocked by

- Blocked by "Panel type picker component"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 24 (first-class panel types)
- User story 34 (Ctrl+B, R creates panel instead of toggling)

---

## 14. Promote dev server terminal to first-class panel type

**Status:** pending

### What to build

Make dev server terminal a standalone panel type:

- Update `PaneContent` to render `DevServerTerminalPane` correctly as a standalone pane (not just within `TerminalPaneWithSidebars`)
- Remove `toggleDevServerPane` from `PanelActions` — replace with creating a devServer panel tab or split
- Update `Ctrl+B, S` to create a new dev server panel instead of toggling
- Handle the dev server terminal lifecycle: starting/attaching to the dev server process when the pane is created
- Remove `devServerTerminalId` from `LeafNode` — the terminal ID is managed by the pane itself

### Acceptance criteria

- [ ] Dev server terminal renders correctly as a standalone pane
- [ ] Dev server terminal starts/attaches correctly when pane is created
- [ ] `Ctrl+B, S` creates a new dev server terminal panel
- [ ] Dev server appears as option #4 in the panel type picker
- [ ] Old layouts with `devServerOpen: true` are migrated (handled by migration issue)
- [ ] Closing the dev server pane handles terminal cleanup

### Blocked by

- Blocked by "Panel type picker component"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 24 (first-class panel types)
- User story 34 (Ctrl+B, S creates panel instead of toggling)

---

## 15. Wire panel type picker into split + new tab flows

**Status:** pending

### What to build

Connect the panel type picker to all panel creation entry points:

- `Cmd+D` (split right): show picker, then split with chosen type
- `Cmd+Shift+D` (split down): show picker, then split with chosen type
- `Ctrl+T` (new tab): show picker, then create tab with chosen type
- `Ctrl+B, H` (split right fallback): show picker
- `Ctrl+B, V` (split down fallback): show picker
- Panel tab bar "+" button: show picker

The picker appears as a small popover anchored to the active pane (for splits) or the tab bar (for new tab). Terminal is pre-selected so Enter immediately creates a terminal.

### Acceptance criteria

- [ ] `Cmd+D` shows picker, selecting terminal creates a terminal split right
- [ ] `Cmd+Shift+D` shows picker, selecting terminal creates a terminal split down
- [ ] `Ctrl+T` shows picker, selecting any type creates that panel tab
- [ ] Pressing Enter immediately (terminal pre-selected) creates terminal with no extra interaction
- [ ] Pressing a number key selects that type and creates immediately
- [ ] Escape cancels without creating anything
- [ ] Tab bar "+" button shows picker
- [ ] `Ctrl+B, H` and `Ctrl+B, V` also show picker

### Blocked by

- Blocked by "Panel type picker component"
- Blocked by "Promote diff to first-class panel type"
- Blocked by "Promote review to first-class panel type"
- Blocked by "Promote dev server terminal to first-class panel type"

### User stories addressed

- User story 13 (picker on split/new tab)
- User story 14 (terminal pre-selected)
- User story 17 (Cmd+D / Cmd+Shift+D with picker)

---

## 16. cmux-style keybindings: pane navigation + zoom

**Status:** pending

### What to build

Add the cmux-style direct keyboard shortcuts for pane navigation and zoom, alongside the existing `Ctrl+B` fallback:

- `Cmd+Option+Left/Right/Up/Down` — navigate between panes directionally
- `Cmd+Shift+Enter` — toggle pane zoom/fullscreen (already exists, verify it works in new hierarchy)
- `Cmd+B` — toggle sidebar (already exists, verify no conflicts)
- Update `terminal-keys.ts` bypass for `Cmd+Option+Arrow` combinations

The existing `Ctrl+B, Arrow` navigation continues to work as fallback.

### Acceptance criteria

- [ ] `Cmd+Option+Left` moves focus to the pane on the left
- [ ] `Cmd+Option+Right` moves focus to the pane on the right
- [ ] `Cmd+Option+Up` moves focus to the pane above
- [ ] `Cmd+Option+Down` moves focus to the pane below
- [ ] Navigation works within panel splits AND across workspace tiles
- [ ] `Cmd+Shift+Enter` toggles zoom for the active pane in the new hierarchy
- [ ] All shortcuts work when terminal has focus
- [ ] `Ctrl+B, Arrow` fallback continues to work
- [ ] Tests for terminal bypass and shortcut registration

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 20 (Cmd+Option+Arrow navigation)
- User story 22 (Cmd+Shift+Enter zoom)
- User story 23 (Cmd+B sidebar toggle)
- User story 32 (Ctrl+B fallback preserved)
- User story 33 (Ctrl+B Arrow fallback)

---

## 17. Progressive Cmd+W close logic

**Status:** pending

### What to build

Implement the progressive close behavior for `Cmd+W`:

1. If active pane has content -> close the pane (existing behavior)
2. If active pane is empty (last pane was closed) -> close the panel tab
3. If panel tab was the last tab -> close the workspace from the window tab (show empty workspace state)
4. If workspace was the last workspace -> show empty window tab state
5. If window tab is empty -> close the window tab
6. If window tab was the last -> do nothing (or show close-app dialog)

Close confirmation dialogs must work at each level: if closing a tab/workspace/window tab would close terminals with running processes, show confirmation.

### Acceptance criteria

- [ ] `Cmd+W` on a pane with content closes that pane
- [ ] `Cmd+W` on an empty panel tab closes the tab
- [ ] `Cmd+W` on the last panel tab in a workspace shows empty workspace state
- [ ] `Cmd+W` on an empty workspace closes it from the window tab
- [ ] `Cmd+W` on an empty window tab closes the window tab
- [ ] `Cmd+W` on the last window tab shows close-app dialog (or does nothing)
- [ ] Close confirmation appears when closing would kill running terminal processes
- [ ] `Ctrl+B, X` follows the same progressive close logic
- [ ] Tests for the full close chain at each level

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 18 (Cmd+W close pane)
- User story 19 (progressive close on empty containers)
- User story 36 (last pane -> empty state -> close tab)
- User story 37 (last tab -> empty workspace -> close workspace)
- User story 38 (last workspace -> empty window tab -> close window tab)

---

## 18. Empty state: window tab with workspace picker

**Status:** pending

### What to build

An empty state component shown when a window tab has no workspaces. Displays:

- A "New Workspace" primary action button that triggers the sidebar workspace creation flow
- A list/picker of existing workspaces that aren't currently open in any tab
- Keyboard navigation: Tab to move between options, Enter to select
- Selecting a workspace adds it to the current window tab

The workspace picker filters out workspaces already open in other tabs (workspace uniqueness constraint).

### Acceptance criteria

- [ ] Empty state renders when a window tab has no workspace tiles
- [ ] "New Workspace" button triggers the sidebar creation flow
- [ ] Existing workspaces listed with project name and branch
- [ ] Workspaces already open in other tabs are excluded from the list
- [ ] Selecting a workspace adds it to the current tab and renders it
- [ ] Keyboard navigable (Tab, arrow keys, Enter)
- [ ] Visually clear with helpful text explaining the state

### Blocked by

- Blocked by "Window tab bar integration"

### User stories addressed

- User story 4 (empty tab workspace picker)
- User story 31 (workspace uniqueness)

---

## 19. Empty state: workspace and panel tab

**Status:** pending

### What to build

Empty state components for:

1. **Empty panel tab**: shown when all panes in a panel tab have been closed. Displays a CTA to add a panel (triggers type picker) with keyboard shortcut hints.

2. **Empty workspace**: shown when all panel tabs in a workspace have been closed. Displays a CTA to add a panel tab with shortcut hints.

Both states should be visually consistent with the window tab empty state.

### Acceptance criteria

- [ ] Empty panel tab state renders when last pane is closed
- [ ] CTA button opens the panel type picker
- [ ] Keyboard shortcut hints displayed (Ctrl+T, Cmd+D)
- [ ] Empty workspace state renders when last panel tab is closed
- [ ] CTA for adding a panel tab in the empty workspace
- [ ] Both states are visually consistent with the window tab empty state
- [ ] `Cmd+W` on these states progresses the close chain (handled by progressive close issue)

### Blocked by

- Blocked by "Panel tab bar integration"
- Blocked by "Panel type picker component"

### User stories addressed

- User story 36 (empty state after last pane closed)
- User story 37 (empty workspace state)

---

## 20. Sidebar navigation to terminal across tabs

**Status:** pending

### What to build

When clicking a terminal entry in the sidebar, navigate to the correct location in the tab hierarchy:

1. Use `findTerminalLocation(layout, terminalId)` to locate the tab + workspace + panel tab + pane
2. If the terminal is in a different Electron window, focus that window first (via IPC)
3. Switch to the correct window tab (if not already active)
4. Switch to the correct panel tab within the workspace (if not already active)
5. Focus the pane containing the terminal

Also update the sidebar highlight: the workspace entry corresponding to the currently focused workspace should be visually highlighted, regardless of tab depth.

### Acceptance criteria

- [ ] Clicking a terminal in the sidebar navigates to its exact location
- [ ] Correct window tab is activated
- [ ] Correct panel tab within the workspace is activated
- [ ] The terminal pane receives focus
- [ ] Cross-window navigation works (focuses the correct Electron window)
- [ ] Sidebar highlights the workspace matching the currently focused workspace
- [ ] If the terminal's workspace is minimized, it is expanded
- [ ] Tests for `findTerminalLocation` cross-tab lookup

### Blocked by

- Blocked by "Layout-utils: window tab operations" (for `findTerminalLocation`)
- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 30 (sidebar terminal navigation)

---

## 21. Session persistence for hierarchical layout

**Status:** pending

### What to build

Update the session persistence layer to serialize and deserialize the new hierarchical `WindowLayout` format:

- `usePanelLayout` hook: update the save path to commit the full `WindowLayout` tree
- Restore: detect whether persisted data is old (flat `PanelNode`) or new (`WindowLayout`) format, run migration if old
- Reconciliation: extend `reconcileLayout` and `repairPanelLayoutTree` to walk the new hierarchy (window tabs > workspace tiles > panel tabs > panel splits)
- Ensure `isReconciling` state blocks rendering during the reconciliation of all tabs
- Handle edge case: persisted layout references a workspace that was destroyed while the app was closed

### Acceptance criteria

- [ ] New hierarchical layout saves correctly to LiveStore
- [ ] App restart restores exact layout: window tabs, workspace tiles, panel tabs, splits
- [ ] Active tab/pane state restored at each level
- [ ] Old-format layouts are detected and migrated on first load (via migration issue)
- [ ] Stale terminal IDs are reconciled (respawned) across all tabs
- [ ] Stale workspace references are cleaned up with appropriate empty states
- [ ] Multi-window: each Electron window restores its own layout independently
- [ ] Tests: round-trip serialization, reconciliation with stale data

### Blocked by

- Blocked by "Layout migration: flat PanelNode to hierarchical WindowLayout"
- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 28 (layout persistence)
- User story 29 (multi-window persistence)

---

## 22. Workspace uniqueness enforcement

**Status:** pending

### What to build

Enforce the constraint that a workspace can only be open in one window tab at a time, across all Electron windows:

- When adding a workspace to a tab, check all tabs in the current window AND query other windows' layouts via LiveStore
- If the workspace is already open elsewhere, remove it from the old location before adding to the new one
- Provide a `moveWorkspace(layout, workspaceId, targetTabId)` function for explicitly moving workspaces between tabs
- Cross-window move: when moving a workspace from window A to window B, coordinate via LiveStore events

### Acceptance criteria

- [ ] Adding a workspace already open in another tab removes it from the old tab
- [ ] Adding a workspace already open in another window removes it from the old window
- [ ] `moveWorkspace` function moves a workspace between tabs within the same window
- [ ] Cross-window workspace moves update both windows' layouts atomically (via LiveStore)
- [ ] No duplicate workspace views can exist at any point
- [ ] Tests for uniqueness enforcement across tabs and windows

### Blocked by

- Blocked by "Session persistence for hierarchical layout"

### User stories addressed

- User story 31 (workspace uniqueness)
- User story 35 (move workspace between windows)

---

## 23. Tab drag-and-drop reordering

**Status:** pending

### What to build

Enable drag-and-drop reordering for both window tabs and panel tabs using `@atlaskit/pragmatic-drag-and-drop` (matching existing workspace drag-and-drop patterns):

- Window tab bar: drag tabs to reorder, fire `reorderWindowTabs` layout operation
- Panel tab bar: drag tabs to reorder within a workspace, fire `reorderPanelTabs` layout operation
- Visual feedback during drag (drop indicator between tabs)
- Tab items need drag handles (the tab itself is the handle)

### Acceptance criteria

- [ ] Window tabs can be dragged to reorder
- [ ] Panel tabs within a workspace can be dragged to reorder
- [ ] Drop indicator shows between tabs during drag
- [ ] Reorder persists to LiveStore
- [ ] Drag does not interfere with tab click-to-select
- [ ] Works with both mouse and trackpad

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- User story 26 (drag-and-drop tab reordering)

---

## 24. Polish: tab bar animations and transitions

**Status:** pending

### What to build

Add smooth animations for tab bar appearance/disappearance:

- When going from 1 tab to 2 tabs, the tab bar slides/fades in
- When going from 2 tabs to 1 tab, the tab bar slides/fades out
- Tab close animations (tab shrinks out, siblings expand)
- New tab animation (tab expands in)

### Acceptance criteria

- [ ] Tab bar animates in when going from 1 to 2+ tabs
- [ ] Tab bar animates out when going from 2 to 1 tab
- [ ] Individual tab add/remove animations are smooth
- [ ] Animations don't cause layout shift or jank
- [ ] Animations respect `prefers-reduced-motion` media query

### Blocked by

- Blocked by "Tab bar component"

### User stories addressed

- Polishing requirement 1 (tab bar transitions)

---

## 25. Polish: focus consistency

**Status:** pending

### What to build

Audit and fix focus behavior across all layout operations:

- After splitting: focus lands on the new pane
- After closing a pane: focus moves to nearest sibling
- After switching window tabs: last-focused pane in that tab receives focus
- After switching panel tabs: last-focused pane in that tab receives focus
- After workspace tile changes: focus preserved or moved to sensible default
- Terminal focus: when switching to a tab with a terminal, the terminal gets keyboard focus immediately (no click required)

### Acceptance criteria

- [ ] Every layout operation leaves focus in a predictable, sensible location
- [ ] Terminal panes receive immediate keyboard focus on tab switch
- [ ] No "focus limbo" states where no pane has focus
- [ ] Focus state is persisted per-tab (each tab remembers its last focus)
- [ ] Audit results documented — each operation tested manually

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- Polishing requirement 2 (focus consistency)
- Polishing requirement 6 (terminal focus preservation)

---

## 26. Polish: visual indicators and keyboard discoverability

**Status:** pending

### What to build

Visual refinements:

- Active window tab has a clear visual indicator (underline, background color, or border)
- Active panel tab has a clear visual indicator
- Focused pane within a split has a distinct border/highlight
- Sidebar highlights the workspace matching the currently focused workspace
- Tab bar "+" button and tab close buttons show tooltips with keyboard shortcuts
- Panel type picker shows shortcut numbers clearly

### Acceptance criteria

- [ ] Active tab indicators are visible and consistent at both levels
- [ ] Focused pane border/highlight is distinct from unfocused panes
- [ ] Sidebar workspace highlight matches focused workspace
- [ ] Tooltips show correct shortcuts on hover
- [ ] Panel type picker numbers are prominent

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- Polishing requirement 3 (keyboard discoverability)
- Polishing requirement 9 (visual active indicators)
- Polishing requirement 11 (sidebar highlight)

---

## 27. Polish: tab overflow and performance

**Status:** pending

### What to build

Handle edge cases for many tabs and ensure performance:

- Tab overflow: when tabs exceed available width, make the tab bar horizontally scrollable or show a dropdown to access hidden tabs
- Performance: only the active window tab's content should be fully rendered. Background tabs keep terminals alive but can suspend React rendering.
- Measure and optimize window tab switch time to be near-instant

### Acceptance criteria

- [ ] Tab bar scrolls or shows overflow indicator when many tabs exist
- [ ] All tabs remain accessible via keyboard shortcuts even when visually overflowed
- [ ] Switching window tabs is near-instant (< 100ms perceived)
- [ ] Background tab terminals continue running
- [ ] Memory usage does not grow linearly with number of background tabs

### Blocked by

- Blocked by "Window tab bar integration"
- Blocked by "Panel tab bar integration"

### User stories addressed

- Polishing requirement 7 (tab overflow)
- Polishing requirement 12 (performance)

---

## 28. Polish: close confirmation and error handling

**Status:** pending

### What to build

Ensure close confirmation and error handling work at all hierarchy levels:

- Close confirmation dialogs appear when closing a tab/workspace/window tab that contains terminals with running processes
- Stale layout repair: when restoring a layout with invalid references, gracefully show empty states instead of crashing
- Error boundaries around tab content to isolate failures

### Acceptance criteria

- [ ] Close confirmation dialog appears when closing a panel tab with running processes
- [ ] Close confirmation dialog appears when closing a workspace with running processes
- [ ] Close confirmation dialog appears when closing a window tab with running processes
- [ ] `Cmd+Enter` confirms destructive close (existing pattern preserved)
- [ ] Stale layout references produce empty states, not crashes
- [ ] Error in one tab's content does not crash other tabs

### Blocked by

- Blocked by "Progressive Cmd+W close logic"
- Blocked by "Session persistence for hierarchical layout"

### User stories addressed

- Polishing requirement 8 (stale layout handling)
- Polishing requirement 10 (consistent close confirmation)

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Hierarchical layout types | None | done |
| 2 | Layout-utils: window tab operations | 1 | done |
| 3 | Layout-utils: workspace tile operations | 1 | done |
| 4 | Layout-utils: panel tab operations | 1 | done |
| 5 | Schema + LiveStore events for new layout model | 1 | done |
| 6 | Layout migration: flat PanelNode to hierarchical WindowLayout | 1, 2, 5 | done |
| 7 | Tab bar component | None | done |
| 8 | Window tab bar integration | 7, 2, 5 | done |
| 9 | Workspace bidirectional tiling UI | 3, 5, 6 | done |
| 10 | Panel tab bar integration | 7, 4, 9 | pending |
| 11 | Panel type picker component | None | pending |
| 12 | Promote diff to first-class panel type | 11, 10 | pending |
| 13 | Promote review to first-class panel type | 11, 10 | pending |
| 14 | Promote dev server terminal to first-class panel type | 11, 10 | pending |
| 15 | Wire panel type picker into split + new tab flows | 11, 12, 13, 14 | pending |
| 16 | cmux-style keybindings: pane navigation + zoom | 8, 10 | pending |
| 17 | Progressive Cmd+W close logic | 8, 10 | pending |
| 18 | Empty state: window tab with workspace picker | 8 | pending |
| 19 | Empty state: workspace and panel tab | 10, 11 | pending |
| 20 | Sidebar navigation to terminal across tabs | 2, 8, 10 | pending |
| 21 | Session persistence for hierarchical layout | 6, 8, 10 | pending |
| 22 | Workspace uniqueness enforcement | 21 | pending |
| 23 | Tab drag-and-drop reordering | 8, 10 | pending |
| 24 | Polish: tab bar animations and transitions | 7 | pending |
| 25 | Polish: focus consistency | 8, 10 | pending |
| 26 | Polish: visual indicators and keyboard discoverability | 8, 10 | pending |
| 27 | Polish: tab overflow and performance | 8, 10 | pending |
| 28 | Polish: close confirmation and error handling | 17, 21 | pending |
