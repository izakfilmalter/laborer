/**
 * A workspace's right panel: store wiring plus the surface registry.
 *
 * This is the seam later bullets extend. `renderSurface` maps an active
 * surface descriptor to its content; adding a surface means enabling its
 * availability flag and adding a branch here. For this tracer:
 *
 * - Diff renders the existing `DiffPane` (its own header carries the diff
 *   toolbar; the panel tab strip replaces its close button).
 * - Pull request renders t3code's full pull request panel
 *   (`PullRequestPanel`), and mirrors the loaded pull request's state onto
 *   the tab icon the way t3's compact chrome did.
 * - Browser / Files / Agents are disabled launcher cards. There is no
 *   Terminal surface: terminals live in the main panel tabs/splits.
 *
 * The component renders nothing while the panel is hidden (`isOpen` false);
 * tab state survives in the store, so reopening restores the same tabs.
 */
import type { PullRequestState } from '@laborer/shared/rpc'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { PullRequestPanel } from '@/components/pull-request/detail-panel'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { DiffPane } from '@/panes/diff-pane'
import {
  type RightPanelSurface,
  selectWorkspaceRightPanelState,
  useRightPanelStore,
} from '@/right-panel-store'
import { rightPanelWidthStorageKey } from './right-panel-shell'
import { type PullRequestTabStatus, RightPanelTabs } from './right-panel-tabs'

/** The workspace's PR number, or null while it has no pull request. */
function useWorkspacePullRequestNumber(workspaceId: string): number | null {
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  return useMemo(() => {
    const workspace = workspaceViewsFromRows(tasks, projects).find(
      (ws) => ws.id === workspaceId
    )
    return workspace?.prNumber ?? null
  }, [projects, tasks, workspaceId])
}

/**
 * The workspace's PR state as the sidebar cards already know it, so the
 * tab icon carries the right tone before the panel's own read lands.
 */
function useWorkspacePullRequestStatus(
  workspaceId: string
): PullRequestTabStatus | null {
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  return useMemo(() => {
    const workspace = workspaceViewsFromRows(tasks, projects).find(
      (ws) => ws.id === workspaceId
    )
    if (!workspace || workspace.prNumber === null) {
      return null
    }
    // The shared rows uppercase GitHub's state; the contract is lowercase.
    const state = workspace.prState?.toLowerCase()
    if (state === 'open' || state === 'closed' || state === 'merged') {
      return {
        state: state as PullRequestState,
        isDraft: workspace.prIsDraft ?? false,
      }
    }
    return null
  }, [projects, tasks, workspaceId])
}

function SurfaceUnavailable({ label }: { readonly label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-muted-foreground text-sm">
        {label} is not available yet.
      </p>
    </div>
  )
}

export function WorkspaceRightPanel({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  const state = useRightPanelStore(
    useCallback(
      (store) =>
        selectWorkspaceRightPanelState(store.byWorkspaceId, workspaceId),
      [workspaceId]
    )
  )
  const pullRequestNumber = useWorkspacePullRequestNumber(workspaceId)
  const pullRequestStatus = useWorkspacePullRequestStatus(workspaceId)

  const activeSurface = useMemo(
    () =>
      state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ??
      null,
    [state.activeSurfaceId, state.surfaces]
  )

  const store = useRightPanelStore.getState

  const handleActivate = useCallback(
    (surface: RightPanelSurface) => {
      store().activateSurface(workspaceId, surface.id)
    },
    [workspaceId]
  )
  const handleCloseSurface = useCallback(
    (surface: RightPanelSurface) => {
      store().closeSurface(workspaceId, surface.id)
    },
    [workspaceId]
  )
  const handleCloseOtherSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      store().closeOtherSurfaces(workspaceId, surface.id)
    },
    [workspaceId]
  )
  const handleCloseSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      store().closeSurfacesToRight(workspaceId, surface.id)
    },
    [workspaceId]
  )
  const handleCloseAllSurfaces = useCallback(() => {
    store().closeAllSurfaces(workspaceId)
  }, [workspaceId])
  const handleAddDiff = useCallback(() => {
    store().open(workspaceId, 'diff')
  }, [workspaceId])
  const handleAddPullRequest = useCallback(() => {
    store().open(workspaceId, 'pull-request')
  }, [workspaceId])
  // Disabled in this tracer; the launcher never invokes these, but the
  // registry keeps the callbacks so enabling a surface is one flag away.
  const handleAddBrowser = useCallback(() => {
    store().open(workspaceId, 'preview')
  }, [workspaceId])
  const handleAddFiles = useCallback(() => {
    store().open(workspaceId, 'files')
  }, [workspaceId])
  const handleAddAgents = useCallback(() => {
    store().open(workspaceId, 'agents')
  }, [workspaceId])

  if (!state.isOpen) {
    return null
  }

  return (
    <RightPanelTabs
      activeSurfaceId={state.activeSurfaceId}
      agentsAvailable={false}
      browserAvailable={false}
      diffAvailable={true}
      filesAvailable={false}
      onActivate={handleActivate}
      onAddAgents={handleAddAgents}
      onAddBrowser={handleAddBrowser}
      onAddDiff={handleAddDiff}
      onAddFiles={handleAddFiles}
      onAddPullRequest={handleAddPullRequest}
      onCloseAllSurfaces={handleCloseAllSurfaces}
      onCloseOtherSurfaces={handleCloseOtherSurfaces}
      onCloseSurface={handleCloseSurface}
      onCloseSurfacesToRight={handleCloseSurfacesToRight}
      pullRequestAvailable={pullRequestNumber !== null}
      pullRequestNumber={pullRequestNumber}
      pullRequestStatus={pullRequestStatus}
      surfaces={state.surfaces}
      widthStorageKey={rightPanelWidthStorageKey(workspaceId)}
    >
      {activeSurface ? (
        <ActiveSurfaceContent
          surface={activeSurface}
          workspaceId={workspaceId}
        />
      ) : null}
    </RightPanelTabs>
  )
}

/** The surface registry: maps the active descriptor to its content. */
function ActiveSurfaceContent({
  surface,
  workspaceId,
}: {
  readonly surface: RightPanelSurface
  readonly workspaceId: string
}) {
  switch (surface.kind) {
    case 'diff':
      return <DiffPane workspaceId={workspaceId} />
    case 'pull-request':
      return <PullRequestPanel workspaceId={workspaceId} />
    case 'preview':
      return <SurfaceUnavailable label="Browser" />
    case 'files':
      return <SurfaceUnavailable label="Files" />
    case 'file':
      return <SurfaceUnavailable label="File viewer" />
    case 'agents':
      return <SurfaceUnavailable label="Agents" />
    default:
      return surface satisfies never
  }
}
