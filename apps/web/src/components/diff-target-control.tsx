/**
 * The diff pane's "compared against what?" control.
 *
 * A worktree holds two stories: what the agent has not committed yet, and
 * everything the branch has done since it forked. Once an agent commits as
 * it works, the first one shows almost nothing — so this is how the reader
 * asks for the other, or for an explicit ref.
 *
 * Icon-sized on purpose. It sits in a 32px pane header next to the totals,
 * the comment picker, collapse-all, split/unified and word wrap, in a pane
 * that can be under 500px wide, so it borrows the same ghost-icon shape
 * every other control in that row uses and says which target is active
 * through its icon, its accessible name, and the checked menu item rather
 * than through a label that would not fit.
 *
 * @see `@/lib/diff-target` for the choice vocabulary and the target shape.
 */

import type { DiffTarget } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@laborer/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@laborer/ui/components/field'
import { Input } from '@laborer/ui/components/input'
import { FileDiff, GitBranch, GitCompareArrows } from 'lucide-react'
import { useId, useState } from 'react'
import {
  diffTargetChoices,
  diffTargetKey,
  diffTargetLabel,
  parseDiffTargetKey,
} from '@/lib/diff-target'

const TargetIcon = ({ target }: { readonly target: DiffTarget }) => {
  if (target._tag === 'working') {
    return <FileDiff className="size-3.5" />
  }
  if (target._tag === 'branch') {
    return <GitBranch className="size-3.5" />
  }
  return <GitCompareArrows className="size-3.5" />
}

interface DiffTargetControlProps {
  readonly onSelectTarget: (target: DiffTarget) => void
  readonly target: DiffTarget
  readonly triggerClassName?: string
}

export function DiffTargetControl({
  onSelectTarget,
  target,
  triggerClassName,
}: DiffTargetControlProps) {
  const refFieldId = useId()
  const [refDialogOpen, setRefDialogOpen] = useState(false)
  const [ref, setRef] = useState('')
  const [refError, setRefError] = useState<string | null>(null)

  const choices = diffTargetChoices(target)
  const triggerLabel = `Diff compares: ${diffTargetLabel(target)}. Change what the diff compares against`

  const submitRef = () => {
    const trimmed = ref.trim()
    if (trimmed.length === 0) {
      setRefError('Name a branch, tag, or commit — for example origin/main.')
      return
    }
    setRefDialogOpen(false)
    setRef('')
    setRefError(null)
    onSelectTarget({ _tag: 'ref', ref: trimmed })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={triggerLabel}
              className={triggerClassName}
              data-testid="diff-target-trigger"
              size="icon"
              // The rest of the toolbar explains itself through a Tooltip,
              // which cannot wrap a menu trigger without fighting it for the
              // same element. A native title says the same thing.
              title={triggerLabel}
              variant="ghost"
            >
              <TargetIcon target={target} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              const next = parseDiffTargetKey(value)
              if (next) {
                onSelectTarget(next)
              }
            }}
            value={diffTargetKey(target)}
          >
            {/* Base UI anchors a group label to its group, so this lives
                inside the radio group rather than above it. */}
            <DropdownMenuLabel>Compare against</DropdownMenuLabel>
            {choices.map((choice) => (
              <DropdownMenuRadioItem
                // A radio item keeps its menu open by default, which is
                // right for a filter and wrong here: picking a target is
                // the whole errand, and an open menu leaves an inert
                // overlay over the diff it was asked about.
                closeOnClick
                data-testid={`diff-target-option-${choice.key}`}
                key={choice.key}
                value={choice.key}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{choice.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {choice.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="diff-target-custom-ref"
            onClick={() => {
              setRef(target._tag === 'ref' ? target.ref : '')
              setRefError(null)
              setRefDialogOpen(true)
            }}
          >
            Another ref…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        onOpenChange={(next) => {
          setRefDialogOpen(next)
          if (!next) {
            setRefError(null)
          }
        }}
        open={refDialogOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Compare against a ref</DialogTitle>
            <DialogDescription>
              Anything git can resolve here — a branch, a tag, or a commit. The
              diff shows what this branch changed since it forked from it.
            </DialogDescription>
          </DialogHeader>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              submitRef()
            }}
          >
            <Field data-invalid={refError === null ? undefined : true}>
              <FieldLabel htmlFor={refFieldId}>Ref</FieldLabel>
              <Input
                aria-invalid={refError === null ? undefined : true}
                autoFocus
                data-testid="diff-target-ref-input"
                id={refFieldId}
                onChange={(event) => {
                  setRef(event.target.value)
                  setRefError(null)
                }}
                placeholder="e.g. origin/main"
                value={ref}
              />
              {refError !== null && <FieldError>{refError}</FieldError>}
            </Field>

            <DialogFooter>
              <DialogClose
                render={
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                }
              />
              <Button data-testid="diff-target-ref-submit" type="submit">
                Compare
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
