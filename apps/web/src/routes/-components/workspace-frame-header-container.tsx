import { projects, workspaces } from '@laborer/shared/schema'
import type { PanelNode } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useMemo } from 'react'
import { WorkspaceFrameHeader } from '@/components/workspace-frame-header'
import { useLaborerStore } from '@/livestore/store'
import { findNodeById, getScopedActivePaneId } from '@/panels/layout-utils'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'

/** LiveStore query for projects (used by PanelHeaderBar to resolve names). */
const allProjects$ = queryDb(projects, { label: 'headerProjects' })

/** LiveStore query for workspaces. */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/**
 * Data-fetching wrapper for WorkspaceFrameHeader. Queries LiveStore for
 * project, workspace, and layout data, then delegates to the presentational
 * component.
 */
export function WorkspaceFrameHeaderContainer({
  workspaceId,
  subLayout,
  dragHandleRef,
  isMinimized,
  onHeaderClick,
  onMinimize,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  readonly isMinimized: boolean
  readonly onHeaderClick: () => void
  readonly onMinimize: () => void
}) {
  const store = useLaborerStore()
  const projectList = store.useQuery(allProjects$)
  const workspaceList = store.useQuery(allWorkspaces$)
  const globalActivePaneId = useActivePaneId()
  const actions = usePanelActions()

  // Scope the active pane to this workspace's sub-tree so header buttons
  // always operate on a pane within their own workspace, not the globally
  // focused one that may belong to a different workspace.
  const scopedActivePaneId = useMemo(
    () => getScopedActivePaneId(subLayout, globalActivePaneId),
    [subLayout, globalActivePaneId]
  )

  const diffIsOpen = useMemo(() => {
    if (!scopedActivePaneId) {
      return false
    }
    const node = findNodeById(subLayout, scopedActivePaneId)
    return node?._tag === 'LeafNode' && node.diffOpen === true
  }, [scopedActivePaneId, subLayout])

  const workspaceData = useMemo(() => {
    if (!workspaceId) {
      return {
        projectName: undefined,
        branchName: undefined,
        isContainerized: false,
        prNumber: null,
        prUrl: null,
        prTitle: null,
        prState: null,
        workspaceStatus: undefined,
      }
    }
    const workspace = workspaceList.find((ws) => ws.id === workspaceId)
    if (!workspace) {
      return {
        projectName: undefined,
        branchName: undefined,
        isContainerized: false,
        prNumber: null,
        prUrl: null,
        prTitle: null,
        prState: null,
        workspaceStatus: undefined,
      }
    }
    const project = projectList.find((p) => p.id === workspace.projectId)
    const isContainerized = workspace.containerId != null
    const isContainerPaused = workspace.containerStatus === 'paused'
    const displayStatus =
      isContainerized && isContainerPaused ? 'paused' : workspace.status
    return {
      projectName: project?.name,
      branchName: workspace.branchName,
      isContainerized,
      prNumber: workspace.prNumber ?? null,
      prUrl: workspace.prUrl ?? null,
      prTitle: workspace.prTitle ?? null,
      prState: workspace.prState ?? null,
      workspaceStatus: displayStatus,
    }
  }, [workspaceId, workspaceList, projectList])

  return (
    <WorkspaceFrameHeader
      actions={actions}
      activePaneId={scopedActivePaneId}
      branchName={workspaceData.branchName}
      diffIsOpen={diffIsOpen}
      dragHandleRef={dragHandleRef}
      isContainerized={workspaceData.isContainerized}
      isMinimized={isMinimized}
      onHeaderClick={onHeaderClick}
      onMinimize={onMinimize}
      prNumber={workspaceData.prNumber}
      projectName={workspaceData.projectName}
      prState={workspaceData.prState}
      prTitle={workspaceData.prTitle}
      prUrl={workspaceData.prUrl}
      workspaceId={workspaceId}
      workspaceStatus={workspaceData.workspaceStatus}
    />
  )
}
