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

type PullRequest = Parameters<typeof partitionByAuthor>[2] extends
  | readonly (infer Entry)[]
  | undefined
  ? Entry
  : never

const pullRequest = (
  branchName: string,
  authorLogin: string,
  number = 1
): PullRequest => ({
  authorLogin,
  body: null,
  branchName,
  isDraft: false,
  number,
  title: branchName,
  url: `https://github.com/acme/repo/pull/${number}`,
})

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

describe('partitionByAuthor — pull requests that are not here yet', () => {
  it('gives an author a group for work with no worktree behind it', () => {
    // Nothing of theirs is checked out, but they still have something open,
    // and a heading that only counted worktrees would say they have nothing.
    const { authorGroups } = partitionByAuthor([], 'izakfilmalter', [
      pullRequest('octocat/fix', 'octocat', 7),
    ])

    expect(authorGroups).toHaveLength(1)
    expect(authorGroups[0]?.login).toBe('octocat')
    expect(authorGroups[0]?.nodes).toEqual([])
    expect(
      authorGroups[0]?.remotePullRequests.map((entry) => entry.number)
    ).toEqual([7])
  })

  it('does not list a pull request that is already checked out', () => {
    // The workspace card above is the same branch. Two entries for one branch
    // would read as two pieces of work.
    const { authorGroups } = partitionByAuthor(
      [node('octocat/fix', 'octocat')],
      'izakfilmalter',
      [pullRequest('octocat/fix', 'octocat', 7)]
    )

    expect(authorGroups[0]?.nodes).toHaveLength(1)
    expect(authorGroups[0]?.remotePullRequests).toEqual([])
  })

  it('counts a branch pulled in as a sub-workspace as checked out', () => {
    const { authorGroups } = partitionByAuthor(
      [node('their-feature', 'octocat', [node('octocat/fix', 'octocat')])],
      'izakfilmalter',
      [pullRequest('octocat/fix', 'octocat', 7)]
    )

    expect(authorGroups[0]?.remotePullRequests).toEqual([])
  })

  it('leaves the viewer’s own pull requests out of the author groups', () => {
    // The reviewer's own work is the list above, not reference material filed
    // under their own name.
    const { authorGroups } = partitionByAuthor([], 'izakfilmalter', [
      pullRequest('my-feature', 'izakfilmalter', 8),
    ])

    expect(authorGroups).toEqual([])
  })

  it('shows an author’s checked-out branches above what is still remote', () => {
    const { authorGroups } = partitionByAuthor(
      [node('octocat/here', 'octocat')],
      'izakfilmalter',
      [
        pullRequest('octocat/older', 'octocat', 3),
        pullRequest('octocat/newer', 'octocat', 9),
      ]
    )

    expect(authorGroups[0]?.nodes.map((entry) => entry.workspace.id)).toEqual([
      'octocat/here',
    ])
    // Newest first: the pull request just opened is the one being asked about.
    expect(
      authorGroups[0]?.remotePullRequests.map((entry) => entry.branchName)
    ).toEqual(['octocat/newer', 'octocat/older'])
  })
})
