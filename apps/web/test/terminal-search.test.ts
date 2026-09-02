/**
 * Unit tests for terminal find matching.
 *
 * The screen arrives as one line per row, so a match is only useful if its
 * columns still point at the cells the text came from — case folding, wrapped
 * rows, and the scrollback offset all have to leave columns alone.
 *
 * @see apps/web/src/terminal/ghostty-support/terminal-search.ts
 */

import { describe, expect, it } from 'vitest'
import {
  findTerminalSearchMatches,
  formatTerminalSearchResults,
  stepTerminalSearchIndex,
  TERMINAL_SEARCH_MATCH_LIMIT,
  terminalSearchIndexNear,
} from '../src/terminal/ghostty-support/terminal-search'

describe('findTerminalSearchMatches', () => {
  it('reports every match as a row and column range', () => {
    const matches = findTerminalSearchMatches(
      { firstRow: 0, lines: ['npm run test', 'run run'] },
      'run'
    )
    expect(matches).toEqual([
      { row: 0, startColumn: 4, endColumn: 7 },
      { row: 1, startColumn: 0, endColumn: 3 },
      { row: 1, startColumn: 4, endColumn: 7 },
    ])
  })

  it('counts rows from the first row the screen starts at', () => {
    const matches = findTerminalSearchMatches(
      { firstRow: 120, lines: ['error: boom'] },
      'error'
    )
    expect(matches).toEqual([{ row: 120, startColumn: 0, endColumn: 5 }])
  })

  it('matches without regard to case', () => {
    expect(
      findTerminalSearchMatches({ firstRow: 0, lines: ['ERROR here'] }, 'error')
    ).toEqual([{ row: 0, startColumn: 0, endColumn: 5 }])
  })

  it('does not let case folding slide a column', () => {
    // "İ" lowercases into two code units, which would shift every later
    // column on the line; such a line falls back to a case-sensitive match.
    const matches = findTerminalSearchMatches(
      { firstRow: 0, lines: ['İstanbul boom'] },
      'boom'
    )
    expect(matches).toEqual([{ row: 0, startColumn: 9, endColumn: 13 }])
  })

  it('reports overlapping runs once, left to right', () => {
    expect(
      findTerminalSearchMatches({ firstRow: 0, lines: ['aaaa'] }, 'aa')
    ).toEqual([
      { row: 0, startColumn: 0, endColumn: 2 },
      { row: 0, startColumn: 2, endColumn: 4 },
    ])
  })

  it('finds nothing for an empty query', () => {
    expect(
      findTerminalSearchMatches({ firstRow: 0, lines: ['anything'] }, '')
    ).toEqual([])
  })

  it('stops collecting at the match limit', () => {
    const lines = Array.from({ length: 40 }, () => 'x'.repeat(1000))
    expect(findTerminalSearchMatches({ firstRow: 0, lines }, 'x')).toHaveLength(
      TERMINAL_SEARCH_MATCH_LIMIT
    )
  })
})

describe('stepTerminalSearchIndex', () => {
  it('wraps around both ends', () => {
    expect(stepTerminalSearchIndex(3, 2, 'next')).toBe(0)
    expect(stepTerminalSearchIndex(3, 0, 'previous')).toBe(2)
  })

  it('starts at the appropriate end when nothing is active', () => {
    expect(stepTerminalSearchIndex(3, -1, 'next')).toBe(0)
    expect(stepTerminalSearchIndex(3, -1, 'previous')).toBe(2)
  })

  it('has nowhere to go without matches', () => {
    expect(stepTerminalSearchIndex(0, -1, 'next')).toBe(-1)
  })
})

describe('terminalSearchIndexNear', () => {
  const matches = [
    { row: 4, startColumn: 0, endColumn: 3 },
    { row: 9, startColumn: 2, endColumn: 5 },
  ]

  it('follows the active match to its new position', () => {
    expect(terminalSearchIndexNear(matches, matches[1] ?? null)).toBe(1)
  })

  it('lands on the first match after where the old one was', () => {
    expect(
      terminalSearchIndexNear(matches, { row: 5, startColumn: 0, endColumn: 3 })
    ).toBe(1)
  })

  it('falls back to the last match when the screen scrolled past it', () => {
    expect(
      terminalSearchIndexNear(matches, {
        row: 99,
        startColumn: 0,
        endColumn: 3,
      })
    ).toBe(1)
  })

  it('has no answer without a previous match or without matches', () => {
    expect(terminalSearchIndexNear(matches, null)).toBe(-1)
    expect(
      terminalSearchIndexNear([], { row: 1, startColumn: 0, endColumn: 1 })
    ).toBe(-1)
  })
})

describe('formatTerminalSearchResults', () => {
  it('says nothing before a query is typed', () => {
    expect(formatTerminalSearchResults('', 0, -1)).toBe('')
  })

  it('reports an empty result', () => {
    expect(formatTerminalSearchResults('nope', 0, -1)).toBe('0/0')
  })

  it('counts from one', () => {
    expect(formatTerminalSearchResults('run', 17, 2)).toBe('3/17')
  })

  it('marks a capped count', () => {
    expect(
      formatTerminalSearchResults('x', TERMINAL_SEARCH_MATCH_LIMIT, 0)
    ).toBe(`1/${TERMINAL_SEARCH_MATCH_LIMIT}+`)
  })
})
