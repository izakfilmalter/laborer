import { describe, expect, it, vi } from 'vitest'
import {
  reconcileLaunchAgent,
  SERVICE_MANAGEMENT_PROTOCOL_VERSION,
} from '../src/companion/service-management.ts'
import { LABORER_VERSION } from '../src/version.ts'

const response = (
  state:
    | 'denied'
    | 'enabled'
    | 'not-found'
    | 'not-registered'
    | 'requires-approval'
): string =>
  JSON.stringify({
    protocolVersion: SERVICE_MANAGEMENT_PROTOCOL_VERSION,
    serviceVersion: LABORER_VERSION,
    state,
  })

describe('companion LaunchAgent reconciliation', () => {
  it('adopts an already registered service without registering a duplicate', async () => {
    const run = vi.fn(async () => response('enabled'))

    await expect(reconcileLaunchAgent(run)).resolves.toBe('already-registered')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('status')
  })

  it('registers a missing service exactly once', async () => {
    const run = vi
      .fn<(operation: 'register' | 'status') => Promise<string>>()
      .mockResolvedValueOnce(response('not-registered'))
      .mockResolvedValueOnce(response('enabled'))

    await expect(reconcileLaunchAgent(run)).resolves.toBe('registered')
    expect(run.mock.calls).toEqual([['status'], ['register']])
  })

  it.each([
    ['requires-approval', 'requires-approval'],
    ['denied', 'denied'],
    ['not-found', 'unavailable'],
  ] as const)('maps native %s without claiming daemon health', async (native, expected) => {
    await expect(
      reconcileLaunchAgent(async () => response(native))
    ).resolves.toBe(expected)
  })

  it('fails closed when the bundled service version is incompatible', async () => {
    await expect(
      reconcileLaunchAgent(async () =>
        JSON.stringify({
          protocolVersion: SERVICE_MANAGEMENT_PROTOCOL_VERSION,
          serviceVersion: '0.0.0-older',
          state: 'enabled',
        })
      )
    ).resolves.toBe('version-mismatch')
  })

  it.each([
    'not json',
    JSON.stringify({
      protocolVersion: SERVICE_MANAGEMENT_PROTOCOL_VERSION + 1,
      serviceVersion: LABORER_VERSION,
      state: 'enabled',
    }),
  ])('fails closed for invalid helper output', async (output) => {
    await expect(reconcileLaunchAgent(async () => output)).resolves.toBe(
      'unavailable'
    )
  })
})
