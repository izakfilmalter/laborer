import { describe, expect, it } from 'vitest'
import { containerName } from '../src/container-name.js'

const HASH_SUFFIX_PATTERN = /-[a-f0-9]{6}$/
const DOUBLE_HYPHEN_HASH_PATTERN = /--[a-f0-9]{6}$/
const ORB_LOCAL_URL_PATTERN = /^[a-z0-9-]+\.orb\.local$/

describe('containerName', () => {
  it('produces a simple container name from branch and project', () => {
    const result = containerName('feature-auth', 'my-project')

    expect(result).toEqual({
      name: 'feature-auth--my-project',
      url: 'feature-auth--my-project.orb.local',
    })
  })

  it('converts slashes to hyphens', () => {
    const result = containerName('feature/auth', 'my-project')

    expect(result.name).toBe('feature-auth--my-project')
  })

  it('converts multiple slashes to hyphens', () => {
    const result = containerName('feature/auth/login', 'my-project')

    expect(result.name).toBe('feature-auth-login--my-project')
  })

  it('lowercases all characters', () => {
    const result = containerName('Feature/Auth', 'My-Project')

    expect(result.name).toBe('feature-auth--my-project')
  })

  it('strips invalid characters', () => {
    const result = containerName('feature_auth!@#$%', 'my.project(v2)')

    expect(result.name).toBe('featureauth--myprojectv2')
  })

  it('collapses consecutive hyphens', () => {
    const result = containerName('feature--auth', 'my---project')

    expect(result.name).toBe('feature-auth--my-project')
  })

  it('trims leading and trailing hyphens from slugs', () => {
    const result = containerName('-feature-', '-project-')

    expect(result.name).toBe('feature--project')
  })

  it('handles unicode characters by stripping them', () => {
    const result = containerName('feature/日本語', 'projeté')

    expect(result.name).toBe('feature--projet')
  })

  it('handles empty branch name', () => {
    const result = containerName('', 'my-project')

    expect(result.name).toBe('--my-project')
  })

  it('handles empty project name', () => {
    const result = containerName('feature-auth', '')

    expect(result.name).toBe('feature-auth--')
  })

  it('handles both empty', () => {
    const result = containerName('', '')

    expect(result.name).toBe('--')
  })

  it('produces a name exactly at 63 chars without truncation', () => {
    // 63 - 2 (separator --) = 61 chars for slugs
    // branch: 30 chars, project: 31 chars
    const branch = 'a'.repeat(30)
    const project = 'b'.repeat(31)
    const result = containerName(branch, project)

    expect(result.name.length).toBe(63)
    expect(result.name).toBe(`${'a'.repeat(30)}--${'b'.repeat(31)}`)
  })

  it('truncates names exceeding 63 chars with a hash suffix', () => {
    const branch = 'a'.repeat(40)
    const project = 'b'.repeat(40)
    const result = containerName(branch, project)

    expect(result.name.length).toBeLessThanOrEqual(63)
    // Should end with a 6-char hex hash preceded by a hyphen
    expect(result.name).toMatch(HASH_SUFFIX_PATTERN)
  })

  it('preserves uniqueness for different inputs that would truncate the same', () => {
    const result1 = containerName('a'.repeat(50), 'project-alpha')
    const result2 = containerName('a'.repeat(50), 'project-beta')

    // Both get truncated, but should have different hashes
    expect(result1.name).not.toBe(result2.name)
    expect(result1.name.length).toBeLessThanOrEqual(63)
    expect(result2.name.length).toBeLessThanOrEqual(63)
  })

  it('produces a valid .orb.local URL', () => {
    const result = containerName('feature/auth', 'my-project')

    expect(result.url).toBe('feature-auth--my-project.orb.local')
  })

  it('produces a valid URL for truncated names', () => {
    const result = containerName('a'.repeat(40), 'b'.repeat(40))

    expect(result.url).toBe(`${result.name}.orb.local`)
    expect(result.url).toMatch(ORB_LOCAL_URL_PATTERN)
  })

  it('handles branch names with only invalid characters', () => {
    const result = containerName('!!!', 'my-project')

    expect(result.name).toBe('--my-project')
  })

  it('handles realistic branch names with slashes and numbers', () => {
    const result = containerName('fix/issue-123', 'laborer')

    expect(result.name).toBe('fix-issue-123--laborer')
  })

  it('handles very long branch name with slashes', () => {
    const branch =
      'feature/very-long-branch-name-that-describes-the-change-in-detail'
    const result = containerName(branch, 'my-project')

    expect(result.name.length).toBeLessThanOrEqual(63)
    expect(result.name).toMatch(HASH_SUFFIX_PATTERN)
  })

  it('produces deterministic output for the same inputs', () => {
    const result1 = containerName('feature/auth', 'my-project')
    const result2 = containerName('feature/auth', 'my-project')

    expect(result1).toEqual(result2)
  })

  it('does not leave trailing hyphens in the truncated base', () => {
    // Craft an input where truncation lands right on a hyphen
    // The base is truncated at maxBaseLength (63 - 1 - 6 = 56 chars)
    // and trailing hyphens should be stripped before appending the hash
    const branch = `${'a'.repeat(54)}-`
    const project = 'b'.repeat(10)
    const result = containerName(branch, project)

    // Should not have `--` before the hash (double hyphen from trailing + hash separator)
    expect(result.name).not.toMatch(DOUBLE_HYPHEN_HASH_PATTERN)
    expect(result.name.length).toBeLessThanOrEqual(63)
  })
})
