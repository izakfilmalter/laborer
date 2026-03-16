import { workspaces } from '@laborer/shared/schema'
import type {
  PanelLeafNode,
  PanelTab,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useMemo } from 'react'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { useLaborerStore } from '@/livestore/store'
import { generateId } from '@/panels/id-utils'

/** LiveStore query for building the default panel layout. */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/**
 * Computes an initial hierarchical `WindowLayout` from the current LiveStore
 * state.
 *
 * This is used to seed the layout when there's no persisted layout yet.
 *
 * - Groups running terminals by workspace into `WorkspaceTileLeaf` nodes.
 * - Multiple workspaces -> horizontal `WorkspaceTileSplit` (side-by-side tiles).
 * - Single workspace -> single `WorkspaceTileLeaf`.
 * - Active workspaces but no terminals -> empty terminal pane.
 * - No workspaces -> undefined (PanelManager shows empty state).
 */
export function useInitialLayout(): WindowLayout | undefined {
  const store = useLaborerStore()
  const { terminals: terminalList } = useTerminalList()
  const workspaceList = store.useQuery(allWorkspaces$)

  return useMemo(() => {
    const runningTerminals = terminalList.filter((t) => t.status === 'running')

    // Group running terminals by workspace ID.
    const terminalsByWorkspace = new Map<
      string,
      Array<{ id: string; workspaceId: string }>
    >()
    for (const t of runningTerminals) {
      if (!t.workspaceId) {
        continue
      }
      const existing = terminalsByWorkspace.get(t.workspaceId) ?? []
      existing.push({ id: t.id, workspaceId: t.workspaceId })
      terminalsByWorkspace.set(t.workspaceId, existing)
    }

    /**
     * Build a WorkspaceTileLeaf for a workspace with its terminals.
     * If no terminals are provided, creates an empty pane.
     */
    const buildTileLeaf = (
      workspaceId: string,
      terminals: Array<{ id: string }> = []
    ): WorkspaceTileLeaf => {
      const panelTabId = generateId('panel-tab')

      let panelLayout:
        | PanelLeafNode
        | import('@laborer/shared/types').PanelSplitNode

      if (terminals.length > 1) {
        const children: readonly PanelLeafNode[] = terminals.map((t) => ({
          _tag: 'PanelLeafNode' as const,
          id: generateId('pane'),
          paneType: 'terminal' as const,
          terminalId: t.id,
          workspaceId,
        }))
        const equalSize = 100 / children.length
        panelLayout = {
          _tag: 'PanelSplitNode' as const,
          id: generateId('split'),
          direction: 'horizontal' as const,
          children,
          sizes: children.map(() => equalSize),
        }
      } else {
        panelLayout = {
          _tag: 'PanelLeafNode' as const,
          id: generateId('pane'),
          paneType: 'terminal' as const,
          terminalId: terminals[0]?.id,
          workspaceId,
        }
      }

      let firstLeafId: string | undefined
      if (panelLayout._tag === 'PanelLeafNode') {
        firstLeafId = panelLayout.id
      } else {
        const firstChild = panelLayout.children[0]
        firstLeafId =
          firstChild?._tag === 'PanelLeafNode' ? firstChild.id : undefined
      }

      const panelTab: PanelTab = {
        id: panelTabId,
        panelLayout,
        focusedPaneId: firstLeafId,
      }

      return {
        _tag: 'WorkspaceTileLeaf' as const,
        id: generateId('workspace-tile'),
        workspaceId,
        panelTabs: [panelTab],
        activePanelTabId: panelTabId,
      }
    }

    // Build tile leaves from grouped terminals.
    const tileLeaves: WorkspaceTileLeaf[] = []

    if (terminalsByWorkspace.size > 0) {
      for (const [wsId, terminals] of terminalsByWorkspace) {
        tileLeaves.push(buildTileLeaf(wsId, terminals))
      }
    } else {
      // No running terminals — check for active workspaces.
      const activeWorkspace = workspaceList.find(
        (ws) => ws.status === 'running' || ws.status === 'creating'
      )
      if (activeWorkspace) {
        tileLeaves.push(buildTileLeaf(activeWorkspace.id))
      }
    }

    // No workspaces at all -> undefined
    if (tileLeaves.length === 0) {
      return undefined
    }

    // Build workspace tile tree.
    let workspaceLayout: WorkspaceTileNode
    const singleTile = tileLeaves[0]
    if (tileLeaves.length === 1 && singleTile) {
      workspaceLayout = singleTile
    } else {
      const equalSize = 100 / tileLeaves.length
      const split: WorkspaceTileSplit = {
        _tag: 'WorkspaceTileSplit',
        id: generateId('workspace-split'),
        direction: 'horizontal',
        children: tileLeaves,
        sizes: tileLeaves.map(() => equalSize),
      }
      workspaceLayout = split
    }

    // Create the window tab.
    const windowTabId = generateId('window-tab')
    const windowTab: WindowTab = {
      id: windowTabId,
      label: 'Main',
      workspaceLayout,
    }

    return {
      tabs: [windowTab],
      activeTabId: windowTabId,
    }
  }, [terminalList, workspaceList])
}
