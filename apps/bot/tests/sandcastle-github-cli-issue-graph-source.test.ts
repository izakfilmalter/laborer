import { assert, describe, it } from '@effect/vitest'
import { GitHubCliIssueGraphSource } from '../../../.sandcastle/github-cli-issue-graph-source/index.ts'

const multiplePullRequestsPattern = /multiple open pull requests/

const githubIssue = (
  number: number,
  options: Readonly<Record<string, unknown>> = {}
) => ({
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  labels: [{ name: 'sandcastle:ready' }],
  number,
  parent_issue_url: null,
  state: 'open',
  title: `Issue ${number}`,
  ...options,
})

const githubPullRequest = (urlSuffix: number) => ({
  baseRefName: 'master',
  body: 'Pull request body',
  headRefName: 'sandcastle/issue-12',
  isCrossRepository: false,
  isDraft: false,
  state: 'OPEN',
  title: `Pull request ${urlSuffix}`,
  url: `https://github.com/acme/widgets/pull/${urlSuffix}`,
})

describe('GitHubCliIssueGraphSource', () => {
  it('lists every open labeled issue across REST pages and excludes pull requests', () => {
    const calls: (readonly string[])[] = []
    const source = new GitHubCliIssueGraphSource((args) => {
      calls.push(args)
      return JSON.stringify([
        [
          {
            html_url: 'https://github.com/acme/widgets/issues/3',
            labels: [{ name: 'sandcastle:ready' }],
            number: 3,
            state: 'open',
            title: 'First issue',
          },
          {
            html_url: 'https://github.com/acme/widgets/pull/4',
            labels: [{ name: 'sandcastle:ready' }],
            number: 4,
            pull_request: {},
            state: 'open',
            title: 'A pull request',
          },
        ],
        [
          {
            html_url: 'https://github.com/acme/widgets/issues/8',
            labels: [{ name: 'sandcastle:ready' }],
            number: 8,
            state: 'open',
            title: 'Second issue',
          },
        ],
      ])
    }, 'acme/widgets')

    assert.deepStrictEqual(
      source.listOpenIssueNumbers('sandcastle:ready'),
      [3, 8]
    )
    assert.deepStrictEqual(calls, [
      [
        'api',
        '--method',
        'GET',
        'repos/acme/widgets/issues',
        '-f',
        'state=open',
        '-f',
        'labels=sandcastle:ready',
        '-f',
        'per_page=100',
        '--paginate',
        '--slurp',
      ],
    ])
  })

  it('maps native children, open blockers, and a same-repository parent', () => {
    const calls: (readonly string[])[] = []
    const source = new GitHubCliIssueGraphSource((args) => {
      calls.push(args)
      const endpoint = args[3]
      if (endpoint === 'repos/acme/widgets/issues/12') {
        return JSON.stringify(
          githubIssue(12, {
            parent_issue_url:
              'https://api.github.com/repos/acme/widgets/issues/9',
            state: 'closed',
            title: 'Tracked work',
          })
        )
      }
      if (endpoint === 'repos/acme/widgets/issues/12/sub_issues') {
        return JSON.stringify([
          [githubIssue(14, { title: 'First child' })],
          [githubIssue(13, { title: 'Second child' })],
        ])
      }
      if (endpoint === 'repos/acme/widgets/issues/12/dependencies/blocked_by') {
        return JSON.stringify([
          [githubIssue(4, { title: 'Open prerequisite' })],
          [
            githubIssue(5, {
              state: 'closed',
              title: 'Delivered prerequisite',
            }),
          ],
        ])
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }, 'acme/widgets')

    assert.deepStrictEqual(source.issue(12), {
      childNumbers: [14, 13],
      number: 12,
      openBlockers: [{ number: 4, title: 'Open prerequisite' }],
      parentNumber: 9,
      state: 'CLOSED',
      title: 'Tracked work',
    })
    for (const paginatedCall of calls.slice(1)) {
      assert.deepStrictEqual(paginatedCall.slice(-4), [
        '-f',
        'per_page=100',
        '--paginate',
        '--slurp',
      ])
    }
  })

  it('returns no pull request only after a successful empty open-PR query', () => {
    const calls: (readonly string[])[] = []
    const source = new GitHubCliIssueGraphSource((args) => {
      calls.push(args)
      return '[]'
    }, 'acme/widgets')

    assert.strictEqual(source.pullRequest('sandcastle/issue-12'), undefined)
    assert.deepStrictEqual(calls, [
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--state',
        'all',
        '--head',
        'sandcastle/issue-12',
        '--limit',
        '2',
        '--json',
        'baseRefName,body,headRefName,isCrossRepository,isDraft,state,title,url',
      ],
    ])
  })

  it('fails closed when multiple open pull requests match a branch', () => {
    const source = new GitHubCliIssueGraphSource(
      () => JSON.stringify([githubPullRequest(20), githubPullRequest(21)]),
      'acme/widgets'
    )

    assert.throws(
      () => source.pullRequest('sandcastle/issue-12'),
      multiplePullRequestsPattern
    )
  })

  it('resolves and reuses repository nameWithOwner through gh repo view', () => {
    const calls: (readonly string[])[] = []
    const source = new GitHubCliIssueGraphSource((args) => {
      calls.push(args)
      if (args[0] === 'repo') {
        return JSON.stringify({ nameWithOwner: 'acme/widgets' })
      }
      return '[]'
    })

    assert.deepStrictEqual(source.pullRequest('sandcastle/issue-12'), undefined)
    assert.deepStrictEqual(source.pullRequest('sandcastle/issue-13'), undefined)
    assert.deepStrictEqual(calls[0], [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
    ])
    assert.strictEqual(calls.filter((args) => args[0] === 'repo').length, 1)
  })

  it('maps one validated open pull request', () => {
    const source = new GitHubCliIssueGraphSource(
      () => JSON.stringify([githubPullRequest(20)]),
      'acme/widgets'
    )

    assert.deepStrictEqual(source.pullRequest('sandcastle/issue-12'), {
      baseRefName: 'master',
      body: 'Pull request body',
      headRefName: 'sandcastle/issue-12',
      isCrossRepository: false,
      isDraft: false,
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/20',
    })
  })

  it('rejects malformed and cross-repository parent issue URLs', () => {
    const invalidParents = [
      'not a URL',
      'https://evil.example/repos/acme/widgets/issues/9',
      'https://api.github.com/repos/acme/other/issues/9',
    ]

    for (const parent_issue_url of invalidParents) {
      const source = new GitHubCliIssueGraphSource((args) => {
        const endpoint = args[3]
        if (endpoint === 'repos/acme/widgets/issues/12') {
          return JSON.stringify(githubIssue(12, { parent_issue_url }))
        }
        return '[[]]'
      }, 'acme/widgets')

      assert.throws(() => source.issue(12))
    }
  })

  it('fails closed on malformed issue and pull-request payloads', () => {
    const malformedIssueSource = new GitHubCliIssueGraphSource(
      () => JSON.stringify({ number: 12, state: 'OPEN', title: 'Bad issue' }),
      'acme/widgets'
    )
    const malformedPullRequestSource = new GitHubCliIssueGraphSource(
      () =>
        JSON.stringify([
          { ...githubPullRequest(20), state: 'DRAFT', url: 'not a URL' },
        ]),
      'acme/widgets'
    )

    assert.throws(() => malformedIssueSource.issue(12))
    assert.throws(() =>
      malformedPullRequestSource.pullRequest('sandcastle/issue-12')
    )
  })

  it('validates requested issue numbers before invoking GitHub', () => {
    let invoked = false
    const source = new GitHubCliIssueGraphSource(() => {
      invoked = true
      return '{}'
    }, 'acme/widgets')

    assert.throws(() => source.issue(0))
    assert.throws(() => source.issue(Number.MAX_SAFE_INTEGER + 1))
    assert.strictEqual(invoked, false)
  })

  it('propagates runner errors unchanged', () => {
    const failure = new Error('gh failed')
    const source = new GitHubCliIssueGraphSource(() => {
      throw failure
    }, 'acme/widgets')
    let issueFailure: unknown
    let pullRequestFailure: unknown

    try {
      source.issue(12)
    } catch (error) {
      issueFailure = error
    }
    try {
      source.pullRequest('sandcastle/issue-12')
    } catch (error) {
      pullRequestFailure = error
    }

    assert.strictEqual(issueFailure, failure)
    assert.strictEqual(pullRequestFailure, failure)
  })
})
