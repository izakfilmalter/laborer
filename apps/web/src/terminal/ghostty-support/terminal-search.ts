/**
 * Terminal find — matching the screen's text, without touching the screen.
 *
 * The Ghostty core hands out the whole active screen as one line per row
 * (`GhosttyTerminalCore.screenLines`), so a match is a row plus a column
 * range and can be pointed straight back at cells for highlighting and
 * scrolling. Matching itself is literal and case-insensitive, which is what a
 * terminal find bar is for: reading back what scrolled past.
 *
 * @see apps/web/src/terminal/ghostty/surface.ts — owns the live match set
 * @see apps/web/src/panes/terminal-pane.tsx — the find bar
 */

/** A single match, as a half-open column range on one screen row. */
export interface TerminalSearchMatch {
  /** Exclusive end column. */
  readonly endColumn: number
  /** Screen row, counting the oldest scrollback row as 0. */
  readonly row: number
  readonly startColumn: number
}

/** Which way `stepTerminalSearchIndex` moves through the match list. */
export type TerminalSearchDirection = 'next' | 'previous'

/**
 * Ceiling on tracked matches. A one-character query against a full scrollback
 * can match hundreds of thousands of cells, and neither the counter nor the
 * highlight pass is worth that: past this point the find bar reports the cap.
 */
export const TERMINAL_SEARCH_MATCH_LIMIT = 20_000

/**
 * Case folding that cannot move a column.
 *
 * A handful of characters grow when lowercased (`İ` becomes two code units),
 * which would slide every later column on that line. Those rare strings fold
 * to themselves here, so such a line is matched case-sensitively rather than
 * reported at the wrong cell.
 */
function foldedLine(line: string): string {
  const folded = line.toLowerCase()
  return folded.length === line.length ? folded : line
}

/** Whether a string case-folds without changing length. */
function foldsSafely(value: string): boolean {
  return value.toLowerCase().length === value.length
}

/**
 * Every match of `query` in `screen`, ordered oldest row first, left to right.
 * Matches do not span rows: a query that straddles a soft wrap is not found,
 * the same limitation the row-oriented screen text carries.
 */
export function findTerminalSearchMatches(
  screen: { readonly firstRow: number; readonly lines: readonly string[] },
  query: string
): readonly TerminalSearchMatch[] {
  if (query.length === 0) {
    return []
  }
  const queryFolds = foldsSafely(query)
  const matches: TerminalSearchMatch[] = []
  for (const [index, line] of screen.lines.entries()) {
    const folds = queryFolds && foldsSafely(line)
    const needle = folds ? foldedLine(query) : query
    const haystack = folds ? foldedLine(line) : line
    let from = 0
    while (from <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, from)
      if (start === -1) {
        break
      }
      matches.push({
        row: screen.firstRow + index,
        startColumn: start,
        endColumn: start + needle.length,
      })
      if (matches.length >= TERMINAL_SEARCH_MATCH_LIMIT) {
        return matches
      }
      // Overlapping matches ("aa" in "aaa") are reported once, as every other
      // find bar does, so the counter matches what the user can step through.
      from = start + needle.length
    }
  }
  return matches
}

/** Index of the next or previous match, wrapping around the ends. */
export function stepTerminalSearchIndex(
  count: number,
  current: number,
  direction: TerminalSearchDirection
): number {
  if (count <= 0) {
    return -1
  }
  if (current < 0) {
    return direction === 'next' ? 0 : count - 1
  }
  return direction === 'next'
    ? (current + 1) % count
    : (current - 1 + count) % count
}

/**
 * Where the active match lands in a freshly computed match set.
 *
 * Output keeps arriving while the find bar is open, so the match list is
 * rebuilt underneath the user. The active match is followed by position — the
 * first match at or after where it was — so stepping does not restart at the
 * top of the scrollback every time the shell prints a line.
 */
export function terminalSearchIndexNear(
  matches: readonly TerminalSearchMatch[],
  previous: TerminalSearchMatch | null
): number {
  if (matches.length === 0) {
    return -1
  }
  if (previous === null) {
    return -1
  }
  const index = matches.findIndex(
    (match) =>
      match.row > previous.row ||
      (match.row === previous.row && match.startColumn >= previous.startColumn)
  )
  return index === -1 ? matches.length - 1 : index
}

/** The find bar's counter: "3/17", "0/0", or nothing before a query exists. */
export function formatTerminalSearchResults(
  query: string,
  count: number,
  index: number
): string {
  if (query.length === 0) {
    return ''
  }
  if (count === 0) {
    return '0/0'
  }
  const total = count >= TERMINAL_SEARCH_MATCH_LIMIT ? `${count}+` : `${count}`
  return index < 0 ? `?/${total}` : `${index + 1}/${total}`
}
