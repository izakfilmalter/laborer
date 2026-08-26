/**
 * The "comment on these lines" affordance the diff viewer parks in its
 * gutter.
 *
 * `@pierre/diffs` owns where this button appears: with
 * `enableGutterUtility` on, its interaction manager moves a slot to the
 * hovered line — or, once lines are selected, pins it to the last line of
 * the selection. The app supplies what goes in the slot through
 * `renderGutterUtility`, which React portals into the light DOM under a
 * `slot="gutter-utility-slot"` wrapper. So this is an ordinary app-owned
 * button that happens to be painted inside the viewer's shadow tree,
 * stacked over the line number it covers.
 *
 * ## Sharing the gutter with the drag that selects lines
 *
 * The button sits inside the line-number column, which is also the strip
 * the viewer turns a press-and-drag on into a line selection. Left alone
 * the two gestures ruin each other: the viewer reads a press on this
 * button as the start of a new one-line selection and wipes the very
 * range the button is offering to comment on.
 *
 * So the press is stopped here, in a native `pointerdown` listener on the
 * button. That listener runs in the target phase — before the viewer's
 * listener on the shadow-root `<pre>` — and `stopPropagation()` there
 * keeps the selection intact. A React `onPointerDown` prop cannot do it:
 * React attaches its handlers at the app root, outside the shadow tree,
 * so a synthetic handler runs *after* the viewer's.
 *
 * The trade is that a drag cannot start on the button itself. The button
 * therefore overhangs the number column to the right — the same offset
 * the library's own utility button uses — leaving the numbers themselves
 * free to drag from.
 *
 * The installed library refuses `renderGutterUtility` and
 * `onGutterUtilityClick` together (`resolveEnableGutterUtilityOption`
 * throws), so the library's own "the utility was pressed" path, which
 * would have turned this press into a gutter-drag, is not available
 * alongside a custom node.
 *
 * `onClick` still handles keyboard activation, which never produces a
 * `pointerdown` at all.
 */

import type { SelectedLineRange } from '@pierre/diffs'
import { MessageSquarePlus } from 'lucide-react'
import { useCallback, useRef } from 'react'

interface DiffCommentGutterButtonProps {
  /** Spoken name for the action, phrased for what the gutter points at. */
  readonly label: string
  /** Open a comment on a range. */
  readonly onStartComment: (range: SelectedLineRange) => void
  /** The range the gutter is pointing at right now, if any. */
  readonly resolveRange: () => SelectedLineRange | null
}

export function DiffCommentGutterButton({
  label,
  onStartComment,
  resolveRange,
}: DiffCommentGutterButtonProps) {
  // The native listener below is attached once, so it reads the current
  // callbacks through refs rather than being torn down every render.
  const resolveRangeRef = useRef(resolveRange)
  resolveRangeRef.current = resolveRange
  const startCommentRef = useRef(onStartComment)
  startCommentRef.current = onStartComment

  const startFromCurrentRange = useCallback(() => {
    const range = resolveRangeRef.current()
    if (range) {
      startCommentRef.current(range)
    }
  }, [])

  const attachPointerDown = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) {
        return
      }
      const handlePointerDown = (event: PointerEvent) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
          return
        }
        // Both matter: `preventDefault` keeps the press from starting a
        // text selection, `stopPropagation` keeps the viewer from
        // reading it as the start of a line selection.
        event.preventDefault()
        event.stopPropagation()
        startFromCurrentRange()
      }
      node.addEventListener('pointerdown', handlePointerDown)
      return () => node.removeEventListener('pointerdown', handlePointerDown)
    },
    [startFromCurrentRange]
  )

  return (
    <button
      aria-label={label}
      // `relative z-10` is load-bearing: the viewer slots this into the
      // line-number cell *behind* the number itself, so without a
      // stacking position the number swallows every press. `-me-3` is
      // the overhang that keeps the numbers draggable.
      className="relative z-10 -me-3 flex size-5 items-center justify-center rounded bg-primary text-primary-foreground shadow-sm ring-1 ring-background transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
      data-testid="diff-comment-gutter-button"
      onClick={(event) => {
        // `detail === 0` is a keyboard activation. A pointer press was
        // already handled on `pointerdown`, and browsers still deliver
        // its `click` afterwards.
        if (event.detail === 0) {
          startFromCurrentRange()
        }
      }}
      ref={attachPointerDown}
      title={label}
      type="button"
    >
      <MessageSquarePlus className="size-3.5" />
    </button>
  )
}
