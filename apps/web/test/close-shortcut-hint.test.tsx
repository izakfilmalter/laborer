/**
 * Regression tests for the close keyboard hints.
 *
 * Browsers reserve Cmd+W and Cmd+Shift+W, so those shortcuts never reach the
 * page in the web build. The hints must advertise the prefix sequences that
 * actually run the progressive close chain there.
 *
 * @see apps/web/src/components/close-shortcut-hint.tsx
 * @see apps/web/src/panels/panel-hotkeys.tsx
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloseShortcutHint,
  CloseWindowTabShortcutHint,
} from '../src/components/close-shortcut-hint'

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

afterEach(() => {
  cleanup()
  setDesktopBridge(false)
})

describe('CloseShortcutHint', () => {
  it('advertises the prefix sequence in the browser build', () => {
    setDesktopBridge(false)
    render(<CloseShortcutHint />)

    expect(screen.getByText('⌃')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('X')).toBeTruthy()
    expect(screen.queryByText('⌘')).toBeNull()
  })

  it('advertises Cmd+W inside the desktop shell', () => {
    setDesktopBridge(true)
    render(<CloseShortcutHint />)

    expect(screen.getByText('⌘')).toBeTruthy()
    expect(screen.getByText('W')).toBeTruthy()
  })
})

describe('CloseWindowTabShortcutHint', () => {
  it('advertises the prefix sequence in the browser build', () => {
    setDesktopBridge(false)
    render(<CloseWindowTabShortcutHint />)

    expect(screen.getByText('⌃')).toBeTruthy()
    expect(screen.getByText('⇧')).toBeTruthy()
    expect(screen.getByText('X')).toBeTruthy()
    expect(screen.queryByText('W')).toBeNull()
  })

  it('advertises Cmd+Shift+W inside the desktop shell', () => {
    setDesktopBridge(true)
    render(<CloseWindowTabShortcutHint />)

    expect(screen.getByText('⌘')).toBeTruthy()
    expect(screen.getByText('W')).toBeTruthy()
  })
})
