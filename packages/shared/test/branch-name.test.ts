import { describe, expect, it } from 'vitest'
import { isPastedBranchName, pastedBranchName } from '../src/branch-name.js'

describe('pastedBranchName', () => {
  it('keeps a pasted branch name verbatim so it can match origin', () => {
    expect(pastedBranchName('feature/colleague-pr')).toBe(
      'feature/colleague-pr'
    )
    expect(pastedBranchName('  izak/Fix-Thing_2.0  ')).toBe(
      'izak/Fix-Thing_2.0'
    )
    expect(pastedBranchName('renovate/effect-4.x')).toBe('renovate/effect-4.x')
    expect(pastedBranchName('hotfix')).toBe('hotfix')
  })

  it('reads prose as a title rather than a branch name', () => {
    expect(pastedBranchName('Fix the login flow')).toBeNull()
    expect(pastedBranchName('')).toBeNull()
    expect(pastedBranchName('   ')).toBeNull()
    expect(pastedBranchName('Ship it!')).toBeNull()
    expect(pastedBranchName('⚡️')).toBeNull()
  })

  it('rejects text git would refuse as a ref', () => {
    expect(pastedBranchName('feature/..hack')).toBeNull()
    expect(pastedBranchName('feature//hack')).toBeNull()
    expect(pastedBranchName('feature/')).toBeNull()
    expect(pastedBranchName('/leading')).toBeNull()
    expect(pastedBranchName('feature.lock')).toBeNull()
    expect(pastedBranchName('branch@{0}')).toBeNull()
    expect(pastedBranchName(`a/${'b'.repeat(300)}`)).toBeNull()
  })

  it('reports the same classification as the predicate', () => {
    expect(isPastedBranchName('feature/colleague-pr')).toBe(true)
    expect(isPastedBranchName('Fix the login flow')).toBe(false)
  })
})
