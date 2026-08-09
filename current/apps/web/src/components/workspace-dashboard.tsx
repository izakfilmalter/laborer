/**
 * Cross-project workspace dashboard component.
 *
 * Provides a high-level overview of all workspaces across all projects
 * with their status. Gives the developer a command-center view of what's
 * happening across their entire development environment.
 *
 * Per-project sections show:
 * - Project name and repo path
 * - All workspaces for that project with status badges, branch names,
 *   and terminal counts
 *
 * Workspace data comes from LiveStore queries. Terminal counts come from
 * the terminal service via the `useTerminalList` polling hook.
 *
 * @see Issue #114: Cross-project workspace dashboard
 * @see Issue #144: Web app LiveStore terminal query replacement
 * @see Issue #160: UI for detected workspaces
 */

import { projects, workspaces } from '@laborer/shared/schema'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { FolderGit2, GitBranch, LayoutDashboard } from 'lucide-react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { cn } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'

/** LiveStore queries for dashboard data. */
const dashboardProjects$ = queryDb(projects, { label: 'dashboardProjects' })
const dashboardWorkspaces$ = queryDb(workspaces, {
  label: 'dashboardWorkspaces',
})

type WorkspaceStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'errored'
  | 'destroyed'

/** Returns Tailwind classes for a workspace status badge. */
function getStatusClasses(status: string): string {
  switch (status as WorkspaceStatus) {
    case 'creating':
      return 'border-warning/30 bg-warning/10 text-warning'
    case 'running':
      return 'border-success/30 bg-success/10 text-success'
    case 'stopped':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    case 'errored':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'destroyed':
      return 'border-muted-foreground/20 bg-muted/50 text-muted-foreground/60'
    default:
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
  }
}

/** Small colored status indicator dot / spinner. */
function StatusDot({ status }: { readonly status: string }) {
  if (status === 'creating') {
    return <Spinner className="size-3 text-warning" />
  }

  const dotColor = (() => {
    switch (status as WorkspaceStatus) {
      case 'running':
        return 'bg-success'
      case 'stopped':
        return 'bg-muted-foreground/50'
      case 'errored':
        return 'bg-destructive'
      case 'destroyed':
        return 'bg-muted-foreground/30'
      default:
        return 'bg-muted-foreground/50'
    }
  })()

  return <span className={cn('inline-block size-2 rounded-full', dotColor)} />
}

/** Per-project workspace status summary counts. */
interface WorkspaceCounts {
  readonly creating: number
  readonly errored: number
  readonly running: number
  readonly stopped: number
  readonly total: number
}

/** Aggregate workspace counts from a filtered workspace list. */
function computeWorkspaceCounts(
  wsList: ReadonlyArray<{ readonly status: string }>
): WorkspaceCounts {
  let running = 0
  let creating = 0
  let stopped = 0
  let errored = 0
  for (const ws of wsList) {
    switch (ws.status as WorkspaceStatus) {
      case 'running':
        running++
        break
      case 'creating':
        creating++
        break
      case 'stopped':
        stopped++
        break
      case 'errored':
        errored++
        break
      default:
        break
    }
  }
  return { running, creating, stopped, errored, total: wsList.length }
}

/** Compact workspace status summary. */
function WorkspaceStatusSummary({
  counts,
}: {
  readonly counts: WorkspaceCounts
}) {
  if (counts.total === 0) {
    return <span className="text-muted-foreground text-xs">No workspaces</span>
  }

  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {counts.running > 0 && (
        <span className="flex items-center gap-1 text-success">
          <span className="inline-block size-2 rounded-full bg-success" />
          {counts.running} running
        </span>
      )}
      {counts.creating > 0 && (
        <span className="flex items-center gap-1 text-warning">
          <Spinner className="size-3" />
          {counts.creating} creating
        </span>
      )}
      {counts.errored > 0 && (
        <span className="flex items-center gap-1 text-destructive">
          <span className="inline-block size-2 rounded-full bg-destructive" />
          {counts.errored} errored
        </span>
      )}
      {counts.stopped > 0 && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <span className="inline-block size-2 rounded-full bg-muted-foreground/50" />
          {counts.stopped} stopped
        </span>
      )}
    </div>
  )
}

/** Structured data for a single project's dashboard section. */
interface ProjectSection {
  readonly project: {
    readonly id: string
    readonly name: string
    readonly repoPath: string
  }
  readonly terminalCountByWorkspace: ReadonlyMap<string, number>
  readonly workspaceCounts: WorkspaceCounts
  readonly workspaces: ReadonlyArray<{
    readonly id: string
    readonly projectId: string
    readonly branchName: string
    readonly worktreePath: string
    readonly status: string
    readonly origin: WorkspaceOrigin | string
    readonly createdAt: string
    readonly errorMessage: string | null
  }>
}

/**
 * Cross-project workspace dashboard.
 *
 * Shows all workspaces across all projects with status badges and
 * per-project status summaries. Provides a high-level command-center
 * overview for developers running multiple agents simultaneously.
 */
function WorkspaceDashboard() {
  const store = useLaborerStore()
  const projectList = store.useQuery(dashboardProjects$)
  const workspaceList = store.useQuery(dashboardWorkspaces$)
  const { terminals: terminalList } = useTerminalList()

  // Build per-project dashboard sections
  const sections: readonly ProjectSection[] = useMemo(() => {
    return projectList.map((project) => {
      const projectWorkspaces = workspaceList.filter(
        (ws) => ws.projectId === project.id && ws.status !== 'destroyed'
      )
      const workspaceCounts = computeWorkspaceCounts(projectWorkspaces)

      // Count terminals per workspace
      const terminalCountByWorkspace = new Map<string, number>()
      for (const ws of projectWorkspaces) {
        const count = terminalList.filter(
          (t) => t.workspaceId === ws.id && t.status === 'running'
        ).length
        terminalCountByWorkspace.set(ws.id, count)
      }

      return {
        project,
        workspaces: projectWorkspaces,
        workspaceCounts,
        terminalCountByWorkspace,
      }
    })
  }, [projectList, workspaceList, terminalList])

  // Global summary counts
  const globalSummary = useMemo(() => {
    const activeWorkspaces = workspaceList.filter(
      (ws) => ws.status !== 'destroyed'
    )
    return {
      totalProjects: projectList.length,
      workspaceCounts: computeWorkspaceCounts(activeWorkspaces),
    }
  }, [projectList, workspaceList])

  if (projectList.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboard />
          </EmptyMedia>
          <EmptyTitle>No projects</EmptyTitle>
          <EmptyDescription>
            Add a project to see the workspace dashboard.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        {/* Global summary bar */}
        <div className="mb-4 rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <LayoutDashboard className="size-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Overview</h2>
            <Badge className="ml-auto" variant="secondary">
              {globalSummary.totalProjects} project
              {globalSummary.totalProjects !== 1 ? 's' : ''}
            </Badge>
          </div>
          <div>
            <div>
              <p className="mb-1 text-muted-foreground text-xs">Workspaces</p>
              <WorkspaceStatusSummary counts={globalSummary.workspaceCounts} />
            </div>
          </div>
        </div>

        {/* Per-project sections */}
        <div className="grid gap-4">
          {sections.map((section) => (
            <ProjectDashboardSection
              key={section.project.id}
              section={section}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

/** Dashboard section for a single project. */
function ProjectDashboardSection({
  section,
}: {
  readonly section: ProjectSection
}) {
  const {
    project,
    workspaces: projectWorkspaces,
    workspaceCounts,
    terminalCountByWorkspace,
  } = section

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{project.name}</span>
            </CardTitle>
            <p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
              {project.repoPath}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Badge variant="outline">
              {workspaceCounts.total} workspace
              {workspaceCounts.total !== 1 ? 's' : ''}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Workspace list */}
        <div>
          <p className="mb-2 font-medium text-muted-foreground text-xs">
            Workspaces
          </p>
          {projectWorkspaces.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No active workspaces
            </p>
          ) : (
            <div className="grid gap-2">
              {projectWorkspaces.map((ws) => (
                <DashboardWorkspaceRow
                  key={ws.id}
                  terminalCount={terminalCountByWorkspace.get(ws.id) ?? 0}
                  workspace={ws}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Compact workspace row in the dashboard. */
function DashboardWorkspaceRow({
  workspace,
  terminalCount,
}: {
  readonly workspace: {
    readonly id: string
    readonly branchName: string
    readonly status: string
    readonly origin: WorkspaceOrigin | string
    readonly errorMessage: string | null
  }
  readonly terminalCount: number
}) {
  const isDetectedWorkspace =
    (workspace.origin as WorkspaceOrigin) === 'external'

  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2">
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-mono text-xs">
        {workspace.branchName}
      </span>
      {isDetectedWorkspace && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase">
          Detected
        </span>
      )}
      {terminalCount > 0 && (
        <span className="text-muted-foreground text-xs">
          {terminalCount} terminal{terminalCount !== 1 ? 's' : ''}
        </span>
      )}
      {workspace.status === 'errored' && workspace.errorMessage ? (
        <Tooltip>
          <TooltipTrigger>
            <Badge
              className={cn(
                'ml-auto shrink-0 border',
                getStatusClasses(workspace.status)
              )}
              variant="outline"
            >
              <StatusDot status={workspace.status} />
              {workspace.status}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-wrap font-mono text-xs">
            {workspace.errorMessage}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Badge
          className={cn(
            'ml-auto shrink-0 border',
            getStatusClasses(workspace.status)
          )}
          title={
            isDetectedWorkspace && workspace.status === 'stopped'
              ? 'Detected from existing git worktree — never activated in Laborer'
              : undefined
          }
          variant="outline"
        >
          <StatusDot status={workspace.status} />
          {workspace.status}
        </Badge>
      )}
    </div>
  )
}

export { WorkspaceDashboard }
