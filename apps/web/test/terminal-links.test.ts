/**
 * The host's half of terminal links: opening one, and the menu that offers it.
 *
 * Detecting a URL under the pointer belongs to the renderer and is covered
 * beside it.
 *
 * @see apps/web/src/terminal/ghostty-support/terminal-links.test.ts — matching
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(async () => true),
}))

vi.mock('../src/lib/local-api', () => ({
  localApi: { openExternal: openExternalUrlMock },
}))

import {
  openTerminalLink,
  terminalContextMenuItems,
} from '../src/lib/terminal-links'

describe('opening a terminal link', () => {
  afterEach(() => {
    openExternalUrlMock.mockClear()
  })

  it('routes through the desktop bridge rather than the page', () => {
    openTerminalLink('https://example.com/issue/123')

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      'https://example.com/issue/123'
    )
  })

  it('does not surface a failed open to the caller', () => {
    openExternalUrlMock.mockRejectedValueOnce(new Error('no shell'))

    expect(() => {
      openTerminalLink('https://example.com')
    }).not.toThrow()
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

  it('always offers paste, which has nothing to read the screen for', () => {
    expect(
      terminalContextMenuItems({
        link: 'https://example.com',
        hasSelection: true,
      }).map((item) => item.id)
    ).toEqual(['copy-link', 'open-link', 'copy', 'paste'])
  })
})
