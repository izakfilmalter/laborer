import { beforeAll, describe, expect, it } from 'vitest'

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

describe('parseFileDiffEntry', () => {
  it('parses a modified file patch from a file.diff entry', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    const fileDiff = parseFileDiffEntry({
      path: 'src/example.ts',
      added: 1,
      removed: 1,
      status: 'modified',
      truncated: false,
      patch: [
        'diff --git a/src/example.ts b/src/example.ts',
        'index 1111111..2222222 100644',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1,1 +1,1 @@',
        '-const value = 1',
        '+const value = 2',
        '',
      ].join('\n'),
    })

    expect(fileDiff?.name).toBe('src/example.ts')
    expect(fileDiff?.hunks).toHaveLength(1)
  })

  it('parses an untracked-file patch diffed against /dev/null', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    const fileDiff = parseFileDiffEntry({
      path: 'src/new-file.ts',
      added: 1,
      removed: 0,
      status: 'added',
      truncated: false,
      patch: [
        'diff --git a/src/new-file.ts b/src/new-file.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/src/new-file.ts',
        '@@ -0,0 +1,1 @@',
        '+export const value = 1',
        '',
      ].join('\n'),
    })

    expect(fileDiff).not.toBeNull()
    expect(fileDiff?.name).toBe('src/new-file.ts')
    expect(fileDiff?.hunks).toHaveLength(1)
    expect(fileDiff?.hunks[0]?.additionCount).toBeGreaterThan(0)
  })

  it('returns null for entries without a patch (binary or truncated)', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    const fileDiff = parseFileDiffEntry({
      path: 'logo.png',
      added: 0,
      removed: 0,
      status: 'modified',
      truncated: true,
    })

    expect(fileDiff).toBeNull()
  })
})
