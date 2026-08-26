import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { DiffContentsChangeType, FileDiffContents } from '../src/rpc.js'

describe('DiffContentsChangeType contract', () => {
  const decode = Schema.decodeUnknownResult(DiffContentsChangeType)

  it('accepts the change types hunk expansion can use', () => {
    expect(Result.isSuccess(decode('change'))).toBe(true)
    expect(Result.isSuccess(decode('rename-pure'))).toBe(true)
    expect(Result.isSuccess(decode('rename-changed'))).toBe(true)
  })

  it('refuses `new` and `deleted` at the boundary', () => {
    // Each already carries its whole existing side in the patch, so there
    // is no unchanged context to expand into. Refusing them in the schema
    // means the server never has to invent an answer for them.
    expect(Result.isFailure(decode('new'))).toBe(true)
    expect(Result.isFailure(decode('deleted'))).toBe(true)
  })
})

describe('FileDiffContents contract', () => {
  const decode = Schema.decodeUnknownResult(FileDiffContents)

  it('carries both sides and a truncation flag for each', () => {
    const result = decode({
      newContents: 'b\n',
      newTruncated: false,
      oldContents: 'a\n',
      oldTruncated: true,
    })
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('will not let a side arrive without saying whether it was cut', () => {
    // A silent truncation is the failure mode this flag exists to prevent:
    // a short side renders as a complete file with the wrong line count.
    expect(
      Result.isFailure(
        decode({ newContents: 'b\n', oldContents: 'a\n', oldTruncated: false })
      )
    ).toBe(true)
  })
})
