import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { projects, workspaces } from '@laborer/shared/schema'
import type { PanelNode } from '@laborer/shared/types'
import { buildWorkspacePath } from '@laborer/shared/workspace-tree'
import { queryDb } from '@livestore/livestore'
import { useEffect, useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { WorkspaceFrameHeader } from '@/components/workspace-frame-header'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'
import { useLaborerStore } from '@/livestore/store'
import { useActivePaneId, usePanelActions } from '@/panels/panel-context'
import { getScopedActivePaneId } from '@/panels/window-layout-utils'

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
  readonly diffIsOpen?: boolean
  readonly treeIsOpen?: boolean
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
    () =>
      subLayout
        ? getScopedActivePaneId(subLayout, globalActivePaneId)
        : globalActivePaneId,
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
        workspacePath: [],
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
        workspacePath: [],
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
    const isContainerized = workspace.sandboxId != null
    const projectWorkspaces = workspaceList
      .filter(
        (ws) =>
          ws.status !== 'destroyed' && ws.projectId === workspace.projectId
      )
      .map((ws) => ({
        id: ws.id,
        branchName: ws.branchName,
        baseBranch: (ws as { baseBranch?: string | null }).baseBranch ?? null,
      }))
    const workspacePath = buildWorkspacePath(
      projectWorkspaces,
      workspaceId
    ).map((ws) => ws.branchName)
    return {
      projectName: project?.name,
      workspacePath,
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
      isActiveFrame={isActiveFrame}
      isContainerized={workspaceData.isContainerized}
      isMinimized={isMinimized}
      onHeaderClick={onHeaderClick}
      onMinimize={onMinimize}
      prNumber={workspaceData.prNumber}
      projectName={workspaceData.projectName}
      prState={workspaceData.prState}
      prTitle={workspaceData.prTitle}
      prUrl={workspaceData.prUrl}
      treeIsOpen={treeIsOpen ?? false}
      workspaceId={workspaceId}
      workspacePath={workspaceData.workspacePath}
    />
  )
}
