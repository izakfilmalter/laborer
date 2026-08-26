import { describe, expect, it } from 'vitest'
import { isCommentSubmitShortcut } from '@/lib/comment-submit-shortcut'

const press = (overrides: {
  readonly ctrlKey?: boolean
  readonly key?: string
  readonly metaKey?: boolean
}) => ({
  ctrlKey: overrides.ctrlKey ?? false,
  key: overrides.key ?? 'Enter',
  metaKey: overrides.metaKey ?? false,
})

describe('isCommentSubmitShortcut', () => {
  it('sends on Command+Enter and on Ctrl+Enter', () => {
    expect(
      isCommentSubmitShortcut(press({ metaKey: true }), 'ship it', false)
    ).toBe(true)
    expect(
      isCommentSubmitShortcut(press({ ctrlKey: true }), 'ship it', false)
    ).toBe(true)
  })

  it('leaves plain Enter as a newline, because a comment is prose', () => {
    expect(isCommentSubmitShortcut(press({}), 'ship it', false)).toBe(false)
  })

  it('ignores the modifier on any other key', () => {
    expect(
      isCommentSubmitShortcut(press({ key: 'a', metaKey: true }), 'x', false)
    ).toBe(false)
  })

  it('refuses a body that is empty or only whitespace', () => {
    expect(isCommentSubmitShortcut(press({ metaKey: true }), '', false)).toBe(
      false
    )
    expect(
      isCommentSubmitShortcut(press({ metaKey: true }), '  \n\t ', false)
    ).toBe(false)
  })

  it('refuses while a write is already in flight, like the button', () => {
    // The guard and the disabled button read the same two conditions, so the
    // shortcut can never submit something the button would have refused.
    expect(
      isCommentSubmitShortcut(press({ metaKey: true }), 'ship it', true)
    ).toBe(false)
  })
})
