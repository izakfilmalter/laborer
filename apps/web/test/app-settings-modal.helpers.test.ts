import { describe, expect, it } from 'vitest'
import { parseGithubOAuthCallback } from '../src/lib/github-oauth-callback'

describe('parseGithubOAuthCallback', () => {
  it('accepts a callback matching the one-time OAuth state', () => {
    expect(
      parseGithubOAuthCallback(
        'x-github-desktop-dev-auth://oauth?code=github-code&state=expected',
        'expected'
      )
    ).toBe('github-code')
  })

  it.each([
    ['missing state', 'x-github-desktop-dev-auth://oauth?code=github-code'],
    [
      'mismatched state',
      'x-github-desktop-dev-auth://oauth?code=github-code&state=unexpected',
    ],
  ])('rejects a callback with %s', (_label, callbackUrl) => {
    expect(() => parseGithubOAuthCallback(callbackUrl, 'expected')).toThrow(
      'could not be verified'
    )
  })

  it('rejects a callback when no authorization attempt is pending', () => {
    expect(() =>
      parseGithubOAuthCallback(
        'x-github-desktop-dev-auth://oauth?code=github-code&state=expected',
        ''
      )
    ).toThrow('could not be verified')
  })

  it('rejects a callback without an authorization code', () => {
    expect(() =>
      parseGithubOAuthCallback(
        'x-github-desktop-dev-auth://oauth?state=expected',
        'expected'
      )
    ).toThrow('No authorization code')
  })
})
