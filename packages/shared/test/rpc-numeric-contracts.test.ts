import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { NonNegativeInt, PositiveInt } from '../src/rpc.js'

describe('RPC numeric contracts', () => {
  const decodeNonNegativeInt = Schema.decodeUnknownResult(NonNegativeInt)
  const decodePositiveInt = Schema.decodeUnknownResult(PositiveInt)

  it('accepts zero only for non-negative integers', () => {
    expect(Result.isSuccess(decodeNonNegativeInt(0))).toBe(true)
    expect(Result.isFailure(decodePositiveInt(0))).toBe(true)
  })

  it('rejects negative and fractional values', () => {
    for (const value of [-1, 0.5, 1.5]) {
      expect(Result.isFailure(decodeNonNegativeInt(value))).toBe(true)
      expect(Result.isFailure(decodePositiveInt(value))).toBe(true)
    }
  })

  it('accepts positive integers through both contracts', () => {
    expect(Result.isSuccess(decodeNonNegativeInt(1))).toBe(true)
    expect(Result.isSuccess(decodePositiveInt(1))).toBe(true)
  })
})
