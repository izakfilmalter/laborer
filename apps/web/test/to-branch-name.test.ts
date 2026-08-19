import { describe, expect, it } from 'vitest'
import { toBranchName } from '@/hooks/use-create-workspace'

describe('toBranchName', () => {
  it('preserves case so the name still matches origin', () => {
    // Git refs are case-sensitive on the wire. Folding these would make
    // `git fetch origin refs/heads/<name>` miss the branch and silently start a
    // new one off HEAD, losing the commits the branch was opened to review.
    expect(toBranchName('PROJ-1234-Fix-Login')).toBe('PROJ-1234-Fix-Login')
    expect(toBranchName('Release/2.0')).toBe('Release/2.0')
    expect(toBranchName('izak/Fix-Thing')).toBe('izak/Fix-Thing')
  })

  it('still masks characters git will not take', () => {
    expect(toBranchName('My Feature')).toBe('My-Feature')
    expect(toBranchName('feat: ship it!')).toBe('feat-ship-it')
    expect(toBranchName('a~b^c:d?e*f[g')).toBe('abcdefg')
  })
})
