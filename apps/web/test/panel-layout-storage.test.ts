import type { WindowLayout } from '@laborer/shared/types'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_COLLECTIONS,
  makeValidatedLocalStorageParser,
  panelLayoutCollection,
  panelLayoutSchema,
  setPanelLayoutPreference,
} from '@/db/local-preferences'

const WINDOW_ID = 'panel-layout-storage-test-window'
const LEGACY_KEY = `laborer:panel-layout:v1:${WINDOW_ID}`
const FIRST_LAYOUT: WindowLayout = { tabs: [] }
const SECOND_LAYOUT: WindowLayout = { activeTabId: 'missing', tabs: [] }

describe('panel layout collection', () => {
  afterEach(() => {
    if (panelLayoutCollection.has(WINDOW_ID)) {
      panelLayoutCollection.delete(WINDOW_ID)
    }
    localStorage.removeItem(LEGACY_KEY)
  })

  it('uses the versioned collection and storage identities', () => {
    expect(panelLayoutCollection.id).toBe('laborer.local.panel-layouts.v1')
    expect(LOCAL_COLLECTIONS.panelLayouts.storageKey).toBe(
      'laborer:db:panel-layouts:v1'
    )
  })

  it('keys valid rows by native window id', () => {
    const row = panelLayoutSchema.parse({
      id: WINDOW_ID,
      windowLayout: FIRST_LAYOUT,
    })

    setPanelLayoutPreference(row.id, row.windowLayout)

    expect(panelLayoutCollection.get(WINDOW_ID)).toMatchObject(row)
    expect(() =>
      panelLayoutSchema.parse({ id: '', windowLayout: FIRST_LAYOUT })
    ).toThrow()
    expect(() =>
      panelLayoutSchema.parse({ id: WINDOW_ID, windowLayout: null })
    ).toThrow()
  })

  it('drops corrupt persisted rows before collection hydration', () => {
    const parser = makeValidatedLocalStorageParser(panelLayoutSchema)
    const validRow = { id: WINDOW_ID, windowLayout: FIRST_LAYOUT }

    expect(
      parser.parse(
        JSON.stringify({
          's:corrupt': {
            data: { id: 'corrupt', windowLayout: null },
            versionKey: 'corrupt',
          },
          [`s:${WINDOW_ID}`]: {
            data: validRow,
            versionKey: 'valid',
          },
        })
      )
    ).toEqual({
      [`s:${WINDOW_ID}`]: {
        data: validRow,
        versionKey: 'valid',
      },
    })
  })

  it('wires inserts and updates through ordinary collection mutations', () => {
    setPanelLayoutPreference(WINDOW_ID, FIRST_LAYOUT)
    expect(panelLayoutCollection.get(WINDOW_ID)?.windowLayout).toEqual(
      FIRST_LAYOUT
    )

    setPanelLayoutPreference(WINDOW_ID, SECOND_LAYOUT)
    expect(panelLayoutCollection.get(WINDOW_ID)?.windowLayout).toEqual(
      SECOND_LAYOUT
    )
  })

  it('leaves the legacy per-window key byte-for-byte untouched', async () => {
    const legacyValue = '{"windowLayout":{"tabs":[]},"future":true}'
    localStorage.setItem(LEGACY_KEY, legacyValue)

    setPanelLayoutPreference(WINDOW_ID, FIRST_LAYOUT)

    await waitFor(() => {
      expect(
        localStorage.getItem(LOCAL_COLLECTIONS.panelLayouts.storageKey)
      ).not.toBeNull()
    })
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacyValue)
  })
})
