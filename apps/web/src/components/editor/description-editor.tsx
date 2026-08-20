/**
 * The rich-text surface a card's brief is written in.
 *
 * A brief is stored, and read by an agent, as markdown — so markdown is what
 * this component exchanges, not an editor document format. Rich text here is
 * only how the markdown is *shown* while it is being written: the person gets
 * headings, lists, and code fences they can see, and the agent still gets the
 * plain text it has always been handed.
 *
 * The consequence is that a round trip normalizes. `*` bullets come back as
 * `-`, loose spacing tightens. That is why {@link DescriptionEditorProps.onNormalize}
 * exists: the caller must compare edits against the normalized text, or every
 * card would look dirty the moment its dialog opened.
 */

'use client'

import { cn } from '@laborer/ui/lib/utils'
import { deserializeMd, serializeMd } from '@platejs/markdown'
import { Plate, type PlateEditor, usePlateEditor } from 'platejs/react'
import {
  type FocusEventHandler,
  type KeyboardEventHandler,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { Editor, EditorContainer } from '@/components/editor/nodes/editor'
import { DescriptionKit } from '@/components/editor/plugins/description-kit'

/** How much of a line's height still counts as "on the first line". */
const FIRST_LINE_TOLERANCE = 0.75
const FALLBACK_LINE_HEIGHT = 20

/**
 * Slate props empty text nodes open with zero-width characters so the caret has
 * somewhere to sit. They are an artefact of the editing surface, never part of
 * what someone wrote, and an empty brief serializes to nothing but them — which
 * a caller would otherwise store and hand to an agent as its prompt.
 */
const ZERO_WIDTH = /[\u200B\uFEFF]/g

/** The brief as markdown, with the editing surface's artefacts removed. */
function toMarkdown(editor: PlateEditor): string {
  const markdown = serializeMd(editor).replaceAll(ZERO_WIDTH, '')
  return markdown.trim().length === 0 ? '' : markdown
}

/**
 * Whether the caret sits on the first *visual* line — the point past which
 * ArrowUp has nowhere left to go inside the editor.
 *
 * Slate knows about blocks, not wrapped lines, so being in the first block is
 * not enough: a soft-wrapped opening paragraph has several lines that all live
 * at path `[0]`. Measuring the caret's rect against the editor's top is the
 * only way to tell the top line of that paragraph from the ones below it.
 */
function isCaretOnFirstLine(
  editor: PlateEditor,
  contentEditable: HTMLElement
): boolean {
  const focus = editor.selection?.focus
  if (!focus || focus.path[0] !== 0) {
    return false
  }

  const selection = contentEditable.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return false
  }

  const caretRect = selection.getRangeAt(0).getClientRects()[0]
  if (!caretRect) {
    // An empty first line has no rect, and is necessarily line one.
    return true
  }

  const editorRect = contentEditable.getBoundingClientRect()
  const lineHeight =
    caretRect.height ||
    Number.parseFloat(
      contentEditable.ownerDocument.defaultView?.getComputedStyle(
        contentEditable
      ).lineHeight ?? String(FALLBACK_LINE_HEIGHT)
    )

  return caretRect.top - editorRect.top <= lineHeight * FIRST_LINE_TOLERANCE
}

interface DescriptionEditorHandle {
  /** Focus with the caret at the very top of the brief. */
  readonly focusStart: () => void
}

interface DescriptionEditorProps {
  /** Accessible name for the editable region. */
  readonly ariaLabel?: string
  readonly autoFocus?: boolean
  readonly className?: string
  /**
   * Classes for the editable itself, inside the scroll box. Horizontal padding
   * belongs here so an inline affordance's focus ring is not clipped by the
   * container's edge.
   */
  readonly contentClassName?: string
  readonly disabled?: boolean
  /**
   * Receives the imperative handle. `focusStart` is what a field above uses to
   * hand the caret down, since a plain `.focus()` restores the *last* caret
   * position — wrong when entering from above.
   */
  readonly handleRef?: RefObject<DescriptionEditorHandle | null>
  readonly onBlur?: FocusEventHandler<HTMLDivElement>
  /** The brief as markdown, on every keystroke. */
  readonly onChange?: (markdown: string) => void
  /**
   * ArrowUp or ArrowLeft with nowhere left to go upward. A parent uses this to
   * pass focus to the field above, so title and brief read as one surface.
   */
  readonly onEscapeStart?: () => void
  readonly onFocus?: FocusEventHandler<HTMLDivElement>
  /**
   * The markdown as this editor would write it, reported once on mount.
   * Compare against this rather than against `value` to decide what changed.
   */
  readonly onNormalize?: (markdown: string) => void
  readonly placeholder?: string
  readonly readOnly?: boolean
  /** The brief as markdown. Read on mount only; the editor is uncontrolled. */
  readonly value: string
}

function DescriptionEditor({
  ariaLabel,
  autoFocus = false,
  className,
  contentClassName,
  disabled = false,
  handleRef,
  onBlur,
  onChange,
  onEscapeStart,
  onFocus,
  onNormalize,
  placeholder = 'Add a description…',
  readOnly = false,
  value,
}: DescriptionEditorProps) {
  const editor = usePlateEditor({
    plugins: DescriptionKit,
    readOnly,
    // Read once. Plate keeps its own document from here on, and re-reading
    // `value` would fight the caret on every keystroke.
    value: (created) => deserializeMd(created, value),
  })

  const reportedRef = useRef(false)

  // The stored markdown and this editor's markdown for the same document can
  // differ by formatting alone, so the caller needs ours to compare against.
  useEffect(() => {
    if (reportedRef.current) {
      return
    }
    reportedRef.current = true
    onNormalize?.(toMarkdown(editor))
  }, [editor, onNormalize])

  useImperativeHandle(
    handleRef,
    () => ({ focusStart: () => editor.tf.focus({ edge: 'startEditor' }) }),
    [editor]
  )

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.defaultPrevented || !onEscapeStart) {
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') {
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return
    }

    const { selection } = editor
    if (!(selection && editor.api.isCollapsed())) {
      return
    }

    // Only leave when there is genuinely nowhere left to go, so ordinary
    // navigation between the brief's own lines is never hijacked. ArrowLeft
    // escapes from the exact start; ArrowUp from anywhere on the first line,
    // which is how a title-plus-body surface is expected to behave.
    if (event.key === 'ArrowLeft') {
      if (!editor.api.isStart(selection.focus, [])) {
        return
      }
    } else if (!isCaretOnFirstLine(editor, event.currentTarget)) {
      return
    }

    event.preventDefault()
    onEscapeStart()
  }

  return (
    <Plate editor={editor} onChange={() => onChange?.(toMarkdown(editor))}>
      <EditorContainer className={cn('h-auto', className)} variant="none">
        <Editor
          aria-label={ariaLabel}
          // Slate's own autofocus, which waits until the node-to-DOM map is
          // built. Focusing from an effect runs before that and throws.
          autoFocus={autoFocus && !readOnly}
          className={contentClassName}
          disabled={disabled}
          onBlur={onBlur}
          onFocus={onFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          readOnly={readOnly}
        />
      </EditorContainer>
    </Plate>
  )
}

export { DescriptionEditor }
export type { DescriptionEditorHandle, DescriptionEditorProps }
