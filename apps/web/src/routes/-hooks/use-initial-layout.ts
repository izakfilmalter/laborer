import type { LeafNode, SplitNode, WindowLayout } from '@laborer/shared/types'
import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import {
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { useTerminalList } from '@/hooks/use-terminal-list'

/**
 * Build a seed `WindowLayout` from a panel tree root and workspace ID.
 *
 * Creates a single window tab containing a single workspace tile leaf
 * with a single terminal panel tab wrapping the given panel tree.
 */
function buildSeedWindowLayout(
  panelRoot: LeafNode | SplitNode,
  workspaceId: string
): WindowLayout {
  const seedTabId = `wtab-seed-${Math.random().toString(36).slice(2, 8)}`
  const seedPanelTabId = `ptab-seed-${Math.random().toString(36).slice(2, 8)}`
  const seedTileId = `tile-seed-${Math.random().toString(36).slice(2, 8)}`
  let focusedPaneId = panelRoot.id
  if (panelRoot._tag === 'SplitNode') {
    const firstChild = panelRoot.children[0]
    if (firstChild?._tag === 'LeafNode') {
      focusedPaneId = firstChild.id
    }
  }

  return {
    tabs: [
      {
        id: seedTabId,
        workspaceLayout: {
          _tag: 'WorkspaceTileLeaf' as const,
          id: seedTileId,
          workspaceId,
          panelTabs: [
            {
              id: seedPanelTabId,
              panelLayout: panelRoot,
              focusedPaneId,
            },
          ],
          activePanelTabId: seedPanelTabId,
        },
      },
    ],
    activeTabId: seedTabId,
  }
}

/**
 * Computes an initial panel layout from streamed tasks and live terminals.
 *
 * Returns a complete `WindowLayout` ready to be persisted to the local preference collection
 * when no persisted layout exists yet.
 *
 * - Multiple running terminals -> horizontal SplitNode (side-by-side panes)
 * - Single running terminal -> LeafNode
 * - Active workspaces but no terminals -> empty terminal pane
 * - No workspaces -> undefined (PanelManager shows empty state)
 */
export function useInitialLayout(): WindowLayout | undefined {
  const { terminals: terminalList } = useTerminalList()
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

  return useMemo(() => {
    const runningTerminals = terminalList.filter((t) => t.status === 'running')

    // Multiple running terminals -> horizontal split
    if (runningTerminals.length > 1) {
      const firstTerminal = runningTerminals[0]
      if (!firstTerminal) {
        return undefined
      }
      const children: readonly LeafNode[] = runningTerminals.map((t) => ({
        _tag: 'LeafNode' as const,
        id: `pane-${t.id}`,
        paneType: 'terminal' as const,
        terminalId: t.id,
        workspaceId: t.workspaceId,
      }))
      const equalSize = 100 / children.length
      const sizes: readonly number[] = children.map(() => equalSize)
      const splitRoot: SplitNode = {
        _tag: 'SplitNode' as const,
        id: 'split-root',
        direction: 'horizontal' as const,
        children,
        sizes,
      }
      return buildSeedWindowLayout(splitRoot, firstTerminal.workspaceId ?? '')
    }

    // Single running terminal -> single pane
    const runningTerminal = runningTerminals[0]
    if (runningTerminal) {
      const leaf: LeafNode = {
        _tag: 'LeafNode' as const,
        id: `pane-${runningTerminal.id}`,
        paneType: 'terminal' as const,
        terminalId: runningTerminal.id,
        workspaceId: runningTerminal.workspaceId,
      }
      return buildSeedWindowLayout(leaf, runningTerminal.workspaceId ?? '')
    }

    // Active workspaces but no terminals -> empty terminal pane
    const activeWorkspace = workspaceList.find(
      (ws) => ws.status === 'running' || ws.status === 'creating'
    )
    if (activeWorkspace) {
      const leaf: LeafNode = {
        _tag: 'LeafNode' as const,
        id: `pane-empty-${activeWorkspace.id}`,
        paneType: 'terminal' as const,
        terminalId: undefined,
        workspaceId: activeWorkspace.id,
      }
      return buildSeedWindowLayout(leaf, activeWorkspace.id)
    }

    return undefined
  }, [terminalList, workspaceList])
}
