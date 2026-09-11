import { describe, expect, it } from 'vitest'
import { createSequenceMarkerParser } from './sequence-marker-parser.js'

describe('sequence marker parser', () => {
  it('finds markers before bounding a coalesced Delta larger than its suffix', () => {
    const parser = createSequenceMarkerParser('__DIAG_', 8192)
    const frame = `noise__DIAG_41__${'x'.repeat(20_000)}__DIAG_42__tail`

    expect(parser.write(frame)).toEqual([41, 42])
  })

  it('retains an incomplete marker across Delta boundaries', () => {
    const parser = createSequenceMarkerParser('__DIAG_', 64)

    expect(parser.write(`${'x'.repeat(1000)}__DIA`)).toEqual([])
    expect(parser.write('G_73__and-more')).toEqual([73])
  })
})
