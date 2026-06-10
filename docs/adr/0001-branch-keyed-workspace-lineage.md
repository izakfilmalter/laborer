# Sub-workspace lineage is derived from branch names, not stored parent IDs

A sub-workspace stores only `baseBranch` — the branch its PR targets, captured from the parent workspace at creation time. There is no `parentWorkspaceId`. The sidebar tree is derived at render time by matching `baseBranch` against live workspaces' `branchName`.

## Why

Workspaces are destroyable while branches live on. A stored parent ID dangles the moment the parent workspace is destroyed, and stays wrong if a workspace is later recreated on the same branch (new workspace, new ID — children would not re-link). Branch names are what git and GitHub actually key PRs on, so they are the durable truth; deriving lineage from them makes destruction and recreation non-events.

## Consequences

- Destroying a parent workspace is allowed and unceremonious: its children render top-level once no live workspace owns their base branch. (Destroyed workspaces leave no record — `v1.WorkspaceDestroyed` deletes the row — so there is nothing to chain-walk; in practice children are merged and destroyed before their parent.)
- Recreating a workspace on an existing branch automatically re-adopts its children, with no relinking logic.
- Renaming a parent's branch leaves children's `baseBranch` stale — but a rename breaks the GitHub PR base relationship too, so the stale link is telling the truth. A rename cascade can be added later if it ever matters.
