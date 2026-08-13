import { describe, expect, it } from 'vitest'
import { parseGithubRepo } from '../src/services/github-pr-view.js'

describe('parseGithubRepo', () => {
  it.each([
    ['https://github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['git@github.com:acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    [' https://github.com/acme/widgets ', { owner: 'acme', repo: 'widgets' }],
    ['https://example.com/acme/widgets.git', null],
  ])('parses %s', (remoteUrl, expected) => {
    expect(parseGithubRepo(remoteUrl)).toEqual(expected)
  })
})
