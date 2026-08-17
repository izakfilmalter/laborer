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

import {
  buildWorkspaceTree,
  type WorkspaceTreeNode,
} from '@laborer/shared/workspace-tree'
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
import { ChevronRight, GitBranch, GitBranchPlus } from 'lucide-react'
import { useMemo } from 'react'
import { CardShell } from '@/components/card-shell'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import {
  WorkspaceCard,
  type WorkspaceCardWorkspace,
} from '@/components/workspace-card'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import type {
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
} from '@/hooks/use-create-workspace'
import {
  type CollapseState,
  useWorkspaceGroupCollapseState,
} from '@/hooks/use-project-collapse-state'

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

  // Filter out destroyed workspaces, scoped to the given project
  const activeWorkspaces = useMemo(
    () =>
      workspaceList.filter(
        (ws) => ws.status !== 'destroyed' && ws.projectId === projectId
      ),
    [workspaceList, projectId]
  )

  // The database owns promotion on parent deletion (`ON DELETE SET NULL`).
  // The root workspace (the main checkout, worktreePath === rootPath) is
  // always pinned to the top of the tree.
  const workspaceTree = useMemo(() => {
    const tree = buildWorkspaceTree<WorkspaceTreeRow>(activeWorkspaces)
    const rootNodes = tree.filter(
      (node) => node.workspace.worktreePath === rootPath
    )
    const otherNodes = tree.filter(
      (node) => node.workspace.worktreePath !== rootPath
    )
    return [...rootNodes, ...otherNodes]
  }, [activeWorkspaces, rootPath])

  if (activeWorkspaces.length === 0 && pendingCreations.length === 0) {
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
      {workspaceTree.map((node) => (
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
    </div>
  )
}

export { WorkspaceList }
