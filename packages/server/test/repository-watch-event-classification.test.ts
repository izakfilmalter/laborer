/**
 * Regression: per-worktree `index`/`index.lock` writes must not count as
 * worktree metadata. Every `git status` rewrites them, and reacting to them
 * made reconciliation re-trigger itself on every cooldown forever — and every
 * daemon watching the same repository re-trigger every other.
 */

import { describe, expect, it } from 'vitest'
import {
  isWorktreeRelatedEvent,
  isWorktreesDirMetadataEvent,
} from '../src/services/repository-watch-coordinator.js'

describe('isWorktreeRelatedEvent (git-dir watcher)', () => {
  it.each([
    'worktrees',
    'worktrees/feature',
    'worktrees/feature/HEAD',
    'worktrees/feature/gitdir',
    'worktrees/feature/locked',
    'worktrees/feature/commondir',
  ])('treats %s as worktree metadata', (fileName) => {
    expect(isWorktreeRelatedEvent(fileName)).toBe(true)
  })

  it.each([
    'worktrees/feature/index',
    'worktrees/feature/index.lock',
    'worktrees/feature/ORIG_HEAD',
    'worktrees/feature/logs/HEAD',
    'worktrees/feature/COMMIT_EDITMSG',
    'worktrees/',
    'worktreesX',
    'index.lock',
    'HEAD',
    'objects/ab/cdef',
    null,
  ])('ignores %s', (fileName) => {
    expect(isWorktreeRelatedEvent(fileName)).toBe(false)
  })
})

describe('isWorktreesDirMetadataEvent (worktrees watcher)', () => {
  it('accepts worktree directories and their metadata files', () => {
    expect(isWorktreesDirMetadataEvent('feature')).toBe(true)
    expect(isWorktreesDirMetadataEvent('feature/HEAD')).toBe(true)
    expect(isWorktreesDirMetadataEvent('feature/gitdir')).toBe(true)
  })

  it('ignores per-worktree working state', () => {
    expect(isWorktreesDirMetadataEvent('feature/index.lock')).toBe(false)
    expect(isWorktreesDirMetadataEvent('feature/index')).toBe(false)
    expect(isWorktreesDirMetadataEvent(null)).toBe(false)
  })
})
