/**
 * The keyboard route in, driven only from the keyboard.
 *
 * If any step of this needs a pointer, the route does not exist — the gutter
 * it replaces already works with one.
 */

import type { FileDiffMetadata } from '@pierre/diffs'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DiffCommentLinePicker } from '@/components/diff-comment-line-picker'
import type { CommentableDiffFile } from '@/lib/diff-comment-line-target'

beforeAll(() => {
  if (typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    return
  }
  Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
    configurable: true,
    value() {
      return undefined
    },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const parse = async (path: string): Promise<FileDiffMetadata> => {
  const { parseFileDiffEntry } = await import('@/lib/file-diff')
  const patch = parseFileDiffEntry({
    added: 2,
    path,
    patch: [
      `diff --git a/${path} b/${path}`,
      'index 1111111..2222222 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -3,2 +3,3 @@',
      ' const first = 1',
      '-const second = 2',
      '+const second = 22',
      '+const third = 3',
      '',
    ].join('\n'),
    removed: 1,
    status: 'modified',
    truncated: false,
  })
  if (patch.kind !== 'parsed') {
    throw new Error('fixture patch did not parse')
  }
  return patch.fileDiff
}

const renderPicker = async () => {
  const files: readonly CommentableDiffFile[] = [
    { fileDiff: await parse('src/first.ts'), path: 'src/first.ts' },
    { fileDiff: await parse('src/second.ts'), path: 'src/second.ts' },
  ]
  const onStartComment = vi.fn()
  render(
    <DiffCommentLinePicker files={files} onStartComment={onStartComment} />
  )
  return { onStartComment, user: userEvent.setup() }
}

describe('diff comment line picker', () => {
  it('opens, resolves an anchor, and closes without a pointer', async () => {
    const { onStartComment, user } = await renderPicker()

    await user.tab()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Comment on a line' })
    )
    await user.keyboard('{Enter}')

    await user.type(screen.getByLabelText('Line'), '4')
    await user.keyboard('{Enter}')

    expect(onStartComment).toHaveBeenCalledWith({
      endLine: 4,
      filePath: 'src/first.ts',
      label: 'src/first.ts:4',
      side: 'additions',
      startLine: 4,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('defaults to the first file, which is the one being read', async () => {
    const { user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    expect((screen.getByLabelText('File') as HTMLSelectElement).value).toBe(
      'src/first.ts'
    )
  })

  it('anchors against the chosen file and side', async () => {
    const { onStartComment, user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    await user.selectOptions(screen.getByLabelText('File'), 'src/second.ts')
    await user.selectOptions(
      screen.getByLabelText('Numbered against'),
      'deletions'
    )
    await user.type(screen.getByLabelText('Line'), '3')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(onStartComment).toHaveBeenCalledWith({
      endLine: 3,
      filePath: 'src/second.ts',
      label: 'src/second.ts:3 (original)',
      side: 'deletions',
      startLine: 3,
    })
  })

  it('shows which lines are commentable, since there is no gutter to look at', async () => {
    const { user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    expect(screen.getByText('Changed lines: 3–5')).toBeTruthy()

    await user.selectOptions(
      screen.getByLabelText('Numbered against'),
      'deletions'
    )
    expect(screen.getByText('Changed lines: 3–4')).toBeTruthy()
  })

  it('reports a line the diff does not show, and stays open to fix it', async () => {
    const { onStartComment, user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    await user.type(screen.getByLabelText('Line'), '900')
    await user.keyboard('{Enter}')

    expect(onStartComment).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(
      'Line 900 is not shown in this diff'
    )
    expect(screen.getByLabelText('Line')).toBeTruthy()
  })

  it('clears the refusal as soon as the number is edited', async () => {
    const { user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    await user.type(screen.getByLabelText('Line'), '900')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('alert')).toBeTruthy()

    await user.type(screen.getByLabelText('Line'), '{Backspace}')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('forgets an abandoned attempt rather than reopening onto it', async () => {
    const { user } = await renderPicker()

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    await user.type(screen.getByLabelText('Line'), '900')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Comment on a line' }))
    expect((screen.getByLabelText('Line') as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
