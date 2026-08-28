/**
 * The box a body is rewritten in — a description, or the pull request's
 * title's sibling. Ported from t3code's `PullRequestMarkdownEditor.tsx`.
 *
 * It owns the draft and nothing else: the caller sends the request and
 * says whether it is still in flight. Preview renders through the same
 * component the saved body will be read through.
 */
import { Button } from '@laborer/ui/components/button'
import { Textarea } from '@laborer/ui/components/textarea'
import { cn } from '@laborer/ui/lib/utils'
import { useState } from 'react'
import { PullRequestMarkdown } from './markdown'

export function PullRequestMarkdownEditor({
  value,
  baseHref,
  placeholder,
  label,
  saving,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string
  readonly baseHref?: string | null | undefined
  readonly placeholder?: string | undefined
  readonly label: string
  readonly saving: boolean
  /** A description may be cleared; a remark may not be emptied. */
  readonly allowEmpty?: boolean
  readonly className?: string | undefined
  readonly onSave: (next: string) => void
  readonly onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [preview, setPreview] = useState(false)
  // The words this draft started from: different words mean a different
  // subject, and the draft starts again from them.
  const [seed, setSeed] = useState(value)
  if (seed !== value) {
    setSeed(value)
    setDraft(value)
  }
  const empty = draft.trim().length === 0

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is a convenience that mirrors the Cancel button below; the inputs inside carry the focus.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same — the wrapper only listens for Escape bubbling from its own controls.
    <div
      className={cn('space-y-2', className)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || saving) {
          return
        }
        event.preventDefault()
        onCancel()
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          disabled={saving}
          onClick={() => setPreview(false)}
          size="xs"
          variant={preview ? 'ghost' : 'outline'}
        >
          Write
        </Button>
        <Button
          disabled={saving}
          onClick={() => setPreview(true)}
          size="xs"
          variant={preview ? 'outline' : 'ghost'}
        >
          Preview
        </Button>
      </div>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-muted-foreground text-xs">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown baseHref={baseHref} text={draft} />
          )}
        </div>
      ) : (
        <Textarea
          aria-label={label}
          autoFocus
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          rows={6}
          value={draft}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={saving} onClick={onCancel} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={saving || (empty && !allowEmpty)}
          onClick={() => onSave(draft)}
          size="xs"
          variant="outline"
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
