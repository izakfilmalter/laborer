import type { ILinkHandler } from '@xterm/xterm'
import { openExternalUrl } from '@/lib/desktop'

/** Open a terminal URL in the user's default browser without blocking the UI. */
export const openTerminalLink = (url: string): void => {
  openExternalUrl(url).catch(() => {
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
