/**
 * Reading `gh pr list --json` output.
 *
 * The sidebar files every open pull request under the login that opened it, so
 * the only things this has to get right are attribution and never raising: a
 * heading cannot recover from an exception, and it can always show nothing.
 */

import { describe, expect, it } from 'vitest'
import { toOpenPullRequests } from '../src/services/github-pull-requests.js'

const entry = (overrides: Record<string, unknown> = {}) => ({
  author: { login: 'octocat' },
  body: 'Fixes the thing.',
  headRefName: 'octocat/fix-the-thing',
  isDraft: false,
  number: 42,
  title: 'Fix the thing',
  url: 'https://github.com/acme/repo/pull/42',
  ...overrides,
})

describe('toOpenPullRequests', () => {
  it('reads a pull request into the shape the sidebar shows', () => {
    expect(toOpenPullRequests(JSON.stringify([entry()]))).toEqual([
      {
        authorLogin: 'octocat',
        body: 'Fixes the thing.',
        branchName: 'octocat/fix-the-thing',
        isDraft: false,
        number: 42,
        title: 'Fix the thing',
        url: 'https://github.com/acme/repo/pull/42',
      },
    ])
  })

  it('keeps a pull request with no body, which has nothing to preview', () => {
    const [pullRequest] = toOpenPullRequests(
      JSON.stringify([entry({ body: null })])
    )

    expect(pullRequest?.body).toBeNull()
  })

  it('drops a pull request nobody can be credited with', () => {
    // A deleted account comes back with no author. It cannot be filed under a
    // heading, and inventing a blank one would name a person who is not there.
    expect(
      toOpenPullRequests(JSON.stringify([entry({ author: null })]))
    ).toEqual([])
  })

  it('answers nothing rather than raising on output it cannot read', () => {
    expect(toOpenPullRequests('not json at all')).toEqual([])
    expect(
      toOpenPullRequests(JSON.stringify({ message: 'Not Found' }))
    ).toEqual([])
    expect(toOpenPullRequests('')).toEqual([])
  })

  it('drops only the entries it cannot read', () => {
    // `gh` is one process reporting many pull requests; one malformed entry
    // should not cost the reviewer the rest of the list.
    const parsed = toOpenPullRequests(
      JSON.stringify([entry(), { number: 'not-a-number' }])
    )

    expect(parsed.map((pullRequest) => pullRequest.number)).toEqual([42])
  })
})
