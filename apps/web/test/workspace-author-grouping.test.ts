/**
 * Author grouping for the sidebar workspace list.
 *
 * The reviewer's flow is pulling somebody else's pull request branch in to run
 * it locally and fix nits. Those branches are reference material, so they are
 * gathered under the login that opened them rather than mixed into the
 * reviewer's own list.
 */

import { describe, expect, it } from 'vitest'
import { partitionByAuthor } from '@/components/workspace-list'

type Node = Parameters<typeof partitionByAuthor>[0][number]

const node = (
  id: string,
  prAuthorLogin: string | null,
  children: Node[] = []
) =>
  ({
    children,
    workspace: {
      branchName: id,
      id,
      parentTaskId: null,
      prAuthorLogin,
      projectId: 'project-1',
      worktreePath: `/worktrees/${id}`,
    },
  }) as unknown as Node

describe('partitionByAuthor', () => {
  it('leaves the viewer’s own branches ungrouped', () => {
    const mine = node('my-feature', 'izakfilmalter')

    const { authorGroups, ownNodes } = partitionByAuthor(
      [mine],
      'izakfilmalter'
    )

    expect(authorGroups).toEqual([])
    expect(ownNodes.map((entry) => entry.workspace.id)).toEqual(['my-feature'])
  })

  it('groups another author’s branch under their login', () => {
    const theirs = node('their-fix', 'octocat')

    const { authorGroups, ownNodes } = partitionByAuthor(
      [theirs],
      'izakfilmalter'
    )

    expect(ownNodes).toEqual([])
    expect(authorGroups).toHaveLength(1)
    expect(authorGroups[0]?.login).toBe('octocat')
    expect(authorGroups[0]?.nodes.map((entry) => entry.workspace.id)).toEqual([
      'their-fix',
    ])
  })

  it('keeps a branch with no pull request out of any author group', () => {
    // No pull request means unattributed, which is not the same fact as
    // "mine": guessing either way would move a branch the user did not file.
    const unattributed = node('scratch', null)

    const { authorGroups, ownNodes } = partitionByAuthor(
      [unattributed],
      'izakfilmalter'
    )

    expect(authorGroups).toEqual([])
    expect(ownNodes.map((entry) => entry.workspace.id)).toEqual(['scratch'])
  })

  it('gathers several branches by the same author into one group', () => {
    const { authorGroups } = partitionByAuthor(
      [node('fix-a', 'octocat'), node('fix-b', 'octocat')],
      'izakfilmalter'
    )

    expect(authorGroups).toHaveLength(1)
    expect(authorGroups[0]?.nodes).toHaveLength(2)
  })

  it('orders author groups by login so the sidebar does not reshuffle', () => {
    const { authorGroups } = partitionByAuthor(
      [node('z', 'zoe'), node('a', 'aaron'), node('m', 'mira')],
      'izakfilmalter'
    )

    expect(authorGroups.map((group) => group.login)).toEqual([
      'aaron',
      'mira',
      'zoe',
    ])
  })

  it('keeps the reviewer’s sub-workspace with the branch it patches', () => {
    // A fix stacked on somebody's pull request belongs beside that pull
    // request, not hoisted into the reviewer's own list.
    const myFix = node('nit-fix', 'izakfilmalter')
    const theirBranch = node('their-feature', 'octocat', [myFix])

    const { authorGroups, ownNodes } = partitionByAuthor(
      [theirBranch],
      'izakfilmalter'
    )

    expect(ownNodes).toEqual([])
    expect(
      authorGroups[0]?.nodes[0]?.children.map((c) => c.workspace.id)
    ).toEqual(['nit-fix'])
  })

  it('groups every attributed branch while the viewer login is unknown', () => {
    // Null viewer means the login has not resolved yet. Grouping everything
    // attributed stays truthful rather than briefly claiming branches as mine.
    const { authorGroups, ownNodes } = partitionByAuthor(
      [node('mine', 'izakfilmalter'), node('theirs', 'octocat')],
      null
    )

    expect(ownNodes).toEqual([])
    expect(authorGroups.map((group) => group.login)).toEqual([
      'izakfilmalter',
      'octocat',
    ])
  })
})
