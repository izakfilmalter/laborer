const INITIAL_WIDTH = 480
const INITIAL_HEIGHT = 320
const MIN_WIDTH = 240
const MIN_HEIGHT = 160

export const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002

export function fitPictureInPictureContentSize(
  current: readonly number[],
  aspectRatio: number
): readonly [width: number, height: number] {
  const currentWidth = Math.max(1, current[0] ?? INITIAL_WIDTH)
  const currentHeight = Math.max(1, current[1] ?? INITIAL_HEIGHT)
  const currentArea = currentWidth * currentHeight
  let width = Math.sqrt(currentArea * aspectRatio)
  let height = width / aspectRatio
  const minimumScale = Math.max(1, MIN_WIDTH / width, MIN_HEIGHT / height)
  width *= minimumScale
  height *= minimumScale
  return [Math.round(width), Math.round(height)]
}
