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

    const patch = parseFileDiffEntry({
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

    expect(patch.kind).toBe('parsed')
    if (patch.kind !== 'parsed') {
      return
    }
    expect(patch.fileDiff.name).toBe('src/example.ts')
    expect(patch.fileDiff.hunks).toHaveLength(1)
  })

  it('parses an untracked-file patch diffed against /dev/null', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    const patch = parseFileDiffEntry({
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

    expect(patch.kind).toBe('parsed')
    if (patch.kind !== 'parsed') {
      return
    }
    expect(patch.fileDiff.name).toBe('src/new-file.ts')
    expect(patch.fileDiff.hunks).toHaveLength(1)
    expect(patch.fileDiff.hunks[0]?.additionCount).toBeGreaterThan(0)
  })

  it('reports an absent patch, which the pane reads as truncated or binary', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    const patch = parseFileDiffEntry({
      path: 'logo.png',
      added: 0,
      removed: 0,
      status: 'modified',
      truncated: true,
    })

    expect(patch.kind).toBe('absent')
  })

  it('treats a blank patch as absent rather than as raw text', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    expect(
      parseFileDiffEntry({
        path: 'blank.ts',
        added: 0,
        removed: 0,
        status: 'modified',
        truncated: false,
        patch: '   \n',
      }).kind
    ).toBe('absent')
  })

  it('keeps a patch that arrived but produced no files as raw text', async () => {
    const { parseFileDiffEntry } = await import('@/lib/file-diff')

    // A patch the server did send: mislabelling this as truncated is the
    // regression the tagged result exists to prevent.
    const patch = parseFileDiffEntry({
      path: 'src/mystery.ts',
      added: 1,
      removed: 0,
      status: 'modified',
      truncated: false,
      patch: 'not a unified diff at all\njust some text\n',
    })

    expect(patch.kind).toBe('raw')
    if (patch.kind !== 'raw') {
      return
    }
    expect(patch.patch).toContain('not a unified diff at all')
    expect(patch.reason.length).toBeGreaterThan(0)
  })
})
