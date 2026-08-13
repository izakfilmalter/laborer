/**
 * The inline composer shared by the kanban board and the sidebar.
 *
 * One affordance, two surfaces: a "+" toggles a one-line input in place, Enter
 * commits, pasting something the surface recognizes commits on the spot, Esc
 * cancels back to the "+", and an abandoned empty composer closes on blur. It
 * stays open after a commit so several things can be typed in a row, and it
 * says what the text will become before it is committed.
 *
 * Each surface supplies what only it can know — how to classify the text, what
 * to commit, and which control to type into — and inherits the interaction.
 *
 * @see Issue #169: Per-project "+" button
 */

import { Plus } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, extractErrorMessage } from '@/lib/utils'

/**
 * Why the composer closed. Esc is a deliberate cancel, so focus goes back to
 * the control that opened it; a blur means the person is already somewhere
 * else and moving their focus again would yank them back.
 */
type ComposerCloseReason = 'blur' | 'cancel'

/** A line of guidance under the input, styled by how urgent it is. */
interface ComposerHint {
  readonly className: string
  readonly text: string
}

/** Everything a control needs to be driven by the composer. */
interface ComposerControlProps {
  readonly 'aria-describedby': string
  readonly 'aria-invalid': boolean
  readonly 'aria-label': string
  readonly onBlur: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  readonly onPaste: () => void
  /** Report typed text. Echoes of a programmatic write are ignored. */
  readonly onValueChange: (next: string) => void
  readonly placeholder: string
  readonly ref: (element: HTMLInputElement | null) => void
  readonly value: string
}

/** The "+" that toggles a composer, in the header of whatever owns one. */
function ComposerToggleButton({
  className,
  closedLabel,
  composerId,
  disabled,
  id,
  label,
  onToggle,
  open,
  size = 'icon-xs',
  title,
}: {
  readonly className?: string | undefined
  /** Tooltip while closed, e.g. "Add card". Open always reads "Close composer". */
  readonly closedLabel: string
  readonly composerId: string
  readonly disabled?: boolean | undefined
  readonly id: string
  /** Accessible name, e.g. "Add card to In Progress". */
  readonly label: string
  readonly onToggle: () => void
  readonly open: boolean
  readonly size?: 'icon-sm' | 'icon-xs' | undefined
  readonly title?: string | undefined
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // Only reference the composer while it exists in the tree.
            aria-controls={open ? composerId : undefined}
            aria-expanded={open}
            aria-label={label}
            className={cn(
              'text-muted-foreground',
              open && 'bg-accent text-foreground',
              className
            )}
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
            size={size}
            title={title}
            type="button"
            variant="ghost"
          />
        }
      >
        <Plus
          className={cn('size-3.5 transition-transform', open && 'rotate-45')}
        />
      </TooltipTrigger>
      <TooltipContent>{open ? 'Close composer' : closedLabel}</TooltipContent>
    </Tooltip>
  )
}

interface InlineComposerProps {
  /** Icon for the current text, shown at the head of the input. */
  readonly addon: (trimmed: string) => ReactNode
  /** Accessible name for the input. */
  readonly ariaLabel: string
  /**
   * Commit the trimmed text. The composer clears and shows its confirmation
   * straight away; a rejection is reported inline and the text is restored.
   * Surface-specific cleanup belongs in here, ahead of the rethrow.
   */
  readonly commit: (trimmed: string) => Promise<unknown>
  /** True when committing empty text is meaningful, rather than a no-op. */
  readonly commitsEmpty?: boolean | undefined
  /** True when a paste producing this text should commit on the spot. */
  readonly commitsOnPaste: (trimmed: string) => boolean
  readonly composerId: string
  /** What to say after a commit, until the result lands. */
  readonly confirmation: (trimmed: string) => string
  /** What the text will become, when that is worth saying. Null defers to the idle line. */
  readonly hint: (trimmed: string) => ComposerHint | null
  /** The resting line, e.g. "Enter to add · Esc to close". */
  readonly idleHint: (trimmed: string) => string
  readonly onClose: (reason: ComposerCloseReason) => void
  /**
   * Report a failure that arrived after the composer was gone, when the
   * surface would rather not swallow it.
   */
  readonly onFailureWhileClosed?: ((message: string) => void) | undefined
  readonly placeholder: string
  /** Renders the control. Defaults to a plain input; the sidebar masks branch names. */
  readonly renderControl?:
    | ((props: ComposerControlProps) => ReactNode)
    | undefined
}

function InlineComposer({
  addon,
  ariaLabel,
  commit,
  commitsEmpty = false,
  commitsOnPaste,
  composerId,
  confirmation,
  hint,
  idleHint,
  onClose,
  onFailureWhileClosed,
  placeholder,
  renderControl,
}: InlineComposerProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // A paste is only known to be a paste in its own handler; the value it
  // produces arrives with the change that follows.
  const pastedRef = useRef(false)
  const mountedRef = useRef(true)
  // A masked control re-reports every value the composer writes itself. Those
  // echoes must not be mistaken for typing, which would wipe the hint the
  // write was made to show.
  const writtenValueRef = useRef<string | null>(null)
  const trimmed = value.trim()

  /** Opening the composer puts the caret in it, so text can be typed at once. */
  const attachInput = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element
    element?.focus()
  }, [])

  // Failures arrive after a round trip, by which time the composer may be
  // gone; it reports inline only while it is still on screen.
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    []
  )

  /** Write a value into the input without treating the echo as typing. */
  const writeValue = (next: string) => {
    writtenValueRef.current = next
    setValue(next)
  }

  const submit = (text = trimmed) => {
    const submitted = text.trim()
    if (submitted === '' && !commitsEmpty) {
      return
    }

    setError(null)
    writeValue('')
    setConfirmed(confirmation(submitted))

    commit(submitted).catch((cause: unknown) => {
      const message = extractErrorMessage(cause)
      if (!mountedRef.current) {
        onFailureWhileClosed?.(message)
        return
      }
      setConfirmed(null)
      setError(message)
      // Put the rejected text back to be corrected — unless the person has
      // already started typing the next one.
      if ((inputRef.current?.value ?? '') === '') {
        writeValue(submitted)
      }
      inputRef.current?.focus()
    })
  }

  const controlProps: ComposerControlProps = {
    'aria-describedby': `${composerId}-hint`,
    'aria-invalid': error !== null,
    'aria-label': ariaLabel,
    onBlur: () => {
      // An abandoned empty composer closes itself; typed text stays put.
      if (trimmed.length === 0) {
        onClose('blur')
      }
    },
    onKeyDown: (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose('cancel')
      } else if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    },
    onPaste: () => {
      pastedRef.current = true
    },
    onValueChange: (next) => {
      if (writtenValueRef.current === next) {
        writtenValueRef.current = null
        return
      }
      writtenValueRef.current = null
      setValue(next)
      setError(null)
      setConfirmed(null)

      const wasPaste = pastedRef.current
      pastedRef.current = false
      if (wasPaste && commitsOnPaste(next.trim())) {
        // Commit the pasted value directly: waiting for the state this change
        // sets would commit the value from the render before the paste.
        submit(next.trim())
      }
    },
    placeholder,
    ref: attachInput,
    value,
  }

  const shownHint: ComposerHint = (() => {
    if (error !== null) {
      return { className: 'text-destructive', text: error }
    }
    const urgent = hint(trimmed)
    if (urgent !== null) {
      return urgent
    }
    return {
      className: 'text-muted-foreground',
      text: confirmed ?? idleHint(trimmed),
    }
  })()

  return (
    <div className="flex flex-col gap-1" id={composerId}>
      <InputGroup className="bg-background">
        <InputGroupAddon>{addon(trimmed)}</InputGroupAddon>
        {renderControl ? (
          renderControl(controlProps)
        ) : (
          <InputGroupInput
            aria-describedby={controlProps['aria-describedby']}
            aria-invalid={controlProps['aria-invalid']}
            aria-label={controlProps['aria-label']}
            className="text-xs"
            onBlur={controlProps.onBlur}
            onChange={(event) => controlProps.onValueChange(event.target.value)}
            onKeyDown={controlProps.onKeyDown}
            onPaste={controlProps.onPaste}
            placeholder={controlProps.placeholder}
            ref={controlProps.ref}
            value={controlProps.value}
          />
        )}
      </InputGroup>
      <p
        aria-live="polite"
        className={cn('min-h-4 px-0.5 text-[11px]', shownHint.className)}
        id={`${composerId}-hint`}
      >
        {shownHint.text}
      </p>
    </div>
  )
}

export { ComposerToggleButton, InlineComposer }
export type { ComposerCloseReason, ComposerControlProps, ComposerHint }
