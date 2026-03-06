# Sidebar Project-Grouped Layout — Issues

---

## Issue 168: ProjectGroup collapsible headings with nested workspaces

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Replace the flat sidebar layout (separate Projects section + Workspaces section) with a project-grouped tree structure. Each project becomes a collapsible heading (chevron + project name) with its workspaces nested directly underneath.

The HomeComponent sidebar assembly changes from rendering `<ProjectList>` and `<WorkspaceList>` as sibling sections to iterating over projects and rendering a `<ProjectGroup>` per project. Each ProjectGroup contains a collapsible heading and an embedded WorkspaceList scoped to that project.

WorkspaceList gains a required `projectId` prop and renders only workspaces for that project (replacing the optional `activeProjectId` filter). WorkspaceItem cards drop the project name `CardDescription` since the project context is provided by the parent heading.

Collapse/expand state is stored in React state as a `Record<string, boolean>` mapping project IDs to expanded/collapsed. Initialized from localStorage on mount (default: all expanded). Persisted to localStorage on every change via `useEffect`.

The ProjectSwitcher dropdown and Tasks section remain temporarily (addressed in later issues). The old `ProjectList` component (flat card list) is replaced by the project heading rendering inside `ProjectGroup`.

### Acceptance criteria

- [ ] Each project renders as a collapsible heading with a chevron toggle and the project name displayed prominently
- [ ] Clicking the chevron collapses/expands the project's children
- [ ] Workspaces for each project are listed directly under their project heading
- [ ] WorkspaceList accepts a required `projectId` prop and only renders workspaces for that project
- [ ] Workspace cards no longer show the project name as a CardDescription
- [ ] Projects with no workspaces still appear as headings
- [ ] Collapse state persists across page reloads via localStorage
- [ ] All projects default to expanded on first visit (no localStorage state)
- [ ] Project settings and delete actions remain accessible from the project heading
- [ ] The old flat Projects and Workspaces sections are removed
- [ ] Chevron rotation animation is smooth on expand/collapse

### Blocked by

None - can start immediately

### User stories addressed

- User story 1, 2, 3, 5, 6, 13, 15, 16, 17

---

## Issue 169: Per-project "+" button and CreateWorkspaceForm pre-selection

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Add a "+" button to each project heading (next to the chevron and project name) that opens the CreateWorkspaceForm dialog with the project pre-selected.

CreateWorkspaceForm gains an optional `defaultProjectId` prop. When provided, the project select field initializes to that project. The user can still change the project selection in the dialog if needed.

The "+" button should have a tooltip ("Create Workspace") and a clear hover state. It sits at the right end of the project heading row.

### Acceptance criteria

- [ ] Each project heading has a "+" button at the right side
- [ ] Clicking "+" opens the CreateWorkspaceForm dialog
- [ ] The dialog's project select field is pre-populated with the parent project
- [ ] The user can still change the project selection in the dialog
- [ ] The "+" button has a tooltip ("Create Workspace")
- [ ] The "+" button has a visible hover state
- [ ] CreateWorkspaceForm accepts an optional `defaultProjectId` prop

### Blocked by

- Blocked by #168

### User stories addressed

- User story 4, 18

---

## Issue 170: Tasks nested under each project

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Move tasks from the flat bottom section of the sidebar into each ProjectGroup as a sub-section below the project's workspaces.

Each project gets its own TaskSourcePicker + TaskList, scoped to that project's ID. The task source state (`activeTaskSource`) changes from a single global value to a per-project `Record<string, TaskSourceFilter>`, so each project can independently have Manual/Linear/GitHub selected.

TaskSourcePicker and TaskList already accept `activeProjectId` props — these become required `projectId` props since tasks are always rendered within a specific project context. The "Workspaces" and "Tasks" sub-sections within each ProjectGroup are visually separated (e.g., a subtle divider or sub-heading).

The old standalone Tasks section in the sidebar is removed.

### Acceptance criteria

- [ ] Each project group has a "Tasks" sub-section below its workspaces
- [ ] TaskSourcePicker renders within each project group, scoped to that project
- [ ] TaskList renders within each project group, scoped to that project
- [ ] Task source selection (Manual/Linear/GitHub) is independent per project
- [ ] Tasks and workspaces are visually separated within each project group
- [ ] The old standalone Tasks section is removed from the sidebar
- [ ] Task import (Linear/GitHub sync) works correctly when scoped to a project
- [ ] Empty task states render correctly per project

### Blocked by

- Blocked by #168

### User stories addressed

- User story 7, 8

---

## Issue 171: Replace ProjectSwitcher with search bar

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Remove the ProjectSwitcher dropdown and replace it with a search input at the top of the sidebar. The search bar filters the project-grouped tree in real-time as the user types.

Create a new `SidebarSearch` component — a text input with a search icon and a clear button (X icon) that appears when text is entered. The search query state lives at the sidebar level in HomeComponent.

Filter logic: when the query is non-empty, show a project if its name matches (case-insensitive substring) OR if any of its workspace branch names match. Auto-expand collapsed projects that contain matches (overriding the localStorage collapse state). When the search is cleared, restore the previous collapse state.

The Add Project button remains at the top of the sidebar, above or alongside the search bar.

### Acceptance criteria

- [ ] ProjectSwitcher dropdown is removed
- [ ] A search input appears at the top of the sidebar
- [ ] Typing filters the sidebar tree in real-time — only matching projects/workspaces are shown
- [ ] Matching is case-insensitive and substring-based
- [ ] Projects are shown if their name matches OR if any child workspace branch name matches
- [ ] Collapsed projects that contain matches are auto-expanded during search
- [ ] Clearing the search restores the full sidebar and previous collapse state
- [ ] The search bar has a clear/reset button (X icon) when text is entered
- [ ] An empty search query shows all projects and workspaces
- [ ] Add Project button remains accessible at the top of the sidebar

### Blocked by

- Blocked by #168

### User stories addressed

- User story 9, 10, 11, 14

---

## Issue 172: Server Status sticky footer

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Extract the Server Status section from inside the ScrollArea and render it as a sticky footer at the bottom of the sidebar panel, always visible regardless of scroll position.

The sidebar panel structure changes from `ScrollArea > [all sections including Server Status]` to `ScrollArea > [project groups] + Footer > [Server Status]`. The footer sits below the ScrollArea within the ResizablePanel, pinned to the bottom.

### Acceptance criteria

- [ ] Server Status is visible at the bottom of the sidebar without scrolling
- [ ] Server Status does not scroll with the rest of the sidebar content
- [ ] The footer does not overlap with the bottom of the scrollable content
- [ ] The footer styling is visually consistent with the current Server Status section
- [ ] The sidebar retains its current resizable behavior and responsive sizing

### Blocked by

- Blocked by #168

### User stories addressed

- User story 12

---

## Issue 174: Persist sidebar width in localStorage

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

Persist the sidebar panel width to localStorage so it survives page reloads. Currently the sidebar resets to its default width on every reload.

Read the stored width on mount and pass it as the `defaultSize` to the sidebar `ResizablePanel`. Listen for the `onResize` callback from `react-resizable-panels` and persist the new width to localStorage (debounced to avoid excessive writes during drag). If no stored value exists, fall back to the current default from `useResponsiveLayout`.

### Acceptance criteria

- [ ] Sidebar width persists across page reloads
- [ ] On first visit (no stored value), the sidebar uses the existing responsive default
- [ ] Dragging the resize handle updates the stored width
- [ ] Writes to localStorage are debounced during drag resize
- [ ] The stored width is clamped to current min/max bounds on restore (handles viewport size changes between sessions)
- [ ] Collapsing the sidebar does not persist 0% as the width (restoring should use the last non-collapsed width)

### Blocked by

None - can start immediately

### User stories addressed

- User story 3 (persist state across reloads)

---

## Issue 173: Sidebar project-grouped layout — polish and verification

### Parent PRD

PRD-sidebar-project-grouped.md

### What to build

End-to-end verification and polish pass for the full sidebar restructure. Verify all polishing requirements from the PRD across the complete integration.

### Acceptance criteria

- [ ] Consistent indentation and visual hierarchy between project headings, workspace cards, and task sub-sections
- [ ] Chevron rotation animation on expand/collapse is smooth and responsive
- [ ] Search bar handles edge cases: partial matches, case-insensitive, matches on both project names and workspace branch names
- [ ] Auto-expansion during search feels natural; clearing search restores previous collapse state
- [ ] Sticky footer for Server Status doesn't overlap with scrollable content
- [ ] Keyboard navigation works: Tab through project headings, Enter to expand/collapse
- [ ] Removing project name from workspace cards doesn't leave awkward empty space
- [ ] "+" button on project headings has clear hover state and tooltip
- [ ] Search bar clear button works correctly
- [ ] Sidebar retains current resizable behavior and responsive sizing
- [ ] No visual regressions for workspace cards, task lists, or project actions

### Blocked by

- Blocked by #168, #169, #170, #171, #172, #174

### User stories addressed

- All polishing requirements

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 168 | ProjectGroup collapsible headings with nested workspaces | None | Done |
| 169 | Per-project "+" button and CreateWorkspaceForm pre-selection | #168 | Ready |
| 170 | Tasks nested under each project | #168 | Ready |
| 171 | Replace ProjectSwitcher with search bar | #168 | Ready |
| 172 | Server Status sticky footer | #168 | Done |
| 173 | Sidebar project-grouped layout — polish and verification | #168, #169, #170, #171, #172, #174 | Blocked |
| 174 | Persist sidebar width in localStorage | None | Ready |
