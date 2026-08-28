/**
 * Styling bridge between `@pierre/diffs` and the app's design tokens.
 *
 * The viewer renders into a shadow root, so app CSS cannot reach its
 * internals. Everything below is injected through the viewer's
 * `unsafeCSS` option, which is the only supported way to restyle the
 * chrome it owns (file headers, hunk separators, gutter, row tints).
 *
 * Ported from t3code's `DIFF_SURFACE_THEME_UNSAFE_CSS` /
 * `StyledDiffCodeView`, with `light-dark()` replaced by mix-strength
 * custom properties because this app selects its theme with a `.dark`
 * class rather than `color-scheme`. The per-theme values live in
 * `apps/web/src/index.css`; custom properties inherit through the
 * shadow boundary, so the viewer picks them up.
 */

/**
 * Maps every diff surface the renderer paints onto the app's code
 * tokens, so the themed palette reaches the code body, gutter, and row
 * tints instead of the renderer's bundled colors.
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the
     diff body sits on — mixing from the canvas leaves the gutter looking
     unthemed when a palette separates the two. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--code-background) 95%, var(--code-foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--code-background) var(--diff-change-mix), var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--code-background) var(--diff-change-number-mix), var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--code-background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--code-background) var(--diff-change-mix), var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--code-background) var(--diff-change-number-mix), var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--code-background) 80%, var(--destructive));

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}
`

/**
 * The full stylesheet handed to every `FileDiff` in the diff pane:
 * the token bridge above plus the chrome treatment — compact sticky
 * file headers, hairline hunk separators, and selected-line tints.
 */
export const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: color-mix(
    in lab,
    var(--code-background) var(--diff-selected-mix),
    color-mix(in srgb, var(--code-background) var(--diff-selected-tint-mix), var(--diffs-modified-base))
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: color-mix(
    in lab,
    var(--code-background) var(--diff-selected-gutter-mix),
    color-mix(in srgb, var(--code-background) var(--diff-selected-gutter-tint-mix), var(--diffs-modified-base))
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  /* The row collapses the file, so it reads as a target; the chevron is
     the keyboard equivalent. See the click-capture handler in the pane. */
  cursor: pointer;
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
  padding-inline: 8px 12px !important;
}

[data-diffs-header]:hover {
  /* A native scrollbar gutter cannot be painted by descendants. Use an inset
     edge cue instead of a full-width band that would look accidentally
     clipped at the gutter. */
  background-color: var(--code-background) !important;
  box-shadow: inset 3px 0 color-mix(in srgb, var(--code-foreground) 24%, transparent);
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

/* The viewer paints the counts removed-first; the pane's toolbar total and
   its placeholders print added-first, the way git diff --shortstat and every
   host that shows a "+24 -1" pair do. [data-metadata] is a flex row, so the
   order is a presentation detail this can reverse without touching the
   viewer's markup. The metadata slot (the app's Open button) stays last. */
[data-diffs-header] [data-additions-count] {
  order: 1;
}

[data-diffs-header] [data-deletions-count] {
  order: 2;
}

[data-diffs-header] [data-metadata] > slot {
  order: 3;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

/* The filename is itself the "open this file" target — see the click-capture
   handler in the diff pane. The keyboard equivalent is the header's Open
   button, since this node is painted by the viewer and is not focusable. */
[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--code-foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--code-background) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: transparent !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--code-foreground) 52%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines] {
  display: flex !important;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  [data-unmodified-lines] {
  cursor: pointer;
}

/* What the hunk-context loader is doing, painted where the reader pressed.
   The pane writes --diff-expansion-note onto the file's host node and custom
   properties inherit through the shadow boundary, so this is the one way to
   put app state inside a row the library owns.

   It hangs off the separator's wrapper, which spans the whole row, so the
   note is never squeezed into the text column beside the line count. The
   [data-content] ancestor is what keeps it to one copy: the library repeats
   each separator in every column it paints, and the gutter copies are ~50px
   wide, where an unscoped note showed the first few letters of itself down
   the left of each side of the diff.

   Out of flow, so an empty note costs nothing and a present one costs
   nothing either: the separator has to stay exactly the 24px
   DIFF_VIEW_ITEM_METRICS claims for it, or every expanded file's virtual
   height drifts from what is painted and the end of the list stops being
   reachable. A CSS string is not reliably announced, so the whole sentence
   behind this marker also goes to a live region in the pane. */
[data-content]
  :is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-wrapper]::after {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 12px;
  display: flex;
  align-items: center;
  max-width: 50%;
  overflow: hidden;
  content: var(--diff-expansion-note, "");
  background-color: var(--code-background);
  color: color-mix(in srgb, var(--code-foreground) 68%, var(--code-background));
  font-family: var(--font-sans) !important;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::after {
  width: auto;
  height: 1px;
  flex: 1 1 auto;
  content: "";
  background-color: color-mix(in srgb, var(--code-background) 92%, var(--code-foreground));
}

/* The expand control is visible now that it does something: it is the only
   affordance for the unchanged lines a patch leaves out, and a control the
   reader cannot see is a feature nobody finds. It sits in the library's own
   32px separator column, matching the gutter beside it. The pane gives each
   one a tab stop and a name in onPostRender, because the library paints it
   as a div with neither. */
:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-expand-button] {
  min-width: 32px !important;
  align-self: stretch;
  border-right: 0 !important;
  color: color-mix(in srgb, var(--code-foreground) 52%, var(--code-background)) !important;
  background-color: transparent !important;
  cursor: pointer;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-expand-button]:hover {
  background-color: color-mix(in srgb, var(--code-background) 88%, var(--code-foreground)) !important;
  color: var(--code-foreground) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-expand-button]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  color: var(--code-foreground) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-expand-button] [data-icon] {
  width: 12px;
  height: 12px;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has([data-expand-button])
  [data-separator-content] {
  cursor: pointer;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has([data-expand-button]):is(:hover, :focus-within)
  [data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 76%, var(--code-background)) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has([data-expand-button]):is(:hover, :focus-within)
  [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"]):has([data-expand-button]):is(:hover, :focus-within)
  [data-unmodified-lines]::after {
  background-color: color-mix(in srgb, var(--code-background) 84%, var(--code-foreground));
}

/*
 * Each file's code grid is its own horizontal scroller when word wrap is off.
 * Match ScrollBar's thumb here too, so the viewer has one scrollbar language
 * throughout rather than the app's outside and the browser's default inside.
 *
 * The library keeps \`scrollbar-gutter: stable\` on this element and measures
 * the gutter from a probe that also carries \`data-code\`, so whatever width
 * \`scrollbar-width: thin\` resolves to is the width it measures — reserved
 * space and painted bar stay in step, and fading the thumb out to transparent
 * costs no layout shift.
 */
[data-code] {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

[data-code]:hover {
  scrollbar-color: color-mix(in srgb, transparent 80%, var(--code-foreground))
    transparent;
}
`

/**
 * Geometry the virtualizer measures items against. These have to agree
 * with the chrome sizes the stylesheet above paints, or every item's
 * virtual height drifts from its rendered height and the end of the
 * list sits past the reachable scroll range.
 */
export const DIFF_VIEW_ITEM_METRICS = {
  diffHeaderHeight: 32,
  hunkSeparatorHeight: 24,
  spacing: 0,
  paddingTop: 0,
  /*
   * Unlike the gap above, the 8px under a file's last line is painted
   * unconditionally by the library's own stylesheet, so the metric has
   * to count it.
   */
  paddingBottom: 8,
} as const

export const DIFF_VIEW_LAYOUT = {
  paddingTop: 0,
  paddingBottom: 0,
  gap: 0,
} as const
