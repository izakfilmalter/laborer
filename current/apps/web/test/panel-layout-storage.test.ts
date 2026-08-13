import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeStoredPanelLayout,
  readStoredPanelLayout,
} from '@/routes/-hooks/use-panel-layout'

describe('decodeStoredPanelLayout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('falls back when localStorage access is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError')
    })

    expect(readStoredPanelLayout('window-1')).toEqual({ windowLayout: null })
  })
})
