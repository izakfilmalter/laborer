/**
 * The single styled adapter around Pierre's `CodeView`.
 *
 * `CodeView` owns the scroll container, virtualization, sticky headers,
 * and line selection for a whole list of files, so app styling and the
 * geometry it is measured against have to stay paired in one place —
 * a header styled to a different height than `itemMetrics` claims
 * leaves the scroll range out of step with what is painted.
 *
 * Ported from t3code's `StyledDiffCodeView`.
 */

import type {
  CodeViewHandle,
  CodeViewProps,
  ControlledCodeViewProps,
  UncontrolledCodeViewProps,
} from '@pierre/diffs/react'
import { CodeView } from '@pierre/diffs/react'
import type { Ref } from 'react'
import {
  DIFF_VIEW_ITEM_METRICS,
  DIFF_VIEW_LAYOUT,
  DIFF_VIEW_UNSAFE_CSS,
} from '@/lib/diff-rendering'

export type StyledDiffCodeViewOptions<LAnnotation> = Omit<
  NonNullable<CodeViewProps<LAnnotation>['options']>,
  'unsafeCSS' | 'itemMetrics' | 'layout'
>

type StyledDiffCodeViewProps<LAnnotation> = (
  | Omit<ControlledCodeViewProps<LAnnotation>, 'options'>
  | Omit<UncontrolledCodeViewProps<LAnnotation>, 'options'>
) & {
  readonly options?: StyledDiffCodeViewOptions<LAnnotation>
  readonly viewerRef?: Ref<CodeViewHandle<LAnnotation>>
  /**
   * Extra rules appended to the shared stylesheet, for a surface that has
   * to restyle chrome inside the viewer's shadow root (the pull request
   * panel hides the per-file counts it replaces with host-reported ones).
   */
  readonly unsafeCSSExtra?: string
}

export function StyledDiffCodeView<LAnnotation = undefined>({
  className,
  options,
  viewerRef,
  unsafeCSSExtra,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  return (
    <CodeView<LAnnotation>
      {...props}
      {...(viewerRef ? { ref: viewerRef } : {})}
      // The custom element is focusable for keyboard scrolling; its native
      // outline sits outside the pane's clipping boundary, and the controls
      // inside keep their own focus indicators.
      className={
        className
          ? `diff-render-surface outline-none ${className}`
          : 'diff-render-surface outline-none'
      }
      options={{
        ...options,
        unsafeCSS: unsafeCSSExtra
          ? `${DIFF_VIEW_UNSAFE_CSS}\n${unsafeCSSExtra}`
          : DIFF_VIEW_UNSAFE_CSS,
        itemMetrics: DIFF_VIEW_ITEM_METRICS,
        layout: DIFF_VIEW_LAYOUT,
      }}
    />
  )
}
