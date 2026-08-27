/**
 * Workspace list UI component.
 *
 * Displays a reactive list of task-backed workspaces from the combined stream,
 * arranged as a tree of sub-workspace groups. Each workspace is a
 * `WorkspaceCard` — the same card the kanban board shows for work that has a
 * workspace — so this module owns the arrangement, not the card.
 *
 * Updates reactively when task state changes.
 *
 * When no workspaces exist (all destroyed or none created), shows an empty
 * state with guidance text and a CTA button to create the first workspace.
 *
 * Accepts a required `projectId` prop to scope workspaces to a single project.
 *
 * @see Issue #41: Workspace list UI component
 * @see Issue #48: Destroy Workspace button + confirmation dialog
 * @see Issue #119: Empty state — no workspaces
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #113: Project switcher — filter workspaces by active project
 * @see Issue #160: UI for detected workspaces
 */

import type { OpenPullRequest } from '@laborer/shared/rpc'
import {
  buildWorkspaceTree,
  type WorkspaceTreeNode,
} from '@laborer/shared/workspace-tree'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@laborer/ui/components/avatar'
import { Badge } from '@laborer/ui/components/badge'
import { Button } from '@laborer/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@laborer/ui/components/collapsible'
import { DialogTrigger } from '@laborer/ui/components/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { Spinner } from '@laborer/ui/components/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { useLiveQuery } from '@tanstack/react-db'
import {
  ChevronRight,
  CloudDownload,
  GitBranch,
  GitBranchPlus,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { CardShell } from '@/components/card-shell'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import { PullRequestCard } from '@/components/pull-request-card'
import {
  WorkspaceCard,
  type WorkspaceCardWorkspace,
} from '@/components/workspace-card'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { orderedWorkspaceViews } from '@/db/workspace-order'
import type {
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
} from '@/hooks/use-create-workspace'
import { useCreateWorkspace } from '@/hooks/use-create-workspace'
import { useCurrentGithubLogin } from '@/hooks/use-current-github-login'
import {
  authorGroupKey,
  type CollapseState,
  useWorkspaceGroupCollapseState,
} from '@/hooks/use-project-collapse-state'
import { useProjectPullRequests } from '@/hooks/use-project-pull-requests'
import { toast } from '@/lib/toast'

interface WorkspaceListProps {
  /** Reports pending sub-workspace creation changes to the project group. */
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  /** Temporary workspace items shown while planning or creation is in flight. */
  readonly pendingCreations?: readonly PendingWorkspaceCreation[] | undefined
  /** Only workspaces belonging to this project are shown. */
  readonly projectId: string
  /** The project name, used by the sub-workspace creation dialog. */
  readonly projectName: string
  readonly projectShortName?: string | null | undefined
  /**
   * The canonical Project root path used to identify the root workspace.
   * The root workspace is the one where worktreePath matches this path.
   */
  readonly rootPath: string
}

/** Workspace row shape used by the sidebar tree. */
type WorkspaceTreeRow = WorkspaceCardWorkspace & {
  readonly parentTaskId: string | null
  readonly prAuthorLogin: string | null
}

/**
 * One author's work, gathered under a heading bearing their login.
 *
 * Two halves of the same question. `nodes` is what has been pulled in and has
 * a worktree; `remotePullRequests` is what they have open that has not. A
 * heading that showed only the first would quietly answer "what do I have of
 * theirs" when the question being asked is "what do they have".
 */
interface AuthorGroup {
  readonly login: string
  readonly nodes: readonly WorkspaceTreeNode<WorkspaceTreeRow>[]
  readonly remotePullRequests: readonly OpenPullRequest[]
}

/**
 * Every branch name anywhere in a tree, including nested sub-workspaces.
 *
 * A pull request whose branch is checked out as somebody's sub-workspace is
 * still checked out, so the whole lineage is walked rather than just its top.
 */
const collectBranchNames = (
  nodes: readonly WorkspaceTreeNode<WorkspaceTreeRow>[],
  into: Set<string>
): Set<string> => {
  for (const node of nodes) {
    into.add(node.workspace.branchName)
    collectBranchNames(node.children, into)
  }
  return into
}

/**
 * Split top-level tree nodes into the reviewer's own list and one group per
 * other author.
 *
 * Only the top of each stack is consulted. A sub-workspace of somebody else's
 * branch is normally the reviewer's own fix-up commit for that pull request,
 * so it belongs beside the branch it patches rather than pulled out into its
 * own list — which is precisely the collecting this grouping exists to do.
 *
 * A null `viewerLogin` means "we do not yet know who I am". Everything
 * attributed still groups, which stays truthful; the reviewer's own branches
 * simply fold into a group of their own name until the login resolves.
 */
const partitionByAuthor = (
  nodes: readonly WorkspaceTreeNode<WorkspaceTreeRow>[],
  viewerLogin: string | null,
  pullRequests: readonly OpenPullRequest[] = []
): {
  readonly authorGroups: readonly AuthorGroup[]
  readonly ownNodes: readonly WorkspaceTreeNode<WorkspaceTreeRow>[]
} => {
  const ownNodes: WorkspaceTreeNode<WorkspaceTreeRow>[] = []
  const byAuthor = new Map<string, WorkspaceTreeNode<WorkspaceTreeRow>[]>()

  for (const node of nodes) {
    const login = node.workspace.prAuthorLogin
    // An unattributed branch — no pull request, or one we have not read yet —
    // stays where it has always been rather than being filed under a guess.
    if (login === null || login === viewerLogin) {
      ownNodes.push(node)
      continue
    }
    const existing = byAuthor.get(login)
    if (existing === undefined) {
      byAuthor.set(login, [node])
    } else {
      existing.push(node)
    }
  }

  // A pull request already checked out is the card above, not a second entry
  // for the same branch. Matching on branch name is what "pulled in" means
  // here: creation reuses the branch on origin, so the worktree carries it.
  const localBranchNames = collectBranchNames(nodes, new Set<string>())
  const remoteByAuthor = new Map<string, OpenPullRequest[]>()

  for (const pullRequest of pullRequests) {
    if (
      pullRequest.authorLogin === viewerLogin ||
      localBranchNames.has(pullRequest.branchName)
    ) {
      continue
    }
    const existing = remoteByAuthor.get(pullRequest.authorLogin)
    if (existing === undefined) {
      remoteByAuthor.set(pullRequest.authorLogin, [pullRequest])
    } else {
      existing.push(pullRequest)
    }
  }

  const logins = new Set([...byAuthor.keys(), ...remoteByAuthor.keys()])
  const authorGroups = [...logins]
    .map(
      (login): AuthorGroup => ({
        login,
        nodes: byAuthor.get(login) ?? [],
        // Newest first: the pull request somebody just opened is the one a
        // reviewer is being asked about.
        remotePullRequests: [...(remoteByAuthor.get(login) ?? [])].sort(
          (left, right) => right.number - left.number
        ),
      })
    )
    .sort((left, right) => left.login.localeCompare(right.login))

  return { authorGroups, ownNodes }
}

interface WorkspaceTreeGroupProps {
  readonly collapseState: CollapseState
  readonly node: WorkspaceTreeNode<WorkspaceTreeRow>
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectName: string
  readonly projectShortName?: string | null | undefined
  readonly rootPath: string
}

/**
 * Renders one node of the workspace tree. Childless workspaces render as a
 * plain card. A workspace with sub-workspaces gets a thin, collapsible,
 * branch-named group header wrapping its own card plus its children —
 * recursively, so stacks can nest arbitrarily deep.
 *
 * Lineage is the persisted parent task relationship (ADR 0009). A deleted
 * parent disappears from the stream after SQLite promotes its children.
 */
function WorkspaceTreeGroup({
  node,
  collapseState,
  onPendingCreationChange,
  projectName,
  projectShortName,
  rootPath,
}: WorkspaceTreeGroupProps) {
  const { workspace, children } = node

  const card = (
    <WorkspaceCard
      isRootWorkspace={workspace.worktreePath === rootPath}
      onPendingCreationChange={onPendingCreationChange}
      projectName={projectName}
      projectShortName={projectShortName}
      showCreateSubWorkspaceAction={children.length === 0}
      workspace={workspace}
    />
  )

  if (children.length === 0) {
    return card
  }

  const groupKey = workspace.id
  const expanded = collapseState.isExpanded(groupKey)

  return (
    <Collapsible open={expanded}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-medium text-muted-foreground text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          data-testid={`workspace-group-${workspace.branchName}`}
          onClick={() => collapseState.toggle(groupKey)}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <GitBranch className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-mono">
            {workspace.branchName}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">
            {children.length}
          </span>
        </CollapsibleTrigger>
        <CreateWorkspaceForm
          baseWorkspace={{
            id: workspace.id,
            branchName: workspace.branchName,
          }}
          onPendingCreationChange={onPendingCreationChange}
          projectId={workspace.projectId}
          projectName={projectName}
          trigger={
            <Tooltip>
              <TooltipTrigger
                render={
                  <DialogTrigger
                    render={
                      <Button
                        aria-label={`Create sub-workspace from ${workspace.branchName}`}
                        className="size-6"
                        size="icon-sm"
                        variant="ghost"
                      />
                    }
                  />
                }
              >
                <GitBranchPlus className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                Create sub-workspace from this branch
              </TooltipContent>
            </Tooltip>
          }
        />
      </div>
      <CollapsibleContent>
        <div className="mt-1 ml-1.5 grid gap-2 border-l pl-1.5">
          {card}
          {children.map((child) => (
            <WorkspaceTreeGroup
              collapseState={collapseState}
              key={child.workspace.id}
              node={child}
              onPendingCreationChange={onPendingCreationChange}
              projectName={projectName}
              projectShortName={projectShortName}
              rootPath={rootPath}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface AuthorWorkspaceGroupProps {
  readonly collapseState: CollapseState
  readonly group: AuthorGroup
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
  readonly projectName: string
  readonly projectShortName?: string | null | undefined
  readonly rootPath: string
}

/**
 * Check out every one of this author's pull requests that is not here yet.
 *
 * The per-card action is the honest unit of the operation, but a review pass
 * usually wants all of somebody's open work at once, and clicking down a list
 * of five is the same decision made five times. Creations are started
 * together and each reports its own outcome, because one branch failing to
 * check out says nothing about the other four.
 *
 * Renders nothing when the author has nothing outstanding — a button that can
 * only tell you it has no work to do is worse than no button.
 */
function PullInAuthorPullRequestsButton({
  login,
  onPendingCreationChange,
  projectId,
  pullRequests,
}: {
  readonly login: string
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
  readonly pullRequests: readonly OpenPullRequest[]
}) {
  const createWorkspace = useCreateWorkspace(onPendingCreationChange)
  const [isPulling, setIsPulling] = useState(false)

  if (pullRequests.length === 0) {
    return null
  }

  const label = `Pull in ${pullRequests.length} pull request${
    pullRequests.length === 1 ? '' : 's'
  } from ${login}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="shrink-0"
            disabled={isPulling}
            onClick={async () => {
              setIsPulling(true)
              const outcomes = await Promise.allSettled(
                pullRequests.map((pullRequest) =>
                  createWorkspace({
                    branchNameOrSlackUrl: pullRequest.branchName,
                    projectId,
                  })
                )
              )
              setIsPulling(false)

              const failed = outcomes.filter(
                (outcome) => outcome.status === 'rejected'
              )
              if (failed.length === 0) {
                toast.success(
                  `Pulling in ${outcomes.length} branch${
                    outcomes.length === 1 ? '' : 'es'
                  } from ${login}`
                )
                return
              }
              toast.error(
                `${failed.length} of ${outcomes.length} branches from ${login} could not be pulled in`
              )
            }}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {isPulling ? (
          <Spinner className="size-3.5" />
        ) : (
          <CloudDownload className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A collapsible heading gathering everything one other person has open.
 *
 * Sits below the reviewer's own workspaces because it is reference material
 * for a review pass, not the work in progress. Its count reads "checked out
 * of open" whenever the two differ, so the heading itself says whether the
 * list under it is the whole story.
 *
 * The trigger and the pull-in action are siblings rather than nested: a button
 * inside a button is invalid, and collapsing a group is not the same intent as
 * checking five branches out.
 */
function AuthorWorkspaceGroup({
  collapseState,
  group,
  onPendingCreationChange,
  projectId,
  projectName,
  projectShortName,
  rootPath,
}: AuthorWorkspaceGroupProps) {
  const groupKey = authorGroupKey(projectId, group.login)
  const expanded = collapseState.isExpanded(groupKey)
  const openCount = group.nodes.length + group.remotePullRequests.length

  return (
    <Collapsible open={expanded}>
      <div className="flex min-w-0 items-center gap-1">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-medium text-muted-foreground text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          data-testid={`workspace-author-group-${group.login}`}
          onClick={() => collapseState.toggle(groupKey)}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <Avatar className="size-4 shrink-0">
            <AvatarImage
              alt=""
              src={`https://github.com/${group.login}.png?s=32`}
            />
            <AvatarFallback className="text-[8px]">
              {group.login.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate">{group.login}</span>
          <span className="ml-auto shrink-0 tabular-nums">
            {group.remotePullRequests.length === 0
              ? openCount
              : `${group.nodes.length}/${openCount}`}
          </span>
        </CollapsibleTrigger>
        <PullInAuthorPullRequestsButton
          login={group.login}
          onPendingCreationChange={onPendingCreationChange}
          projectId={projectId}
          pullRequests={group.remotePullRequests}
        />
      </div>
      <CollapsibleContent>
        <div className="mt-1 ml-1.5 grid gap-2 border-l pl-1.5">
          {group.nodes.map((node) => (
            <WorkspaceTreeGroup
              collapseState={collapseState}
              key={node.workspace.id}
              node={node}
              onPendingCreationChange={onPendingCreationChange}
              projectName={projectName}
              projectShortName={projectShortName}
              rootPath={rootPath}
            />
          ))}
          {/* Below the checked-out branches: what is here comes first, what
              could be here follows. */}
          {group.remotePullRequests.map((pullRequest) => (
            <PullRequestCard
              key={pullRequest.url}
              onPendingCreationChange={onPendingCreationChange}
              projectId={projectId}
              pullRequest={pullRequest}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function PendingWorkspaceItem({
  creation,
}: {
  readonly creation: PendingWorkspaceCreation
}) {
  const isAnalyzing = creation.phase === 'analyzing'
  const branchLabel =
    creation.branchName ?? (isAnalyzing ? 'Slack workspace' : 'New workspace')
  const phaseLabel = isAnalyzing ? 'Reading Slack thread' : 'Creating workspace'

  return (
    <CardShell
      actions={
        <Badge
          className="shrink-0 border border-warning/30 bg-warning/10 text-warning"
          variant="outline"
        >
          <Spinner className="size-3" />
          {isAnalyzing ? 'planning' : 'creating'}
        </Badge>
      }
      aria-label={`${phaseLabel}: ${branchLabel}`}
      aria-live="polite"
      className="border-warning/30 bg-warning/5"
      data-testid={`pending-workspace-${creation.id}`}
      icon={<GitBranch className="size-4 shrink-0 text-muted-foreground" />}
      role="status"
      subtitle={<p className="text-muted-foreground text-xs">{phaseLabel}</p>}
      title={<span className="block truncate font-mono">{branchLabel}</span>}
    />
  )
}

function WorkspaceList({
  onPendingCreationChange,
  pendingCreations = [],
  projectId,
  projectName,
  projectShortName,
  rootPath,
}: WorkspaceListProps) {
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const workspaceList = useMemo(
    () => workspaceViewsFromRows(tasks, projects),
    [projects, tasks]
  )
  const collapseState = useWorkspaceGroupCollapseState()
  const viewerLogin = useCurrentGithubLogin()
  const pullRequests = useProjectPullRequests(projectId)

  // Filter out destroyed workspaces, scoped to the given project, and present
  // them oldest-first so newly created workspaces always land at the bottom.
  const activeWorkspaces = useMemo(
    () =>
      orderedWorkspaceViews(
        workspaceList.filter(
          (ws) => ws.status !== 'destroyed' && ws.projectId === projectId
        )
      ),
    [workspaceList, projectId]
  )

  // The database owns promotion on parent deletion (`ON DELETE SET NULL`).
  // Pull the root workspace out before building the lineage tree so even a
  // stale parentTaskId cannot nest the main checkout under another workspace.
  // Pending creations render separately above this tree while they are in
  // flight; within the workspace tree, the root is always first.
  const workspaceTree = useMemo(() => {
    const rootWorkspaces = activeWorkspaces.filter(
      (workspace) => workspace.worktreePath === rootPath
    )
    const otherWorkspaces = activeWorkspaces.filter(
      (workspace) => workspace.worktreePath !== rootPath
    )
    const rootNodes = rootWorkspaces.map(
      (workspace): WorkspaceTreeNode<WorkspaceTreeRow> => ({
        children: [],
        workspace,
      })
    )
    return [
      ...rootNodes,
      ...buildWorkspaceTree<WorkspaceTreeRow>(otherWorkspaces),
    ]
  }, [activeWorkspaces, rootPath])

  // Branches somebody else opened are pulled out into per-author groups below
  // the reviewer's own list. Nothing is hidden — the same nodes are rendered,
  // just gathered under the name they came from.
  const { authorGroups, ownNodes } = useMemo(
    () => partitionByAuthor(workspaceTree, viewerLogin, pullRequests),
    [workspaceTree, viewerLogin, pullRequests]
  )

  // Somebody else's open pull request is work this project has, even with no
  // worktree behind it, so a project whose only branch is the root checkout
  // is not empty once one exists.
  if (
    activeWorkspaces.length === 0 &&
    pendingCreations.length === 0 &&
    authorGroups.length === 0
  ) {
    return (
      <Empty className="py-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchPlus />
          </EmptyMedia>
          <EmptyTitle>No workspaces</EmptyTitle>
          <EmptyDescription>
            Create a workspace to start working on isolated branches with AI
            agents.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid gap-2">
      {pendingCreations.map((creation) => (
        <PendingWorkspaceItem creation={creation} key={creation.id} />
      ))}
      {ownNodes.map((node) => (
        <WorkspaceTreeGroup
          collapseState={collapseState}
          key={node.workspace.id}
          node={node}
          onPendingCreationChange={onPendingCreationChange}
          projectName={projectName}
          projectShortName={projectShortName}
          rootPath={rootPath}
        />
      ))}
      {authorGroups.map((group) => (
        <AuthorWorkspaceGroup
          collapseState={collapseState}
          group={group}
          key={group.login}
          onPendingCreationChange={onPendingCreationChange}
          projectId={projectId}
          projectName={projectName}
          projectShortName={projectShortName}
          rootPath={rootPath}
        />
      ))}
    </div>
  )
}

export { partitionByAuthor, WorkspaceList }
export type { AuthorGroup }
