import { describe, expect, it } from 'vitest'
import { decodeStoredPanelLayout } from '@/routes/-hooks/use-panel-layout'

describe('decodeStoredPanelLayout', () => {
  it('falls back for malformed JSON', () => {
    expect(decodeStoredPanelLayout('{')).toEqual({ windowLayout: null })
  })

  it('falls back for a non-object envelope', () => {
    expect(decodeStoredPanelLayout('[]')).toEqual({ windowLayout: null })
    expect(decodeStoredPanelLayout('42')).toEqual({ windowLayout: null })
  })

  it('reads the layout while ignoring envelope excess keys', () => {
    expect(
      decodeStoredPanelLayout(
        JSON.stringify({ windowLayout: { tabs: [] }, futureField: true })
      )
    ).toEqual({ windowLayout: { tabs: [] } })
  })
})
