# Laborer

Laborer turns Slack conversations into invocations of user-controlled local programs and carries their deliberate replies back to Slack.

## Language

**Laborer**:
The generic bridge that accepts work through Slack, invokes user-controlled local programs, and carries their deliberate replies back to the conversation. Laborer does not own the meaning or workflow of the work. The new Slack-native Laborer supersedes the legacy personal mission-control app.

**Laborer Slack app**:
Laborer's conversational identity in Slack. People mention it in a conversation and receive its updates there.

**Laborer daemon**:
The local Laborer service that connects the Laborer Slack app to one or more Slack workspaces and supervises their configured local runtimes. One daemon may serve several workspace bindings without merging their conversations or state.

**Laborer companion**:
The local macOS menu-bar application through which an operator observes the Laborer daemon and its current work. It is a client of the daemon and does not own work-thread or Execution state.
_Avoid_: Laborer app

**Slack workspace binding**:
The daemon-owned association from one authenticated Slack workspace installation to its local configuration, including the work handler's Laborer root. A binding selects local configuration; it does not define the conversation agent's workflow or choose repositories for it.

**Laborer root**:
The directory configured for a Slack workspace binding as the work handler's initial working directory. It carries no runtime-state or ownership semantics and does not need to be a Git repository.

**Laborer global config root**:
The user-owned directory containing only durable Markdown Agent context and its directory partitions. It is `~/.config/laborer` by default or `$XDG_CONFIG_HOME/laborer` when `XDG_CONFIG_HOME` is absolute and nonblank. It is outside every Laborer root: Souls are partitioned there by canonical Laborer-root identity, while Workspace memory and User profiles are partitioned by authenticated Slack workspace identity.

**Laborer global state root**:
The user-owned directory for the daemon's durable runtime state and cross-process Agent-context mutation locks. It is `~/.local/state/laborer` by default or `$XDG_STATE_HOME/laborer` when `XDG_STATE_HOME` is absolute and nonblank. Runtime state is partitioned by authenticated Slack workspace rather than by Laborer root; Workspace and User-profile locks are keyed by authenticated Slack workspace and target so different Laborer roots coordinate the same memory.

**Work thread**:
A Slack channel thread accepted by Laborer as a unit of work and delivered to one configured work handler over a sequence of turns. Its identity is bound to the canonical Slack thread root, and it remains active indefinitely after activation.

**In-progress work thread**:
A work thread with accepted work for which Laborer still owes progress, including any nonterminal Execution. This transient activity state does not affect whether the work thread remains activated.
_Avoid_: Active conversation

**Dormant work thread**:
A work thread that has responded to all accepted participant input and has no nonterminal Executions. Dormancy is transient: later participant input moves the still-activated work thread back into progress.

**Activation**:
The first newly created, nonblank text message that explicitly mentions Laborer and asks it to accept a public or private channel thread as a work thread. Any human or external bot may activate Laborer from a channel root or existing thread reply; Laborer's own messages, edits, and direct messages cannot. After activation, authored text replies under the canonical root become handler input without another mention, while unrelated channel roots remain outside the work thread.

**Historical context**:
One-time Slack conversation context included in a work thread's first turn. A root activation receives the ten preceding top-level channel messages without expanding their threads. A reply activation receives the canonical root and earlier replies through the activating reply. Context is distinguished from input and is not replayed in later turns.

**Normalized message**:
The narrow text-oriented record Laborer presents to a work handler. It carries a stable identity, context-or-input classification, activation marker, author kind and Slack ID, original Slack timestamp, and verbatim Slack `mrkdwn` text. Laborer excludes its own messages, textless rich content, system notices, edits, deletions, and reactions; it does not resolve display names or expose raw Slack payloads.

**Work handler**:
The user-supplied local program Laborer invokes for a work thread. Its configuration specifies what to run from the Laborer root. It owns all workflow-specific behavior, resources, and continuation state, including any worktrees it creates.

**Turn**:
One work-handler invocation over a work thread's latest accepted message together with the coalesced backlog of earlier messages that arrived while the previous turn ran. Turns are at-most-once: a failed or interrupted turn is not replayed, and recovery is a participant addressing Laborer again.

**Handler invocation**:
The temporary local process that executes one turn. It exits when the turn finishes; an idle work thread consumes no running handler process.

**Handler state directory**:
A stable filesystem directory Laborer assigns to one work thread and presents to its work handler on every turn. Laborer manages the directory's identity and location but treats its contents as opaque handler-owned state.

**Public reply**:
A conversational message the work handler explicitly chooses to send. Laborer binds it to the work thread and posts it as the Laborer Slack app on a best-effort basis. Public replies are the only handler-authored output shown in Slack; internal output remains private.

**Operational notice**:
A sanitized, Laborer-authored Slack message reporting that a turn failed. Operational notices identify the failure category without exposing handler output, commands, paths, environment, stack traces, or credentials. They are best-effort and are not durably queued.

The following terms belong to the first intended coding-workflow use case, not to Laborer's generic core.

**Conversation agent**:
A user-configured, general-purpose agent supervised by Laborer for one work thread. One work thread continues one durable agent session, retaining prior messages, tool activity, and operation results; within the authority granted by the user, the agent may answer, investigate, execute, modify, delegate, orchestrate, or invoke Actions as it chooses.

**Soul**:
The manually authored, Laborer-root-scoped character that guides a conversation agent's personality, voice, values, and behavioral boundaries. It is stored under the Laborer global config root using a stable identity derived from the canonical Laborer root, so path aliases share one Soul and distinct roots do not. A Soul is trusted guidance, is not changed by the conversation agent, and is snapshotted when an agent session begins so later edits affect only subsequently created agent sessions.

**Workspace memory**:
Durable, agent-curated knowledge shared across the conversation agent's work threads in one Slack workspace. It is stored under that Slack workspace's partition in the Laborer global config root, independently of the bound Laborer root. The conversation agent decides when information is worth retaining, while explicit requests to remember something make that information eligible for retention. Workspace memory provides context rather than instructions, does not cross Slack workspace boundaries even when workspace bindings share a Laborer root, and is snapshotted when an agent session begins so later changes affect only subsequently created agent sessions.

**User profile**:
Durable, agent-curated knowledge about a Slack participant that helps a conversation agent understand and respond to that person over time within one Slack workspace. Profiles are stored in the workspace's partition in the Laborer global config root and never cross Slack workspace boundaries. The conversation agent decides whom to profile and what relevant information to retain, including inferred information, and resolves contradictions using its own judgment. User profiles are silently maintained, provide context rather than instructions, and are snapshotted for a work thread when their participant first appears in it.

**Agent context snapshot**:
The context fixed for one agent session from the Soul and Workspace memory present when that session begins, together with each human participant's Slack display name and User profile when that participant first appears. Later changes apply only to subsequently created agent sessions or participants not yet introduced into the current session. If a work thread's agent session cannot be resumed and must be replaced, the replacement receives a new snapshot.

**Conversation-agent authority**:
The user alone determines what a conversation agent may do and which capabilities it can access, including shell execution, filesystem and network access, tools, skills, MCP servers, Actions, and orchestration. Laborer must never narrow, disable, hide, replace, or reinterpret those user-granted capabilities; Actions are additional capabilities, not the boundary of the agent's authority.
_Avoid_: Routing-only agent, restricted conversation agent, read-only conversation agent

**Conversation-agent message**:
Substantive Markdown authored by a conversation agent for the people in a work thread. Laborer streams each substantive message directly to Slack as it is produced and does not require the agent to wrap it in a structured reply record. Content already delivered remains visible if the agent later fails. A private silent completion is not a Conversation-agent message.

**Private silent completion**:
A Conversation response whose complete text is the exact case-sensitive token `NO_REPLY` with only surrounding ECMAScript whitespace. It is semantic completion output but is neither a Conversation-agent message nor public Slack output, and Laborer does not mark durable public output as observed for it. A substantive response that merely contains `NO_REPLY`, uses different casing, or includes any other non-whitespace text retains direct Conversation-agent message streaming semantics.

**Implementation agent**:
An agent that performs the work of an Execution on behalf of a conversation agent. It may exchange Execution updates and Execution follow-ups with the conversation agent, but it does not author public Slack messages directly.

**Action**:
A user-defined, named operation made available to a conversation agent. The same Action definition may support both direct human invocation and agent invocation. Actions remain user-owned and never publish directly to Slack.

**Execution**:
One invocation of an Action for a work thread. An Execution has its own lifecycle and remains nonterminal while Laborer is waiting for that invocation to finish.

**Execution update**:
Nonterminal information from an ongoing Execution that helps a conversation agent reassure people that work continues and explain how it is developing. An implementation agent may volunteer an update at a time and with content of its choosing, or provide one when the conversation agent asks. An update belongs to one Execution, including when several Executions share a work thread. It becomes new input for the conversation agent without requiring another participant message. The conversation agent decides whether and how to respond, including whether to express it publicly while preserving its factual meaning.

**Execution follow-up**:
A question or interpreted instruction that a conversation agent directs to an ongoing Execution. It may request status, answer an implementation agent's question, or steer the work. The conversation agent derives a follow-up from the work-thread conversation rather than forwarding a participant's raw message, and ordinary conversation may continue while the Execution runs.

**Intake pass**:
A short-lived agent pass owned by a work handler that reads an activation's context, classifies the requested work, and prepares a brief for another agent. It is not part of Laborer.

**Bug**:
Existing or promised behavior producing the wrong result.

**Feature**:
Net-new or intentionally changed behavior.

**Agent session**:
An optional durable conversational identity managed by a work handler. The current conversation agent binds one agent session to each work thread and minimally resumes it across daemon restarts; Laborer otherwise treats agent choice and session continuation as handler concerns.

**Legacy Laborer app**:
The personal mission-control app being superseded. The remaining workspace, terminal, and panel vocabulary below describes this legacy app and may be reused by coding work handlers.

**Project**:
A git repository registered in the Legacy Laborer app. Owns workspaces.

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

**Agent status**:
The semantic state of the agent running in a terminal: working, needs input, idle, or unknown. An agent error surfaces as needs input.
_Avoid_: Active, waiting-for-input (the legacy two-value signal)

**Seen**:
Whether the operator has viewed a terminal since its agent last became idle. Viewing the terminal's workspace in a focused window marks it seen.

**Done**:
The display state of an idle, unseen terminal — the agent finished while nobody was watching. Done is derived from idle plus unseen; it is never stored and never reported by a detector.
_Avoid_: Completed (as a stored agent status)

**Attention**:
The agent states that ask for operator notice: needs input and done. Attention ranks a terminal above working and idle in UI emphasis and is what notifications announce.
