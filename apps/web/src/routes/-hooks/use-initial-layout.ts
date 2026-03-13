import { workspaces } from '@laborer/shared/schema'
import type { LeafNode, PanelNode, SplitNode } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useMemo } from 'react'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { useLaborerStore } from '@/livestore/store'

/** LiveStore query for building the default panel layout. */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/**
 * Computes an initial panel layout from the current LiveStore state.
 *
 * This is used to seed the layout when there's no persisted layout yet.
 *
 * - Multiple running terminals -> horizontal SplitNode (side-by-side panes)
 * - Single running terminal -> LeafNode
 * - Active workspaces but no terminals -> empty terminal pane
 * - No workspaces -> undefined (PanelManager shows empty state)
 */
export function useInitialLayout(): PanelNode | undefined {
  const store = useLaborerStore()
  const { terminals: terminalList } = useTerminalList()
  const workspaceList = store.useQuery(allWorkspaces$)

  return useMemo(() => {
    const runningTerminals = terminalList.filter((t) => t.status === 'running')

    // Multiple running terminals -> horizontal split
    if (runningTerminals.length > 1) {
      const children: readonly LeafNode[] = runningTerminals.map((t) => ({
        _tag: 'LeafNode' as const,
        id: `pane-${t.id}`,
        paneType: 'ghosttyTerminal' as const,
        terminalId: undefined,
        workspaceId: t.workspaceId,
      }))
      const equalSize = 100 / children.length
      const sizes: readonly number[] = children.map(() => equalSize)
      return {
        _tag: 'SplitNode' as const,
        id: 'split-root',
        direction: 'horizontal' as const,
        children,
        sizes,
      } satisfies SplitNode
    }

    // Single running terminal -> single pane
    const runningTerminal = runningTerminals[0]
    if (runningTerminal) {
      return {
        _tag: 'LeafNode' as const,
        id: `pane-${runningTerminal.id}`,
        paneType: 'ghosttyTerminal' as const,
        terminalId: undefined,
        workspaceId: runningTerminal.workspaceId,
      } satisfies LeafNode
    }

    // Active workspaces but no terminals -> empty ghostty terminal pane
    const activeWorkspace = workspaceList.find(
      (ws) => ws.status === 'running' || ws.status === 'creating'
    )
    if (activeWorkspace) {
      return {
        _tag: 'LeafNode' as const,
        id: `pane-empty-${activeWorkspace.id}`,
        paneType: 'ghosttyTerminal' as const,
        terminalId: undefined,
        workspaceId: activeWorkspace.id,
      } satisfies LeafNode
    }

    return undefined
  }, [terminalList, workspaceList])
}
