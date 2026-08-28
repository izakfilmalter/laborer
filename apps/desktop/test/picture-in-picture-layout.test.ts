import { describe, expect, it } from 'vitest'
import { fitPictureInPictureContentSize } from '../src/preview/picture-in-picture-layout.js'

describe('fitPictureInPictureContentSize', () => {
  it('preserves content area while changing orientation', () => {
    expect(fitPictureInPictureContentSize([480, 320], 16 / 9)).toEqual([
      523, 294,
    ])
    expect(fitPictureInPictureContentSize([480, 320], 9 / 16)).toEqual([
      294, 523,
    ])
  })

  it('does not collapse toward minimum size across repeated changes', () => {
    const portrait = fitPictureInPictureContentSize([523, 294], 9 / 16)
    expect(fitPictureInPictureContentSize(portrait, 16 / 9)).toEqual([523, 294])
  })
})
