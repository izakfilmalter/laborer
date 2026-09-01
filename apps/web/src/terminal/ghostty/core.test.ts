/** biome-ignore-all lint/style/noNonNullAssertion: vendored from t3code (github.com/pingdotgg/t3code); keep verbatim so the tree can be re-synced */
/** biome-ignore-all lint/style/useConsistentArrayType: vendored from t3code (github.com/pingdotgg/t3code); keep verbatim so the tree can be re-synced */
/** biome-ignore-all lint/suspicious/useIterableCallbackReturn: vendored from t3code (github.com/pingdotgg/t3code); keep verbatim so the tree can be re-synced */

import { describe, expect, it } from 'vitest'

import { ghosttyCellText } from './core'

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4))
  codepoints.forEach((codepoint, index) =>
    view.setUint32(index * 4, codepoint, true)
  )
  return view
}

describe('ghosttyCellText', () => {
  it('converts oversized grapheme clusters without hitting engine spread limits', () => {
    // A program printing one base character followed by a huge run of
    // combining marks packs the whole cluster into one cell; spreading that
    // many arguments into String.fromCodePoint once overflows the call stack.
    const graphemeLength = 130_000
    const view = new DataView(new ArrayBuffer(graphemeLength * 4))
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(
        index * 4,
        index === 0 ? 'a'.codePointAt(0)! : 0x3_01,
        true
      )
    }
    const text = ghosttyCellText(view, graphemeLength)
    expect(text.length).toBe(graphemeLength)
    expect(text.codePointAt(0)).toBe('a'.codePointAt(0))
    expect(text.codePointAt(1)).toBe(0x3_01)
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x3_01)
  })

  it('converts small clusters including astral codepoints', () => {
    const text = ghosttyCellText(codepointView([0x1_f6_42, 0x20_e3]), 2)
    expect([...text]).toEqual(['\u{1F642}', '\u{20E3}'])
  })

  it('returns an empty string for empty cells', () => {
    expect(ghosttyCellText(codepointView([]), 0)).toBe('')
  })
})
