/** Ported from t3code's `filePreviewMode.ts`. */

const MARKDOWN_EXTENSION_REGEX = /\.(?:md|mdx)$/i
const TASK_MARKER_STATE_REGEX = /[ xX]/

export const isMarkdownPreviewFile = (path: string): boolean =>
  MARKDOWN_EXTENSION_REGEX.test(path)

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== '[' ||
    !TASK_MARKER_STATE_REGEX.test(markdown[markerOffset + 1] ?? '') ||
    markdown[markerOffset + 2] !== ']'
  ) {
    return markdown
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? 'x' : ' '}${markdown.slice(markerOffset + 2)}`
}
