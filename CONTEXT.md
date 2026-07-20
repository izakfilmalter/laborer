# Laborer

Laborer turns Slack conversations into invocations of user-controlled local programs and carries their deliberate replies back to Slack.

## Language

**Laborer**:
The generic bridge that accepts work through Slack, invokes user-controlled local programs, and carries their deliberate replies back to the conversation. Laborer does not own the meaning or workflow of the work. The new Slack-native Laborer supersedes the legacy personal mission-control app.

**Laborer Slack app**:
Laborer's conversational identity in Slack. People mention it in a conversation and receive its updates there.

**Laborer Runner**:
The local service that receives work-thread events and invokes the configured work handler.

**Work thread**:
A Slack thread accepted by Laborer as a unit of work and delivered to one configured work handler over a sequence of turns.

**Activation**:
The first mention that asks Laborer to accept a Slack thread as a work thread. For the prototype, any Slack message may activate Laborer, regardless of sender. After activation, every new message except Laborer's own becomes handler input without requiring another mention.

**Work handler**:
The user-supplied local program Laborer invokes for a work thread. Its configuration specifies what to run and where to run it. It owns all workflow-specific behavior, resources, and continuation state.

**Turn**:
One serialized batch of work-thread input delivered to a work handler.

**Handler invocation**:
The temporary local process that executes one turn. It exits when the turn finishes; an idle work thread consumes no running handler process.

**Public reply**:
A conversational message the work handler explicitly chooses to send to its work thread. Public replies are the only handler-authored output shown in Slack; internal output remains private.

The following terms belong to the first intended coding-workflow use case, not to Laborer's generic core.

**Intake pass**:
A short-lived agent pass owned by a work handler that reads an activation's context, classifies the requested work, and prepares a brief for another agent. It is not part of Laborer.

**Bug**:
Existing or promised behavior producing the wrong result.

**Feature**:
Net-new or intentionally changed behavior.

**Agent session**:
An optional durable conversational identity managed by a work handler. Laborer treats agent choice and session continuation as handler concerns.

**Legacy Laborer app**:
The personal mission-control app being superseded. The remaining workspace, terminal, and panel vocabulary below describes this legacy app and may be reused by coding work handlers.

**Project**:
A git repository registered in the Legacy Laborer app. Owns workspaces, plans, and tasks.

**Workspace**:
An isolated working environment for a branch, backed by a git worktree, with its own terminals and PR tracking.
_Avoid_: Worktree (that's the git mechanism, not the Laborer concept)

**Setup script**:
A project-provided script that prepares a newly created workspace.

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

**Restored terminal**:
A terminal the terminal service brought back from persisted state after a restart, keeping its original identity.
_Avoid_: Respawned terminal (that's a replacement with a new identity)

**Adoption**:
Re-attaching the UI to a live or restored terminal by its ID after a service restart. The opposite of respawning; adoption is always preferred when the terminal still exists.

**Spawn intent**:
What a terminal pane is meant to launch (agent CLI or plain shell), persisted with the layout so a replacement terminal keeps the pane's identity.

**Orphan**:
A freshly spawned terminal that no client ever claimed. Only orphans may be reaped on a timer; a terminal that was claimed once is never an orphan, no matter how long it goes unwatched.
_Avoid_: Calling detached or restored terminals orphans
