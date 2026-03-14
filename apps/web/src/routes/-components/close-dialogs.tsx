import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { isElectron } from '@/lib/desktop'
import { isExactEnter, isMetaEnter, isMetaShiftEnter } from '@/lib/dialog-keys'

/**
 * Inline pane-scoped close confirmation dialog.
 *
 * Renders directly within the terminal pane's container (no portal),
 * using absolute positioning so the backdrop and dialog are constrained
 * to the pane's visual bounds. This gives a scoped UX where only the
 * affected terminal pane is overlaid, rather than the entire application.
 *
 * @see CloseWorkspaceDialog for the workspace-level equivalent (still portaled)
 */
export function PaneCloseConfirmDialog({
  onCancel,
  onCloseAndDestroy,
  onConfirm,
}: {
  readonly onCancel: () => void
  /**
   * Optional handler for "Close & Destroy" action.
   * When provided, a third button is shown that closes the pane AND
   * destroys the workspace worktree. Triggered by Cmd+Shift+Enter.
   */
  readonly onCloseAndDestroy?: (() => void) | undefined
  readonly onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Auto-focus the dialog container when it mounts so keyboard events
  // are captured immediately without requiring a click.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (isExactEnter(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (onCloseAndDestroy && isMetaShiftEnter(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        onCloseAndDestroy()
        return
      }
      if (isMetaEnter(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        onConfirm()
      }
    },
    [onCancel, onCloseAndDestroy, onConfirm]
  )

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Dialog container needs keyboard event handling for Escape and Cmd+Enter shortcuts
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => {
        // Clicking the backdrop (not the dialog content) cancels
        if (e.target === e.currentTarget) {
          onCancel()
        }
      }}
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
    >
      {/* Backdrop — covers only the pane */}
      <div className="absolute inset-0 bg-foreground/10 supports-backdrop-filter:backdrop-blur-xs" />
      {/* Dialog content */}
      <div className="relative z-10 grid w-full max-w-sm gap-4 bg-background p-4 ring-1 ring-foreground/10">
        <div className="grid gap-1.5 text-left">
          <h2 className="font-medium text-sm">Close terminal?</h2>
          <p className="text-muted-foreground text-xs/relaxed">
            This terminal has a running process. Closing the pane will kill the
            process.
          </p>
        </div>
        <div className="flex flex-row justify-end gap-2">
          <Button onClick={onCancel} variant="outline">
            Cancel <Kbd>Esc</Kbd>
          </Button>
          {onCloseAndDestroy && (
            <Button onClick={onCloseAndDestroy} variant="destructive">
              Close & Destroy
              <Kbd>⌘</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>↵</Kbd>
            </Button>
          )}
          <Button onClick={onConfirm}>
            Close
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Confirmation dialog shown when attempting to close a workspace that has
 * terminals with running processes. Warns the user that all terminals in
 * the workspace will be killed.
 */
export function CloseWorkspaceDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}) {
  const handleConfirm = useCallback(() => {
    onConfirm()
    onOpenChange(false)
  }, [onConfirm, onOpenChange])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This workspace has terminals with running processes. Closing the
            workspace will kill all of them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Close workspace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Dialog shown when closing the last pane of a workspace whose PR is merged
 * and no process is running. Prompts the user to also destroy the worktree.
 *
 * Keyboard shortcuts:
 * - Escape → Cancel (close dialog, keep pane open)
 * - Cmd+Enter → Close & Destroy (close pane + destroy worktree)
 * - Cmd+Shift+Enter → Close & Destroy (alias)
 * - Plain Enter → blocked (prevent accidental confirmation)
 *
 * This dialog does NOT accept plain Enter because the action is destructive.
 */
export function DestroyWorkspaceOnCloseDialog({
  open,
  onOpenChange,
  onCloseAndDestroy,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCloseAndDestroy: () => void
  readonly onConfirm: () => void
}) {
  const handleCloseAndDestroy = useCallback(() => {
    onCloseAndDestroy()
    onOpenChange(false)
  }, [onCloseAndDestroy, onOpenChange])

  const handleConfirm = useCallback(() => {
    onConfirm()
    onOpenChange(false)
  }, [onConfirm, onOpenChange])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (isExactEnter(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (isMetaShiftEnter(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
            handleCloseAndDestroy()
            return
          }
          if (isMetaEnter(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
            handleConfirm()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Destroy workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            The PR for this workspace has been merged. Would you like to destroy
            the worktree? This will remove the git worktree, delete the branch,
            and free the allocated port.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            Cancel <Kbd>Esc</Kbd>
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Close
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </AlertDialogAction>
          <AlertDialogAction
            onClick={handleCloseAndDestroy}
            variant="destructive"
          >
            Close & Destroy
            <Kbd>⌘</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Confirmation dialog shown when attempting to close a panel tab that has
 * terminals with running processes. Warns the user that terminals in the
 * tab will be killed.
 */
export function ClosePanelTabDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}) {
  const handleConfirm = useCallback(() => {
    onConfirm()
    onOpenChange(false)
  }, [onConfirm, onOpenChange])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close tab?</AlertDialogTitle>
          <AlertDialogDescription>
            This tab has terminals with running processes. Closing the tab will
            kill all of them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Close tab
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Confirmation dialog shown when attempting to close a window tab that has
 * terminals with running processes across any workspace. Warns the user
 * that all terminals in all workspaces within the tab will be killed.
 */
export function CloseWindowTabDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}) {
  const handleConfirm = useCallback(() => {
    onConfirm()
    onOpenChange(false)
  }, [onConfirm, onOpenChange])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close window tab?</AlertDialogTitle>
          <AlertDialogDescription>
            This window tab has terminals with running processes. Closing the
            tab will kill all of them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Close window tab
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function CloseAppDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const handleCloseToTray = useCallback(() => {
    if (isElectron()) {
      // In Electron, closing the window is intercepted by the main process
      // which hides it to tray instead of quitting. See Issue 13.
      window.close()
    }
    onOpenChange(false)
  }, [onOpenChange])

  const handleCloseClick = useCallback(() => {
    handleCloseToTray()
  }, [handleCloseToTray])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close Laborer?</AlertDialogTitle>
          <AlertDialogDescription>
            The window will be hidden to the system tray. Your workspaces will
            continue running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleCloseClick}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
