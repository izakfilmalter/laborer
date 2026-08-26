import type { FileDiffMetadata } from '@pierre/diffs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CommentableDiffFile } from '@/lib/diff-comment-line-target'
import {
  describeCommentableLines,
  resolveDiffCommentLineTarget,
} from '@/lib/diff-comment-line-target'

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

/**
 * A two-hunk diff parsed by the pane's own parser: additions on 3-5 and on
 * 20-21, deletions on 4 and on 20.
 */
const parse = async (path: string): Promise<FileDiffMetadata> => {
  const { parseFileDiffEntry } = await import('@/lib/file-diff')
  const patch = parseFileDiffEntry({
    added: 4,
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
      '@@ -19,2 +20,2 @@',
      '-const old = 4',
      '+const next = 4',
      ' const last = 5',
      '',
    ].join('\n'),
    removed: 2,
    status: 'modified',
    truncated: false,
  })
  if (patch.kind !== 'parsed') {
    throw new Error('fixture patch did not parse')
  }
  return patch.fileDiff
}

const files = async (): Promise<readonly CommentableDiffFile[]> => [
  { fileDiff: await parse('src/example.ts'), path: 'src/example.ts' },
]

describe('describeCommentableLines', () => {
  it('lists the line numbers a side actually shows', async () => {
    // This is the hint that stands in for the gutter: a diff numbers lines
    // against the file, not the hunk, so without it a keyboard user guesses.
    const fileDiff = await parse('src/example.ts')
    expect(describeCommentableLines(fileDiff, 'additions')).toBe('3–5, 20–21')
  })

  it('numbers the other side against the original file', async () => {
    const fileDiff = await parse('src/example.ts')
    expect(describeCommentableLines(fileDiff, 'deletions')).toBe('3–4, 19–20')
  })
})

describe('resolveDiffCommentLineTarget', () => {
  it('produces the same anchor shape a drag would have', async () => {
    expect(
      resolveDiffCommentLineTarget(await files(), {
        filePath: 'src/example.ts',
        line: '4',
        side: 'additions',
      })
    ).toEqual({
      anchor: {
        endLine: 4,
        filePath: 'src/example.ts',
        label: 'src/example.ts:4',
        side: 'additions',
        startLine: 4,
      },
      ok: true,
    })
  })

  it('marks a deletion-side anchor so the number is not ambiguous', async () => {
    const target = resolveDiffCommentLineTarget(await files(), {
      filePath: 'src/example.ts',
      line: '19',
      side: 'deletions',
    })
    expect(target).toMatchObject({
      anchor: { label: 'src/example.ts:19 (original)', side: 'deletions' },
      ok: true,
    })
  })

  it('tolerates surrounding whitespace in the typed line', async () => {
    expect(
      resolveDiffCommentLineTarget(await files(), {
        filePath: 'src/example.ts',
        line: '  4  ',
        side: 'additions',
      })
    ).toMatchObject({ ok: true })
  })

  it('refuses a file the viewer never parsed', async () => {
    expect(
      resolveDiffCommentLineTarget(await files(), {
        filePath: 'not/here.ts',
        line: '4',
        side: 'additions',
      })
    ).toEqual({ ok: false, reason: 'Pick a file with a rendered diff.' })
  })

  it('refuses anything that is not a whole positive line number', async () => {
    const rendered = await files()
    for (const line of ['', '   ', '0', '-3', '4.5', '4abc', 'four', '1e3']) {
      expect(
        resolveDiffCommentLineTarget(rendered, {
          filePath: 'src/example.ts',
          line,
          side: 'additions',
        })
      ).toEqual({ ok: false, reason: 'Enter a line number.' })
    }
  })

  it('names the lines that would have worked when the line is not shown', async () => {
    // There is no gutter highlight to correct a wrong guess with, so the
    // refusal has to carry the answer.
    expect(
      resolveDiffCommentLineTarget(await files(), {
        filePath: 'src/example.ts',
        line: '900',
        side: 'additions',
      })
    ).toEqual({
      ok: false,
      reason: 'Line 900 is not shown in this diff. Try 3–5, 20–21.',
    })
  })

  it('says plainly when a side has nothing to comment on', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')
    const patch = parseFileDiffEntry({
      added: 1,
      path: 'src/new.ts',
      patch: [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,1 @@',
        '+export const value = 1',
        '',
      ].join('\n'),
      removed: 0,
      status: 'added',
      truncated: false,
    })
    if (patch.kind !== 'parsed') {
      throw new Error('fixture patch did not parse')
    }

    expect(
      resolveDiffCommentLineTarget(
        [{ fileDiff: patch.fileDiff, path: 'src/new.ts' }],
        { filePath: 'src/new.ts', line: '1', side: 'deletions' }
      )
    ).toEqual({
      ok: false,
      reason: 'This file has no removed lines to comment on.',
    })
  })
})
