# Laborer

Laborer turns Slack conversations into invocations of user-controlled local programs and carries their deliberate replies back to Slack.

## Language

**Laborer**:
The generic bridge that accepts work through Slack, invokes user-controlled local programs, and carries their deliberate replies back to the conversation. Laborer does not own the meaning or workflow of the work. The new Slack-native Laborer supersedes the legacy personal mission-control app.

**Laborer Slack app**:
Laborer's conversational identity in Slack. People mention it in a conversation and receive its updates there.

**Laborer Runner**:
The local service that receives work-thread events and invokes the configured work handler. One Runner is bound to one Laborer root.

**Laborer root**:
The directory that binds a Laborer Runner to its configuration and work handler. It is the handler's initial working directory and does not need to be a Git repository.

**Work thread**:
A Slack channel thread accepted by Laborer as a unit of work and delivered to one configured work handler over a sequence of turns. Its identity is bound to the canonical Slack thread root, and it remains active indefinitely after activation.

**Activation**:
The first newly created, nonblank text message that explicitly mentions Laborer and asks it to accept a public or private channel thread as a work thread. Any human or external bot may activate Laborer from a channel root or existing thread reply; Laborer's own messages, edits, and direct messages cannot. After activation, authored text replies under the canonical root become handler input without another mention, while unrelated channel roots remain outside the work thread.

**Historical context**:
One-time Slack conversation context included in a work thread's first turn. A root activation receives the ten preceding top-level channel messages without expanding their threads. A reply activation receives the canonical root and earlier replies through the activating reply. Context is distinguished from input and is not replayed in later turns.

**Normalized message**:
The narrow text-oriented record Laborer presents to a work handler. It carries a stable identity, context-or-input classification, activation marker, author kind and Slack ID, original Slack timestamp, and verbatim Slack `mrkdwn` text. Laborer excludes its own messages, textless rich content, system notices, edits, deletions, and reactions; it does not resolve display names or expose raw Slack payloads.

**Work handler**:
The user-supplied local program Laborer invokes for a work thread. Its configuration specifies what to run from the Laborer root. It owns all workflow-specific behavior, resources, and continuation state, including any worktrees it creates.

**Turn**:
One serialized batch of work-thread input delivered to a work handler. A turn has one stable identity across replay attempts, and a known handler outcome permanently consumes its assigned input.

**Turn attempt**:
One invocation of a work handler for a turn. An attempt interrupted by a Runner shutdown or crash is replayed automatically as a new attempt of the same turn; a known handler failure is not retried automatically.

**Settled turn**:
A turn whose handler has a known terminal outcome and whose accepted outbound items have all been delivered or explicitly abandoned. Only a settled turn permits the next queued turn in its work thread to start.

**Handler invocation**:
The temporary local process that executes one turn. It exits when the turn finishes; an idle work thread consumes no running handler process.

**Handler state directory**:
A stable filesystem directory Laborer assigns to one work thread and presents to its work handler on every turn. Laborer manages the directory's identity and location but treats its contents as opaque handler-owned state.

**Public reply**:
A conversational message the work handler explicitly chooses to send by emitting a public-reply protocol record. Laborer binds it to the work thread and posts it as the Laborer Slack app. Public replies are ordered, append-only, and the only handler-authored output shown in Slack; internal output remains private.

**Operational notice**:
A sanitized, Laborer-authored Slack message reporting that a turn or reply failed. Operational notices identify the turn and failure category without exposing handler output, commands, paths, environment, stack traces, or credentials. They exist because Slack is the prototype's primary interface.

**Outbound item**:
A durable, ordered Slack message awaiting delivery for a turn. Public replies and operational notices use the same outbox and may be pending, delivering, delivered, or blocked. A permanently blocked head item pauses only its work thread until a local operator retries or abandons it.

**Durable snapshot**:
The Runner-owned, versioned record of accepted inbound identities, work-thread queues, turns, attempts, sanitized outcomes, and outbound delivery state. The prototype stores one atomic filesystem JSON snapshot per Runner, retains it indefinitely, and fails closed rather than inferring or resetting corrupt or unwritable state. Handler state-directory contents and raw process output are not part of the snapshot.

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
