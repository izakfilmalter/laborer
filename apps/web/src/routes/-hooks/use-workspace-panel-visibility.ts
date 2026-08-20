/**
 * Which full-height side panels a workspace is showing.
 *
 * The diff, the file tree, and the pull request conversation are each a
 * panel a workspace either shows or does not, so visibility is keyed by
 * workspace rather than by pane: the panel belongs to the work, not to
 * whichever pane happened to ask for it. That key is also what lets a
 * surface with no pane of its own — a card in the sidebar — open one.
 *
 * The layout is the authority on which workspaces exist, so open panels are
 * pruned against it. A workspace that leaves the window takes its panels
 * with it instead of springing them open again the next time it returns.
 */

import type { WindowLayout } from '@laborer/shared/types'
import { useCallback, useEffect, useState } from 'react'
import { getAllWorkspaceTileLeaves } from '@/panels/window-layout-utils'

/** Show a workspace's panel, saying nothing new if it is already shown. */
const openWorkspacePanel = (
  workspaceIds: readonly string[],
  workspaceId: string
): readonly string[] =>
  workspaceIds.includes(workspaceId)
    ? workspaceIds
    : [...workspaceIds, workspaceId]

const toggleWorkspacePanel = (
  workspaceIds: readonly string[],
  workspaceId: string
): readonly string[] =>
  workspaceIds.includes(workspaceId)
    ? workspaceIds.filter((id) => id !== workspaceId)
    : [...workspaceIds, workspaceId]

/** Returns the same array when nothing was pruned, so state stays put. */
const filterOpenWorkspacePanels = (
  workspaceIds: readonly string[],
  openWorkspaceIds: ReadonlySet<string>
): readonly string[] => {
  const nextWorkspaceIds = workspaceIds.filter((id) => openWorkspaceIds.has(id))

  return nextWorkspaceIds.length === workspaceIds.length
    ? workspaceIds
    : nextWorkspaceIds
}

/** Whether the layout currently places this workspace anywhere at all. */
const layoutHasWorkspace = (
  windowLayout: WindowLayout,
  workspaceId: string
): boolean =>
  getAllWorkspaceTileLeaves(windowLayout).some(
    (leaf) => leaf.workspaceId === workspaceId
  )

interface WorkspacePanelVisibility {
  /** Workspaces currently showing the pull request conversation. */
  readonly commentsWorkspaceIds: readonly string[]
  /** Workspaces currently showing the diff. */
  readonly diffWorkspaceIds: readonly string[]
  /**
   * Reveal a workspace and show its pull request conversation.
   *
   * Opens, never toggles. Callers reach this from a count of unresolved
   * conversations, which can only mean "show me"; a toggle would close the
   * panel out from under an operator who clicked the count while already
   * reading it. Asking again just brings the workspace forward.
   */
  readonly openCommentsForWorkspace: (workspaceId: string) => void
  /** @returns Whether the conversation is now shown. */
  readonly toggleComments: (workspaceId: string) => boolean
  /** @returns Whether the diff is now shown. */
  readonly toggleDiff: (workspaceId: string) => boolean
  /** @returns Whether the file tree is now shown. */
  readonly toggleTree: (workspaceId: string) => boolean
  /** Workspaces currently showing the file tree. */
  readonly treeWorkspaceIds: readonly string[]
}

function useWorkspacePanelVisibility({
  focusWorkspace,
  windowLayout,
}: {
  /** Brings a workspace forward, wherever in the window it lives. */
  readonly focusWorkspace: (workspaceId: string) => void
  readonly windowLayout: WindowLayout | undefined
}): WorkspacePanelVisibility {
  const [commentsWorkspaceIds, setCommentsWorkspaceIds] = useState<
    readonly string[]
  >([])
  const [diffWorkspaceIds, setDiffWorkspaceIds] = useState<readonly string[]>(
    []
  )
  const [treeWorkspaceIds, setTreeWorkspaceIds] = useState<readonly string[]>(
    []
  )
  /**
   * An open request still waiting for its workspace to reach the layout.
   *
   * Revealing a workspace commits the layout through the persisted
   * collection, so the workspace is absent from `windowLayout` on the render
   * that asked for it — and may stay absent across several commits, since
   * adding it to an empty window creates the tab first. Marking the panel
   * open in that gap would hand the prune pass below an id the layout cannot
   * vouch for, and it would be reaped before it was ever seen: the click
   * would do nothing at all, which is a worse answer than the GitHub link it
   * replaced.
   *
   * Holding the request until the workspace has actually arrived removes the
   * race rather than running it. The id only ever joins the open set on a
   * render where the layout already agrees the workspace exists, which is
   * exactly the condition the prune pass tests.
   *
   * One request at a time, because it records an intent the operator can
   * only have one of: the last count they clicked. A request for a workspace
   * that never arrives — one living in another window, which was focused
   * there instead — simply goes unanswered.
   */
  const [pendingCommentsWorkspaceId, setPendingCommentsWorkspaceId] = useState<
    string | null
  >(null)

  // Close panels whose workspace no longer exists anywhere in the window
  // layout, so a closed workspace does not leave its panels behind.
  useEffect(() => {
    const hasOpenPanels =
      commentsWorkspaceIds.length > 0 ||
      diffWorkspaceIds.length > 0 ||
      treeWorkspaceIds.length > 0
    if (!(hasOpenPanels && windowLayout)) {
      return
    }

    const openWorkspaceIds = new Set(
      getAllWorkspaceTileLeaves(windowLayout).map((leaf) => leaf.workspaceId)
    )

    setCommentsWorkspaceIds((current) =>
      filterOpenWorkspacePanels(current, openWorkspaceIds)
    )
    setDiffWorkspaceIds((current) =>
      filterOpenWorkspacePanels(current, openWorkspaceIds)
    )
    setTreeWorkspaceIds((current) =>
      filterOpenWorkspacePanels(current, openWorkspaceIds)
    )
  }, [commentsWorkspaceIds, diffWorkspaceIds, treeWorkspaceIds, windowLayout])

  // Answer a held open request the moment its workspace lands in the layout.
  useEffect(() => {
    if (
      pendingCommentsWorkspaceId === null ||
      !windowLayout ||
      !layoutHasWorkspace(windowLayout, pendingCommentsWorkspaceId)
    ) {
      return
    }

    setCommentsWorkspaceIds((current) =>
      openWorkspacePanel(current, pendingCommentsWorkspaceId)
    )
    setPendingCommentsWorkspaceId(null)
  }, [pendingCommentsWorkspaceId, windowLayout])

  const openCommentsForWorkspace = useCallback(
    (workspaceId: string) => {
      focusWorkspace(workspaceId)
      setPendingCommentsWorkspaceId(workspaceId)
    },
    [focusWorkspace]
  )

  const toggleComments = useCallback(
    (workspaceId: string): boolean => {
      const isOpen = commentsWorkspaceIds.includes(workspaceId)

      setCommentsWorkspaceIds((current) =>
        toggleWorkspacePanel(current, workspaceId)
      )

      return !isOpen
    },
    [commentsWorkspaceIds]
  )

  const toggleDiff = useCallback(
    (workspaceId: string): boolean => {
      const isOpen = diffWorkspaceIds.includes(workspaceId)

      setDiffWorkspaceIds((current) =>
        toggleWorkspacePanel(current, workspaceId)
      )

      return !isOpen
    },
    [diffWorkspaceIds]
  )

  const toggleTree = useCallback(
    (workspaceId: string): boolean => {
      const isOpen = treeWorkspaceIds.includes(workspaceId)

      setTreeWorkspaceIds((current) =>
        toggleWorkspacePanel(current, workspaceId)
      )

      return !isOpen
    },
    [treeWorkspaceIds]
  )

  return {
    commentsWorkspaceIds,
    diffWorkspaceIds,
    openCommentsForWorkspace,
    toggleComments,
    toggleDiff,
    toggleTree,
    treeWorkspaceIds,
  }
}

export { useWorkspacePanelVisibility }
export type { WorkspacePanelVisibility }
