import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeValidatedLocalStorageParser } from '@/db/local-preferences'

const preferenceSchema = z.object({
  id: z.literal('current'),
  value: z.number().finite(),
})

describe('local preference persistence boundary', () => {
  it('drops invalid rows from the TanStack DB storage envelope', () => {
    const parser = makeValidatedLocalStorageParser(preferenceSchema)
    const parsed = parser.parse(
      JSON.stringify({
        's:current': {
          data: { id: 'current', value: 'not-a-number' },
          versionKey: 'invalid',
        },
        's:valid': {
          data: { id: 'current', value: 420 },
          versionKey: 'valid',
        },
      })
    )

    expect(parsed).toEqual({
      's:valid': {
        data: { id: 'current', value: 420 },
        versionKey: 'valid',
      },
    })
  })

  it('leaves malformed envelopes for the adapter to reject as empty', () => {
    const parser = makeValidatedLocalStorageParser(preferenceSchema)

    expect(parser.parse('[]')).toEqual([])
    expect(() => parser.parse('{')).toThrow()
  })
})
