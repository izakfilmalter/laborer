/**
 * Branch-keyed workspace lineage.
 *
 * A sub-workspace stores only `baseBranch` (the branch its PR targets). The
 * sidebar tree is derived at render time by matching `baseBranch` against
 * live workspaces' `branchName` — there is no stored parent ID.
 * See docs/adr/0001-branch-keyed-workspace-lineage.md.
 */

export interface WorkspaceTreeInput {
  baseBranch: string | null
  branchName: string
}

export interface WorkspaceTreeNode<W extends WorkspaceTreeInput> {
  children: WorkspaceTreeNode<W>[]
  workspace: W
}

/**
 * Builds the sidebar workspace tree for a single project.
 *
 * - A workspace nests under the workspace whose `branchName` matches its
 *   `baseBranch`.
 * - Workspaces with no `baseBranch`, or whose base branch has no live owner,
 *   render top-level.
 * - Input order is preserved at every level.
 */
export const buildWorkspaceTree = <W extends WorkspaceTreeInput>(
  workspaceList: readonly W[]
): WorkspaceTreeNode<W>[] => {
  const nodes = workspaceList.map(
    (workspace): WorkspaceTreeNode<W> => ({ workspace, children: [] })
  )

  const byBranch = new Map<string, WorkspaceTreeNode<W>>()
  for (const node of nodes) {
    if (!byBranch.has(node.workspace.branchName)) {
      byBranch.set(node.workspace.branchName, node)
    }
  }

  /**
   * Resolves the parent node, treating any cycle through `node` (including
   * self-reference) as "no parent" so every workspace stays reachable.
   */
  const resolveParent = (node: WorkspaceTreeNode<W>) => {
    if (node.workspace.baseBranch === null) {
      return undefined
    }
    const parent = byBranch.get(node.workspace.baseBranch)
    const seen = new Set([node])
    let ancestor = parent
    while (ancestor) {
      if (seen.has(ancestor)) {
        return undefined
      }
      seen.add(ancestor)
      ancestor = ancestor.workspace.baseBranch
        ? byBranch.get(ancestor.workspace.baseBranch)
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
