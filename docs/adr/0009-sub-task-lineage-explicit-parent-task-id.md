# Sub-task lineage is a stored parent task ID

Supersedes [ADR 0001](0001-branch-keyed-workspace-lineage.md).

A sub-task stores an explicit `parent_task_id` referencing its parent task. `base_branch` remains on the task but demotes to a snapshotted git detail — captured from the parent's branch at creation time and used for PR targeting and diff bases — no longer the source of lineage. The sidebar tree renders from `parent_task_id`; nesting depth is arbitrary.

## Why

ADR 0001 derived lineage from branch names because workspaces were destroyable while branches lived on: a stored parent ID would dangle when the parent workspace was destroyed, and recreation minted a new ID that children could not re-link to. That model died with the LiveStore removal. The persisted entity is now the **task** — durable, with at most one worktree whose lifecycle is independent of the task's identity. Tasks are not destroyed when their worktree goes away, so the dangling-parent problem ADR 0001 was built around no longer exists. A stored parent ID is the direct domain fact (this task splits that one, its PR stacks onto that one's branch), where branch matching was an inference that broke on renames and on tasks that share branch names across projects.

## Consequences

- `parent_task_id` is a self-referencing foreign key with `ON DELETE SET NULL`, so parent deletion promoting children to top-level is a database guarantee, not application logic. Deletion is never blocked by children.
- Sub-tasks are independent kanban cards carrying a badge linking back to the parent; the sidebar tree shows the hierarchy.
- The purpose is stacked PRs: a child's PR merges into the parent's branch, splitting work into small reviewable chunks without scope-creeping the parent's open PR.
- Renaming a parent's branch leaves children's snapshotted `base_branch` stale — but a rename breaks the GitHub PR base relationship too, so the stale value is telling the truth, exactly as under ADR 0001. Lineage itself (the tree) is unaffected by renames now.
- Recreating a worktree for a parent task is a non-event: lineage keys on the task row, which never changed.
