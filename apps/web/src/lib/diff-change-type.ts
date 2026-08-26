/**
 * How a file's change type is presented in the diff pane's header.
 *
 * Ported from t3code's `getDiffCollapseIconClassName`, with t3's literal
 * `--diffs-*` colours replaced by this app's semantic tokens so the
 * chevron tracks the active theme like everything else in the pane.
 *
 * Colour is never the only signal: {@link diffChangeTypeLabel} feeds the
 * accessible name of the collapse control, so a screen reader hears the
 * change type the colour encodes.
 */

import type { FileDiffEntry } from '@laborer/shared/rpc'

/**
 * `file.diff` reports three statuses today. `renamed` is carried
 * because the viewer's own metadata already distinguishes renames
 * (`rename-pure` / `rename-changed`) and the RPC contract may grow one;
 * it is presented as a modification, which is what a rename is to the
 * reader of a diff.
 */
export type DiffChangeType = FileDiffEntry['status'] | 'renamed'

/** Tailwind text colour for the change type, in app tokens. */
export const diffChangeTypeIconClassName = (
  changeType: DiffChangeType
): string => {
  switch (changeType) {
    case 'added':
      return 'text-success'
    case 'deleted':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}

/** Human-readable change type, for accessible names. */
export const diffChangeTypeLabel = (changeType: DiffChangeType): string => {
  switch (changeType) {
    case 'added':
      return 'added file'
    case 'deleted':
      return 'deleted file'
    case 'renamed':
      return 'renamed file'
    default:
      return 'modified file'
  }
}
