# Review Findings Panel — Issues

Parent PRD: [PRD-review-findings-panel.md](./PRD-review-findings-panel.md)

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Review pane type + panel system wiring | None | done |
| 2 | PR comment fetching RPC + server service | None | done |
| 3 | Review pane renders fetched comments | 1, 2 | done |
| 4 | Finding extraction (server-side parsing) | 2 | done |
| 5 | Grouped display with severity badges | 3, 4 | done |
| 6 | Polling + manual refresh | 3 | done |
| 7 | Verdict badge on workspace card | 4 | done |
| 8 | Checkbox selection + reaction state display | 5 | done |
| 9 | Rocket reaction RPCs + Fix Selected action | 8 | done |
| 10 | Click-to-open-in-editor | 5 | pending |
| 11 | Cross-pane diff scroll | 10 | pending |
| 12 | Keyboard shortcut + error handling + polish | 1-11 | pending |

---

## Issue 1: Review pane type + panel system wiring

### What to build

Add `'review'` as a new pane type to Laborer's panel system. This is the foundational wiring that all subsequent review pane work depends on. The review pane should be openable via a split-right action and render a placeholder component. No data fetching or GitHub integration yet — just the panel system plumbing.

This involves adding the literal to `PaneType`, updating `VALID_PANE_TYPES` in layout-utils, adding a branch in `PaneContent` in panel-manager to route to a new placeholder review pane component, and adding a `toggleReviewPane` action to `PanelActions` that always splits right.

See the "Panel system" and "Review Pane" sections of the parent PRD for full context.

### Acceptance criteria

- [ ] `'review'` is a valid `PaneType` in the shared types
- [ ] `VALID_PANE_TYPES` in layout-utils includes `'review'`
- [ ] Panel manager routes `paneType === 'review'` to a new `ReviewPane` component
- [ ] A placeholder `ReviewPane` component exists that renders a "Review" heading and the workspace ID
- [ ] The review pane can be opened via split-right from an existing pane
- [ ] The review pane accepts a `workspaceId` prop from the leaf node
- [ ] Panel layout repair logic handles the new pane type without corrupting state
- [ ] Tests: panel layout accepts review pane type, split-right creates a review pane

### Blocked by

None - can start immediately

### User stories addressed

- User story 15

---

## Issue 2: PR comment fetching RPC + server service

### What to build

Create a new server service and RPC endpoint that fetches all PR comments from GitHub for a workspace's pull request. The service detects owner/repo from the workspace's git remote, resolves the PR number, and calls `gh api` to fetch both issue comments and inline review comments (paginated).

Returns raw comment data including author login, author avatar URL, body, file path (for inline comments), line number (for inline comments), created timestamp, comment ID, and reactions array. No finding parsing yet — that comes in a later slice.

See the "PR Comment Fetcher" section of the parent PRD for full context.

### Acceptance criteria

- [ ] New `review.fetchComments` RPC defined in the shared RPC contract with request/response schemas
- [ ] Server handler resolves workspace → worktree path → PR number (reuses existing `detectPrNumber` pattern)
- [ ] Server detects owner/repo from `git remote get-url origin` (supports SSH `git@github.com:owner/repo.git` and HTTPS `https://github.com/owner/repo.git` formats)
- [ ] Server fetches issue comments via `gh api repos/{owner}/{repo}/issues/{pr}/comments --paginate`
- [ ] Server fetches inline review comments via `gh api repos/{owner}/{repo}/pulls/{pr}/comments --paginate`
- [ ] Response includes: comment ID, author (login + avatar URL), body, file path (nullable), line (nullable), created timestamp, reactions array, comment type (issue vs review)
- [ ] Returns `PR_NOT_FOUND` error when no PR exists for the workspace branch
- [ ] Tests: owner/repo parsing from SSH and HTTPS remote URLs
- [ ] Tests: response schema validation with mock gh output
- [ ] Tests: error handling for missing gh CLI, auth failure

### Blocked by

None - can start immediately (parallel with "Review pane type + panel system wiring")

### User stories addressed

- User story 6

---

## Issue 3: Review pane renders fetched comments

### What to build

Wire the review pane component to call the `review.fetchComments` RPC on mount and render the fetched comments as a flat list. Each comment shows author name, avatar, and body. Handle empty state (no PR exists) and loading state (fetch in progress).

This is the first slice where the review pane shows real data from GitHub. No finding parsing or grouped display yet — all comments rendered uniformly.

See the "Review Pane" section of the parent PRD for full context.

### Acceptance criteria

- [ ] Review pane calls `review.fetchComments` on mount with the workspace ID
- [ ] Each comment renders author login, avatar image, and body text
- [ ] Inline review comments show their file path and line number reference
- [ ] Empty state shown when no PR exists for the workspace (clear message explaining why)
- [ ] Loading state shown while the fetch is in progress (spinner or skeleton)
- [ ] Error state shown when the RPC fails (with error message)
- [ ] Tests: renders comments with author info and body
- [ ] Tests: renders empty state when no PR
- [ ] Tests: renders loading state during fetch

### Blocked by

- Blocked by "Review pane type + panel system wiring"
- Blocked by "PR comment fetching RPC + server service"

### User stories addressed

- User story 6
- User story 7
- User story 22
- User story 23

---

## Issue 4: Finding extraction (server-side parsing)

### What to build

Enhance the `review.fetchComments` server service to parse brrr-specific markers from PR comments and return structured finding data alongside raw comments.

The server should extract `<!-- brrr-finding:{json} -->` HTML comment markers from inline review comment bodies to produce structured `ReviewFinding` objects (id, file, line, severity, description, suggested_fixes, category, depends_on). It should also parse the `<!-- brrr-review -->` marker from issue comments to extract the review verdict (approved/needs_fix).

Comments that contain a brrr-finding marker should be returned in the `findings` array (not the `comments` array). Comments without markers stay in the `comments` array.

See the "PR Comment Fetcher" and "Further Notes" sections of the parent PRD for the marker format details.

### Acceptance criteria

- [ ] Server parses `<!-- brrr-finding:{json} -->` markers from inline review comment bodies
- [ ] Extracted findings include: id, file, line, severity (critical/warning/info), description, suggested_fixes, category, depends_on, comment ID, reactions
- [ ] Server parses `<!-- brrr-review -->` marker from issue comments to extract verdict (approved/needs_fix)
- [ ] Response shape is `{ verdict: ReviewVerdict | null, findings: ReviewFinding[], comments: PrComment[] }`
- [ ] Comments with brrr-finding markers appear in `findings`, not `comments`
- [ ] Malformed JSON in markers is handled gracefully (comment falls back to the `comments` array)
- [ ] Missing markers produce `verdict: null` and empty `findings` array
- [ ] Shared response schemas (`ReviewFinding`, `PrComment`, `ReviewVerdict`) defined in the RPC contract
- [ ] Tests: valid finding marker parsing with all fields
- [ ] Tests: malformed JSON falls back gracefully
- [ ] Tests: multiple findings across multiple comments
- [ ] Tests: verdict extraction from summary comment (approved, needs_fix, missing)
- [ ] Tests: mixed comments (some with markers, some without)

### Blocked by

- Blocked by "PR comment fetching RPC + server service"

### User stories addressed

- User story 1

---

## Issue 5: Grouped display with severity badges

### What to build

Update the review pane to display findings and comments in two separate grouped sections instead of a flat list. The Findings section shows structured finding cards with severity badges, file:line links, category tags, descriptions, and collapsible suggested fixes. The Comments section shows human-authored comments with author info, body, and file:line for inline comments. Findings are sorted by severity (critical first).

See the "Review Pane" and "'Polishing' Requirements" sections of the parent PRD.

### Acceptance criteria

- [ ] Two visually distinct sections: "Findings" and "Comments" with headings and counts
- [ ] Finding cards display: severity badge (critical/warning/info), file:line reference, category tag, description text
- [ ] Suggested fixes shown in a collapsible section (collapsed by default) on each finding card
- [ ] Findings sorted by severity: critical first, then warning, then info
- [ ] Comments section renders author avatar, login name, body (as markdown or plain text), and timestamp
- [ ] Inline review comments in the Comments section show their file path and line number
- [ ] Sections are collapsible
- [ ] Tests: findings render with correct severity badges and colors
- [ ] Tests: comments render with author info and body
- [ ] Tests: findings are sorted by severity

### Blocked by

- Blocked by "Review pane renders fetched comments"
- Blocked by "Finding extraction (server-side parsing)"

### User stories addressed

- User story 2
- User story 3
- User story 4
- User story 5
- User story 19
- User story 26
- User story 27

---

## Issue 6: Polling + manual refresh

### What to build

Add automatic polling and manual refresh to the review pane. The pane should re-fetch `review.fetchComments` every 30 seconds while mounted and stop polling when unmounted. A manual refresh button allows the user to trigger an immediate fetch.

See the "Review Pane" section of the parent PRD.

### Acceptance criteria

- [ ] Review pane polls `review.fetchComments` every 30 seconds while mounted
- [ ] Polling stops when the pane is unmounted (no leaked intervals)
- [ ] Manual refresh button triggers an immediate fetch and resets the polling timer
- [ ] Loading indicator shown during refresh (subtle, does not replace existing content)
- [ ] Refresh does not cause layout shifts or content flicker
- [ ] Tests: polling starts on mount, stops on unmount
- [ ] Tests: manual refresh triggers immediate fetch

### Blocked by

- Blocked by "Review pane renders fetched comments"

### User stories addressed

- User story 8
- User story 9

---

## Issue 7: Verdict badge on workspace card

### What to build

Add a review verdict badge to each workspace card that shows whether the PR has been reviewed and what the verdict was. This uses a lightweight `review.fetchVerdict` RPC that only fetches issue comments (not inline review comments) and parses the `<!-- brrr-review -->` summary comment for the verdict.

The badge sits next to the existing `GitHubPrStatusBadge` and shows: green checkmark for approved, red X for needs_fix, nothing if no review has been run. It auto-updates, either by polling at the PrWatcher interval or by being triggered when PrWatcher detects a PR state change.

See the "Workspace card" and "Verdict Badge Data Source" sections of the parent PRD.

### Acceptance criteria

- [ ] New `review.fetchVerdict` RPC defined in the shared RPC contract
- [ ] Server handler fetches only issue comments and parses `<!-- brrr-review -->` marker for verdict
- [ ] Verdict badge component renders next to `GitHubPrStatusBadge` on workspace cards
- [ ] Shows green checkmark icon for "approved" verdict
- [ ] Shows red X icon for "needs_fix" verdict
- [ ] Hidden (renders nothing) when no review summary comment exists
- [ ] Badge auto-updates (polled or triggered by PrWatcher state changes)
- [ ] Badge is compact and does not crowd the existing PR status badge
- [ ] Tests: badge renders correct icon for each verdict state
- [ ] Tests: badge hidden when no review exists

### Blocked by

- Blocked by "Finding extraction (server-side parsing)"

### User stories addressed

- User story 17
- User story 18

---

## Issue 8: Checkbox selection + reaction state display

### What to build

Add triage UI to the review pane's findings section. Each finding card gets a checkbox for selection. Reaction state indicators show which findings are already queued (rocket), fixed (thumbs-up), or won't-fix (confused). A selected count is shown in the pane header. This is UI-only — no server interaction for reactions yet.

See the "Review Pane" section of the parent PRD.

### Acceptance criteria

- [ ] Each finding card has a checkbox for selection
- [ ] Selected findings have a visually highlighted background
- [ ] Selected count displayed (e.g., "3 selected")
- [ ] Reaction state indicators on each finding: rocket emoji/icon for queued, thumbs-up for fixed, confused for won't-fix
- [ ] Already-resolved findings (thumbs-up or confused) are visually dimmed or styled differently
- [ ] Select all / deselect all capability
- [ ] Selection state is local to the pane (not persisted)
- [ ] Tests: checkbox toggles selection state
- [ ] Tests: selected count updates correctly
- [ ] Tests: reaction state indicators render correctly

### Blocked by

- Blocked by "Grouped display with severity badges"

### User stories addressed

- User story 20
- User story 21

---

## Issue 9: Rocket reaction RPCs + Fix Selected action

### What to build

Add server-side RPCs for managing rocket reactions on GitHub PR review comments, and wire up the "Fix Selected" and "Unqueue" actions in the review pane.

"Fix Selected" adds rocket reactions to all selected findings via `gh api`, then triggers `brrr.fix` for the workspace (spawning a terminal). "Unqueue" removes the rocket reaction from a single finding. The server reaction service is a thin wrapper around the `gh api` endpoints for adding/removing reactions.

See the "Rocket Reaction Service" and "Triage" sections of the parent PRD.

### Acceptance criteria

- [ ] New `review.addReaction` RPC: payload `{ workspaceId, commentId, content }`, adds reaction via `gh api`
- [ ] New `review.removeReaction` RPC: payload `{ workspaceId, commentId, reactionId }`, removes reaction via `gh api`
- [ ] "Fix Selected" button in review pane header, disabled when no findings selected, shows count
- [ ] Clicking "Fix Selected" adds rocket reactions to all selected findings, then calls `brrr.fix` RPC
- [ ] On success, spawned terminal is assigned to a panel pane (same pattern as existing `brrr.fix` button)
- [ ] "Unqueue" action on individual findings removes the rocket reaction
- [ ] After adding/removing reactions, the pane re-fetches to show updated reaction state
- [ ] Error toast shown if reaction API calls fail
- [ ] Tests: add reaction calls correct gh api endpoint
- [ ] Tests: remove reaction calls correct gh api endpoint
- [ ] Tests: Fix Selected button disabled when nothing selected

### Blocked by

- Blocked by "Checkbox selection + reaction state display"

### User stories addressed

- User story 10
- User story 11
- User story 12
- User story 25

---

## Issue 10: Click-to-open-in-editor

### What to build

Make file:line references in the review pane clickable. Clicking a finding's file:line or an inline comment's file:line opens that location in the user's configured editor via the existing `editor.open` RPC.

See the "Diff pane (cross-pane communication)" section of the parent PRD.

### Acceptance criteria

- [ ] File:line references in finding cards are clickable links
- [ ] File:line references in inline comment cards are clickable links
- [ ] Clicking calls `editor.open` RPC with the workspace ID and file path
- [ ] The file opens at the correct line in the configured editor
- [ ] Visual affordance (underline, hover state) indicates the reference is clickable
- [ ] Tests: clicking file:line triggers editor.open RPC call

### Blocked by

- Blocked by "Grouped display with severity badges"

### User stories addressed

- User story 13

---

## Issue 11: Cross-pane diff scroll

### What to build

When clicking a file:line reference in the review pane, if a diff pane is open for the same workspace, scroll the diff pane to that file and line. This requires a cross-pane communication mechanism — a shared context or event bus at the panel level that the diff pane subscribes to.

See the "Diff pane (cross-pane communication)" section of the parent PRD.

### Acceptance criteria

- [ ] A panel-level event bus or shared context exists for cross-pane communication
- [ ] Review pane emits a "scroll to file:line" event when a file:line link is clicked
- [ ] Diff pane subscribes to these events and scrolls to the matching file and line
- [ ] Only diff panes showing the same workspace respond to the event
- [ ] If no diff pane is open for the workspace, the event is silently ignored
- [ ] Scroll behavior is smooth (not jarring jumps)
- [ ] Works alongside the editor.open action (both fire on the same click)

### Blocked by

- Blocked by "Click-to-open-in-editor"

### User stories addressed

- User story 14

---

## Issue 12: Keyboard shortcut + error handling + polish

### What to build

Final polish slice: add a keyboard shortcut to open the review pane, add a workspace action button, improve error handling with actionable guidance, and apply all polishing requirements from the PRD.

See the "'Polishing' Requirements" section of the parent PRD for the full list.

### Acceptance criteria

- [ ] Keyboard shortcut (tmux-prefix style) opens the review pane for the active workspace
- [ ] Workspace card has a button/action to open the review pane
- [ ] gh auth errors show actionable guidance ("Run `gh auth login` to authenticate")
- [ ] Rate limit errors are detected and shown with guidance
- [ ] Severity badge colors match brrr convention: red (critical), yellow (warning), blue (info)
- [ ] Smooth transitions between loading, empty, error, and populated states (no layout shifts)
- [ ] Dark and light theme support verified
- [ ] All interactive elements (checkboxes, buttons, links) are keyboard-navigable
- [ ] Error toasts include actionable guidance
- [ ] "Fix Selected" button shows selected count and is disabled when none selected
- [ ] Collapsible sections (Findings, Comments, suggested fixes) animate smoothly
- [ ] Review pane respects the app's existing design system (shadcn/ui components, Tailwind classes)

### Blocked by

- Blocked by "Review pane type + panel system wiring"
- Blocked by "PR comment fetching RPC + server service"
- Blocked by "Review pane renders fetched comments"
- Blocked by "Finding extraction (server-side parsing)"
- Blocked by "Grouped display with severity badges"
- Blocked by "Polling + manual refresh"
- Blocked by "Verdict badge on workspace card"
- Blocked by "Checkbox selection + reaction state display"
- Blocked by "Rocket reaction RPCs + Fix Selected action"
- Blocked by "Click-to-open-in-editor"
- Blocked by "Cross-pane diff scroll"

### User stories addressed

- User story 16
- User story 24
- Polishing requirements 1-12
