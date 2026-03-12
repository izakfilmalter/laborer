/**
 * Component tests for CloseTerminalDialog keyboard shortcuts.
 *
 * Verifies that the close-terminal confirmation dialog renders Kbd
 * shortcut hints and responds to keyboard events the same way as
 * the destroy-workspace dialog: plain Enter is blocked to prevent
 * accidental confirmation, and Cmd+Enter is required to confirm.
 *
 * @see apps/web/src/routes/-components/close-dialogs.tsx
 * @see apps/web/test/dialog-keys.test.ts — pure keyboard helpers
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub alert dialog primitives so they render inline (no portal needed).
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogContent: ({
    children,
    onKeyDown,
  }: {
    children: React.ReactNode
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  }) => (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: test stub for dialog onKeyDown
    <dialog data-testid="dialog-content" onKeyDown={onKeyDown} open>
      {children}
    </dialog>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogAction: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

import { CloseTerminalDialog } from '../src/routes/-components/close-dialogs'

const CANCEL_RE = /cancel esc/i
const CLOSE_ACTION_RE = /close ⌘ ↵/i

describe('CloseTerminalDialog keyboard shortcuts', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders Cancel button with Esc kbd shortcut', () => {
    render(
      <CloseTerminalDialog
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open={true}
      />
    )

    expect(screen.getByRole('button', { name: CANCEL_RE })).toBeDefined()
  })

  it('renders Close button with ⌘ ↵ kbd shortcuts', () => {
    render(
      <CloseTerminalDialog
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open={true}
      />
    )

    expect(screen.getByRole('button', { name: CLOSE_ACTION_RE })).toBeDefined()
  })

  it('does not call onConfirm when plain Enter is pressed', () => {
    const onConfirm = vi.fn()
    render(
      <CloseTerminalDialog
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open={true}
      />
    )

    fireEvent.keyDown(screen.getByTestId('dialog-content'), {
      key: 'Enter',
    })

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm when Cmd+Enter is pressed', () => {
    const onConfirm = vi.fn()
    render(
      <CloseTerminalDialog
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open={true}
      />
    )

    fireEvent.keyDown(screen.getByTestId('dialog-content'), {
      key: 'Enter',
      metaKey: true,
    })

    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
