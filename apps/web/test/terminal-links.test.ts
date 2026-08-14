import type { IBufferRange } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(async () => true),
}))

vi.mock('../src/lib/local-api', () => ({
  localApi: { openExternal: openExternalUrlMock },
}))

import {
  openTerminalLink,
  terminalOscLinkHandler,
} from '../src/lib/terminal-links'

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
