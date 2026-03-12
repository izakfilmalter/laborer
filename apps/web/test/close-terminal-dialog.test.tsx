/**
 * Component tests for PaneCloseConfirmDialog keyboard shortcuts.
 *
 * Verifies that the pane-scoped close-terminal confirmation dialog renders
 * Kbd shortcut hints and responds to keyboard events the same way as
 * the destroy-workspace dialog: plain Enter is blocked to prevent
 * accidental confirmation, Cmd+Enter is required to confirm, and
 * Escape cancels.
 *
 * @see apps/web/src/routes/-components/close-dialogs.tsx
 * @see apps/web/test/dialog-keys.test.ts — pure keyboard helpers
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the Button component to render a plain button (avoids @base-ui dependency).
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

// Stub the Kbd component to render a plain <kbd> element.
vi.mock('@/components/ui/kbd', () => ({
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}))

import { PaneCloseConfirmDialog } from '../src/routes/-components/close-dialogs'

const CANCEL_RE = /cancel esc/i
const CLOSE_ACTION_RE = /close ⌘ ↵/i

describe('PaneCloseConfirmDialog keyboard shortcuts', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders Cancel button with Esc kbd shortcut', () => {
    render(<PaneCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByRole('button', { name: CANCEL_RE })).toBeDefined()
  })

  it('renders Close button with ⌘ ↵ kbd shortcuts', () => {
    render(<PaneCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByRole('button', { name: CLOSE_ACTION_RE })).toBeDefined()
  })

  it('does not call onConfirm when plain Enter is pressed', () => {
    const onConfirm = vi.fn()
    render(<PaneCloseConfirmDialog onCancel={vi.fn()} onConfirm={onConfirm} />)

    fireEvent.keyDown(screen.getByRole('alertdialog'), {
      key: 'Enter',
    })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm when Cmd+Enter is pressed', () => {
    const onConfirm = vi.fn()
    render(<PaneCloseConfirmDialog onCancel={vi.fn()} onConfirm={onConfirm} />)

    fireEvent.keyDown(screen.getByRole('alertdialog'), {
      key: 'Enter',
      metaKey: true,
    })

    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn()
    render(<PaneCloseConfirmDialog onCancel={onCancel} onConfirm={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('alertdialog'), {
      key: 'Escape',
    })

    expect(onCancel).toHaveBeenCalledOnce()
  })
})
