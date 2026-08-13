import { describe, expect, it } from 'vitest'
import type { DurableWorkThreadActivity } from '../src/durable-runtime/root-runtime.ts'
import {
  makePostCutoverOperatorProjection,
  makeWorkThreadActivityProjection,
} from '../src/operator-status/activity-projection.ts'

const observation = (
  overrides: Partial<DurableWorkThreadActivity> = {}
): DurableWorkThreadActivity => ({
  channelId: 'C123',
  conversationId: 'workspace:TTEAM:C123:1000.000001',
  conversationInProgress: false,
  evidenceAtUnixMs: 1000,
  excerpt: '  <@UBOT> investigate\nthis  ',
  executions: [],
  rootTs: '1000.000001',
  workspaceId: 'TTEAM',
  ...overrides,
})

describe('post-cutover operator activity projection', () => {
  it('derives dormant and in-progress solely from Conversation and Execution state', () => {
    let now = 2000
    const projection = makeWorkThreadActivityProjection({ now: () => now })

    projection.observe('TTEAM', [observation()])
    expect(projection.snapshot('TTEAM')).toEqual([
      expect.objectContaining({
        activity: 'dormant',
        excerpt: 'investigate this',
        stateChangedAtUnixMs: 1000,
      }),
    ])

    now = 3000
    projection.observe('TTEAM', [
      observation({ conversationInProgress: true, evidenceAtUnixMs: 2500 }),
    ])
    expect(projection.snapshot('TTEAM')[0]).toEqual(
      expect.objectContaining({
        activity: 'in-progress',
        stateChangedAtUnixMs: 3000,
      })
    )

    now = 4000
    projection.observe('TTEAM', [
      observation({
        evidenceAtUnixMs: 3500,
        executions: [
          {
            actionName: 'build/run',
            executionId: 'execution:1',
            lifecycle: 'recovery-blocked',
            startedAtUnixMs: 3500,
          },
        ],
      }),
    ])
    expect(projection.snapshot('TTEAM')[0]).toEqual(
      expect.objectContaining({
        activity: 'in-progress',
        executions: [
          expect.objectContaining({
            id: 'execution:1',
            lifecycle: 'recovery-blocked',
          }),
        ],
      })
    )

    now = 5000
    projection.observe('TTEAM', [observation({ evidenceAtUnixMs: 4500 })])
    expect(projection.snapshot('TTEAM')[0]).toEqual(
      expect.objectContaining({
        activity: 'dormant',
        stateChangedAtUnixMs: 5000,
      })
    )
  })

  it('refreshes dormant recency when a complete turn happens between polls', () => {
    let now = 2000
    const projection = makeWorkThreadActivityProjection({ now: () => now })

    projection.observe('TTEAM', [observation()])
    now = 4000
    projection.observe('TTEAM', [observation({ evidenceAtUnixMs: 3000 })])

    expect(projection.snapshot('TTEAM')[0]?.stateChangedAtUnixMs).toBe(3000)
  })

  it('fails closed and recovers workspace readiness when activity cannot be read', () => {
    const projection = makePostCutoverOperatorProjection([
      { bindingIndex: 0, expectedTeamId: 'TTEAM', tokenIsValid: true },
    ])

    projection.observe('TTEAM', [observation()])
    projection.markWorkspaceReady('TTEAM')
    expect(projection.snapshot().workspaces[0]).toEqual(
      expect.objectContaining({
        readiness: 'ready',
        threads: [expect.anything()],
      })
    )

    projection.markWorkspaceUnavailable('TTEAM')
    expect(projection.snapshot().workspaces[0]).toEqual(
      expect.objectContaining({
        detail: 'runtime-unavailable',
        readiness: 'unavailable',
        threads: [],
      })
    )

    projection.markWorkspaceReady('TTEAM')
    expect(projection.snapshot().workspaces[0]).toEqual(
      expect.objectContaining({
        readiness: 'ready',
        threads: [expect.anything()],
      })
    )
  })
})
