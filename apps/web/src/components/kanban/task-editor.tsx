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
  DialogTitle,
} from '@laborer/ui/components/dialog'
import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import { Separator } from '@laborer/ui/components/separator'
import { cn } from '@laborer/ui/lib/utils'
import {
  ChevronRight,
  ExternalLink,
  GitBranch,
  TriangleAlert,
  XIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  DescriptionEditor,
  type DescriptionEditorHandle,
} from '@/components/editor/description-editor'
import { BOARD_COLUMNS } from '@/components/kanban/board-columns'
import { type BoardTask, boardTaskTitle } from '@/components/kanban/board-data'
import { SourceBadge } from '@/components/kanban/source-badge'
import { TaskLabelsControl } from '@/components/labels/task-labels-control'
import { updateTask as updateTaskOptimistically } from '@/db/shared-mutations'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'
import { localApi } from '@/lib/local-api'

const updateTaskMutation = LaborerClient.mutation('task.update')

const DESCRIPTION_LIMIT = 100_000
/** Where the description counter starts warning rather than informing. */
const DESCRIPTION_WARN_RATIO = 0.9
const TITLE_LIMIT = 100
/** Where the title counter starts earning its place on screen. */
const TITLE_COUNTER_THRESHOLD = 80

/**
 * Where the card came from and what it is attached to: its column, its branch,
 * its Slack thread.
 *
 * Read-only and muted. These frame the two editable fields without competing
 * with them, which is why they sit on one line above the brief rather than
 * being laid out as fields of their own.
 */
function TaskDetailMeta({ task }: { readonly task: BoardTask }) {
  const slackPermalink = task.slackPermalink

  if (!(task.branch || slackPermalink)) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
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
 * How much room is left in each field.
 *
 * Both counters stay out of the way until they have something to say: the title
 * only near its ceiling, the brief only once there is one. A brief has no hard
 * ceiling in practice, so its count is information rather than a warning right
 * up until the point where it would fail to save.
 */
function TaskDetailCounters({
  descriptionLength,
  titleLength,
}: {
  readonly descriptionLength: number
  readonly titleLength: number
}) {
  return (
    <div className="ml-auto flex items-center gap-3 text-xs tabular-nums">
      {titleLength >= TITLE_COUNTER_THRESHOLD && (
        <span className="text-muted-foreground">
          Title: {TITLE_LIMIT - titleLength} left
        </span>
      )}
      {descriptionLength > 0 && (
        <span
          className={cn(
            'text-muted-foreground',
            descriptionLength > DESCRIPTION_LIMIT * DESCRIPTION_WARN_RATIO &&
              'text-warning',
            descriptionLength > DESCRIPTION_LIMIT && 'text-destructive'
          )}
        >
          {descriptionLength.toLocaleString()} characters
        </span>
      )}
    </div>
  )
}

/**
 * What is standing between this draft and a save.
 *
 * These share one id because they are one message in the eye of the title
 * field, and only one can be true at a time: a card is either missing a title,
 * or still carrying its stand-in, or neither.
 */
function TaskDetailMessages({
  messageId,
  overLimit,
  titleMissing,
  unnamed,
}: {
  readonly messageId: string
  readonly overLimit: boolean
  readonly titleMissing: boolean
  readonly unnamed: boolean
}) {
  return (
    <>
      {titleMissing && (
        <p className="text-destructive text-xs" id={messageId}>
          A card needs a title.
        </p>
      )}
      {unnamed && !titleMissing && (
        <p className="text-muted-foreground text-xs" id={messageId}>
          Still unnamed — saving a title here replaces the stand-in the board
          shows.
        </p>
      )}
      {overLimit && (
        <p className="text-destructive text-xs" role="alert">
          This brief is too long to save. Trim it to{' '}
          {DESCRIPTION_LIMIT.toLocaleString()} characters.
        </p>
      )}
    </>
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
  return (
    <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2.5">
      {confirmingDiscard ? (
        <>
          {/* The question replaces the usual actions, so it has to announce
              itself — a screen reader user gets no other signal that the
              buttons under their fingers changed meaning. */}
          <p className="text-sm text-warning" role="alert">
            Discard your unsaved edits?
          </p>
          <div className="ml-auto flex gap-2">
            <Button onClick={onDiscard} type="button" variant="outline">
              Discard
            </Button>
            <Button autoFocus onClick={onKeepEditing} type="button">
              Keep editing
            </Button>
          </div>
        </>
      ) : (
        <>
          <p
            aria-live="polite"
            className="min-h-5 text-muted-foreground text-xs"
          >
            {dirty ? 'Unsaved changes' : 'No changes yet'}
          </p>
          <div className="ml-auto flex gap-2">
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
        </>
      )}
    </div>
  )
}

/**
 * The card detail surface: what the card is called, the brief its agent starts
 * from, and where the card came from.
 *
 * The two editable fields are the whole point, so they are given the dialog's
 * body outright — a large unadorned title over a chromeless brief — and
 * everything else is pushed to the frame around them: provenance above,
 * labels and actions below. Neither field wears a border, because the writing
 * is the interface here and a form control's chrome would only fence it in.
 *
 * Edits are held locally until Save, so an unfinished rewrite is never
 * half-committed, and an attempt to leave with unsaved work asks first instead
 * of dropping it.
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
  const column = BOARD_COLUMNS.find(({ id }) => id === task.status)
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
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descriptionRef = useRef<DescriptionEditorHandle>(null)
  const fieldId = useId()
  const titleId = `${fieldId}-title`
  const titleMessageId = `${fieldId}-title-message`
  const descriptionHelpId = `${fieldId}-description-help`
  const normalizedDescription = description.length === 0 ? null : description
  const trimmedTitle = title.trim()
  const dirty = title !== baseline.title || description !== baseline.description
  // Only scold about an empty title once the person has emptied it themselves.
  const titleMissing = dirty && trimmedTitle.length === 0
  const hasTitleMessage = titleMissing || presented.isPlaceholder
  const overLimit = description.length > DESCRIPTION_LIMIT
  const canSave = dirty && trimmedTitle.length > 0 && !overLimit

  /** Any edit answers an outstanding question and dates the last failure. */
  const noteEdit = () => {
    setRecoveryBanner(null)
    setConfirmingDiscard(false)
  }

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
        // Anchored near the top rather than centred: the dialog grows downward
        // as a brief is written, and a centred one would slide its title out
        // from under the caret every time a line was added.
        className="top-[clamp(1rem,calc((100dvh-32rem)/2),8rem)] flex max-h-[calc(100dvh-clamp(1rem,calc((100dvh-32rem)/2),8rem)*2)] w-full translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="task-detail-dialog"
        onKeyDown={(event) => {
          // Escape inside the brief steps out to the dialog frame first, so a
          // stray keypress while writing never throws away the draft. The
          // second Escape reaches the dialog and asks the usual question.
          if (event.key !== 'Escape') {
            return
          }
          const active = document.activeElement
          if (active instanceof HTMLElement && active.isContentEditable) {
            event.preventDefault()
            active.blur()
          }
        }}
        // The dialog carries its own close control in the header row, beside
        // the card's provenance, rather than floating one over the title.
        showCloseButton={false}
      >
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          {column && (
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                className={cn(
                  'inline-block size-2 shrink-0 rounded-full',
                  column.dotClassName
                )}
              />
              {column.title}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground/60"
          />
          <DialogTitle className="font-medium text-sm">
            Card details
          </DialogTitle>
          <SourceBadge source={task.source} />
          <Button
            aria-label="Close"
            className="ml-auto"
            onClick={requestClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          Name the card and write the brief its agent starts from.
        </DialogDescription>
        <Separator />
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: ⌘↵ submits from either field */}
        <form
          className="flex min-h-0 flex-1 flex-col"
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
          <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pt-3">
            {/* Unadorned, and the size of a heading, because that is what it
                is: the card's name, not a form field to be filled in. A
                textarea rather than an input so a long name wraps into view
                instead of scrolling sideways out of it; `field-sizing-content`
                keeps it exactly as tall as the name needs. */}
            <textarea
              // The message under the fields is the only explanation for a
              // disabled Save, so the field has to carry it to a screen reader.
              aria-describedby={hasTitleMessage ? titleMessageId : undefined}
              aria-invalid={titleMissing}
              aria-label="Title"
              autoComplete="off"
              autoFocus
              className="field-sizing-content w-full shrink-0 resize-none bg-transparent font-medium text-lg leading-snug outline-none placeholder:text-muted-foreground aria-invalid:placeholder:text-destructive"
              id={titleId}
              maxLength={TITLE_LIMIT}
              onChange={(event) => {
                setTitle(event.target.value)
                noteEdit()
              }}
              onFocus={(event) => {
                lastFieldRef.current = event.currentTarget
              }}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey) {
                  return
                }
                // The title and the brief are one surface, so the caret walks
                // out of the bottom of the title into the top of the brief.
                const atEnd =
                  event.currentTarget.selectionStart === title.length &&
                  event.currentTarget.selectionEnd === title.length
                const leaving =
                  event.key === 'Enter' ||
                  event.key === 'ArrowDown' ||
                  (event.key === 'ArrowRight' && atEnd)
                if (leaving) {
                  event.preventDefault()
                  descriptionRef.current?.focusStart()
                }
              }}
              placeholder={
                presented.isPlaceholder ? presented.text : 'Name this card'
              }
              ref={titleRef}
              rows={1}
              value={title}
            />
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Negative margin lets the editable's own padding provide the
                  hover and focus bleed for inline chips without the brief
                  sitting further in than the title above it. */}
              <div className="-mx-2 min-h-32 flex-1 overflow-y-auto">
                <DescriptionEditor
                  ariaLabel="Description"
                  contentClassName="px-2"
                  handleRef={descriptionRef}
                  // The editor reads its markdown once and owns the document
                  // from then on, so adopting a newer card has to rebuild it.
                  // The baseline's revision moves only when the dialog takes
                  // fresh values from the board, which is exactly when the
                  // shown text is stale — a draft in progress holds its
                  // revision, and so keeps its editor and its caret.
                  key={`description-${String(baseline.revision)}`}
                  onChange={(markdown) => {
                    setDescription(markdown)
                    noteEdit()
                  }}
                  onEscapeStart={() => {
                    const input = titleRef.current
                    if (!input) {
                      return
                    }
                    input.focus()
                    input.setSelectionRange(title.length, title.length)
                  }}
                  onFocus={(event) => {
                    lastFieldRef.current = event.currentTarget
                  }}
                  // The editor rewrites markdown into its own shape, so the
                  // draft is measured against that shape rather than against
                  // the stored text — otherwise every card would open dirty.
                  onNormalize={(markdown) => {
                    setDescription(markdown)
                    setBaseline((current) =>
                      initialDraft
                        ? current
                        : { ...current, description: markdown }
                    )
                  }}
                  placeholder="What should the agent know or do?"
                  value={description}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {/* Labels save on selection through their own write, so they sit
                  outside the draft form the Save button governs. */}
              <TaskLabelsControl task={task} />
              <TaskDetailMeta task={task} />
              <TaskDetailCounters
                descriptionLength={description.length}
                titleLength={title.length}
              />
            </div>
            <TaskDetailMessages
              messageId={titleMessageId}
              overLimit={overLimit}
              titleMissing={titleMissing}
              unnamed={presented.isPlaceholder}
            />
            <p className="text-muted-foreground text-xs" id={descriptionHelpId}>
              Markdown — used as the agent’s initial prompt when this card
              enters In Progress. Type <span className="font-mono">/</span> for
              blocks.
            </p>
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
          </div>
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
 * editor and a node to render. Everything between — the optimistic action,
 * the CAS conflict, the reopen that hands a rejected draft back — is in here,
 * because a half-owned version of this is how a surface loses somebody's
 * text.
 *
 * TanStack patches the card the instant the dialog hands over its draft and
 * settles the transaction against correlated authoritative publication.
 */
function useTaskEditor(tasks: readonly BoardTask[]): {
  readonly openTaskEditor: (task: BoardTask) => void
  readonly taskEditor: ReactNode
} {
  const [openedTask, setOpenedTask] = useState<BoardTask | null>(null)
  const [recovery, setRecovery] = useState<TaskEditRecovery | null>(null)
  const updateTask = useAtomSet(updateTaskMutation, { mode: 'promise' })

  const editingTask =
    tasks.find((task) => task.id === openedTask?.id) ?? openedTask ?? undefined

  const save = (
    taskId: string,
    draft: {
      readonly description: string | null
      readonly expectedRevision: number
      readonly title: string
    }
  ) => {
    updateTaskOptimistically({
      description: draft.description,
      expectedRevision: draft.expectedRevision,
      operationId: crypto.randomUUID(),
      send: (payload) => updateTask({ payload }),
      taskId,
      title: draft.title,
    }).catch((error: unknown) => {
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
      const latestTask = tasks.find((task) => task.id === taskId)
      setOpenedTask(latestTask ?? editingTask ?? null)
      toast.error(conflict ? 'Card changed elsewhere' : 'Could not save card', {
        description: message,
      })
    })
  }

  const recovering = editingTask && recovery?.taskId === editingTask.id

  return {
    openTaskEditor: setOpenedTask,
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
            setOpenedTask(null)
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
