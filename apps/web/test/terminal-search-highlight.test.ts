/**
 * Find highlights on the terminal canvas.
 *
 * The active match has to be told apart from the rest at a glance, and every
 * highlight has to sit under the glyphs rather than over them, or matched text
 * becomes unreadable in the pane that was searched to read it.
 *
 * @see apps/web/src/terminal/ghostty/renderer.ts
 */

import { describe, expect, it } from 'vitest'
import type { GhosttyCell, GhosttySnapshot } from '../src/terminal/ghostty/core'
import { renderGhosttySnapshot } from '../src/terminal/ghostty/renderer'

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
})

/** Records fills and glyph draws in the order the renderer issues them. */
function recordingContext() {
  const operations: Array<{
    readonly args: readonly number[]
    readonly kind: 'fillRect' | 'fillText'
    readonly style: string
  }> = []
  let fillStyle = ''
  const context = {
    canvas: { width: 200, height: 80 },
    beginPath: () => undefined,
    clip: () => undefined,
    fillRect: (...args: number[]) => {
      operations.push({ kind: 'fillRect', args, style: fillStyle })
    },
    fillText: (_text: string, ...args: number[]) => {
      operations.push({ kind: 'fillText', args, style: fillStyle })
    },
    rect: () => undefined,
    resetTransform: () => undefined,
    restore: () => undefined,
    save: () => undefined,
    set fillStyle(value: string) {
      fillStyle = value
    },
    set font(_value: string) {
      // no-op
    },
    set textBaseline(_value: string) {
      // no-op
    },
  } as unknown as CanvasRenderingContext2D
  return { context, operations }
}

const snapshot: GhosttySnapshot = {
  cols: 4,
  rows: 2,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
  cursorX: -1,
  cursorY: -1,
  cursorVisible: false,
  cursorBlinking: false,
  cursorStyle: 1,
  dirtyRows: new Set([0, 1]),
  rowData: [0, 1].map(() => ({
    cells: [cell('a'), cell('b'), cell('c'), cell('d')],
    text: 'abcd',
    isWrapContinuation: false,
    wrapsToNext: false,
  })),
}

function render(options: Parameters<typeof renderGhosttySnapshot>[0]) {
  renderGhosttySnapshot({
    metrics: { width: 10, height: 20, baseline: 15 },
    fontSize: 12,
    fontFamily: 'monospace',
    padding: 4,
    forceFull: false,
    cursorOn: false,
    ...options,
  })
}

describe('find highlights', () => {
  it('paints each match over its columns and lights the active one', () => {
    const { context, operations } = recordingContext()

    render({
      context,
      snapshot,
      searchRanges: [
        { start: { x: 1, y: 0 }, end: { x: 2, y: 0 } },
        { start: { x: 0, y: 1 }, end: { x: 1, y: 1 } },
      ],
      activeSearchRange: { start: { x: 0, y: 1 }, end: { x: 1, y: 1 } },
    })

    const highlights = operations.filter(
      (operation) =>
        operation.kind === 'fillRect' &&
        operation.style.includes('245, 158, 11')
    )
    expect(highlights.map((highlight) => highlight.args)).toEqual([
      [14, 4, 20, 20],
      [4, 24, 20, 20],
    ])
    // The active match is the opaque one.
    expect(highlights[0]?.style).toBe('rgba(245, 158, 11, 0.3)')
    expect(highlights[1]?.style).toBe('rgba(245, 158, 11, 0.7)')
  })

  it('keeps highlighted text legible by painting under the glyphs', () => {
    const { context, operations } = recordingContext()

    render({
      context,
      snapshot,
      searchRanges: [{ start: { x: 1, y: 0 }, end: { x: 2, y: 0 } }],
    })

    const highlight = operations.findIndex((operation) =>
      operation.style.includes('245, 158, 11')
    )
    const firstGlyph = operations.findIndex(
      (operation) => operation.kind === 'fillText'
    )
    expect(highlight).toBeGreaterThanOrEqual(0)
    expect(firstGlyph).toBeGreaterThan(highlight)
  })

  it('paints nothing when no match is on screen', () => {
    const { context, operations } = recordingContext()

    render({ context, snapshot, searchRanges: [] })

    expect(
      operations.some((operation) => operation.style.includes('245, 158, 11'))
    ).toBe(false)
  })
})
