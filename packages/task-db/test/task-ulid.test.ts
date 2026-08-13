import { describe, expect, it } from 'vitest'
import { createTaskUlid, isTaskUlid } from '../src/task-ulid.js'

describe('createTaskUlid', () => {
  it('produces a 26-character Crockford ULID', () => {
    const id = createTaskUlid()
    expect(id).toHaveLength(26)
    expect(isTaskUlid(id)).toBe(true)
  })

  it('encodes the timestamp into the first ten characters', () => {
    expect(createTaskUlid(2).slice(0, 10)).toBe('0000000002')
    expect(createTaskUlid(0).slice(0, 10)).toBe('0000000000')
  })

  it('clamps timestamps to the ULID 48-bit range', () => {
    expect(createTaskUlid(-1).slice(0, 10)).toBe('0000000000')
    expect(createTaskUlid(Number.MAX_SAFE_INTEGER).slice(0, 10)).toBe(
      '7ZZZZZZZZZ'
    )
  })

  it('orders lexically by creation time', () => {
    expect(createTaskUlid(1000) < createTaskUlid(2000)).toBe(true)
  })

  it('never collides across a burst of same-millisecond ids', () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => createTaskUlid(1234))
    )
    expect(ids.size).toBe(1000)
  })
})

describe('isTaskUlid', () => {
  it('accepts only canonical Crockford ULIDs', () => {
    expect(isTaskUlid(createTaskUlid())).toBe(true)
    expect(isTaskUlid('')).toBe(false)
    expect(isTaskUlid('not-a-ulid')).toBe(false)
    expect(isTaskUlid('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false)
    expect(isTaskUlid(crypto.randomUUID())).toBe(false)
    expect(isTaskUlid(createTaskUlid().toLowerCase())).toBe(false)
    expect(isTaskUlid('80000000000000000000000000')).toBe(false)
  })
})
