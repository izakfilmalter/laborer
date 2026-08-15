/**
 * Regression tests for the browser `beforeunload` guard and the host-aware
 * shortcut notice.
 *
 * Browsers never deliver ⌘W/⌘Q to the page, so a browser-hosted tab can be torn
 * down with running terminals inside it. The guard is the only warning left,
 * and it must stay off inside the Electron shell where `useBeforeQuit` owns
 * quit confirmation.
 *
 * @see apps/web/src/hooks/use-confirm-before-unload.ts
 * @see apps/web/src/components/browser-shortcut-notice.tsx
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserShortcutNotice } from '../src/components/browser-shortcut-notice'
import { useConfirmBeforeUnload } from '../src/hooks/use-confirm-before-unload'

const runningTerminalCount = vi.hoisted(() => ({ value: 0 }))

vi.mock('@/hooks/use-terminal-list', () => ({
  getRunningTerminalCount: () => runningTerminalCount.value,
}))

function setDesktopBridge(present: boolean) {
  if (present) {
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {},
      writable: true,
    })
    return
  }
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    'desktopBridge'
  )
}

function Harness() {
  useConfirmBeforeUnload()
  return null
}

/** Dispatch a cancelable `beforeunload` and report whether it was vetoed. */
function dispatchBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  runningTerminalCount.value = 0
})

afterEach(() => {
  cleanup()
  setDesktopBridge(false)
})

describe('useConfirmBeforeUnload', () => {
  it('vetoes unload when running terminals would be killed', () => {
    setDesktopBridge(false)
    runningTerminalCount.value = 2
    render(<Harness />)

    expect(dispatchBeforeUnload()).toBe(true)
  })

  it('allows unload when nothing is running', () => {
    setDesktopBridge(false)
    render(<Harness />)

    expect(dispatchBeforeUnload()).toBe(false)
  })

  it('stays out of the way inside the desktop shell', () => {
    setDesktopBridge(true)
    runningTerminalCount.value = 3
    render(<Harness />)

    expect(dispatchBeforeUnload()).toBe(false)
  })

  it('removes the listener on unmount', () => {
    setDesktopBridge(false)
    runningTerminalCount.value = 1
    const view = render(<Harness />)
    view.unmount()

    expect(dispatchBeforeUnload()).toBe(false)
  })
})

describe('BrowserShortcutNotice', () => {
  it('explains reserved shortcuts in the browser build', () => {
    setDesktopBridge(false)
    render(<BrowserShortcutNotice />)

    expect(screen.getByTestId('browser-shortcut-notice')).toBeTruthy()
  })

  it('renders nothing inside the desktop shell', () => {
    setDesktopBridge(true)
    render(<BrowserShortcutNotice />)

    expect(screen.queryByTestId('browser-shortcut-notice')).toBeNull()
  })
})
