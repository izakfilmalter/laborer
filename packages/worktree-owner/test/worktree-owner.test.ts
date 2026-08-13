import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readWorktreeOwnerMarker,
  WORKTREE_OWNER_MARKER_MAX_BYTES,
  WORKTREE_OWNER_MARKER_NAME,
  type WorktreeOwnerMarker,
  writeWorktreeOwnerMarker,
} from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  )
})

const marker = (): WorktreeOwnerMarker => ({
  conversationId: 'conversation-1',
  executionId: 'execution-1',
  operationId: 'operation-1',
  rootAuthorityDigest: 'root-digest',
  schemaVersion: 1,
  worktreeName: 'tree',
})

describe('worktree owner marker', () => {
  it('round trips the shared schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laborer-owner-marker-'))
    roots.push(root)

    await writeWorktreeOwnerMarker(root, marker())

    expect(await readWorktreeOwnerMarker(root)).toEqual(marker())
  })

  it('rejects markers larger than the shared limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laborer-owner-marker-'))
    roots.push(root)
    await writeFile(
      join(root, WORKTREE_OWNER_MARKER_NAME),
      'x'.repeat(WORKTREE_OWNER_MARKER_MAX_BYTES + 1),
      { mode: 0o600 }
    )

    await expect(readWorktreeOwnerMarker(root)).rejects.toThrow(
      'Invalid worktree owner marker'
    )
  })
})
