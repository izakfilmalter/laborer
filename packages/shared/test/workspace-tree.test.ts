import { describe, expect, it } from 'vitest'
import { buildWorkspaceTree } from '../src/workspace-tree.js'

const workspace = (branchName: string, baseBranch: string | null = null) => ({
  branchName,
  baseBranch,
})

describe('buildWorkspaceTree', () => {
  it('renders workspaces without a base branch as top-level, in input order', () => {
    const tree = buildWorkspaceTree([
      workspace('feat/one'),
      workspace('feat/two'),
    ])

    expect(tree).toEqual([
      { workspace: workspace('feat/one'), children: [] },
      { workspace: workspace('feat/two'), children: [] },
    ])
  })

  it('nests sub-workspaces under the workspace owning their base branch, recursively', () => {
    const tree = buildWorkspaceTree([
      workspace('feat/big-thing'),
      workspace('fix/auth', 'feat/big-thing'),
      workspace('fix/auth-tests', 'fix/auth'),
      workspace('fix/ui', 'feat/big-thing'),
      workspace('solo'),
    ])

    expect(tree).toEqual([
      {
        workspace: workspace('feat/big-thing'),
        children: [
          {
            workspace: workspace('fix/auth', 'feat/big-thing'),
            children: [
              {
                workspace: workspace('fix/auth-tests', 'fix/auth'),
                children: [],
              },
            ],
          },
          { workspace: workspace('fix/ui', 'feat/big-thing'), children: [] },
        ],
      },
      { workspace: workspace('solo'), children: [] },
    ])
  })

  it('renders a sub-workspace top-level when no live workspace owns its base branch', () => {
    const tree = buildWorkspaceTree([
      workspace('fix/auth', 'feat/destroyed-parent'),
      workspace('fix/auth-tests', 'fix/auth'),
    ])

    expect(tree).toEqual([
      {
        workspace: workspace('fix/auth', 'feat/destroyed-parent'),
        children: [
          { workspace: workspace('fix/auth-tests', 'fix/auth'), children: [] },
        ],
      },
    ])
  })

  it('never drops workspaces when base branches form a cycle or self-reference', () => {
    const tree = buildWorkspaceTree([
      workspace('feat/a', 'feat/b'),
      workspace('feat/b', 'feat/a'),
      workspace('feat/self', 'feat/self'),
    ])

    const allBranches = (
      nodes: ReturnType<typeof buildWorkspaceTree>
    ): string[] =>
      nodes.flatMap((node) => [
        node.workspace.branchName,
        ...allBranches(node.children),
      ])

    expect(allBranches(tree).toSorted()).toEqual([
      'feat/a',
      'feat/b',
      'feat/self',
    ])
  })
})
