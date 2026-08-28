/** Ported from t3code's `fileLineReveal.ts`. */

interface LineGeometry {
  readonly height: number
  readonly top: number
}

interface CenteredFileLineScrollInput {
  readonly estimatedLine: LineGeometry
  readonly fileTop: number
  readonly renderedLine?: LineGeometry
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly viewportTop: number
}

export function resolveCenteredFileLineScrollTop(
  input: CenteredFileLineScrollInput
): number {
  const lineTop =
    input.renderedLine === undefined
      ? input.fileTop + input.estimatedLine.top
      : input.scrollTop + input.renderedLine.top - input.viewportTop
  const lineHeight = input.renderedLine?.height ?? input.estimatedLine.height
  const centeredTop = Math.max(
    0,
    lineTop - Math.max(0, (input.viewportHeight - lineHeight) / 2)
  )
  return Math.min(
    centeredTop,
    Math.max(0, input.scrollHeight - input.viewportHeight)
  )
}
