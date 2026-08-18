import type { IBufferRange, ILink, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(async () => true),
}))

vi.mock('../src/lib/local-api', () => ({
  localApi: { openExternal: openExternalUrlMock },
}))

import {
  createTerminalLinkProvider,
  openTerminalLink,
  terminalContextMenuItems,
  terminalOscLinkHandler,
} from '../src/lib/terminal-links'

interface FakeRow {
  readonly isWrapped: boolean
  readonly text: string
}

/**
 * Minimal xterm buffer over fixed-width rows — enough for the link provider,
 * which only reads line wrap flags and single-width cells.
 */
const fakeTerminal = (rows: readonly FakeRow[], cols: number): Terminal => {
  const cellAt = (row: FakeRow, column: number) => row.text[column] ?? ' '
  const makeCell = () => {
    let chars = ' '
    return {
      getChars: () => chars,
      getWidth: () => 1,
      setChars: (next: string) => {
        chars = next
      },
    }
  }

  const getLine = (index: number) => {
    const row = rows[index]
    if (!row) {
      return undefined
    }
    return {
      isWrapped: row.isWrapped,
      length: cols,
      getCell: (column: number, cell: ReturnType<typeof makeCell>) => {
        cell.setChars(cellAt(row, column))
        return cell
      },
    }
  }

  return {
    buffer: {
      active: { length: rows.length, getLine, getNullCell: makeCell },
    },
  } as unknown as Terminal
}

const provideLinks = (
  terminal: Terminal,
  bufferLineNumber: number
): ILink[] => {
  let links: ILink[] = []
  createTerminalLinkProvider(terminal).provideLinks(
    bufferLineNumber,
    (provided) => {
      links = [...(provided ?? [])]
    }
  )
  return links
}

const LINK_RANGE: IBufferRange = {
  start: { x: 1, y: 1 },
  end: { x: 10, y: 1 },
}

describe('terminal links', () => {
  beforeEach(() => {
    openExternalUrlMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a detected URL through the desktop bridge', () => {
    openTerminalLink('https://example.com/docs')

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('opens an OSC 8 hyperlink without a confirmation prompt', () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    terminalOscLinkHandler.activate(
      new MouseEvent('click'),
      'https://example.com/issue/123',
      LINK_RANGE
    )

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      'https://example.com/issue/123'
    )
  })

  it('keeps non-HTTP OSC 8 protocols disabled', () => {
    expect(terminalOscLinkHandler.allowNonHttpProtocols).toBe(false)
  })
})

describe('wrapped terminal links', () => {
  const WRAPPED_URL = 'https://exampl.com/a/very/long/path'
  const terminal = fakeTerminal(
    [
      { text: 'see https://exampl.c', isWrapped: false },
      { text: 'om/a/very/long/path', isWrapped: true },
    ],
    20
  )

  it('detects the whole URL from the row where it starts', () => {
    const [link] = provideLinks(terminal, 1)

    expect(link?.text).toBe(WRAPPED_URL)
    expect(link?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 19, y: 2 },
    })
  })

  it('detects the whole URL from the wrapped continuation row', () => {
    const [link] = provideLinks(terminal, 2)

    expect(link?.text).toBe(WRAPPED_URL)
  })

  it('opens the full URL when a wrapped link is activated', () => {
    const [link] = provideLinks(terminal, 2)

    link?.activate(new MouseEvent('click'), link.text)

    expect(openExternalUrlMock).toHaveBeenCalledWith(WRAPPED_URL)
  })

  it('does not join rows that are not soft wrapped', () => {
    const hardWrapped = fakeTerminal(
      [
        { text: 'see https://exampl.c', isWrapped: false },
        { text: 'om/a/very/long/path', isWrapped: false },
      ],
      20
    )

    expect(provideLinks(hardWrapped, 1)[0]?.text).toBe('https://exampl.c')
  })
})

describe('terminal context menu items', () => {
  it('offers link actions only when a link is under the pointer', () => {
    const overLink = terminalContextMenuItems({
      link: 'https://example.com',
      hasSelection: false,
    }).map((item) => item.id)

    expect(overLink).toEqual(['copy-link', 'open-link', 'paste'])
  })

  it('offers copy only when there is a selection', () => {
    expect(
      terminalContextMenuItems({ link: null, hasSelection: true }).map(
        (item) => item.id
      )
    ).toEqual(['copy', 'paste'])
    expect(
      terminalContextMenuItems({ link: null, hasSelection: false }).map(
        (item) => item.id
      )
    ).toEqual(['paste'])
  })
})
