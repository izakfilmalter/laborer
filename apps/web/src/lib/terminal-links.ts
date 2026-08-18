import type { ContextMenuItem } from '@laborer/shared/desktop-bridge'
import type {
  IBufferCell,
  IBufferLine,
  ILink,
  ILinkHandler,
  ILinkProvider,
  Terminal,
} from '@xterm/xterm'
import { localApi } from '@/lib/local-api'

/** Open a terminal URL in the user's default browser without blocking the UI. */
export const openTerminalLink = (url: string): void => {
  localApi.openExternal(url).catch(() => {
    // Link open failures are non-critical.
  })
}

/**
 * Handles explicit OSC 8 hyperlinks instead of xterm's default confirmation
 * dialog. xterm filters non-HTTP protocols before invoking this handler.
 */
export const terminalOscLinkHandler: ILinkHandler = {
  activate: (_event, url) => {
    openTerminalLink(url)
  },
  allowNonHttpProtocols: false,
}

/**
 * URL shapes worth linkifying. Trailing punctuation is excluded so a URL at
 * the end of a sentence does not swallow the period or closing bracket.
 */
const TERMINAL_URL_PATTERN =
  /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi

/**
 * Upper bound on the rows joined into one logical line. A wrapped URL spans a
 * handful of rows; the cap keeps a pathological wrap chain from walking the
 * whole scrollback on every hover.
 */
const MAX_WRAPPED_ROWS = 32

/** Buffer coordinates of the cell that produced one character of a line. */
interface CellIndex {
  readonly column: number
  readonly row: number
}

interface LogicalLine {
  /** `cells[i]` locates the cell that `text[i]` came from. */
  readonly cells: readonly CellIndex[]
  readonly text: string
}

const appendCells = (
  line: IBufferLine,
  row: number,
  cell: IBufferCell,
  text: string[],
  cells: CellIndex[]
): void => {
  for (let column = 0; column < line.length; column++) {
    line.getCell(column, cell)
    // Width 0 is the trailing half of a wide character — already accounted for.
    if (cell.getWidth() === 0) {
      continue
    }
    const chars = cell.getChars() || ' '
    for (const char of chars) {
      text.push(char)
      cells.push({ row, column })
    }
  }
}

/**
 * Reassemble the soft-wrapped rows around `row` into one logical line, keeping
 * a cell coordinate per character.
 *
 * xterm hands link providers a single row at a time, so a URL that wrapped mid
 * string would otherwise be detected only up to the wrap point. Walking the
 * `isWrapped` chain in both directions restores the whole URL, and the cell map
 * lets the resulting link keep a range that spans those rows.
 */
const readLogicalLine = (
  terminal: Terminal,
  row: number
): LogicalLine | null => {
  const buffer = terminal.buffer.active
  if (!buffer.getLine(row)) {
    return null
  }

  let first = row
  while (
    first > 0 &&
    row - first < MAX_WRAPPED_ROWS &&
    buffer.getLine(first)?.isWrapped === true
  ) {
    first--
  }

  let last = row
  while (
    last + 1 < buffer.length &&
    last - row < MAX_WRAPPED_ROWS &&
    buffer.getLine(last + 1)?.isWrapped === true
  ) {
    last++
  }

  const text: string[] = []
  const cells: CellIndex[] = []
  const cell = buffer.getNullCell()
  for (let current = first; current <= last; current++) {
    const line = buffer.getLine(current)
    if (line) {
      appendCells(line, current, cell, text, cells)
    }
  }

  return { text: text.join(''), cells }
}

/** All URLs on the logical line containing `row`, in buffer coordinates. */
const findLinksOnRow = (
  terminal: Terminal,
  row: number,
  activate: (event: MouseEvent, url: string) => void
): ILink[] => {
  const logical = readLogicalLine(terminal, row)
  if (!logical) {
    return []
  }

  const pattern = new RegExp(TERMINAL_URL_PATTERN.source, 'gi')
  const links: ILink[] = []
  let match = pattern.exec(logical.text)
  while (match !== null) {
    const url = match[0]
    const start = logical.cells[match.index]
    const end = logical.cells[match.index + url.length - 1]
    if (start && end && start.row <= row && row <= end.row) {
      links.push({
        range: {
          start: { x: start.column + 1, y: start.row + 1 },
          end: { x: end.column + 1, y: end.row + 1 },
        },
        text: url,
        activate,
      })
    }
    match = pattern.exec(logical.text)
  }

  return links
}

export type TerminalContextMenuAction =
  | 'copy-link'
  | 'open-link'
  | 'copy'
  | 'paste'

/**
 * Right-click menu for the terminal canvas. Link actions only appear when the
 * pointer is over a detected URL, and Copy only when there is a selection to
 * copy, so the menu never offers an action that would do nothing.
 */
export const terminalContextMenuItems = ({
  link,
  hasSelection,
}: {
  readonly link: string | null
  readonly hasSelection: boolean
}): readonly ContextMenuItem<TerminalContextMenuAction>[] => [
  ...(link === null
    ? []
    : [
        { id: 'copy-link' as const, label: 'Copy Link' },
        { id: 'open-link' as const, label: 'Open Link' },
      ]),
  ...(hasSelection ? [{ id: 'copy' as const, label: 'Copy' }] : []),
  { id: 'paste', label: 'Paste' },
]

export interface TerminalLinkProviderOptions {
  /** Called with the URL under the pointer, or null once it leaves. */
  readonly onHoverChange?: (url: string | null) => void
}

/**
 * Wrap-aware replacement for `WebLinksAddon`'s provider.
 *
 * The upstream provider stops joining wrapped rows at the first row containing
 * a space, so a URL that wraps after other text on the line is activated with
 * only its first half. This provider joins the whole `isWrapped` chain, so the
 * link carries the complete URL however it happens to wrap.
 */
export const createTerminalLinkProvider = (
  terminal: Terminal,
  options: TerminalLinkProviderOptions = {}
): ILinkProvider => ({
  provideLinks: (bufferLineNumber, callback) => {
    const links = findLinksOnRow(
      terminal,
      bufferLineNumber - 1,
      (_event, url) => openTerminalLink(url)
    )
    callback(
      links.map((link) => ({
        ...link,
        hover: () => options.onHoverChange?.(link.text),
        leave: () => options.onHoverChange?.(null),
      }))
    )
  },
})
