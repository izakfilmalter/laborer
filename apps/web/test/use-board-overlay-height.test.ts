import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boardOverlayHeightCollection,
  LOCAL_COLLECTIONS,
} from '@/db/local-preferences'
import { useBoardOverlayHeight } from '@/hooks/use-board-overlay-height'

describe('useBoardOverlayHeight', () => {
  afterEach(() => cleanup())

  it('defaults, clamps through TanStack DB, and preserves the legacy key', async () => {
    localStorage.clear()
    localStorage.setItem('laborer:board-overlay-height', '0.45')
    if (boardOverlayHeightCollection.has('current')) {
      await boardOverlayHeightCollection.delete('current').isPersisted.promise
    }

    const { result } = renderHook(() => useBoardOverlayHeight())
    expect(result.current.fraction).toBe(0.7)

    act(() => result.current.setFraction(0.05))
    expect(result.current.fraction).toBe(0.2)

    await waitFor(() =>
      expect(
        localStorage.getItem(LOCAL_COLLECTIONS.boardHeight.storageKey)
      ).not.toBeNull()
    )
    expect(localStorage.getItem('laborer:board-overlay-height')).toBe('0.45')
  })
})
