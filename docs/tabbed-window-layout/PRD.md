# PRD: Tabbed Window Layout

## Problem Statement

The current layout model forces a rigid vertical stacking of workspace frames in the main work area. Each workspace occupies a vertical slice, and panels within a workspace are limited to splits with sidebar-toggled sub-panes (diff, review, dev server). There is no way to group multiple workspace arrangements into switchable views, tile workspaces horizontally, or manage panels as independent tabs within a workspace. Users who work across multiple workspaces simultaneously lack the flexibility to organize their screen real estate effectively — they cannot, for example, place two workspaces side-by-side, maintain separate "contexts" in tabs they can switch between, or quickly promote a diff view into its own tabbed panel.

## Solution

Introduce a hierarchical tabbed layout system inspired by cmux's window model, adapted to laborer's workspace-centric architecture. The hierarchy is:

```
Window Tab  >  Workspace Tiles  >  Panel Tabs  >  Panel Splits
```

1. **Window Tabs**: The main work area (right of sidebar) gains a tab bar. Each window tab contains an independent arrangement of workspaces. The tab bar auto-hides when there is only one tab. Workspaces are unique — a workspace can only be open in one window tab at a time across all Electron windows.

2. **Workspace Tiles**: Within a window tab, workspaces tile in both horizontal and vertical directions (not just vertical as today). Each workspace frame has its own header bar showing branch name, PR badge, and workspace actions.

3. **Panel Tabs**: Within each workspace frame, panels are organized as tabs. The workspace-level tab bar auto-hides when there is only one panel tab. Each panel tab represents a single panel type (terminal, diff, review, dev server terminal).

4. **Panel Splits**: Panel tabs can be split horizontally and vertically, creating a tiled arrangement of panels within a single tab. This preserves the existing split functionality but scopes it within a tab.

5. **First-Class Panel Types**: Diff, review, and dev server terminal are promoted from sidebar toggles to independent panel types. When creating a new panel (via split or new tab), a type picker appears with numbered options for quick selection.

6. **cmux-Style Keybindings**: Direct `Cmd+key` shortcuts for all common operations, with the existing `Ctrl+B` prefix system retained as a fallback. `Cmd+number` switches window tabs, `Ctrl+number` switches panel tabs within the focused workspace.

7. **Sidebar Integration**: Clicking a terminal in the sidebar navigates to the window tab and workspace containing that terminal, focusing it. The sidebar remains unchanged in structure — it lists projects and workspaces (worktrees) and is not coupled to what is shown in the work area.

## User Stories

1. As a developer, I want to open multiple workspace arrangements in separate window tabs, so that I can maintain different contexts (e.g., "feature work" vs "code review") and switch between them instantly.

2. As a developer, I want the window tab bar to auto-hide when I only have one tab, so that screen space is not wasted on chrome I don't need.

3. As a developer, I want to create a new empty window tab with `Cmd+N`, so that I can set up a fresh workspace arrangement without disturbing my current one.

4. As a developer, I want the empty window tab to show a workspace picker with a "New Workspace" option and a list of existing workspaces, so that I can quickly populate the tab with the workspace I need.

5. As a developer, I want to switch between window tabs using `Cmd+1` through `Cmd+8` (and `Cmd+9` for the last tab), so that I can navigate tabs as fast as I switch browser tabs.

6. As a developer, I want to cycle through window tabs with `Cmd+Shift+[` and `Cmd+Shift+]`, so that I can move sequentially through my tabs without memorizing their positions.

7. As a developer, I want to close a window tab with `Cmd+Shift+W`, so that I can clean up contexts I no longer need.

8. As a developer, I want to tile workspaces both horizontally and vertically within a window tab, so that I can place a frontend workspace beside a backend workspace instead of only stacking them vertically.

9. As a developer, I want to drag-and-drop workspace frames to rearrange their tiling order and direction within a window tab, so that I can organize my layout visually.

10. As a developer, I want each workspace frame to have its own tab bar for panels, so that I can keep multiple panels (terminal, diff, review) in the same workspace and switch between them.

11. As a developer, I want the workspace panel tab bar to auto-hide when there is only one panel tab, so that single-panel workspaces stay clean and spacious.

12. As a developer, I want to create a new panel tab in the focused workspace with `Ctrl+T`, so that I can add panels without splitting.

13. As a developer, I want a panel type picker to appear when creating a new tab or split, showing numbered options (1: Terminal, 2: Diff, 3: Review, 4: Dev Server), so that I can quickly select the panel type I need by pressing the corresponding number key or arrow-keying and pressing Enter.

14. As a developer, I want the terminal option to be pre-selected in the panel type picker, so that I can press Enter immediately if I just want another terminal.

15. As a developer, I want to switch between panel tabs in the focused workspace using `Ctrl+1` through `Ctrl+8` (and `Ctrl+9` for last), so that I can quickly jump to a specific panel.

16. As a developer, I want to cycle through panel tabs with `Ctrl+Shift+[` and `Ctrl+Shift+]`, so that I can move sequentially through panels.

17. As a developer, I want to split the active panel right with `Cmd+D` and down with `Cmd+Shift+D` (showing the type picker), so that I can tile panels within a tab using familiar shortcuts.

18. As a developer, I want to close the active pane with `Cmd+W`, so that cleanup is a single keystroke.

19. As a developer, I want `Cmd+W` on an empty workspace tab to close that tab, and `Cmd+W` on an empty window tab to close that window tab, so that successive presses of the same key progressively clean up empty containers.

20. As a developer, I want to navigate between panes (splits) using `Cmd+Option+Arrow` keys, so that I can move focus directionally without reaching for the mouse.

21. As a developer, I want to resize panes using `Ctrl+B` then `Shift+Arrow`, so that I can adjust split proportions from the keyboard.

22. As a developer, I want to toggle pane zoom/fullscreen with `Cmd+Shift+Enter`, so that I can temporarily maximize a pane to see more content.

23. As a developer, I want to toggle the sidebar with `Cmd+B`, so that I can reclaim horizontal space when I don't need the project tree.

24. As a developer, I want to use diff, review, and dev server as first-class panel types that I can open in any tab or split, so that I am not limited to toggling them as sidebars on a terminal pane.

25. As a developer, I want diff panels to default to right-side alignment when created, so that they follow the conventional layout without manual adjustment.

26. As a developer, I want to drag-and-drop tabs to reorder them within a tab bar (both window tabs and workspace panel tabs), so that I can organize my tabs spatially.

27. As a developer, I want to drag a panel tab from one workspace's tab bar to another workspace (or into a split), so that I can rearrange panels across workspaces.

28. As a developer, I want my entire layout — window tabs, workspace tiling, panel tabs, and splits — to persist when I quit and reopen the app, so that I resume exactly where I left off.

29. As a developer, I want layout persistence to work across multiple Electron windows, so that my multi-window setup is restored on app restart.

30. As a developer, I want clicking a terminal entry in the sidebar to navigate to the correct window tab and workspace containing that terminal and focus it, so that the sidebar remains a reliable navigation tool regardless of my tab structure.

31. As a developer, I want a workspace to only be openable in one window tab at a time (across all Electron windows), so that I don't accidentally create conflicting views of the same workspace state.

32. As a developer, I want the existing `Ctrl+B` prefix sequences to continue working as a fallback alongside the new `Cmd+key` shortcuts, so that my muscle memory is not broken.

33. As a developer, I want directional pane navigation (`Ctrl+B` then Arrow) to continue working as a fallback alongside `Cmd+Option+Arrow`, so that both styles are supported.

34. As a developer, I want the `Ctrl+B` prefix sequences for diff (`D`), review (`R`), and dev server (`S`) toggles to open those panel types in a new split or tab instead of toggling a sidebar, so that they align with the new first-class panel model.

35. As a developer working in multiple Electron windows, I want to move a workspace from one window's tab to another window's tab, so that I can reorganize across monitors.

36. As a developer, I want closing the last pane in a panel tab to show an empty state, and pressing `Cmd+W` again to close the tab, so that closing is progressive and I don't accidentally lose my tab structure.

37. As a developer, I want closing the last panel tab in a workspace to show an empty workspace state, and pressing `Cmd+W` again to close the workspace from the window tab, so that cleanup is predictable.

38. As a developer, I want closing the last workspace in a window tab to show an empty window tab state, and pressing `Cmd+W` again to close the window tab, so that I always have a chance to undo before losing context.

## 'Polishing' Requirements

1. **Tab bar transitions**: Tab bars should animate smoothly when appearing/disappearing as tabs are added/removed past the auto-hide threshold (1 tab).

2. **Focus consistency**: After any layout operation (split, close, tab switch, workspace switch), focus should land on a sensible target — the new pane, the nearest sibling, or the workspace's last-focused panel.

3. **Keyboard shortcut discoverability**: The panel type picker should clearly show the keyboard number alongside each option. Tab bars should show tooltips with their keyboard shortcut on hover.

4. **Empty state quality**: Empty states (window tab, workspace, panel tab) should be visually clear and inviting, with obvious CTAs and keyboard shortcut hints.

5. **Resize handle consistency**: Split dividers should behave identically whether between workspaces or between panels — same drag handle width, same visual feedback, same minimum size constraints.

6. **Terminal focus preservation**: When switching tabs (window or panel level), the terminal that was focused in the destination tab should immediately receive keyboard focus without requiring a click.

7. **Tab overflow**: When many tabs exist and the tab bar overflows, provide a scrollable tab bar or a dropdown to access hidden tabs.

8. **Error handling for stale layout**: When restoring a persisted layout that references workspaces or terminals that no longer exist, gracefully clean up invalid references and show appropriate empty states.

9. **Visual active indicators**: The active window tab, workspace frame, and panel tab should all have clear visual indicators. The focused pane within a split should have a distinct border or highlight.

10. **Consistent close confirmation**: Close confirmation dialogs (for terminals with running processes) should work correctly at all hierarchy levels — closing a pane, closing a tab, closing a workspace, and closing a window tab.

11. **Sidebar highlight**: The sidebar workspace entry corresponding to the currently focused workspace should remain visually highlighted regardless of the tab structure depth.

12. **Performance**: Switching window tabs should be near-instant. Only the active window tab's content should be fully rendered; background tabs should be kept alive (terminals continue running) but can have their rendering suspended.

## Implementation Decisions

### Data Model Changes

The layout tree model shifts from a single flat tree per window to a three-level hierarchy:

**Level 1 — Window Tabs**: An ordered list of window tab objects, each containing a workspace layout tree. One tab is marked as active per Electron window.

**Level 2 — Workspace Tiles**: Within each window tab, a recursive split tree (like today) where leaf nodes represent workspace frames. Each leaf references a workspace ID. Tiling supports both horizontal and vertical splits. Each workspace leaf also contains its panel layout.

**Level 3 — Panel Tabs + Splits**: Within each workspace frame, an ordered list of panel tabs. Each panel tab contains a recursive split tree where leaf nodes are individual panels (terminal, diff, review, devServer). One tab is marked active per workspace. One pane is marked focused per tab.

The `LeafNode` type loses its `diffOpen`, `devServerOpen`, `devServerTerminalId` flags. Instead, diff and dev server become independent panel types created as separate leaf nodes in the panel split tree.

### Schema / LiveStore Changes

The `panel_layout` state table schema changes to store the new hierarchical model:

- `windowId` remains the primary key
- `layoutTree` JSON column changes from `PanelNode` to a new schema representing the array of window tabs, each containing a workspace tile tree and nested panel tab/split trees
- `activePaneId` is replaced by a more granular focus model: `activeWindowTabId`, plus per-workspace `activePanelTabId` and `focusedPaneId` stored within the tree structure
- `workspaceOrder` is subsumed into the workspace tile tree structure

New LiveStore events are needed:
- `windowTabCreated`, `windowTabClosed`, `windowTabSwitched`, `windowTabsReordered`
- `panelTabCreated`, `panelTabClosed`, `panelTabSwitched`, `panelTabsReordered`
- The existing `layoutSplit`, `layoutPaneClosed`, `layoutPaneAssigned`, `layoutRestored` events continue but carry the full new tree structure

Old events must remain decodable (backward-compatible) per LiveStore's event schema evolution rules. The materializer for `panel_layout` handles migration: if the persisted `layoutTree` is in the old flat format, it is automatically wrapped into a single window tab with workspaces extracted as before.

### Layout Tree Manipulation Module

The existing `layout-utils.ts` (pure functions) is refactored into a deeper module with clear separation:

- **Window tab operations**: add, remove, reorder, switch active tab
- **Workspace tile operations**: add workspace to tab, remove workspace, split workspace tile, resize workspace tiles
- **Panel tab operations**: add, remove, reorder, switch active panel tab within a workspace
- **Panel split operations**: split pane, close pane, resize, navigate directionally (largely the existing logic, scoped within a panel tab)
- **Cross-cutting operations**: find workspace by ID across all tabs/windows, move workspace between tabs, find terminal location for sidebar navigation, ensure focus invariants

All functions remain pure (input tree, output new tree). The module's public interface is a set of named operations, each returning a new tree plus any side-effect descriptors (e.g., "focus this pane", "scroll sidebar to this workspace").

### Tab Bar Component

A single shared `TabBar` component is used for both window-level and workspace-level tabs. Props control:
- Auto-hide behavior (hidden when tab count is 1)
- Tab items (label, icon, close button, active state, dirty indicator)
- Drag-and-drop reordering
- New tab button (+)
- Keyboard shortcut hints

The component is purely presentational — it receives items and callbacks, with no knowledge of the layout tree.

### Panel Type Picker Component

A lightweight popover component that appears when `Cmd+D`, `Cmd+Shift+D`, or `Ctrl+T` is pressed. It shows:
1. Terminal (pre-selected)
2. Diff
3. Review
4. Dev Server

Arrow keys navigate, number keys select directly, Enter confirms, Escape cancels. The picker is context-aware: if opened from a workspace that has a diff or dev server already associated, those options can show relevant context.

### Keybinding System

Primary cmux-style shortcuts are registered via the existing TanStack Hotkeys mechanism. The `Ctrl+B` prefix system is preserved alongside. Terminal key bypass (`terminal-keys.ts`) is updated to also pass through the new `Cmd+key` combos (`Cmd+N`, `Cmd+Shift+W`, `Cmd+Shift+[/]`, `Cmd+Option+Arrow`, etc.).

`Ctrl+Shift+[/]` for panel tab cycling requires special handling in the terminal bypass layer since these involve modifier keys that terminals may interpret.

### Session Persistence

The session persistence layer (which saves/restores layout on quit/relaunch) is updated to serialize and deserialize the new hierarchical tree format. The persisted format includes:
- All window tabs with their workspace tile trees
- All panel tabs within each workspace with their split trees
- Active tab/pane state at each level
- Window-to-tab mapping for multi-window support

On restore, workspaces and terminals that no longer exist are cleaned up gracefully (the existing `reconcileLayout` and `repairPanelLayoutTree` patterns are extended to the new hierarchy).

### Sidebar Navigation

When clicking a terminal entry in the sidebar:
1. Find which window tab and workspace contains that terminal (cross-cutting lookup)
2. Switch to that window tab
3. Switch to the panel tab containing that terminal
4. Focus the pane containing that terminal
5. If the workspace is in a different Electron window, focus that window first

### Multi-Window Coordination

Since workspaces are unique (one tab at a time), the workspace-to-window-tab mapping must be coordinated across Electron windows. This uses the existing LiveStore sync mechanism — the `panel_layout` table is per-window (`windowId` primary key), and the workspace uniqueness constraint is enforced when assigning a workspace to a tab (if already open in another window, it is removed from the old location first).

## Testing Decisions

A good test in this codebase tests external behavior through the public interface of a module, not implementation details. Tests should assert what the user or consumer of the module sees, not how the internals are structured.

### Modules to Test

**1. Layout tree manipulation functions (highest priority)**
These are pure functions with clear inputs and outputs, making them ideal for unit testing. Test coverage should include:
- Window tab CRUD (add, remove, reorder, switch)
- Workspace tile operations (add, remove, split horizontally/vertically, resize)
- Panel tab CRUD within workspaces (add, remove, reorder, switch)
- Panel split operations (split, close, navigate directionally, resize)
- Cross-cutting lookups (find workspace across tabs, find terminal location)
- Edge cases: closing last pane/tab/workspace at each level, workspace uniqueness enforcement
- Migration: converting old flat layout tree to new hierarchical format
- Repair/reconciliation: handling stale workspace and terminal references
- Focus invariants: active pane is always a valid leaf after any operation

**2. Tab bar component**
Test rendering behavior: auto-hide with 1 tab, show with 2+ tabs, active tab indicator, new tab button, close button callbacks. Use the existing component testing patterns in the codebase.

**3. Keybinding integration**
Test that keyboard shortcuts trigger the correct layout operations. Focus on the terminal bypass layer to ensure shortcuts pass through xterm.js correctly.

**4. Session persistence round-trip**
Test that the new hierarchical layout serializes and deserializes correctly, and that old-format layouts are migrated properly on deserialization.

### Prior Art

The existing tests for `layout-utils.ts` provide the pattern for testing pure layout tree functions. The same approach (construct a tree, apply an operation, assert the result) extends naturally to the new hierarchy.

## Out of Scope

- **Customizable keybindings UI**: Users cannot remap shortcuts through a settings interface. This is a follow-up feature.
- **New panel types (browser, markdown)**: Only the four existing panel types (terminal, diff, review, dev server) are supported. New types can be added later by extending the panel type picker.
- **Command palette (`Cmd+Shift+P`)**: A searchable command palette for all actions is not part of this PRD.
- **Tab pinning**: The ability to pin tabs (prevent accidental close, sort to left) is a follow-up.
- **Cross-pane tab dragging (panel tabs between workspaces)**: Drag-and-drop of panel tabs between different workspace frames is a follow-up. Within a workspace, tab reordering is supported.
- **Workspace creation from inside the work area**: The workspace picker in empty window tabs allows selecting existing workspaces and has a "New Workspace" button, but the full workspace creation flow (project selection, branch naming, etc.) remains in the sidebar. The "New Workspace" button navigates to/triggers the sidebar's creation flow.

## Further Notes

### Terminology

To avoid confusion with cmux's terminology (where "Tab" = "Workspace"):
- **Window Tab**: A top-level tab in the work area's tab bar. Contains an arrangement of workspaces.
- **Workspace**: A git worktree + container + terminals. Unchanged from current meaning.
- **Panel Tab**: A tab within a workspace's tab bar. Contains a panel type or a split of panels.
- **Pane**: A leaf node in a split tree — the actual visible content area displaying a panel.
- **Panel**: The content type (terminal, diff, review, dev server terminal).

### Migration Path

The old flat `PanelNode` layout tree format must continue to deserialize correctly. On first load after upgrade:
1. The old tree is wrapped in a single window tab
2. Workspace sub-trees are extracted as today (via `filterTreeByWorkspace`)
3. Each workspace's panels become a single panel tab containing the existing split tree
4. Sidebar toggle flags (`diffOpen`, `devServerOpen`) are migrated: if `true`, a new panel tab is created for that panel type

This ensures zero data loss on upgrade and maintains backward compatibility with the append-only LiveStore eventlog.

### Keybinding Reference

| Category | Shortcut | Action |
|----------|----------|--------|
| **Window Tabs** | `Cmd+N` | New window tab |
| | `Cmd+1` - `Cmd+8` | Switch to window tab 1-8 |
| | `Cmd+9` | Switch to last window tab |
| | `Cmd+Shift+[` | Previous window tab |
| | `Cmd+Shift+]` | Next window tab |
| | `Cmd+Shift+W` | Close window tab |
| **Panel Tabs** | `Ctrl+T` | New panel tab (shows type picker) |
| | `Ctrl+1` - `Ctrl+8` | Switch to panel tab 1-8 |
| | `Ctrl+9` | Switch to last panel tab |
| | `Ctrl+Shift+[` | Previous panel tab |
| | `Ctrl+Shift+]` | Next panel tab |
| **Splits** | `Cmd+D` | Split right (shows type picker) |
| | `Cmd+Shift+D` | Split down (shows type picker) |
| | `Cmd+W` | Close active pane (progressive) |
| | `Cmd+Option+Arrow` | Navigate between panes |
| | `Cmd+Shift+Enter` | Toggle pane zoom/fullscreen |
| **Resize** | `Ctrl+B`, `Shift+Arrow` | Resize active pane |
| **Sidebar** | `Cmd+B` | Toggle sidebar |
| **Fallback (Ctrl+B prefix)** | `Ctrl+B`, `H` | Split right |
| | `Ctrl+B`, `V` | Split down |
| | `Ctrl+B`, `X` | Close pane |
| | `Ctrl+B`, `Arrow` | Navigate panes |
| | `Ctrl+B`, `Z` | Toggle pane zoom |
| | `Ctrl+B`, `O` | Cycle focus to next pane |
| | `Ctrl+B`, `P` | Cycle focus to previous pane |
| | `Ctrl+B`, `D` | New diff panel (split/tab) |
| | `Ctrl+B`, `R` | New review panel (split/tab) |
| | `Ctrl+B`, `S` | New dev server panel (split/tab) |
