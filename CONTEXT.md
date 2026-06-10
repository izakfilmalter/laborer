# Laborer

Mission control for parallel AI coding agents. Each agent works in an isolated git-worktree-based workspace with its own terminals, diff viewer, and PR tracking.

## Language

**Project**:
A git repository registered in Laborer. Owns workspaces, plans, and tasks.

**Workspace**:
An isolated working environment for a branch, backed by a git worktree, with its own terminals and PR tracking.
_Avoid_: Worktree (that's the git mechanism, not the Laborer concept)

**Root workspace**:
The workspace whose worktree is the main git checkout of the project (`worktreePath === repoPath`). Cannot be destroyed.

**Sub-workspace**:
A workspace created from another workspace's branch rather than the repo's default branch. Its PR targets its base branch. Identified solely by having a base branch; there is no stored parent link.
_Avoid_: Nested workspace, child workspace (as a schema term)

**Parent workspace**:
The live workspace whose branch name matches a sub-workspace's base branch. A display-time derivation, not a stored relationship; when no live workspace owns that branch, the sub-workspace has no parent.

**Base branch**:
The branch a workspace's PR targets. For ordinary workspaces this is the repo's default branch (stored as nothing); for sub-workspaces it is the parent workspace's branch captured at creation time. Durable — survives parent workspace destruction.
_Avoid_: Target branch

**Base SHA**:
The commit SHA used as the base for a workspace's diff view. Captured at worktree creation. Distinct from base branch.

**Origin**:
How a workspace came to exist: `laborer` (created by the app) or `external` (a pre-existing worktree detected on disk).

**Diff Viewer**:
The read-only pane showing a workspace's changes against its base SHA. Purely visual — it never modifies the diff, files, or worktree. Its only interactions are navigational (open in editor, scroll to a file/line).

**Panel type picker**:
The transient chooser used to select what kind of pane to create or assign when opening a new split or panel tab.

**Terminal**:
A long-lived shell process owned by a workspace, in which agents run. It exists independently of any UI viewing it and must keep making progress while unwatched.

**Terminal pane**:
A view of a terminal in the panel layout. Panes come and go (open, close, fullscreen, workspace switches) without affecting the terminal itself; several panes can view one terminal.
_Avoid_: Using "terminal" for the view

**Detached terminal**:
A terminal no pane is currently viewing. Detached terminals are first-class: agents inside them are expected to continue working at full speed.
