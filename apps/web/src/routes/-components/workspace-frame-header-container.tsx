import { useAtomSet } from '@effect/atom-react/Hooks'
import type { PanelNode } from '@laborer/shared/types'
import { buildWorkspacePath } from '@laborer/shared/workspace-tree'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  WorkspaceFrameHeader,
  type WorkspaceFrameHeaderProps,
} from '@/components/workspace-frame-header'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { useProjectShortName } from '@/hooks/use-project-short-name'
import { useWorkspaceAgentStatus } from '@/hooks/use-workspace-agent-status'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'
import { getScopedActivePaneId } from '@/panels/window-layout-utils'

const refreshPrMutation = LaborerClient.mutation('workspace.refreshPr')

function WorkspaceFrameHeaderWithProjectShortName({
  projectId,
  ...props
}: Omit<WorkspaceFrameHeaderProps, 'projectShortName'> & {
  readonly projectId: string
}) {
  const projectShortName = useProjectShortName(projectId)
  return (
    <WorkspaceFrameHeader
      {...props}
      projectId={projectId}
      projectShortName={projectShortName}
    />
  )
}

/**
 * Data-fetching wrapper for WorkspaceFrameHeader. Reads project and task-backed
 * workspace data from the combined stream, then delegates to the presentational
 * component.
 */
export function WorkspaceFrameHeaderContainer({
  commentsIsOpen,
  diffIsOpen,
  isActiveFrame,
  workspaceId,
  subLayout,
  dragHandleRef,
  isMinimized,
  onHeaderClick,
  onMinimize,
  treeIsOpen,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout?: PanelNode | undefined
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  readonly isActiveFrame: boolean
  readonly isMinimized: boolean
  readonly onHeaderClick: () => void
  readonly onMinimize: () => void
  readonly commentsIsOpen?: boolean
  readonly diffIsOpen?: boolean
  readonly treeIsOpen?: boolean
}) {
  const { data: projectList } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const workspaceList = useMemo(
    () => workspaceViewsFromRows(tasks, projectList),
    [projectList, tasks]
  )
  const globalActivePaneId = useActivePaneId()
  const actions = usePanelActions()
  const refreshPr = useAtomSet(refreshPrMutation, { mode: 'promise' })

  // Scope the active pane to this workspace's sub-tree so header buttons
  // always operate on a pane within their own workspace, not the globally
  // focused one that may belong to a different workspace.
  const scopedActivePaneId = useMemo(
    () =>
      subLayout
        ? getScopedActivePaneId(subLayout, globalActivePaneId)
        : globalActivePaneId,
    [subLayout, globalActivePaneId]
  )

  // Workspace-level agent status, shared with the frame that outlines itself
  // for the same status.
  const workspaceAgentStatus = useWorkspaceAgentStatus(workspaceId)

  const workspaceData = useMemo(() => {
    const emptyWorkspaceData = {
      projectName: undefined,
      projectId: undefined,
      taskNumber: null,
      workspacePath: [],
      branchName: undefined,
      prBaseBranch: null,
      prCheckStatus: null,
      prChecks: null,
      prMergeStatus: null,
      prNumber: null,
      prUnresolvedThreads: null,
      prUrl: null,
      prTitle: null,
      prState: null,
    }
    if (!workspaceId) {
      return emptyWorkspaceData
    }
    const workspace = workspaceList.find((ws) => ws.id === workspaceId)
    if (!workspace) {
      return emptyWorkspaceData
    }
    const project = projectList.find((p) => p.id === workspace.projectId)
    const projectWorkspaces = workspaceList
      .filter(
        (ws) =>
          ws.status !== 'destroyed' && ws.projectId === workspace.projectId
      )
      .map((ws) => ({
        id: ws.id,
        branchName: ws.branchName,
        parentTaskId: ws.parentTaskId,
      }))
    const workspacePath = buildWorkspacePath(
      projectWorkspaces,
      workspaceId
    ).map((ws) => ws.branchName)
    return {
      projectName: project?.name,
      projectId: workspace.projectId,
      taskNumber: workspace.taskNumber,
      workspacePath,
      branchName: workspace.branchName,
      prBaseBranch: workspace.prBaseBranch ?? null,
      prCheckStatus: workspace.prCheckStatus ?? null,
      prChecks: workspace.prChecks ?? null,
      prMergeStatus: workspace.prMergeStatus ?? null,
      prNumber: workspace.prNumber ?? null,
      prUnresolvedThreads: workspace.prUnresolvedThreads ?? null,
      prUrl: workspace.prUrl ?? null,
      prTitle: workspace.prTitle ?? null,
      prState: workspace.prState ?? null,
    }
  }, [workspaceId, workspaceList, projectList])
  useEffect(() => {
    if (!(workspaceId && scopedActivePaneId)) {
      return
    }

    refreshPr({ payload: { workspaceId } }).catch(() => {
      // Silently ignore refresh failures; polling will retry in the background.
    })
  }, [refreshPr, scopedActivePaneId, workspaceId])

  const headerProps = {
    actions,
    activePaneId: scopedActivePaneId,
    agentStatus: workspaceAgentStatus,
    branchName: workspaceData.branchName,
    commentsIsOpen: commentsIsOpen ?? false,
    diffIsOpen: diffIsOpen ?? false,
    dragHandleRef,
    isActiveFrame,
    isMinimized,
    onHeaderClick,
    onMinimize,
    prBaseBranch: workspaceData.prBaseBranch,
    prCheckStatus: workspaceData.prCheckStatus,
    prChecks: workspaceData.prChecks,
    prMergeStatus: workspaceData.prMergeStatus,
    prNumber: workspaceData.prNumber,
    projectId: workspaceData.projectId,
    projectName: workspaceData.projectName,
    prState: workspaceData.prState,
    prTitle: workspaceData.prTitle,
    prUnresolvedThreads: workspaceData.prUnresolvedThreads,
    prUrl: workspaceData.prUrl,
    taskNumber: workspaceData.taskNumber,
    treeIsOpen: treeIsOpen ?? false,
    workspaceId,
    workspacePath: workspaceData.workspacePath,
  } satisfies Omit<WorkspaceFrameHeaderProps, 'projectShortName'>

  return workspaceData.projectId && workspaceData.taskNumber ? (
    <WorkspaceFrameHeaderWithProjectShortName
      {...headerProps}
      projectId={workspaceData.projectId}
    />
  ) : (
    <WorkspaceFrameHeader {...headerProps} projectShortName={null} />
  )
}
