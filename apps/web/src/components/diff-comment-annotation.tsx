/**
 * The inline review conversation the diff viewer paints under a line.
 *
 * `@pierre/diffs` renders one app-owned node per annotated (side, line) into
 * the light DOM, slotted into its shadow tree. Everything below is that node:
 * the conversations anchored there, and the composer when one is open.
 *
 * ## Telling a human note from an agent answer
 *
 * This is the whole point of the pane, so the distinction is carried three
 * ways rather than one: the author's name is written out, the reply carries an
 * icon, and the tint follows the app's existing colour language — blue is the
 * agent identity colour throughout mission control (see
 * `agent-status-presentation.ts`), and the human's own words take the primary
 * accent. Colour alone would not survive a monochrome display or a screen
 * reader; the name always does.
 *
 * ## Sharing the surface with the viewer's pointer gestures
 *
 * The annotation sits inside the diff body, which is also where a press-and-
 * drag becomes a line selection and where a click on the file header collapses
 * the file. Presses are stopped at the annotation's root so selecting the text
 * of a comment, or pressing one of its buttons, cannot be read as either.
 *
 * Ported from t3code's `DiffCommentAnnotation`, widened from a single draft
 * bubble to a persisted, replied-to, resolvable thread.
 */

import type {
  ReviewCommentReply,
  ReviewCommentThread,
} from '@laborer/shared/rpc'
import { Badge } from '@laborer/ui/components/badge'
import { Button } from '@laborer/ui/components/button'
import { Markdown } from '@laborer/ui/components/markdown'
import { Textarea } from '@laborer/ui/components/textarea'
import { cn } from '@laborer/ui/lib/utils'
import {
  Bot,
  CircleCheck,
  CircleDot,
  CornerDownRight,
  Trash2,
  User,
} from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from '@/components/pull-request/relative-time'
import { isCommentSubmitShortcut } from '@/lib/comment-submit-shortcut'
import type { DiffCommentAnnotationGroup } from '@/lib/diff-comment-threads'

/** Epoch milliseconds, as every review row stores them. */
const asIso = (epochMs: number) => new Date(epochMs).toISOString()

const AUTHOR_PRESENTATION = {
  agent: {
    icon: Bot,
    name: 'Agent',
    surface: 'border-blue-400/50 bg-blue-400/[0.07]',
    ink: 'text-blue-400',
  },
  human: {
    icon: User,
    name: 'You',
    surface: 'border-primary/55 bg-primary/[0.05]',
    ink: 'text-primary',
  },
} as const

/** Stop a press here from reaching the viewer's selection or header handlers. */
const swallowPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
  event.stopPropagation()
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface DiffCommentComposerProps {
  /** Spoken location of what is being commented on, e.g. `src/a.ts:12-18`. */
  readonly anchorLabel: string
  /** True while the write is in flight; blocks a double submit. */
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onChange: (body: string) => void
  readonly onSubmit: (body: string) => void
  readonly placeholder?: string
  readonly submitLabel?: string
  /** Owned by the caller, so a rejected write can put the words back. */
  readonly value: string
}

export function DiffCommentComposer({
  anchorLabel,
  busy,
  onCancel,
  onChange,
  onSubmit,
  placeholder = 'Leave a comment for the agent…',
  submitLabel = 'Comment',
  value,
}: DiffCommentComposerProps) {
  const trimmed = value.trim()

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 font-sans"
      data-testid="diff-comment-composer"
      onPointerDown={swallowPointerDown}
    >
      <Textarea
        aria-label={`Comment on ${anchorLabel}`}
        // The composer is opened by an explicit action on the line, so taking
        // focus is what the person asked for rather than a steal.
        autoFocus
        className="min-h-16 bg-background/60 text-xs leading-5"
        data-testid="diff-comment-composer-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (isCommentSubmitShortcut(event, value, busy)) {
            event.preventDefault()
            onSubmit(trimmed)
          }
        }}
        placeholder={placeholder}
        value={value}
      />
      <div className="flex items-center gap-1.5">
        <span className="me-auto text-[10px] text-muted-foreground/80">
          ⌘/Ctrl + Enter to send · Esc to cancel
        </span>
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          data-testid="diff-comment-composer-submit"
          disabled={busy || trimmed.length === 0}
          onClick={() => onSubmit(trimmed)}
          size="sm"
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function DiffCommentReply({
  now,
  reply,
}: {
  readonly now: number
  readonly reply: ReviewCommentReply
}) {
  const presentation = AUTHOR_PRESENTATION[reply.author]
  const iso = asIso(reply.createdAt)

  return (
    <li
      className={cn(
        'flex min-w-0 gap-2 border-s-2 px-3 py-2',
        presentation.surface
      )}
      data-review-comment-author={reply.author}
    >
      <presentation.icon
        aria-hidden="true"
        className={cn('mt-0.5 size-3.5 shrink-0', presentation.ink)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className={cn('font-medium text-[11px]', presentation.ink)}>
            {presentation.name}
          </span>
          <span
            className="text-[10px] text-muted-foreground"
            title={formatAbsoluteTime(iso)}
          >
            {formatRelativeTime(iso, now)}
          </span>
        </div>
        <Markdown className="min-w-0 text-[13px] leading-5">
          {reply.body}
        </Markdown>
      </div>
    </li>
  )
}

export interface DiffCommentThreadCardProps {
  /** Disables the thread's own writes while one of them is in flight. */
  readonly busy: boolean
  readonly now: number
  readonly onDelete: (thread: ReviewCommentThread) => void
  /** Omitted where there is nowhere to put a composer, as in the detached
   * list — the thread still reads and can still be resolved or deleted. */
  readonly onReply?: ((thread: ReviewCommentThread) => void) | undefined
  readonly onSetStatus: (
    thread: ReviewCommentThread,
    status: 'open' | 'resolved'
  ) => void
  /** The reply composer, when this thread is the one being replied to. */
  readonly replyComposer?: React.ReactNode
  readonly thread: ReviewCommentThread
}

export function DiffCommentThreadCard({
  busy,
  now,
  onDelete,
  onReply,
  onSetStatus,
  replyComposer,
  thread,
}: DiffCommentThreadCardProps) {
  const resolved = thread.status === 'resolved'
  const location = `${thread.filePath}:${
    thread.startLine === thread.endLine
      ? thread.startLine
      : `${thread.startLine}-${thread.endLine}`
  }`

  return (
    <article
      aria-label={`Review comment on ${location}${resolved ? ', resolved' : ''}`}
      className={cn(
        'flex min-w-0 flex-col font-sans text-foreground',
        // Resolved threads stay, quieted rather than removed: what was asked
        // is evidence, and it un-dims the moment the pointer or focus is on it.
        resolved &&
          'opacity-60 transition-opacity focus-within:opacity-100 hover:opacity-100'
      )}
      data-review-comment-status={thread.status}
      data-testid="diff-comment-thread"
    >
      <ol className="flex min-w-0 flex-col">
        {(resolved ? thread.replies.slice(0, 1) : thread.replies).map(
          (reply) => (
            <DiffCommentReply key={reply.id} now={now} reply={reply} />
          )
        )}
      </ol>

      {resolved && thread.replies.length > 1 && (
        <p className="border-transparent border-s-2 px-3 pb-1 text-[11px] text-muted-foreground">
          {thread.replies.length - 1} more{' '}
          {thread.replies.length === 2 ? 'reply' : 'replies'} — reopen to read
          the conversation.
        </p>
      )}

      {replyComposer}

      <div className="flex flex-wrap items-center gap-1 border-transparent border-s-2 px-3 pb-2">
        {resolved && (
          <Badge
            className="h-5 gap-1 border-success/30 bg-success/10 px-1.5 text-[10px] text-success"
            variant="outline"
          >
            <CircleCheck aria-hidden="true" className="size-3" />
            Resolved
          </Badge>
        )}
        <span className="me-auto font-mono text-[10px] text-muted-foreground">
          {location}
        </span>
        {onReply !== undefined && !(resolved || replyComposer) && (
          <Button
            aria-label={`Reply to the review comment on ${location}`}
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => onReply(thread)}
            size="sm"
            variant="ghost"
          >
            <CornerDownRight aria-hidden="true" className="size-3" />
            Reply
          </Button>
        )}
        <Button
          aria-label={
            resolved
              ? `Reopen the review comment on ${location}`
              : `Resolve the review comment on ${location}`
          }
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => onSetStatus(thread, resolved ? 'open' : 'resolved')}
          size="sm"
          variant="ghost"
        >
          {resolved ? (
            <CircleDot aria-hidden="true" className="size-3" />
          ) : (
            <CircleCheck aria-hidden="true" className="size-3" />
          )}
          {resolved ? 'Reopen' : 'Resolve'}
        </Button>
        <Button
          aria-label={`Delete the review comment on ${location}`}
          className="h-6 px-2 text-muted-foreground text-xs hover:text-destructive"
          disabled={busy}
          onClick={() => onDelete(thread)}
          size="sm"
          variant="ghost"
        >
          <Trash2 aria-hidden="true" className="size-3" />
          <span className="sr-only">Delete</span>
        </Button>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Group — what `renderAnnotation` returns for one line
// ---------------------------------------------------------------------------

export interface DiffCommentAnnotationProps
  extends Omit<DiffCommentThreadCardProps, 'replyComposer' | 'thread'> {
  /** The composer, when the open draft belongs to this line. */
  readonly composer?: React.ReactNode
  readonly group: DiffCommentAnnotationGroup
  /** Thread the reply composer belongs to, if the draft is a reply. */
  readonly replyingToThreadId?: string | undefined
}

export function DiffCommentAnnotation({
  busy,
  composer,
  group,
  now,
  onDelete,
  onReply,
  onSetStatus,
  replyingToThreadId,
}: DiffCommentAnnotationProps) {
  return (
    <div
      className="divide-y divide-border/40 border-border/40 border-y bg-muted/20"
      data-testid="diff-comment-annotation"
      onPointerDown={swallowPointerDown}
    >
      {group.threads.map((thread) => (
        <DiffCommentThreadCard
          busy={busy}
          key={thread.id}
          now={now}
          onDelete={onDelete}
          onReply={onReply}
          onSetStatus={onSetStatus}
          thread={thread}
          {...(replyingToThreadId === thread.id
            ? { replyComposer: composer }
            : {})}
        />
      ))}
      {replyingToThreadId === undefined && composer}
    </div>
  )
}
