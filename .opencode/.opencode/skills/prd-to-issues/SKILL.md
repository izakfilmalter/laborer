---
name: prd-to-issues
description: Use this skill when converting a PRD into a list of issues.
---

# PRD to Issues

Break a PRD into independently-grabbable issues using vertical slices (tracer bullets).

## Process

### 1. Locate the PRD

Ask the user for the PRD. Use `laborer_list_prds` to show available PRDs, then use `laborer_read_prd` (by id or title) to read and internalize the full PRD content.

### 2. Explore the codebase

Read the key modules and integration layers referenced in the PRD. Identify:

- The distinct integration layers the feature touches (e.g. DB/schema, API/backend, UI, tests, config)
- Existing patterns for similar features
- Natural seams where work can be parallelized

### 3. Draft vertical slices

Break the PRD into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- The first slice should be the simplest possible end-to-end path (the "hello world" tracer bullet)
- Later slices add breadth: edge cases, additional user stories, polish
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Layers touched**: which integration layers this slice cuts through
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories from the PRD this addresses

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Is the ordering right for the first tracer bullet?
- Are there any slices missing?

Iterate until the user approves the breakdown.

### 5. Create the issues

For each approved slice, use the `laborer_create_issue` MCP tool to create an issue. Pass the PRD's id as `prdId`, a short descriptive title, and the issue body using the template below.

Create issues in dependency order (blockers first) so you can reference real issue titles in the "Blocked by" field.

You can use `laborer_read_issues` to review all issues for a PRD, `laborer_list_remaining_issues` to see pending/in-progress issues, and `laborer_update_issue` to modify an issue's body or status.

<issue-template>
## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation. Reference specific sections of the parent PRD rather than duplicating content.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- Blocked by "<issue-title>" (if any)

Or "None - can start immediately" if no blockers.

## User stories addressed

Reference by number from the parent PRD:

- User story 3
- User story 7
</issue-template>

After creating all issues, print a summary table:

```
| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Basic widget creation | None | Ready |
| 2 | Widget listing | Basic widget creation | Blocked |
```

Do NOT close or modify the parent PRD.