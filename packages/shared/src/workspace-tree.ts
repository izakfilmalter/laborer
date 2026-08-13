/**
 * Task-keyed workspace lineage (ADR 0009).
 */

export interface WorkspaceTreeInput {
  id: string
  parentTaskId: string | null
}

export type WorkspacePathInput = WorkspaceTreeInput

export interface WorkspaceTreeNode<W extends WorkspaceTreeInput> {
  children: WorkspaceTreeNode<W>[]
  workspace: W
}

/**
 * Builds the sidebar workspace tree for a single project.
 *
 * - A workspace nests under the workspace identified by `parentTaskId`.
 * - Workspaces with no parent, or whose parent is no longer present,
 *   render top-level.
 * - Input order is preserved at every level.
 */
export const buildWorkspaceTree = <W extends WorkspaceTreeInput>(
  workspaceList: readonly W[]
): WorkspaceTreeNode<W>[] => {
  const nodes = workspaceList.map(
    (workspace): WorkspaceTreeNode<W> => ({ workspace, children: [] })
  )

  const byId = new Map<string, WorkspaceTreeNode<W>>()
  for (const node of nodes) {
    byId.set(node.workspace.id, node)
  }

  /**
   * Resolves the parent node, treating any cycle through `node` (including
   * self-reference) as "no parent" so every workspace stays reachable.
   */
  const resolveParent = (node: WorkspaceTreeNode<W>) => {
    if (node.workspace.parentTaskId === null) {
      return undefined
    }
    const parent = byId.get(node.workspace.parentTaskId)
    const seen = new Set([node])
    let ancestor = parent
    while (ancestor) {
      if (seen.has(ancestor)) {
        return undefined
      }
      seen.add(ancestor)
      ancestor = ancestor.workspace.parentTaskId
        ? byId.get(ancestor.workspace.parentTaskId)
        : undefined
    }
    return parent
  }

  const roots: WorkspaceTreeNode<W>[] = []
  for (const node of nodes) {
    const parent = resolveParent(node)
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

/**
 * Builds the visible sidebar path for a workspace: its live ancestors followed
 * by itself. Missing parents promote the workspace to the top level, matching
 * `buildWorkspaceTree`.
 */
export const buildWorkspacePath = <W extends WorkspacePathInput>(
  workspaceList: readonly W[],
  workspaceId: string
): W[] => {
  const target = workspaceList.find((workspace) => workspace.id === workspaceId)
  if (!target) {
    return []
  }

  const byId = new Map<string, W>()
  for (const workspace of workspaceList) {
    byId.set(workspace.id, workspace)
  }

  const path: W[] = []
  const seen = new Set<string>()
  let current: W | undefined = target

  while (current) {
    if (seen.has(current.id)) {
      return [target]
    }

    seen.add(current.id)
    path.unshift(current)

    current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined
  }

  return path
}
