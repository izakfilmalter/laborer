/**
 * Inline workspace composer for the sidebar.
 *
 * The project heading's "+" toggles a one-line composer directly under it,
 * mirroring the kanban board's add-card affordance: Enter commits, pasting a
 * Slack permalink commits immediately, Esc cancels, and the composer stays open
 * so several workspaces can be started in a row. Progress lives in the sidebar
 * as a pending workspace item rather than in a modal.
 *
 * @see Issue #169: Per-project "+" button
 */

import { GitBranch, Plus, Slack } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IMaskInput } from 'react-imask'
import { Button } from '@/components/ui/button'
import { inputClassName } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ALLOWED_INPUT_PATTERN,
  createWorkspaceIntent,
  isSlackUrlInput,
  type PendingWorkspaceCreationChangeHandler,
  toBranchName,
  useCreateWorkspace,
} from '@/hooks/use-create-workspace'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'

/** Strips the border/ring so the masked input blends into its InputGroup. */
const inputGroupControlClassName =
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent'

/**
 * Why the composer closed. Esc is a deliberate cancel, so focus goes back to
 * the control that opened it; a blur means the person is already somewhere
 * else and moving their focus again would yank them back.
 */
type ComposerCloseReason = 'blur' | 'cancel'

/** The project heading's Plus affordance, which toggles that project's composer. */
function CreateWorkspaceButton({
  composerId,
  disabled,
  id,
  onToggle,
  open,
  projectName,
}: {
  readonly composerId: string
  readonly disabled?: boolean | undefined
  readonly id: string
  readonly onToggle: () => void
  readonly open: boolean
  readonly projectName: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // Only reference the composer while it exists in the tree.
            aria-controls={open ? composerId : undefined}
            aria-expanded={open}
            aria-label={`Create workspace in ${projectName}`}
            className={cn('h-7 w-7', open && 'bg-accent text-foreground')}
            disabled={disabled}
            id={id}
            onClick={onToggle}
            onMouseDown={(event) => {
              // An empty composer closes on blur, which would land before this
              // click and let the toggle reopen what was meant to be closed.
              if (open) {
                event.preventDefault()
              }
            }}
            size="icon-sm"
            title={disabled ? 'Connecting to server...' : undefined}
            type="button"
            variant="ghost"
          />
        }
      >
        <Plus
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            open && 'rotate-45 text-foreground'
          )}
        />
      </TooltipTrigger>
      <TooltipContent>
        {open ? 'Close composer' : 'Create Workspace'}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The inline composer for one project. A branch name is masked as it is typed,
 * a Slack URL is kept verbatim, and an empty commit lets the server auto-name
 * the branch. Creation continues in the background as a pending sidebar item,
 * so a rejected create is reported inline only while the composer is still
 * open — otherwise it falls back to a toast.
 */
function CreateWorkspaceComposer({
  composerId,
  onClose,
  onPendingCreationChange,
  projectId,
  projectName,
}: {
  readonly composerId: string
  readonly onClose: (reason: ComposerCloseReason) => void
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
  readonly projectName: string
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // A paste that completes a Slack permalink commits on the spot; the flag is
  // read by onAccept, which is where the mask reports the post-paste value.
  const pastedRef = useRef(false)
  const mountedRef = useRef(true)
  // The mask re-accepts every value the composer writes itself. Those echoes
  // must not be mistaken for typing, which would wipe the hint the write was
  // made to show.
  const writtenValueRef = useRef<string | null>(null)
  const createWorkspace = useCreateWorkspace(onPendingCreationChange)
  const trimmed = value.trim()
  const intent = createWorkspaceIntent(trimmed)

  /** Opening the composer puts the caret in it, so a name can be typed at once. */
  const attachInput = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element
    element?.focus()
  }, [])

  // Failures arrive after the network round trip, by which time the composer
  // may be gone; it reports inline only while it is still on screen.
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    []
  )

  /** Write a value into the input without treating the mask's echo as typing. */
  const writeValue = (next: string) => {
    writtenValueRef.current = next
    setValue(next)
  }

  const submit = (text = trimmed) => {
    const submitted = text.trim()
    const submittedIntent = createWorkspaceIntent(submitted)

    setError(null)
    writeValue('')
    setConfirmation(
      submittedIntent === 'slack'
        ? 'Slack link added — reading the thread in the background.'
        : `Creating ${submitted === '' ? 'an auto-named workspace' : `"${submitted}"`}…`
    )

    createWorkspace({
      branchNameOrSlackUrl: submitted,
      projectId,
    }).catch((cause: unknown) => {
      const message = extractErrorMessage(cause)
      if (!mountedRef.current) {
        toast.error(message)
        return
      }
      setConfirmation(null)
      setError(message)
      // Put the rejected text back to be corrected — unless the person has
      // already started typing the next workspace.
      if ((inputRef.current?.value ?? '') === '') {
        writeValue(submitted)
      }
      inputRef.current?.focus()
    })
  }

  const hint = (() => {
    if (error !== null) {
      return { className: 'text-destructive', text: error }
    }
    if (intent === 'slack') {
      return {
        className: 'text-muted-foreground',
        text: 'Slack link — OpenCode reads the thread, names the branch, and starts.',
      }
    }
    if (intent === 'unrecognized-link') {
      return {
        className: 'text-warning',
        text: 'Not a Slack message link yet — paste a message or thread permalink.',
      }
    }
    if (confirmation !== null) {
      return { className: 'text-muted-foreground', text: confirmation }
    }
    return {
      className: 'text-muted-foreground',
      text:
        intent === 'empty'
          ? 'Enter for an auto-named branch · Esc to close'
          : 'Enter to create · Esc to close',
    }
  })()

  return (
    <div className="flex flex-col gap-1 pt-1" id={composerId}>
      <InputGroup className="bg-background">
        <InputGroupAddon>
          {intent === 'slack' || intent === 'unrecognized-link' ? (
            <Slack aria-hidden="true" className="size-3.5" />
          ) : (
            <GitBranch aria-hidden="true" className="size-3.5" />
          )}
        </InputGroupAddon>
        <IMaskInput
          aria-describedby={`${composerId}-hint`}
          aria-invalid={error !== null}
          aria-label={`Branch name or Slack URL for ${projectName}`}
          className={cn(inputClassName, inputGroupControlClassName, 'text-xs')}
          data-slot="input-group-control"
          inputRef={attachInput}
          mask={ALLOWED_INPUT_PATTERN}
          onAccept={(nextValue: string) => {
            if (writtenValueRef.current === nextValue) {
              writtenValueRef.current = null
              return
            }
            writtenValueRef.current = null
            setValue(nextValue)
            setError(null)
            setConfirmation(null)

            const wasPaste = pastedRef.current
            pastedRef.current = false
            // Commit the post-paste value directly: waiting for React state
            // would submit the value from the render before the paste.
            if (
              wasPaste &&
              createWorkspaceIntent(nextValue.trim()) === 'slack'
            ) {
              submit(nextValue.trim())
            }
          }}
          onBlur={() => {
            // An abandoned empty composer closes itself; typed text stays put.
            if (trimmed.length === 0) {
              onClose('blur')
            }
          }}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose('cancel')
            } else if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          onPaste={() => {
            pastedRef.current = true
          }}
          placeholder={`${projectName}/my-feature, or paste a Slack link`}
          prepare={(str: string, masked: { value: string }) =>
            isSlackUrlInput(`${masked.value}${str}`) ? str : toBranchName(str)
          }
          value={value}
        />
      </InputGroup>
      <p
        aria-live="polite"
        className={cn('min-h-4 px-0.5 text-[11px]', hint.className)}
        id={`${composerId}-hint`}
      >
        {hint.text}
      </p>
    </div>
  )
}

export { CreateWorkspaceButton, CreateWorkspaceComposer }
export type { ComposerCloseReason }
