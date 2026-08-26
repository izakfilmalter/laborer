/**
 * Resolving a click inside the diff viewer's file header.
 *
 * The viewer paints its headers into a shadow root and pools the element
 * for each file, so there is no per-file wrapper in app DOM to hang a
 * handler on. The pane instead catches clicks on the way down and reads
 * `event.composedPath()`, which crosses the shadow boundary and is
 * ordered innermost-first — the same resolution t3code's diff panel does.
 *
 * The markup this walks is the viewer's (`createFileHeaderElement`):
 * a `[data-diffs-header]` row containing a `[data-title]` filename and
 * whatever the app contributes through the prefix/metadata slots.
 */

/** What a click in the viewer's chrome asked for. */
export type DiffHeaderClickTarget =
  /** The filename: open the file in the editor. */
  | { readonly kind: 'open'; readonly path: string }
  /** Anywhere else on the header row: collapse or expand the file. */
  | { readonly kind: 'toggle'; readonly path: string }
  /** A control with its own action, or a click outside any header. */
  | { readonly kind: 'ignore' }

const IGNORE: DiffHeaderClickTarget = { kind: 'ignore' }

const readPath = (node: Element | null | undefined): string | undefined => {
  const text = node?.textContent?.trim()
  return text ? text : undefined
}

/**
 * Reduce a composed event path to the action it stands for.
 *
 * The walk is innermost-first, so precedence falls out of the DOM: a
 * button or link inside the header is reached before the header and
 * keeps its own action; the filename is reached before the header row
 * that contains it and keeps opening the file; everything else on the
 * row toggles that file. Clicks in the diff body never reach a header
 * and are ignored, which leaves text selection there untouched.
 */
export const resolveDiffHeaderClick = (
  composedPath: readonly EventTarget[]
): DiffHeaderClickTarget => {
  for (const node of composedPath) {
    if (!(node instanceof HTMLElement)) {
      continue
    }
    if (
      node instanceof HTMLButtonElement ||
      node instanceof HTMLAnchorElement
    ) {
      return IGNORE
    }
    if (node.hasAttribute('data-title')) {
      const path = readPath(node)
      return path ? { kind: 'open', path } : IGNORE
    }
    if (node.hasAttribute('data-diffs-header')) {
      const path = readPath(node.querySelector('[data-title]'))
      return path ? { kind: 'toggle', path } : IGNORE
    }
  }
  return IGNORE
}
