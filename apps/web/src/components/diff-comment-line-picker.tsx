/**
 * The keyboard route to commenting on a line.
 *
 * The diff viewer's gutter affordance is pointer-only and lives in a shadow
 * root the app cannot make tabbable, so this dialog is the app's own way in:
 * pick a file, pick a side, type a line, and the pane opens the same composer
 * on the same anchor a drag would have produced.
 *
 * Everything here is ordinary form markup on purpose — a native select, a
 * native number input, a labelled submit — because the failure this is fixing
 * is precisely that the fancier surface could not be reached.
 *
 * @see `@/lib/diff-comment-line-target` for the resolution and its failures.
 */

import { Button } from '@laborer/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@laborer/ui/components/dialog'
import { Field, FieldError, FieldLabel } from '@laborer/ui/components/field'
import { Input } from '@laborer/ui/components/input'
import {
  NativeSelect,
  NativeSelectOption,
} from '@laborer/ui/components/native-select'
import { MessageSquarePlus } from 'lucide-react'
import { useId, useState } from 'react'
import type {
  DiffCommentAnchor,
  DiffCommentSide,
} from '@/lib/diff-comment-anchor'
import type { CommentableDiffFile } from '@/lib/diff-comment-line-target'
import {
  describeCommentableLines,
  resolveDiffCommentLineTarget,
} from '@/lib/diff-comment-line-target'

interface DiffCommentLinePickerProps {
  /** Parsed files, in the order the pane lists them. */
  readonly files: readonly CommentableDiffFile[]
  readonly onStartComment: (anchor: DiffCommentAnchor) => void
  readonly triggerClassName?: string
}

export function DiffCommentLinePicker({
  files,
  onStartComment,
  triggerClassName,
}: DiffCommentLinePickerProps) {
  const fileFieldId = useId()
  const sideFieldId = useId()
  const lineFieldId = useId()

  const [open, setOpen] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [side, setSide] = useState<DiffCommentSide>('additions')
  const [line, setLine] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The first file is the one the reader is looking at, so it is the default
  // rather than an empty select they have to answer before reading the hint.
  const selectedPath = filePath === '' ? (files[0]?.path ?? '') : filePath
  const selected = files.find((file) => file.path === selectedPath)
  const availableLines = selected
    ? describeCommentableLines(selected.fileDiff, side)
    : ''

  const reset = () => {
    setFilePath('')
    setSide('additions')
    setLine('')
    setError(null)
  }

  const submit = () => {
    const target = resolveDiffCommentLineTarget(files, {
      filePath: selectedPath,
      line,
      side,
    })
    if (!target.ok) {
      setError(target.reason)
      return
    }
    setOpen(false)
    reset()
    onStartComment(target.anchor)
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          reset()
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label="Comment on a line"
            className={triggerClassName}
            size="icon"
            // The rest of the toolbar explains itself on hover through a
            // Tooltip, which cannot wrap a trigger without fighting it for
            // the same element. A native title says the same thing.
            title="Comment on a line"
            variant="ghost"
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Comment on a line</DialogTitle>
          <DialogDescription>
            The diff's own gutter needs a pointer. Name the line here instead
            and the comment box opens on it.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field>
            <FieldLabel htmlFor={fileFieldId}>File</FieldLabel>
            <NativeSelect
              className="w-full"
              id={fileFieldId}
              onChange={(event) => {
                setFilePath(event.target.value)
                setError(null)
              }}
              value={selectedPath}
            >
              {files.map((file) => (
                <NativeSelectOption key={file.path} value={file.path}>
                  {file.path}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field>
            <FieldLabel htmlFor={sideFieldId}>Numbered against</FieldLabel>
            <NativeSelect
              className="w-full"
              id={sideFieldId}
              onChange={(event) => {
                setSide(event.target.value as DiffCommentSide)
                setError(null)
              }}
              value={side}
            >
              <NativeSelectOption value="additions">
                The file as it is now
              </NativeSelectOption>
              <NativeSelectOption value="deletions">
                The file as it was
              </NativeSelectOption>
            </NativeSelect>
          </Field>

          <Field data-invalid={error === null ? undefined : true}>
            <FieldLabel htmlFor={lineFieldId}>Line</FieldLabel>
            <Input
              aria-describedby={
                availableLines === '' ? undefined : `${lineFieldId}-hint`
              }
              aria-invalid={error === null ? undefined : true}
              autoFocus
              id={lineFieldId}
              inputMode="numeric"
              onChange={(event) => {
                setLine(event.target.value)
                setError(null)
              }}
              placeholder="e.g. 42"
              value={line}
            />
            {availableLines !== '' && (
              <p
                className="text-muted-foreground text-xs"
                id={`${lineFieldId}-hint`}
              >
                Changed lines: {availableLines}
              </p>
            )}
            {error !== null && <FieldError>{error}</FieldError>}
          </Field>

          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              }
            />
            <Button disabled={files.length === 0} type="submit">
              Comment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
