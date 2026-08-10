import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBoardOverlayHeight } from '@/hooks/use-board-overlay-height'

const STORAGE_KEY = 'laborer:board-overlay-height'

describe('useBoardOverlayHeight', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })

  afterEach(() => {
    cleanup()
    localStorage.removeItem(STORAGE_KEY)
  })

  it('defaults to 0.7 when nothing is stored', () => {
    const { result } = renderHook(() => useBoardOverlayHeight())
    expect(result.current.fraction).toBe(0.7)
  })

  it('restores a stored fraction', () => {
    localStorage.setItem(STORAGE_KEY, '0.45')
    const { result } = renderHook(() => useBoardOverlayHeight())
    expect(result.current.fraction).toBe(0.45)
  })

  it('clamps a stored fraction into the allowed range', () => {
    localStorage.setItem(STORAGE_KEY, '5')
    const { result } = renderHook(() => useBoardOverlayHeight())
    expect(result.current.fraction).toBe(1)
  })

  it('ignores unparseable stored values', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number')
    const { result } = renderHook(() => useBoardOverlayHeight())
    expect(result.current.fraction).toBe(0.7)
  })

  it('persists updates and clamps below the minimum', () => {
    const { result } = renderHook(() => useBoardOverlayHeight())

    act(() => {
      result.current.setFraction(0.05)
    })

    expect(result.current.fraction).toBe(0.2)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0.2')
  })

  it('persists updates and clamps above the maximum', () => {
    const { result } = renderHook(() => useBoardOverlayHeight())

    act(() => {
      result.current.setFraction(1.4)
    })

    expect(result.current.fraction).toBe(1)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
  })

  it('accepts and persists an in-range fraction', () => {
    const { result } = renderHook(() => useBoardOverlayHeight())

    act(() => {
      result.current.setFraction(0.33)
    })

    expect(result.current.fraction).toBe(0.33)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0.33')
  })
})
