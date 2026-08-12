import { describe, expect, it } from 'vitest'
import { createTaskUlid, isTaskUlid } from '../src/task-ulid'

describe('createTaskUlid', () => {
  it('produces a 26-character Crockford ULID', () => {
    const id = createTaskUlid()
    expect(id).toHaveLength(26)
    expect(isTaskUlid(id)).toBe(true)
  })

  it('encodes the timestamp into the first ten characters', () => {
    // Matches the server's historical createTaskUlid exactly, so ids stay
    // lexically ordered by creation time across old and new cards.
    expect(createTaskUlid(2).slice(0, 10)).toBe('0000000002')
    expect(createTaskUlid(0).slice(0, 10)).toBe('0000000000')
  })

  it('orders lexically by creation time', () => {
    const earlier = createTaskUlid(1000)
    const later = createTaskUlid(2000)
    expect(earlier < later).toBe(true)
  })

  it('never collides across a burst of same-millisecond ids', () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => createTaskUlid(1234))
    )
    expect(ids.size).toBe(1000)
  })
})

describe('isTaskUlid', () => {
  it('rejects non-ULID identifiers', () => {
    expect(isTaskUlid('')).toBe(false)
    expect(isTaskUlid('not-a-ulid')).toBe(false)
    // Crockford excludes I, L, O, and U.
    expect(isTaskUlid('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false)
    // A UUID is not a task id.
    expect(isTaskUlid(crypto.randomUUID())).toBe(false)
    // Lowercase is not canonical.
    expect(isTaskUlid(createTaskUlid().toLowerCase())).toBe(false)
  })
})
