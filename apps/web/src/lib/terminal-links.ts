/**
 * Host-side link handling for a terminal pane.
 *
 * Detecting a URL under the pointer belongs to the renderer, which is the only
 * thing that knows how a line wrapped across rows; Ghostty's surface does it
 * and hands back the text. What is left here is what the *host* owns: opening
 * a URL through the desktop bridge, and the right-click menu that offers it.
 *
 * @see apps/web/src/terminal/ghostty-support/terminal-links.ts — the matcher
 * @see apps/web/src/panes/terminal-pane.tsx — the menu's call site
 */

import type { ContextMenuItem } from '@laborer/shared/desktop-bridge'
import { localApi } from '@/lib/local-api'

/** Open a terminal URL in the user's default browser without blocking the UI. */
export const openTerminalLink = (url: string): void => {
  localApi.openExternal(url).catch(() => {
    // Link open failures are non-critical.
  })
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
