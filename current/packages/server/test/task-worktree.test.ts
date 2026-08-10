import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectTaskWorktree } from '../src/services/task-worktree.js'

const worktree = (): string => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'laborer-task-worktree-')),
    'tree'
  )
  mkdirSync(path)
  return path
}

describe('inspectTaskWorktree', () => {
  it('reports passive existence and matching owner evidence', () => {
    const path = worktree()
    writeFileSync(
      join(path, '.laborer-worktree-owner.json'),
      JSON.stringify({ executionId: 'execution-1' })
    )

    expect(inspectTaskWorktree(path, 'execution-1')).toEqual({
      botOwned: true,
      exists: true,
    })
    expect(inspectTaskWorktree(path, 'execution-2')).toEqual({
      botOwned: false,
      exists: true,
    })
  })

  it('never treats missing or symlinked owner markers as ownership', () => {
    const path = worktree()
    const markerTarget = join(path, 'marker-target.json')
    writeFileSync(markerTarget, JSON.stringify({ executionId: 'execution-1' }))
    symlinkSync(markerTarget, join(path, '.laborer-worktree-owner.json'))

    expect(inspectTaskWorktree(path, 'execution-1')).toEqual({
      botOwned: false,
      exists: true,
    })
    rmSync(path, { recursive: true })
    expect(inspectTaskWorktree(path, 'execution-1')).toEqual({
      botOwned: false,
      exists: false,
    })
  })
})
