import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { OPERATION_ID_MAX_LENGTH, OperationId } from '../src/rpc.js'

describe('Laborer operation id contract', () => {
  const decode = Schema.decodeUnknownResult(OperationId)

  it('accepts a bounded nonblank Laborer-owned id', () => {
    expect(Result.isSuccess(decode('operation-1'))).toBe(true)
    expect(Result.isSuccess(decode('x'.repeat(OPERATION_ID_MAX_LENGTH)))).toBe(
      true
    )
  })

  it('rejects absent, blank, and oversized ids', () => {
    for (const value of [
      undefined,
      '',
      'x'.repeat(OPERATION_ID_MAX_LENGTH + 1),
    ]) {
      expect(Result.isFailure(decode(value))).toBe(true)
    }
  })
})
