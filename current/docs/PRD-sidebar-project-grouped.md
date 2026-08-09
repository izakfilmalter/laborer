# PRD: Sidebar Project-Grouped Layout

## Problem Statement

The current sidebar has a flat layout with three separate top-level sections: Projects, Workspaces, and Tasks. Workspaces and tasks display which project they belong to via a small text label, but they are all listed in one large flat list. This makes it difficult to mentally associate workspaces and tasks with their parent project. As the number of projects and workspaces grows, the sidebar becomes a long undifferentiated list that is hard to scan and navigate.

The user needs a hierarchical sidebar where projects act as collapsible group headings, with their associated workspaces and tasks nested underneath. This mirrors the pattern used in apps like Codex, where workspaces are grouped under project headings with expand/collapse behavior.

## Solution

Restructure the sidebar from a flat section-based layout into a project-grouped tree layout:

- **Projects become collapsible headings** in the sidebar with a chevron toggle and a "+" button to quickly create a workspace scoped to that project.
- **Workspaces** for each project are listed directly under their project heading, keeping their current card design.
- **Tasks** for each project appear in a sub-section under that project's workspaces, retaining their current source tabs (Manual/Linear/GitHub) and status filter tabs.
- The **ProjectSwitcher dropdown** is replaced with a **search bar** that filters projects and workspaces in real-time as the user types.
- The **Add Project** button remains at the top of the sidebar.
- The **Server Status** indicator moves to a sticky footer outside the scroll area, always visible at the bottom of the sidebar.

## User Stories

1. As a user, I want projects to appear as collapsible headings in the sidebar, so that I can see workspaces and tasks grouped under the project they belong to.
2. As a user, I want to click a chevron on a project heading to collapse or expand it, so that I can focus on the projects I'm actively working on and hide the rest.
3. As a user, I want the collapse/expand state of each project to persist across page reloads (via localStorage), so that I don't have to re-collapse projects every time I refresh.
4. As a user, I want a "+" button on each project heading to create a new workspace scoped to that project, so that I can quickly add workspaces without navigating to a separate dialog and selecting a project.
5. As a user, I want to see all workspaces for a project listed directly under that project's heading, so that I can immediately understand which workspaces belong to which project without reading small text labels.
6. As a user, I want workspace cards to retain their current full detail (branch name, status badge, action buttons, port, worktree path, collapsible terminal list), so that I don't lose any functionality in the new layout.
7. As a user, I want to see a "Tasks" sub-section under each project's workspaces, so that tasks are visually separated from workspaces but still grouped under the same project.
8. As a user, I want the task sub-section to retain the current source tabs (Manual/Linear/GitHub) and status filter tabs, so that I can manage tasks the same way I do today but scoped to each project.
9. As a user, I want a search bar at the top of the sidebar (replacing the project switcher dropdown), so that I can quickly filter down to find specific projects or workspaces.
10. As a user, I want the search bar to filter the sidebar tree in real-time as I type, showing only matching projects and workspaces (and auto-expanding collapsed projects that contain matches), so that navigation is fast.
11. As a user, I want the Add Project button to remain at the top of the sidebar, so that I can always easily add new projects.
12. As a user, I want the Server Status indicator to be pinned to the bottom of the sidebar outside the scroll area, so that I can always see connection status without scrolling.
13. As a user, I want projects with no workspaces or tasks to still appear as headings (with just the "+" button), so that I know the project is registered and can create workspaces for it.
14. As a user, I want the search bar to show all items when the query is empty, so that clearing the search restores the full sidebar.
15. As a user, I want the project heading to show the project name prominently (like a section heading), so that it's visually distinct from workspace/task items nested below it.
16. As a user, I want workspace cards to no longer show the project name as a description label (since it's already provided by the parent project heading), so that the cards are less redundant.
17. As a user, I want the sidebar to default to all projects expanded on first visit (before any localStorage state exists), so that I can see everything immediately.
18. As a user, I want the "Create Workspace" dialog opened from the project-level "+" button to have the project pre-selected, so that I don't have to manually choose the project.

## "Polishing" Requirements

- Ensure consistent indentation and visual hierarchy between project headings, workspace cards, and task sub-sections.
- Verify that the chevron rotation animation on expand/collapse is smooth and feels responsive.
- Check that the search bar filter handles edge cases: partial matches, case-insensitive matching, matches on both project names and workspace branch names.
- Ensure auto-expansion of collapsed projects when their children match a search query feels natural and re-collapses when the query is cleared (restore previous collapse state).
- Verify that the sticky footer for Server Status doesn't overlap with the bottom of the scrollable content.
- Ensure keyboard navigation works within the sidebar: Tab through project headings, Enter to expand/collapse, arrow keys to navigate items.
- Verify that removing the project name from workspace cards doesn't break any layout or leave awkward empty space.
- Ensure the "+" button on project headings has a clear hover state and tooltip ("Create Workspace").
- Confirm that the search bar has a clear/reset button (X icon) when text is entered.
- Ensure the sidebar retains its current resizable behavior and responsive sizing.

## Implementation Decisions

### Modules to Modify

1. **Sidebar layout (HomeComponent)**: The sidebar rendering in the main route component will be restructured. The flat `<section>` blocks for Projects, Workspaces, and Tasks will be replaced with a single project-grouped tree structure. Each project will render as a collapsible group containing its workspaces and tasks.

2. **ProjectSwitcher → SearchBar**: The `ProjectSwitcher` component (dropdown select) will be replaced with a new `SidebarSearch` component -- a text input that filters the sidebar tree in real-time. The search state will be lifted to the sidebar level and passed down to filter projects and their children.

3. **ProjectList → ProjectGroup**: The `ProjectList` component (flat list of project cards) will be replaced with a `ProjectGroup` component. Each `ProjectGroup` renders a collapsible heading (project name + chevron + "+" button) with its workspaces and tasks nested inside.

4. **WorkspaceList**: The `WorkspaceList` component will be modified to accept a `projectId` prop and render only workspaces for that project. The existing filtering logic (which filters by `activeProjectId`) will be replaced with direct per-project rendering.

5. **TaskList + TaskSourcePicker**: These components will be modified to accept a `projectId` prop and render tasks scoped to that project. The source tabs and status filter tabs remain but are scoped per-project.

6. **WorkspaceItem card**: Remove the project name `CardDescription` from each workspace card since the project context is now provided by the parent heading.

7. **CreateWorkspaceForm**: Add support for a `projectId` prop that pre-selects the project in the form dialog, used when the "+" button on a project heading triggers workspace creation.

8. **Server Status footer**: Extract the Server Status section from the scroll area and render it as a sticky footer in the sidebar panel, below the `ScrollArea`.

### Collapse State Management

- Use a React state (`Record<string, boolean>`) mapping project IDs to their expanded/collapsed state.
- Initialize from localStorage on mount, default to all-expanded if no stored state.
- Persist to localStorage on every change via a `useEffect`.

### Search/Filter Logic

- The search input value lives in sidebar-level state.
- When non-empty, iterate all projects and their workspaces: show a project if its name matches OR if any of its workspace branch names match the query.
- When a search is active, auto-expand all projects that have matches (override collapse state). When search is cleared, restore the previous collapse state.
- Matching is case-insensitive and substring-based.

### Structural Change

The sidebar structure changes from:

```
ScrollArea
  ProjectSwitcher (dropdown)
  <section> Projects (flat project cards)
  <section> Workspaces (flat workspace cards)
  <section> Tasks (source tabs + flat task cards)
  <section> Server Status
```

To:

```
SidebarSearch (search input)
Add Project button
ScrollArea
  ProjectGroup (project A)
    Collapsible heading: project name + chevron + "+"
    WorkspaceList (filtered to project A)
    TaskSourcePicker + TaskList (filtered to project A)
  ProjectGroup (project B)
    ...
Footer (sticky, outside scroll)
  Server Status
```

## Testing Decisions

No automated tests are planned for this work. This is a UI restructuring that rearranges existing components into a new layout without introducing new business logic. The existing workspace, task, and project functionality remains unchanged -- only the visual grouping and navigation changes.

Manual verification should cover:
- All projects appear as collapsible headings
- Workspaces and tasks correctly group under their parent project
- Collapse/expand works and persists
- Search filters correctly
- The "+" button on each project opens the workspace creation form with the project pre-selected
- Server status footer stays visible and doesn't overlap content

## Out of Scope

- **Main content area changes**: No changes to the panel manager, workspace dashboard, or terminal views.
- **Data model changes**: No changes to LiveStore schemas or the project/workspace/task data structures.
- **New routing**: No new routes or URL-based navigation for sidebar items.
- **Drag-and-drop reordering**: No reordering of projects or workspaces within the sidebar.
- **Multi-select or bulk actions**: No multi-select of workspaces/tasks across projects.
- **Project-level settings in the heading**: Project settings remain accessible through the existing settings modal, not inlined into the heading.

## Further Notes

- The Codex app screenshot serves as the visual inspiration for the grouping pattern, but the implementation retains laborer's existing card-based workspace and task designs rather than adopting Codex's minimal text-only style.
- The `ProjectSwitcher` component can be fully removed once the search bar is in place, as the project-grouped layout makes per-project filtering redundant.
- The existing `use-responsive-layout` hook and `react-resizable-panels` setup remain unchanged -- the sidebar is still resizable with the same min/max/default sizing.
