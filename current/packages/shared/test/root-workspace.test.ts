import { describe, expect, it } from 'vitest'
import {
  isRootWorkspaceId,
  projectIdFromRootWorkspaceId,
  rootWorkspaceId,
} from '../src/root-workspace'

describe('root workspace identity', () => {
  it('builds a stable id from the project id', () => {
    expect(rootWorkspaceId('4f6e0f9c-1d1e-4e0a-9be1-6d8f6f0a2b7c')).toBe(
      'root-4f6e0f9c-1d1e-4e0a-9be1-6d8f6f0a2b7c'
    )
  })

  it('recognises synthetic root workspace ids', () => {
    expect(isRootWorkspaceId(rootWorkspaceId('project-1'))).toBe(true)
    // Task ids are uppercase Crockford-base32 ULIDs — never `root-` prefixed.
    expect(isRootWorkspaceId('01JGXYZABCDEFGHJKMNPQRSTVW')).toBe(false)
  })

  it('recovers the project id from a root workspace id', () => {
    expect(projectIdFromRootWorkspaceId(rootWorkspaceId('project-1'))).toBe(
      'project-1'
    )
    expect(projectIdFromRootWorkspaceId('01JGXYZABCDEFGHJKMNPQRSTVW')).toBe(
      null
    )
  })
})
