/**
 * The card detail dialog, and the editing cycle around it.
 *
 * Editing a card is the same act wherever the card is shown, so the dialog,
 * the optimistic save, and the recovery that brings a rejected draft back
 * live together here rather than inside the board. `useTaskEditor` owns the
 * whole cycle: which card is open, the save that closes it, and the reopen
 * that follows a failure. A surface asks for `openTaskEditor(taskId)` and
 * renders `taskEditor`.
 *
 * It lives outside `task-board.tsx` because the board imports the workspace
 * card, and the workspace card now opens this dialog — importing it back out
 * of the board would close the loop.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { Button } from '@laborer/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@laborer/ui/components/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@laborer/ui/components/field'
import { Input } from '@laborer/ui/components/input'
import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import { Textarea } from '@laborer/ui/components/textarea'
import { cn } from '@laborer/ui/lib/utils'
import { ExternalLink, GitBranch, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearTaskEditOverlayAtom,
  installTaskEditOverlayAtom,
} from '@/atoms/shared-state'
import { BOARD_COLUMNS } from '@/components/kanban/board-columns'
import { type BoardTask, boardTaskTitle } from '@/components/kanban/board-data'
import { SourceBadge } from '@/components/kanban/source-badge'
import { TaskLabelsControl } from '@/components/labels/task-labels-control'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'
import { localApi } from '@/lib/local-api'

const updateTaskMutation = LaborerClient.mutation('task.update')

const DESCRIPTION_LIMIT = 100_000
const TITLE_LIMIT = 100
/** Where the title counter starts earning its place on screen. */
const TITLE_COUNTER_THRESHOLD = 80

/**
 * The card's unchangeable context — which column it sits in, its branch, its
 * Slack thread. Read-only and muted, so it frames the two editable fields
 * without competing with them.
 */
function TaskDetailMeta({ task }: { readonly task: BoardTask }) {
  const column = BOARD_COLUMNS.find(({ id }) => id === task.status)
  const slackPermalink = task.slackPermalink
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-muted-foreground text-xs">
      {column && (
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              column.dotClassName
            )}
          />
          {column.title}
        </span>
      )}
      {task.branch && (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate font-mono">{task.branch}</span>
        </span>
      )}
      {slackPermalink && (
        <button
          className="flex items-center gap-1.5 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => localApi.openExternal(slackPermalink)}
          type="button"
        >
          <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          Slack thread
        </button>
      )}
    </div>
  )
}

/**
 * The dialog's action bar. It has two modes: ordinary editing, and the
 * confirmation shown when someone tries to leave with unsaved work — the
 * question and its answers replace the normal actions rather than stacking a
 * second dialog on top of the first.
 */
function TaskDetailFooter({
  canSave,
  confirmingDiscard,
  dirty,
  onCancel,
  onDiscard,
  onKeepEditing,
}: {
  readonly canSave: boolean
  readonly confirmingDiscard: boolean
  readonly dirty: boolean
  readonly onCancel: () => void
  readonly onDiscard: () => void
  readonly onKeepEditing: () => void
}) {
  const status = dirty ? 'Unsaved changes' : 'No changes yet'

  if (confirmingDiscard) {
    return (
      <DialogFooter className="mt-1 sm:items-center sm:justify-between">
        {/* The question replaces the usual actions, so it has to announce
            itself — a screen reader user gets no other signal that the buttons
            under their fingers changed meaning. */}
        <p className="text-sm text-warning" role="alert">
          Discard your unsaved edits?
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button onClick={onDiscard} type="button" variant="outline">
            Discard
          </Button>
          <Button autoFocus onClick={onKeepEditing} type="button">
            Keep editing
          </Button>
        </div>
      </DialogFooter>
    )
  }

  return (
    <DialogFooter className="mt-1 sm:items-center sm:justify-between">
      <p
        aria-live="polite"
        className="flex min-h-5 items-center gap-1.5 text-muted-foreground text-xs"
      >
        {status}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={!canSave} type="submit">
          Save changes
          {/* Hidden from the accessible name: “Save changes ⌘ ↵” reads as
              gibberish, and the shortcut is a sighted-user affordance. */}
          <KbdGroup aria-hidden="true">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
        </Button>
      </div>
    </DialogFooter>
  )
}

/**
 * The card detail surface: what the card is called, the brief its agent starts
 * from, and where the card came from.
 *
 * The two editable fields are the whole point, so everything else stays quiet —
 * provenance and branch sit in one muted strip above them rather than competing
 * for the eye. Edits are held locally until Save, so an unfinished rewrite is
 * never half-committed, and an attempt to leave with unsaved work asks first
 * instead of dropping it.
 *
 * Save is optimistic: the dialog hands the draft to `onSave` and closes at
 * once. A rejected save reopens the dialog with the draft restored and the
 * failure explained via `initialDraft` / `initialBanner`.
 */
function TaskDetailDialog({
  initialBanner = null,
  initialDraft = null,
  onOpenChange,
  onSave,
  task,
}: {
  /** Shown until the draft changes — how the previous save failed. */
  readonly initialBanner?: {
    readonly message: string
    readonly tone: 'error' | 'warning'
  } | null
  /** A rejected save's draft, restored instead of the stored values. */
  readonly initialDraft?: {
    readonly description: string
    readonly title: string
  } | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSave: (draft: {
    readonly description: string | null
    readonly expectedRevision: number
    readonly title: string
  }) => void
  readonly task: BoardTask
}) {
  const presented = boardTaskTitle(task)
  // An unnamed Slack card stores its permalink as the title. A raw URL in the
  // field reads like a mistake to correct, so the field starts empty behind a
  // prompt and the card keeps its stand-in until someone names it.
  const incomingTitle = presented.isPlaceholder ? '' : task.title
  const incomingDescription = task.description ?? ''
  const [title, setTitle] = useState(initialDraft?.title ?? incomingTitle)
  const [description, setDescription] = useState(
    initialDraft?.description ?? incomingDescription
  )
  // What the draft is measured against: the card as it stood when the form
  // last took its values from the board. A recovery reopen baselines against
  // the newer card on purpose, so the next deliberate Save applies over it.
  const [baseline, setBaseline] = useState({
    description: incomingDescription,
    revision: task.revision,
    title: incomingTitle,
  })
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  // How the previous save failed; cleared the moment the draft moves on.
  const [recoveryBanner, setRecoveryBanner] = useState(initialBanner)
  // The field the caret was last in, so leaving the discard question can put it
  // back where it was instead of dropping focus on the body.
  const lastFieldRef = useRef<HTMLElement | null>(null)
  const fieldId = useId()
  const titleId = `${fieldId}-title`
  const titleMessageId = `${fieldId}-title-message`
  const descriptionId = `${fieldId}-description`
  const descriptionHelpId = `${fieldId}-description-help`
  const normalizedDescription = description.length === 0 ? null : description
  const trimmedTitle = title.trim()
  const dirty = title !== baseline.title || description !== baseline.description
  // Only scold about an empty title once the person has emptied it themselves.
  const titleMissing = dirty && trimmedTitle.length === 0
  const hasTitleMessage = titleMissing || presented.isPlaceholder
  const canSave = dirty && trimmedTitle.length > 0

  // The board keeps polling while this dialog is open. A card that changed
  // elsewhere replaces an untouched form outright, so the fields never show a
  // stale card; a draft in progress is kept instead, because silently wiping a
  // half-written brief is worse than admitting the card moved underneath it.
  useEffect(() => {
    if (task.revision === baseline.revision) {
      return
    }
    if (dirty) {
      // Keep the revision the draft started from. A poll arriving just
      // before Save must not silently advance the CAS and let this draft
      // overwrite the newer card — the rejected save reopens with the draft
      // and a conflict banner, and that reopen baselines against the winner.
      setChangedElsewhere(true)
      return
    }
    setTitle(incomingTitle)
    setDescription(incomingDescription)
    setBaseline({
      description: incomingDescription,
      revision: task.revision,
      title: incomingTitle,
    })
    setChangedElsewhere(false)
    setRecoveryBanner(null)
  }, [
    baseline.revision,
    dirty,
    incomingDescription,
    incomingTitle,
    task.revision,
  ])

  // Leaving the discard question takes its buttons away with it. Without this
  // the caret lands nowhere and the next keystroke goes to the page.
  useEffect(() => {
    if (!confirmingDiscard) {
      lastFieldRef.current?.focus()
    }
  }, [confirmingDiscard])

  // One banner at a time: a card that moved underneath the draft is the fresher
  // and more actionable news, so it outranks the failure that preceded it.
  const banner = (() => {
    if (changedElsewhere) {
      return {
        message:
          'This card changed elsewhere. Your edits are still here — Save will report the conflict before you can apply them over the newer version.',
        tone: 'warning' as const,
      }
    }
    return recoveryBanner
  })()

  /**
   * Esc, the close button, and Cancel all land here. The first attempt with
   * unsaved work asks; a second one takes the answer and discards.
   */
  const requestClose = () => {
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true)
      return
    }
    onOpenChange(false)
  }

  /**
   * Optimistic: the draft is handed to the board and the dialog closes at
   * once. The board patches the card immediately and brings the dialog back
   * with this draft if the server rejects the write.
   */
  const save = () => {
    if (!canSave) {
      return
    }
    onSave({
      description: normalizedDescription,
      expectedRevision: baseline.revision,
      title: trimmedTitle,
    })
    onOpenChange(false)
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          requestClose()
        }
      }}
      open
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        data-testid="task-detail-dialog"
      >
        <DialogHeader className="gap-2 pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Card details</DialogTitle>
            <SourceBadge source={task.source} />
          </div>
          <DialogDescription>
            Name the card and write the brief its agent starts from.
          </DialogDescription>
          <TaskDetailMeta task={task} />
          {/* Labels save on selection through their own write, so they sit
              outside the draft form the Save button governs. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Labels</span>
            <TaskLabelsControl task={task} />
          </div>
        </DialogHeader>
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: ⌘↵ submits from either field */}
        <form
          className="grid gap-5"
          onKeyDown={(event) => {
            // ⌘↵ saves from either field, matching the workspace form.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              save()
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Field data-invalid={titleMissing}>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor={titleId}>Title</FieldLabel>
              {title.length >= TITLE_COUNTER_THRESHOLD && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {TITLE_LIMIT - title.length} left
                </span>
              )}
            </div>
            <Input
              // The message under the field is the only explanation for a
              // disabled Save, so the field has to carry it to a screen reader.
              aria-describedby={hasTitleMessage ? titleMessageId : undefined}
              aria-invalid={titleMissing}
              autoFocus
              className="font-medium"
              id={titleId}
              maxLength={TITLE_LIMIT}
              onChange={(event) => {
                setTitle(event.target.value)
                setRecoveryBanner(null)
                setConfirmingDiscard(false)
              }}
              onFocus={(event) => {
                lastFieldRef.current = event.currentTarget
              }}
              placeholder={
                presented.isPlaceholder ? presented.text : 'Name this card'
              }
              value={title}
            />
            {titleMissing && (
              <FieldError id={titleMessageId}>A card needs a title.</FieldError>
            )}
            {presented.isPlaceholder && !titleMissing && (
              <FieldDescription className="text-xs" id={titleMessageId}>
                Still unnamed — saving a title here replaces the stand-in the
                board shows.
              </FieldDescription>
            )}
          </Field>
          <Field>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
              {description.length > 0 && (
                <span
                  className={cn(
                    'text-muted-foreground text-xs tabular-nums',
                    description.length > DESCRIPTION_LIMIT * 0.9 &&
                      'text-warning'
                  )}
                >
                  {description.length.toLocaleString()} characters
                </span>
              )}
            </div>
            <Textarea
              aria-describedby={descriptionHelpId}
              className="min-h-40 resize-y"
              id={descriptionId}
              maxLength={DESCRIPTION_LIMIT}
              onChange={(event) => {
                setDescription(event.target.value)
                setRecoveryBanner(null)
                setConfirmingDiscard(false)
              }}
              onFocus={(event) => {
                lastFieldRef.current = event.currentTarget
              }}
              placeholder="What should the agent know or do?"
              value={description}
            />
            <FieldDescription className="text-xs" id={descriptionHelpId}>
              Plain text — used as the agent’s initial prompt when this card
              enters In Progress.
            </FieldDescription>
          </Field>
          {banner && (
            <div
              aria-live="polite"
              className={cn(
                'flex gap-2 rounded-md border px-3 py-2 text-sm',
                banner.tone === 'warning'
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
              role="alert"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{banner.message}</span>
            </div>
          )}
          <TaskDetailFooter
            canSave={canSave}
            confirmingDiscard={confirmingDiscard}
            dirty={dirty}
            onCancel={requestClose}
            onDiscard={() => onOpenChange(false)}
            onKeepEditing={() => setConfirmingDiscard(false)}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A rejected optimistic save: the draft, why it failed, and which card it
 * belongs to, so the dialog can come back exactly as it was left.
 */
interface TaskEditRecovery {
  readonly attempt: number
  readonly description: string
  readonly message: string
  readonly taskId: string
  readonly title: string
  readonly tone: 'error' | 'warning'
}

/**
 * The card-editing cycle for a surface that shows cards.
 *
 * The caller hands over the cards it can show and gets back a way to open the
 * editor and a node to render. Everything between — the optimistic overlay,
 * the CAS conflict, the reopen that hands a rejected draft back — is in here,
 * because a half-owned version of this is how a surface loses somebody's
 * text.
 *
 * The overlay patches the card the instant the dialog hands over its draft
 * and settles when the authoritative row leaves the draft's revision.
 */
function useTaskEditor(tasks: readonly BoardTask[]): {
  readonly openTaskEditor: (taskId: string) => void
  readonly taskEditor: ReactNode
} {
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<TaskEditRecovery | null>(null)
  const updateTask = useAtomSet(updateTaskMutation, { mode: 'promise' })
  const installEditOverlay = useAtomSet(installTaskEditOverlayAtom)
  const clearEditOverlay = useAtomSet(clearTaskEditOverlayAtom)

  const editingTask = tasks.find((task) => task.id === editingTaskId)

  const save = (
    taskId: string,
    draft: {
      readonly description: string | null
      readonly expectedRevision: number
      readonly title: string
    }
  ) => {
    installEditOverlay({
      overlay: {
        expectedRevision: draft.expectedRevision,
        patch: { description: draft.description, title: draft.title },
      },
      taskId,
    })
    updateTask({
      payload: {
        description: draft.description,
        expectedRevision: draft.expectedRevision,
        taskId,
        title: draft.title,
      },
    }).catch((error: unknown) => {
      clearEditOverlay(taskId)
      const conflict = extractErrorCode(error) === 'CAS_CONFLICT'
      const message = conflict
        ? 'This card changed elsewhere while saving. Your edits are below — Save again to apply them over the newer version.'
        : extractErrorMessage(error)
      setRecovery((current) => ({
        attempt: (current?.attempt ?? 0) + 1,
        description: draft.description ?? '',
        message,
        taskId,
        title: draft.title,
        tone: conflict ? 'warning' : 'error',
      }))
      setEditingTaskId(taskId)
      toast.error(conflict ? 'Card changed elsewhere' : 'Could not save card', {
        description: message,
      })
    })
  }

  const recovering = editingTask && recovery?.taskId === editingTask.id

  return {
    openTaskEditor: setEditingTaskId,
    taskEditor: editingTask ? (
      <TaskDetailDialog
        initialBanner={
          recovering ? { message: recovery.message, tone: recovery.tone } : null
        }
        initialDraft={
          recovering
            ? { description: recovery.description, title: recovery.title }
            : null
        }
        // The attempt count remounts the dialog when a failure lands while it
        // is already open, so the restored draft actually takes.
        key={
          recovering
            ? `${editingTask.id}:recovery-${String(recovery.attempt)}`
            : editingTask.id
        }
        onOpenChange={(open) => {
          if (!open) {
            setEditingTaskId(null)
            setRecovery(null)
          }
        }}
        onSave={(draft) => save(editingTask.id, draft)}
        task={editingTask}
      />
    ) : null,
  }
}

export { TaskDetailDialog, useTaskEditor }
export type { TaskEditRecovery }
