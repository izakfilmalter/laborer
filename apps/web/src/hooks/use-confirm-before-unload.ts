/**
 * Browser-side counterpart to {@link useBeforeQuit}.
 *
 * Browsers reserve ⌘W / ⌘⇧W / ⌘Q and never deliver them to the page, so the
 * panel system's progressive close chain can't run and the whole Laborer tab
 * disappears with every running terminal in it. The only leverage the page has
 * left is `beforeunload`: calling `preventDefault()` makes the browser show its
 * own "Leave site?" prompt before tearing the tab down.
 *
 * The guard is deliberately conditional — it only vetoes when there is
 * something to lose (at least one running terminal with a child process), which
 * is the same predicate the Electron quit negotiation uses. This mirrors
 * VS Code's `window.confirmBeforeClose` default of `keyboardOnly` in web and
 * `never` on desktop: no prompt in the Electron shell, because `useBeforeQuit`
 * already owns that path with a real dialog.
 *
 * Browsers ignore custom prompt text, so there is nothing to localize here.
 *
 * @see apps/web/src/hooks/use-before-quit.ts — Electron quit negotiation
 * @see apps/web/src/components/close-shortcut-hint.tsx — host-aware hints
 */

import { useEffect } from 'react'
import { getRunningTerminalCount } from '@/hooks/use-terminal-list'
import { localApi } from '@/lib/local-api'

/**
 * Registers a `beforeunload` veto while running terminals exist.
 *
 * No-op inside the Electron shell, where `useBeforeQuit` handles quit
 * confirmation with a proper in-app dialog.
 */
function useConfirmBeforeUnload(): void {
  useEffect(() => {
    if (localApi.isDesktop) {
      return
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (getRunningTerminalCount() === 0) {
        return
      }
      // Both are required: `preventDefault()` is the modern spec, while
      // `returnValue` is still what some browsers actually check.
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
}

export { useConfirmBeforeUnload }
