## Problem Statement

When brrr runs a PR review (`brrr review`) or fix (`brrr fix`), it posts structured findings and a verdict as GitHub PR comments. Currently, Laborer has zero visibility into these results — the user sees only raw terminal output in an xterm.js pane. To understand what the review found, they must leave Laborer and navigate to GitHub.

Similarly, human collaborators may leave review comments on PRs. These are also invisible inside Laborer. The user has no way to see all feedback in one place, triage it, and decide what to hand off to an AI agent for fixing.

## Solution

Add a new **review pane** to Laborer's panel system. This pane fetches all PR comments (both brrr-authored findings and human-authored reviews) from GitHub, displays them in a structured, grouped list, and lets the user select findings to pass to brrr fix via the existing rocket-reaction convention.

Additionally, show the brrr review **verdict** (approved / needs_fix) as a badge on the workspace card so users can see review status at a glance without opening the pane.

## User Stories

1. As a developer, I want to see all brrr review findings for a workspace's PR in a dedicated pane, so that I don't have to leave Laborer to check GitHub.
2. As a developer, I want findings displayed with severity badges (critical/warning/info), so that I can quickly identify the most important issues.
3. As a developer, I want to see each finding's file path and line number, so that I can understand exactly where the issue is.
4. As a developer, I want to see finding categories (correctness, security, hygiene), so that I can filter by concern type.
5. As a developer, I want to see suggested fixes for each finding, so that I understand the recommended remediation.
6. As a developer, I want to see all human-authored PR review comments alongside brrr findings, so that I have full context in one place.
7. As a developer, I want to see comment authors and their avatars, so that I can identify who left each comment.
8. As a developer, I want the review pane to auto-refresh while open, so that new comments and findings appear without manual action.
9. As a developer, I want a manual refresh button, so that I can force an immediate update when I know new data exists.
10. As a developer, I want to select individual findings via checkboxes, so that I can choose which ones to hand off to AI for fixing.
11. As a developer, I want a "Fix Selected" action that adds rocket reactions to the selected findings on GitHub, so that brrr fix picks them up naturally.
12. As a developer, I want to run brrr fix from the review pane after selecting findings, so that the entire triage-to-fix workflow happens in one place.
13. As a developer, I want to click a finding's file:line reference to open that location in my configured editor, so that I can inspect the code directly.
14. As a developer, I want clicking a finding's file:line to scroll the diff pane (if open for the same workspace) to that location, so that I can see the change in context.
15. As a developer, I want the review pane to open on the right side of the panel grid, so that it sits alongside the terminal or diff view I'm working with.
16. As a developer, I want to open the review pane via a keyboard shortcut or workspace action, so that access is fast.
17. As a developer, I want to see the brrr review verdict (approved/needs_fix) as a badge on the workspace card, so that I can see review status at a glance without opening the review pane.
18. As a developer, I want the verdict badge to update automatically when the PR watcher detects changes, so that the badge stays current.
19. As a developer, I want findings and comments to be displayed in separate grouped sections, so that the different types of feedback are visually distinct.
20. As a developer, I want to see which findings already have a rocket reaction (i.e., are already queued for fix), so that I don't duplicate triage work.
21. As a developer, I want to see which findings have been resolved (thumbs-up or confused reactions), so that I can tell what's already been addressed.
22. As a developer, I want the review pane to show an empty state when no PR exists for the workspace, so that I understand why there's nothing to display.
23. As a developer, I want the review pane to show a loading state while fetching comments, so that I know data is being retrieved.
24. As a developer, I want to see error messages when GitHub API calls fail (e.g., auth issues, rate limiting), so that I can troubleshoot.
25. As a developer, I want to deselect findings and remove rocket reactions if I change my mind before running fix, so that I have full control over what gets fixed.
26. As a developer, I want to see the comment body of inline review comments (not just brrr findings), so that I can read feedback from human reviewers.
27. As a developer, I want to see which file and line an inline review comment refers to, so that I understand its context even when it's from a human reviewer.

## 'Polishing' Requirements

1. Severity badges should use consistent colors that match brrr's convention: red for critical, yellow for warning, blue for info.
2. The grouped sections (Findings vs Comments) should have clear visual separation — headings, counts, and collapsible groups.
3. Finding cards should show suggested fixes in a collapsible `<details>` pattern so they don't overwhelm the list.
4. The review pane should gracefully handle long finding descriptions and comment bodies without breaking layout.
5. Transitions between loading, empty, error, and populated states should be smooth and not cause layout shifts.
6. The verdict badge on the workspace card should be compact and not crowd the existing PR status badge.
7. Checkbox selection state should be visually clear — selected findings should have a highlighted background.
8. The "Fix Selected" button should be disabled when nothing is selected and should show a count of selected items.
9. Reaction state indicators (rocket queued, thumbs-up fixed, confused won't-fix) should use emoji or icons consistently.
10. The pane should respect the app's dark/light theme.
11. Keyboard accessibility: all interactive elements (checkboxes, buttons, links) should be keyboard-navigable.
12. Error toasts for API failures should include actionable guidance (e.g., "Check that gh is authenticated").

## Implementation Decisions

### New Modules

**PR Comment Fetcher (server service)**
- Uses `gh api` CLI to fetch two types of PR comments:
  - Issue comments: `gh api repos/{owner}/{repo}/issues/{pr}/comments --paginate`
  - Inline review comments: `gh api repos/{owner}/{repo}/pulls/{pr}/comments --paginate`
- Parses `<!-- brrr-finding:{json} -->` HTML comment markers from inline review comment bodies to extract structured `ReviewFinding` data (id, file, line, severity, description, suggested_fixes, category, depends_on).
- Parses `<!-- brrr-review -->` marker from issue comments to extract the verdict (approved/needs_fix).
- Extracts reaction data from comments (rocket, thumbs_up, confused) to determine triage/resolution state.
- Returns a typed response: `{ verdict, findings, comments }`.
- Owner/repo detection follows the same pattern as brrr: parse from `git remote get-url origin` (supports both SSH and HTTPS formats).

**Rocket Reaction Service (server service)**
- Adds rocket emoji reactions to inline review comments via `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content=rocket`.
- Removes rocket reactions via `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id} -X DELETE`.
- Thin stateless wrapper — GitHub is the source of truth.

**Review Pane (web component)**
- New pane type in the panel system, rendered identically to how diff pane works but as its own component.
- Always opens on the right side of the active pane (split-right behavior).
- Two grouped sections:
  - **Findings section**: Each finding rendered as a card with severity badge, file:line link, category tag, description, collapsible suggested fixes, checkbox for triage selection, and reaction state indicator.
  - **Comments section**: Each comment rendered with author avatar/name, body (rendered as markdown), file:line reference if it's an inline comment, and timestamp.
- Polls the server RPC every 30 seconds while mounted. Stops polling when unmounted.
- Provides a manual refresh button.
- "Fix Selected" action: adds rocket reactions to selected findings, then triggers `brrr.fix` RPC for the workspace.
- "Unqueue" action: removes rocket reaction from a finding.

### Modified Modules

**Panel system**
- Add `review` to the `PaneType` union in the shared schema.
- Add panel action to open review pane for a workspace (split-right from active pane).
- Add keyboard shortcut for opening review pane.

**Workspace card**
- Add a verdict badge component next to the existing `GitHubPrStatusBadge`.
- Verdict data is fetched via a lightweight RPC that only extracts the `<!-- brrr-review -->` summary comment (not all findings). This avoids heavy API calls for every workspace card.
- Badge shows: green checkmark for approved, red X for needs_fix, nothing if no review has been run.

**Shared RPC contract**
- New RPCs:
  - `review.fetchComments` — payload: `{ workspaceId }`, returns full findings + comments + verdict.
  - `review.fetchVerdict` — payload: `{ workspaceId }`, returns only the verdict (for workspace card badge).
  - `review.addReaction` — payload: `{ workspaceId, commentId, content }`, returns the created reaction.
  - `review.removeReaction` — payload: `{ workspaceId, commentId, reactionId }`, returns void.
- New response schemas for `ReviewFinding`, `PrComment`, `ReviewVerdict`.

**Diff pane (cross-pane communication)**
- Add a mechanism for the review pane to send a "scroll to file:line" message to a diff pane showing the same workspace.
- Implementation: a shared context or event bus at the panel level that diff panes subscribe to.

### Data Flow

1. Review pane mounts → calls `review.fetchComments` RPC.
2. Server detects PR number for workspace (same as `brrr.review` handler), detects owner/repo from git remote.
3. Server calls `gh api` for issue comments and inline review comments (paginated).
4. Server parses markers, extracts findings/verdict/reactions, returns typed response.
5. Review pane renders grouped list. Starts 30s polling interval.
6. User selects findings → clicks "Fix Selected" → server calls `gh api` to add rocket reactions → server calls `brrr.fix` in workspace terminal.
7. Verdict badge on workspace card uses `review.fetchVerdict` (lighter call, only parses summary comment).

### Verdict Badge Data Source

The workspace card verdict badge uses `review.fetchVerdict` which only fetches issue comments (not inline review comments) and looks for the `<!-- brrr-review -->` marker. This is a much lighter API call than the full `review.fetchComments`. It can be polled at the same interval as the PrWatcher (5 seconds) or triggered when PrWatcher detects a state change.

## Testing Decisions

Good tests verify external behavior through the module's public interface without coupling to implementation details. They set up realistic inputs, call the public API, and assert on the outputs and observable side effects.

### PR Comment Fetcher Tests
- Test parsing of `<!-- brrr-finding:{json} -->` markers with valid JSON, malformed JSON, missing markers, multiple findings per comment.
- Test parsing of `<!-- brrr-review -->` summary comment for verdict extraction (approved, needs_fix, missing).
- Test reaction state extraction (rocket present, thumbs_up present, confused present, no reactions).
- Test handling of mixed comment types (some with findings, some without, human comments interleaved).
- Test owner/repo detection from various git remote URL formats (SSH, HTTPS, with/without .git suffix).
- Test pagination handling (mock `gh` output with multiple pages).
- Test error cases: `gh` not found, auth failure, rate limiting, network error.
- Prior art: `packages/server/test/github-task-importer.test.ts` (similar `gh` CLI mocking pattern), `packages/server/test/linear-task-importer.test.ts`.

### Review Pane Tests
- Test rendering of findings with all severity levels and correct badge colors.
- Test rendering of regular comments with author info and body.
- Test checkbox selection and "Fix Selected" button state (disabled when none selected, shows count).
- Test empty state when no PR exists.
- Test loading state while fetch is pending.
- Test error state on API failure.
- Test that file:line links trigger editor.open.
- Prior art: `apps/web/test/workspace-plan-scope.test.tsx`, `apps/web/test/review-pr-form.test.tsx`.

### Rocket Reaction Service Tests
- Test add reaction calls correct `gh api` endpoint with correct parameters.
- Test remove reaction calls correct `gh api` endpoint.
- Test error handling for failed API calls.
- Prior art: `packages/server/test/rpc/terminal-rlph-management.test.ts` (similar RPC handler testing pattern).

### Panel System Tests
- Test that review pane type is accepted in panel layout.
- Test split-right behavior when opening review pane.
- Prior art: `apps/web/test/panel-layout.test.tsx`.

## Out of Scope

- **Storing findings in LiveStore** — GitHub is the source of truth. Findings are fetched fresh each time and not persisted locally.
- **Overlaying findings on the diff pane** — The diff pane and review pane are separate. Clicking a finding scrolls the diff pane, but findings are not rendered inline on the diff.
- **Custom review phase configuration UI** — Users cannot configure which review phases brrr runs or what models they use from within Laborer.
- **Prompt override UI** — Users cannot edit brrr's prompt templates from within Laborer.
- **Continuous loop mode** — The ability to run brrr in continuous mode is a separate feature.
- **`brrr init` setup wizard** — Guided setup for task sources is a separate feature.
- **`brrr prd` integration** — AI-assisted PRD drafting is a separate feature.
- **Resolving/unresolving GitHub review threads** — Laborer shows resolution state but does not modify it.
- **Creating new review comments** — Laborer is read-only for comments; it shows what's on GitHub but doesn't let users write new review comments.

## Further Notes

- brrr embeds machine-readable JSON in every inline finding comment using `<!-- brrr-finding:{serialized ReviewFinding JSON} -->`. This is the primary data source for structured findings. The human-readable text in the same comment is a rendering of the same data and can be ignored when the marker is present.
- brrr's summary comment uses the `<!-- brrr-review -->` marker for idempotent upsert. There will only be one such comment per PR (brrr overwrites it on each review run). This is the data source for the verdict badge.
- The rocket reaction convention is brrr's native triage mechanism: rocket = queued for fix, thumbs-up = fixed, confused = won't fix. Laborer should display these states and only manage the rocket reaction. The thumbs-up and confused reactions are managed by brrr fix itself.
- The `gh` CLI must be authenticated for all of this to work. Error messages should guide the user to run `gh auth login` if authentication fails.
- Rate limiting: GitHub's API allows 5,000 requests/hour for authenticated users. At 30s polling with ~2 API calls per poll, a single open review pane uses ~240 calls/hour. This is well within limits even with multiple panes open.
