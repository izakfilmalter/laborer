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
 * - Files and file surfaces render t3code's `FilePreviewPanel`: the
 *   standalone `files` surface is the full-width explorer, and each
 *   `file:<path>` surface shows that file with an explorer aside.
 * - Browser is a disabled launcher card. There is no Terminal surface
 *   (terminals live in the main panel tabs/splits) and no Agents surface
 *   (Laborer skips it).
 *
 * The component renders nothing while the panel is hidden (`isOpen` false);
 * tab state survives in the store, so reopening restores the same tabs.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import type { PullRequestState } from '@laborer/shared/rpc'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import { FilePreviewPanel } from '@/components/files/file-preview-panel'
import { PreviewPanel } from '@/components/preview/preview-panel'
import { PullRequestPanel } from '@/components/pull-request/detail-panel'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { DiffPane } from '@/panes/diff-pane'
import { usePreviewStateStore } from '@/preview-state-store'
import {
  type RightPanelSurface,
  selectWorkspaceRightPanelState,
  useRightPanelStore,
} from '@/right-panel-store'
import { rightPanelWidthStorageKey } from './right-panel-shell'
import { type PullRequestTabStatus, RightPanelTabs } from './right-panel-tabs'

/** The workspace's project name, for the file surface's breadcrumbs. */
function useWorkspaceProjectName(workspaceId: string): string {
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
    const project = projects.find((row) => row.id === workspace?.projectId)
    return project?.name ?? 'workspace'
  }, [projects, tasks, workspaceId])
}

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

const closePreviewMutation = BrowserDaemonClient.mutation('preview.close')

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
  const projectName = useWorkspaceProjectName(workspaceId)
  const closePreview = useAtomSet(closePreviewMutation, { mode: 'promise' })

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
      if (surface.kind === 'preview' && surface.resourceId) {
        usePreviewStateStore
          .getState()
          .setActive(workspaceId, surface.resourceId)
      }
    },
    [workspaceId]
  )
  const closeBrowserResources = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      for (const surface of surfaces) {
        if (surface.kind !== 'preview' || !surface.resourceId) {
          continue
        }
        const tabId = surface.resourceId
        const snapshot =
          usePreviewStateStore.getState().byWorkspaceId[workspaceId]?.sessions[
            tabId
          ]
        usePreviewStateStore.getState().beginClose(workspaceId, tabId)
        closePreview({
          payload: { workspaceId, tabId },
        }).catch(() => {
          usePreviewStateStore
            .getState()
            .cancelClose(workspaceId, tabId, snapshot)
        })
      }
    },
    [closePreview, workspaceId]
  )
  const handleCloseSurface = useCallback(
    (surface: RightPanelSurface) => {
      closeBrowserResources([surface])
      store().closeSurface(workspaceId, surface.id)
    },
    [closeBrowserResources, workspaceId]
  )
  const handleCloseOtherSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      closeBrowserResources(
        state.surfaces.filter((entry) => entry.id !== surface.id)
      )
      store().closeOtherSurfaces(workspaceId, surface.id)
    },
    [closeBrowserResources, state.surfaces, workspaceId]
  )
  const handleCloseSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      const index = state.surfaces.findIndex((entry) => entry.id === surface.id)
      closeBrowserResources(state.surfaces.slice(index + 1))
      store().closeSurfacesToRight(workspaceId, surface.id)
    },
    [closeBrowserResources, state.surfaces, workspaceId]
  )
  const handleCloseAllSurfaces = useCallback(() => {
    closeBrowserResources(state.surfaces)
    store().closeAllSurfaces(workspaceId)
  }, [closeBrowserResources, state.surfaces, workspaceId])
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

  if (!state.isOpen) {
    return null
  }

  return (
    <RightPanelTabs
      activeSurfaceId={state.activeSurfaceId}
      browserAvailable={Boolean(window.desktopBridge?.preview)}
      diffAvailable={true}
      filesAvailable={true}
      onActivate={handleActivate}
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
      workspaceId={workspaceId}
    >
      {activeSurface ? (
        <ActiveSurfaceContent
          projectName={projectName}
          surface={activeSurface}
          workspaceId={workspaceId}
        />
      ) : null}
    </RightPanelTabs>
  )
}

/** The debounced save owns pending state; the tab chrome ignores it for now. */
const noopPendingChange = () => {
  // Reserved for a dirty indicator on file tabs.
}

/** The surface registry: maps the active descriptor to its content. */
function ActiveSurfaceContent({
  projectName,
  surface,
  workspaceId,
}: {
  readonly projectName: string
  readonly surface: RightPanelSurface
  readonly workspaceId: string
}) {
  const handleOpenFile = useCallback(
    (relativePath: string) => {
      useRightPanelStore.getState().openFile(workspaceId, relativePath)
    },
    [workspaceId]
  )
  switch (surface.kind) {
    case 'diff':
      return <DiffPane workspaceId={workspaceId} />
    case 'pull-request':
      return <PullRequestPanel workspaceId={workspaceId} />
    case 'preview':
      return (
        <PreviewPanel
          tabId={surface.resourceId}
          visible
          workspaceId={workspaceId}
        />
      )
    case 'files':
      return (
        <FilePreviewPanel
          onOpenFile={handleOpenFile}
          onPendingChange={noopPendingChange}
          projectName={projectName}
          relativePath={null}
          revealLine={null}
          revealRequestId={0}
          workspaceId={workspaceId}
        />
      )
    case 'file':
      return (
        <FilePreviewPanel
          onOpenFile={handleOpenFile}
          onPendingChange={noopPendingChange}
          projectName={projectName}
          relativePath={surface.relativePath}
          revealLine={surface.revealLine}
          revealRequestId={surface.revealRequestId}
          workspaceId={workspaceId}
        />
      )
    default:
      return surface satisfies never
  }
}
