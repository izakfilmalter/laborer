import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { DiffTarget } from '../src/rpc.js'

describe('DiffTarget contract', () => {
  const decode = Schema.decodeUnknownResult(DiffTarget)

  it('accepts the three targets `file.diff` offers', () => {
    expect(Result.isSuccess(decode({ _tag: 'working' }))).toBe(true)
    expect(Result.isSuccess(decode({ _tag: 'branch' }))).toBe(true)
    expect(Result.isSuccess(decode({ _tag: 'ref', ref: 'origin/main' }))).toBe(
      true
    )
  })

  it('rejects a stringly-typed mode in place of the union', () => {
    expect(Result.isFailure(decode('branch'))).toBe(true)
    expect(Result.isFailure(decode({ _tag: 'merge-base' }))).toBe(true)
  })

  it('requires a ref that names something', () => {
    expect(Result.isFailure(decode({ _tag: 'ref' }))).toBe(true)
    expect(Result.isFailure(decode({ _tag: 'ref', ref: '' }))).toBe(true)
  })
})
