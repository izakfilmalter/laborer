import {
  AgentStatusReportSchema,
  AgentStatusSnapshotSchema,
} from '@laborer/shared/rpc'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

describe('Agent status RPC contract', () => {
  it.each([
    'working',
    'needs_input',
    'idle',
    'unknown',
  ] as const)('decodes semantic status %s with provenance', (status) => {
    expect(
      Schema.decodeUnknownSync(AgentStatusSnapshotSchema)({
        status,
        source: 'ps',
        changedAt: 123,
        stale: false,
        seen: true,
      })
    ).toEqual({
      status,
      source: 'ps',
      changedAt: 123,
      stale: false,
      seen: true,
    })
  })

  it('rejects the removed two-value status vocabulary', () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentStatusSnapshotSchema)({
        status: 'active',
        source: 'ps',
        changedAt: 123,
        stale: false,
        seen: true,
      })
    ).toThrow()
  })

  it('rejects done as lifecycle or detector output', () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentStatusSnapshotSchema)({
        status: 'done',
        source: 'ps',
        changedAt: 123,
        stale: false,
        seen: false,
      })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentStatusReportSchema)({
        status: 'done',
        sequence: 1,
      })
    ).toThrow()
  })

  it('requires sequence-bearing hook reports', () => {
    expect(
      Schema.decodeUnknownSync(AgentStatusReportSchema)({
        status: 'needs_input',
        sequence: 7,
      })
    ).toEqual({ status: 'needs_input', sequence: 7 })
  })
})
