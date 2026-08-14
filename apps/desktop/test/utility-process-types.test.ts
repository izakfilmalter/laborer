import { describe, expect, it } from 'vitest'
import { isUtilityProcessBootstrapMessage } from '../src/utility-process-types.js'

describe('isUtilityProcessBootstrapMessage', () => {
  it('accepts bootstrap lifecycle messages', () => {
    expect(isUtilityProcessBootstrapMessage({ type: 'ready' })).toBe(true)
    expect(isUtilityProcessBootstrapMessage({ type: 'heartbeat' })).toBe(true)
    expect(
      isUtilityProcessBootstrapMessage({ type: 'error', message: 'failed' })
    ).toBe(true)
  })

  it('rejects malformed and unknown child-process messages', () => {
    expect(
      isUtilityProcessBootstrapMessage({ type: 'error', message: 42 })
    ).toBe(false)
    expect(isUtilityProcessBootstrapMessage({ type: 'surprise' })).toBe(false)
  })
})
