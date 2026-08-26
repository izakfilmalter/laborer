import { describe, expect, it } from 'vitest'
import {
  type DiffChangeType,
  diffChangeTypeIconClassName,
  diffChangeTypeLabel,
} from '@/lib/diff-change-type'

describe('diffChangeTypeIconClassName', () => {
  it('colours added and deleted files with the app tokens', () => {
    expect(diffChangeTypeIconClassName('added')).toBe('text-success')
    expect(diffChangeTypeIconClassName('deleted')).toBe('text-destructive')
  })

  it('leaves modifications and renames neutral', () => {
    expect(diffChangeTypeIconClassName('modified')).toBe(
      'text-muted-foreground'
    )
    expect(diffChangeTypeIconClassName('renamed')).toBe('text-muted-foreground')
  })

  it('never uses a bundled diff colour, so the chevron follows the theme', () => {
    const types: readonly DiffChangeType[] = [
      'added',
      'deleted',
      'modified',
      'renamed',
    ]

    for (const type of types) {
      expect(diffChangeTypeIconClassName(type)).not.toContain('--diffs-')
    }
  })
})

describe('diffChangeTypeLabel', () => {
  it('names every change type, so colour is not the only signal', () => {
    expect(diffChangeTypeLabel('added')).toBe('added file')
    expect(diffChangeTypeLabel('deleted')).toBe('deleted file')
    expect(diffChangeTypeLabel('modified')).toBe('modified file')
    expect(diffChangeTypeLabel('renamed')).toBe('renamed file')
  })
})
