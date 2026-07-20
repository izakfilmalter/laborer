# PRD: Sidebar Width, Workspace Card Overflow, and Detected Worktree Feature Parity

## Problem Statement

The sidebar has three UX issues that collectively degrade the workspace management experience:

1. **Sidebar max-width is too restrictive.** The sidebar is capped at ~480px at 1080p and 760px absolute. Users who want to see full branch names, paths, and action buttons cannot widen the sidebar enough. The sidebar should be resizable up to nearly the full viewport width, allowing users to make it as wide as they need.

2. **Workspace card content overflows.** Long branch names (e.g., `modal-migration/upgrade-confirmation`) and the inline action buttons compete for horizontal space in the card header. The branch name truncates, but the action buttons (status badge, WritePRD, Ralph Loop, Review PR, Fix Findings, expand/collapse, destroy) sit on the same row and push past the card boundary, causing visual overflow. The worktree path also truncates to a single line without enough context.

3. **Detected worktrees are missing core functionality.** Worktrees imported from external sources (origin: "external") show a "Detected" label and a status badge, but are missing the expand/collapse trigger, terminal list, and all action buttons (WritePRD, Ralph Loop, Review PR, Fix Findings). These features are gated behind an `isActive` check (status === "running" or "creating"), so detected worktrees in a "stopped" state get a stripped-down card with no way to spawn terminals or trigger agent workflows. Users expect detected worktrees to behave identically to created workspaces, just in a non-running state.

## Solution

1. **Remove the sidebar max-width cap.** Change the sidebar's maximum size to 90% of the viewport width. Keep the current minimum (~220px at 1080p) and default (~280px at 1080p) unchanged. Remove the absolute pixel cap (currently 760px) so the sidebar can grow freely on any display size.

2. **Restructure workspace cards to a two-row header with text clamping.** Split the card header into two rows:
   - **Row 1**: GitBranch icon + branch name (line-clamped to 2 lines) + "Detected" badge (if applicable) + status badge.
   - **Row 2**: Action buttons (WritePRD, Ralph Loop, Review PR, Fix Findings, expand/collapse, destroy).

   Apply Tailwind v4's `line-clamp-2` to both the branch name and the worktree path, allowing them to wrap up to 2 lines before truncating with an ellipsis. This replaces the current single-line `truncate` behavior.

3. **Give detected worktrees full feature parity.** Remove the `isActive` gate on the expand/collapse trigger, terminal list, and action buttons. Detected worktrees should render the same card UI as created workspaces: expandable terminal section with "+ New" terminal button, and all agent workflow buttons (WritePRD, Ralph Loop, Review PR, Fix Findings). The only difference remains the "Detected" label and the different destroy confirmation message.

## User Stories

1. As a user, I want to resize the sidebar up to 90% of the viewport width, so that I can see full branch names and workspace details without truncation.
2. As a user, I want the sidebar minimum width to stay the same (~220px), so that I can still collapse it to a small size when I need more panel space.
3. As a user, I want the sidebar default width to stay the same (~280px), so that it opens at a reasonable size without taking too much space.
4. As a user, I want branch names in workspace cards to wrap up to 2 lines before truncating, so that I can read long branch names like `modal-migration/upgrade-confirmation` without needing to widen the sidebar.
5. As a user, I want worktree paths in workspace cards to wrap up to 2 lines before truncating, so that I can see enough of the path to identify the workspace location.
6. As a user, I want the workspace card header split into two rows (info row and action row), so that action buttons never overlap or push past the branch name.
7. As a user, I want the status badge (running/stopped/errored) to appear on the same row as the branch name, so that I can see the workspace state at a glance.
8. As a user, I want action buttons (WritePRD, Ralph Loop, Review PR, Fix Findings, expand/collapse, destroy) on a dedicated second row, so that they don't compete with the branch name for space.
9. As a user, I want to expand a detected worktree card to see its terminal list, so that I can manage terminals for externally created worktrees.
10. As a user, I want to click "+ New" on a detected worktree to spawn a terminal session in that worktree's directory, so that I can work in any worktree regardless of how it was created.
11. As a user, I want to trigger WritePRD on a detected worktree, so that I can use agent workflows on externally created worktrees.
12. As a user, I want to start a Ralph Loop on a detected worktree, so that I can run agent loops on any worktree.
13. As a user, I want to trigger Review PR on a detected worktree, so that I can review pull requests from any worktree.
14. As a user, I want to trigger Fix Findings on a detected worktree, so that I can fix findings from any worktree.
15. As a user, I want the expand/collapse chevron to appear on detected worktrees, so that I can toggle the terminal section open and closed.
16. As a user, I want detected worktrees to still show the "Detected" label, so that I can distinguish them from workspaces I created through Laborer.
17. As a user, I want the destroy confirmation for detected worktrees to still use the softer message (worktree on disk is not changed), so that I understand the destroy only removes it from Laborer.
18. As a user, I want the action buttons row to wrap naturally if the card is narrow, so that buttons remain accessible at any sidebar width.

## Polishing Requirements

1. Verify that the sidebar can be resized smoothly from minimum to 90% without layout jank or content shifting.
2. Verify that the ResizableHandle drag handle still works correctly at the new maximum width.
3. Verify that the main content panel (right side) maintains a usable minimum width when the sidebar is at 90%.
4. Verify that branch names with `/` separators wrap at word boundaries where possible (CSS `overflow-wrap: anywhere` or `break-all` may be needed for monospace text without natural break points).
5. Verify that the 2-line clamp ellipsis renders correctly for both short names (no clamp needed) and very long names (3+ lines clamped to 2).
6. Verify that all action buttons on Row 2 are correctly spaced and aligned across workspace cards of varying content lengths.
7. Verify that detected worktree terminal spawning actually works end-to-end (terminal opens in the correct worktree directory).
8. Verify that agent workflow buttons (WritePRD, Ralph Loop, Review PR, Fix Findings) function correctly for detected worktrees in "stopped" state, including any server-side validation that may reject actions on non-running workspaces.
9. Verify that the workspace card layout looks correct at both the minimum sidebar width (~220px) and a very wide sidebar (e.g., 800px+).
10. Verify that the "Detected" badge and status badge don't overflow or stack awkwardly at narrow widths.

## Implementation Decisions

### Module 1: Sidebar max-width — responsive layout hook

The `useResponsiveLayout` hook computes sidebar sizing as pixel values converted to percentages for `react-resizable-panels`. The changes are:

- **Remove the absolute pixel cap** on `maxPx`. Currently the `computeSidebarPx` function clamps `maxPx` to 760px. This cap should be removed entirely.
- **Set `sidebarMax` to a fixed `"90%"` string** instead of computing it from pixel values. Since the goal is "let users make it as wide as they want," a flat 90% avoids unnecessary scaling math. The remaining 10% ensures the main content panel always has some visible width.
- The `minPx`, `defaultPx`, and scaling logic remain unchanged.
- The `paneMin` calculation remains unchanged — it ensures the main content panel has a usable minimum.

### Module 2: Workspace card layout restructure — two-row header

The `WorkspaceItem` component in the workspace list currently uses a single `flex items-start justify-between gap-2` container with two children: the left column (branch name + project name) and the right column (all buttons inline). This is restructured to:

**Row 1** (info row): A flex row containing the GitBranch icon, branch name (line-clamped to 2 lines), optional "Detected" badge, and the status badge. The status badge is pushed to the right with `ml-auto` or `justify-between`. The branch name container uses `min-w-0` and `line-clamp-2` (Tailwind v4) instead of `truncate`.

**Row 2** (action row): A flex row containing all action buttons: WritePRD, Ralph Loop, Review PR, Fix Findings, expand/collapse chevron, and destroy. This row uses `flex-wrap` so buttons wrap naturally at narrow widths rather than overflowing. Buttons are right-aligned or left-aligned (whichever looks better with the card's visual hierarchy).

The worktree path in `CardContent` also switches from `truncate` to `line-clamp-2`.

The `CardDescription` (project name) remains on its own line below Row 1, inside the left column or spanning full width.

### Module 3: Detected worktree feature parity — remove isActive gate

The `WorkspaceItem` component gates several features behind `isActive` (status === "running" || "creating"). The following elements need the `isActive` conditional removed so they render for all non-destroyed workspaces:

1. **WritePrdForm** — currently wrapped in `{isActive && <WritePrdForm ... />}`
2. **Start Ralph Loop button** — currently wrapped in `{isActive && <Button ... />}`
3. **ReviewPrForm** — currently wrapped in `{isActive && <ReviewPrForm ... />}`
4. **FixFindingsForm** — currently wrapped in `{isActive && <FixFindingsForm ... />}`
5. **CollapsibleTrigger** (expand/collapse chevron) — currently wrapped in `{isActive && <CollapsibleTrigger ... />}`
6. **CollapsibleContent** (terminal list) — currently wrapped in `{isActive && <CollapsibleContent ... />}`

All six of these should render unconditionally (for non-destroyed workspaces). The `isActive` variable may still be useful for other purposes (e.g., showing the "creating" spinner), but it should no longer gate these UI elements.

Server-side RPC handlers for terminal spawning and agent workflows may need to handle detected/stopped workspaces gracefully. If they already reject invalid workspace states, the error will surface via the existing toast error handling. No client-side pre-validation changes are needed.

## Testing Decisions

No automated tests are planned for these changes. The modifications are:

- A config constant change (sidebar max-width) — verified visually by resizing.
- CSS/Tailwind class changes (line-clamp, two-row layout) — verified visually at various sidebar widths.
- Conditional rendering removal (isActive gate) — verified by interacting with detected worktrees in the UI.

Visual verification is sufficient for these layout and conditional rendering changes.

## Out of Scope

- **Sidebar minimum width changes**: The minimum stays at ~220px. No changes to the minimum sizing logic.
- **Sidebar default width changes**: The default stays at ~280px. No changes to the initial open width.
- **Starting dev servers for detected worktrees**: Detected worktrees get terminal spawning and agent workflow buttons, but there is no new "start dev server" action. The workspace remains in "stopped" state. If agent workflows or terminals need a running dev server, that is handled by the existing server-side logic.
- **Workspace card redesign beyond two-row header**: No changes to the card's visual styling (colors, borders, padding, typography) beyond the layout restructure.
- **Mobile/responsive sidebar behavior**: The `canCollapseSidebar` threshold (viewport < 1280px) is not changed.
- **Terminal list UI changes**: The terminal list items within the expanded section are not modified.

## Further Notes

- Tailwind v4 provides `line-clamp-2` as a built-in utility (no plugin needed). It applies `-webkit-line-clamp: 2` with `overflow: hidden` and `display: -webkit-box`. This works in all modern browsers.
- The `react-resizable-panels` library accepts percentage strings like `"90%"` for `maxSize`. Setting a flat `"90%"` is simpler and more predictable than computing pixel-to-percent conversions for the max.
- The `flex-wrap` on the action buttons row means that at very narrow sidebar widths, buttons may stack into multiple rows. This is preferable to overflow or truncation of interactive elements.
- Server-side behavior for agent workflows on stopped/detected workspaces should be verified during implementation. If the server rejects these requests, appropriate error toasts will appear via existing error handling — no client-side changes needed, but the server may need updates in a follow-up if workflows require a running workspace.
