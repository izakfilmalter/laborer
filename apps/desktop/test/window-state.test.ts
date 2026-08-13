import type { Rectangle } from 'electron'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  defaultWindowState,
  isBoundsOnScreen,
  parseWindowRecords,
  parseWindowState,
  serializeWindowRecords,
} from '../src/window-state.js'

// ---------------------------------------------------------------------------
// parseWindowState
// ---------------------------------------------------------------------------

describe('parseWindowState', () => {
  it('parses valid window state JSON', () => {
    const raw = JSON.stringify({
      bounds: { x: 100, y: 200, width: 800, height: 600 },
      isMaximized: true,
    })
    const state = parseWindowState(raw)
    expect(state).toEqual({
      bounds: { x: 100, y: 200, width: 800, height: 600 },
      isMaximized: true,
    })
  })

  it('defaults isMaximized to false when missing', () => {
    const raw = JSON.stringify({
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
    })
    const state = parseWindowState(raw)
    expect(state).not.toBeNull()
    expect(state?.isMaximized).toBe(false)
  })

  it('floors fractional bounds values', () => {
    const raw = JSON.stringify({
      bounds: { x: 10.7, y: 20.3, width: 800.9, height: 600.1 },
      isMaximized: false,
    })
    const state = parseWindowState(raw)
    expect(state).toEqual({
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      isMaximized: false,
    })
  })

  it('returns null for invalid JSON', () => {
    expect(parseWindowState('not json')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseWindowState('"hello"')).toBeNull()
  })

  it('returns null when bounds is missing', () => {
    expect(parseWindowState(JSON.stringify({ isMaximized: false }))).toBeNull()
  })

  it('returns null when bounds fields are not numbers', () => {
    const raw = JSON.stringify({
      bounds: { x: 'foo', y: 0, width: 800, height: 600 },
    })
    expect(parseWindowState(raw)).toBeNull()
  })

  it('returns null when width is zero', () => {
    const raw = JSON.stringify({
      bounds: { x: 0, y: 0, width: 0, height: 600 },
    })
    expect(parseWindowState(raw)).toBeNull()
  })

  it('returns null when height is negative', () => {
    const raw = JSON.stringify({
      bounds: { x: 0, y: 0, width: 800, height: -10 },
    })
    expect(parseWindowState(raw)).toBeNull()
  })

  it('returns null when bounds contain NaN', () => {
    const raw = JSON.stringify({
      bounds: { x: 0, y: 0, width: 800, height: null },
    })
    expect(parseWindowState(raw)).toBeNull()
  })

  it('returns null when bounds contain Infinity', () => {
    // JSON.stringify won't encode Infinity, but we test the path anyway
    const raw = '{"bounds":{"x":0,"y":0,"width":800,"height":1e309}}'
    // 1e309 overflows to Infinity in JSON.parse
    expect(parseWindowState(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseWindowRecords
// ---------------------------------------------------------------------------

describe('parseWindowRecords', () => {
  it('parses a persisted multi-window payload', () => {
    const raw = JSON.stringify({
      windows: [
        {
          windowId: 'window-alpha',
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          isMaximized: false,
        },
        {
          windowId: 'window-beta',
          bounds: { x: 100, y: 200, width: 1200, height: 900 },
          isMaximized: true,
        },
      ],
    })

    expect(parseWindowRecords(raw)).toEqual([
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 100, y: 200, width: 1200, height: 900 },
        isMaximized: true,
      },
    ])
  })

  it('upgrades legacy single-window state when a fallback id is provided', () => {
    const raw = JSON.stringify({
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      isMaximized: true,
    })

    expect(parseWindowRecords(raw, 'window-legacy')).toEqual([
      {
        windowId: 'window-legacy',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: true,
      },
    ])
  })

  it('returns null when any record is malformed', () => {
    const raw = JSON.stringify({
      windows: [
        {
          windowId: 'window-alpha',
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          isMaximized: false,
        },
        {
          windowId: '',
          bounds: { x: 100, y: 200, width: 1200, height: 900 },
          isMaximized: true,
        },
      ],
    })

    expect(parseWindowRecords(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// serializeWindowRecords
// ---------------------------------------------------------------------------

describe('serializeWindowRecords', () => {
  it('preserves multiple window records for disk persistence', () => {
    expect(
      serializeWindowRecords([
        {
          windowId: 'window-alpha',
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          isMaximized: false,
        },
        {
          windowId: 'window-beta',
          bounds: { x: 100, y: 200, width: 1200, height: 900 },
          isMaximized: true,
        },
      ])
    ).toEqual({
      windows: [
        {
          windowId: 'window-alpha',
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          isMaximized: false,
        },
        {
          windowId: 'window-beta',
          bounds: { x: 100, y: 200, width: 1200, height: 900 },
          isMaximized: true,
        },
      ],
    })
  })
})

// ---------------------------------------------------------------------------
// isBoundsOnScreen
// ---------------------------------------------------------------------------

describe('isBoundsOnScreen', () => {
  const primaryDisplay = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 } as Rectangle,
  }

  const secondDisplay = {
    workArea: { x: 1920, y: 0, width: 2560, height: 1440 } as Rectangle,
  }

  it('returns true when window is fully within a single display', () => {
    const bounds: Rectangle = { x: 100, y: 100, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(true)
  })

  it('returns true when window overlaps enough of a display', () => {
    // Window extends 50px past the right edge — but has >100px overlap
    const bounds: Rectangle = { x: 1770, y: 100, width: 200, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(true)
  })

  it('returns false when window has insufficient horizontal overlap', () => {
    // Only 50px horizontal overlap (< 100px threshold)
    const bounds: Rectangle = { x: 1870, y: 100, width: 200, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(false)
  })

  it('returns false when window has insufficient vertical overlap', () => {
    // Only 30px vertical overlap (< 50px threshold)
    const bounds: Rectangle = { x: 100, y: 1050, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(false)
  })

  it('returns false when window is completely off-screen', () => {
    const bounds: Rectangle = { x: 5000, y: 5000, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(false)
  })

  it('returns true when window is on the second display', () => {
    const bounds: Rectangle = { x: 2000, y: 100, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay, secondDisplay])).toBe(true)
  })

  it('returns false when no displays are provided', () => {
    const bounds: Rectangle = { x: 100, y: 100, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [])).toBe(false)
  })

  it('handles negative window positions (window above/left of display)', () => {
    // Window starts at x=-700, extends to x=100 — so 100px overlap with display starting at x=0
    const bounds: Rectangle = { x: -700, y: 100, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(true)
  })

  it('returns false when window is entirely to the left of display', () => {
    const bounds: Rectangle = { x: -1000, y: 100, width: 800, height: 600 }
    expect(isBoundsOnScreen(bounds, [primaryDisplay])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// defaultWindowState
// ---------------------------------------------------------------------------

describe('defaultWindowState', () => {
  it('returns default dimensions', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 }
    const state = defaultWindowState(workArea)
    expect(state.bounds.width).toBe(DEFAULT_WIDTH)
    expect(state.bounds.height).toBe(DEFAULT_HEIGHT)
    expect(state.isMaximized).toBe(false)
  })

  it('centers window on the work area', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 }
    const state = defaultWindowState(workArea)
    const expectedX = Math.floor((1920 - DEFAULT_WIDTH) / 2)
    const expectedY = Math.floor((1080 - DEFAULT_HEIGHT) / 2)
    expect(state.bounds.x).toBe(expectedX)
    expect(state.bounds.y).toBe(expectedY)
  })

  it('handles non-zero work area origin (e.g., dock offset)', () => {
    // macOS with dock on left: work area starts at x=80
    const workArea: Rectangle = { x: 80, y: 25, width: 1840, height: 1055 }
    const state = defaultWindowState(workArea)
    const expectedX = Math.floor(80 + (1840 - DEFAULT_WIDTH) / 2)
    const expectedY = Math.floor(25 + (1055 - DEFAULT_HEIGHT) / 2)
    expect(state.bounds.x).toBe(expectedX)
    expect(state.bounds.y).toBe(expectedY)
  })

  it('handles work area smaller than default window size', () => {
    // Extremely small display
    const workArea: Rectangle = { x: 0, y: 0, width: 640, height: 480 }
    const state = defaultWindowState(workArea)
    // Window should still be centered, even if it extends beyond
    expect(state.bounds.x).toBe(Math.floor((640 - DEFAULT_WIDTH) / 2))
    expect(state.bounds.y).toBe(Math.floor((480 - DEFAULT_HEIGHT) / 2))
  })
})
