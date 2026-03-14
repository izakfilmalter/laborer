import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { projects, workspaces } from '@laborer/shared/schema'
import type { PanelNode } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useEffect, useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { WorkspaceFrameHeader } from '@/components/workspace-frame-header'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'
import { useLaborerStore } from '@/livestore/store'
import { getScopedActivePaneId } from '@/panels/layout-utils'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'

/** LiveStore query for projects (used by PanelHeaderBar to resolve names). */
const allProjects$ = queryDb(projects, { label: 'headerProjects' })

/** LiveStore query for workspaces. */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

const refreshPrMutation = LaborerClient.mutation('workspace.refreshPr')

/**
 * Data-fetching wrapper for WorkspaceFrameHeader. Queries LiveStore for
 * project, workspace, and layout data, then delegates to the presentational
 * component.
 */
export function WorkspaceFrameHeaderContainer({
  diffIsOpen,
  workspaceId,
  subLayout,
  dragHandleRef,
  isMinimized,
  onHeaderClick,
  onMinimize,
  reviewIsOpen,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  readonly isMinimized: boolean
  readonly onHeaderClick: () => void
  readonly onMinimize: () => void
  readonly diffIsOpen?: boolean
  readonly reviewIsOpen?: boolean
}) {
  const store = useLaborerStore()
  const projectList = store.useQuery(allProjects$)
  const workspaceList = store.useQuery(allWorkspaces$)
  const globalActivePaneId = useActivePaneId()
  const actions = usePanelActions()
  const refreshPr = useAtomSet(refreshPrMutation, { mode: 'promise' })

  // Scope the active pane to this workspace's sub-tree so header buttons
  // always operate on a pane within their own workspace, not the globally
  // focused one that may belong to a different workspace.
  const scopedActivePaneId = useMemo(
    () => getScopedActivePaneId(subLayout, globalActivePaneId),
    [subLayout, globalActivePaneId]
  )

  // Derive workspace-level agent status from the terminal list
  const { terminals } = useTerminalList()
  const workspaceAgentStatus = useMemo(() => {
    if (!workspaceId) {
      return null
    }
    const workspaceTerminals = terminals.filter(
      (t) => t.workspaceId === workspaceId
    )
    return deriveWorkspaceAgentStatus(workspaceTerminals)
  }, [terminals, workspaceId])

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
        aheadCount: null,
        behindCount: null,
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
        aheadCount: null,
        behindCount: null,
      }
    }
    const project = projectList.find((p) => p.id === workspace.projectId)
    const isContainerized = workspace.containerId != null
    return {
      projectName: project?.name,
      branchName: workspace.branchName,
      isContainerized,
      prNumber: workspace.prNumber ?? null,
      prUrl: workspace.prUrl ?? null,
      prTitle: workspace.prTitle ?? null,
      prState: workspace.prState ?? null,
      aheadCount: workspace.aheadCount ?? null,
      behindCount: workspace.behindCount ?? null,
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

  return (
    <WorkspaceFrameHeader
      actions={actions}
      activePaneId={scopedActivePaneId}
      agentStatus={workspaceAgentStatus}
      aheadCount={workspaceData.aheadCount}
      behindCount={workspaceData.behindCount}
      branchName={workspaceData.branchName}
      diffIsOpen={diffIsOpen ?? false}
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
      reviewIsOpen={reviewIsOpen ?? false}
      workspaceId={workspaceId}
    />
  )
}
