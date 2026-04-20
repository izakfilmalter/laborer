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

describe('parseFileDiff', () => {
  it('parses raw git patch text', async () => {
    const { parseFileDiff } = await import('@/lib/file-diff')

    const fileDiff = parseFileDiff({
      filePath: 'src/example.ts',
      result: {
        type: 'text',
        content: 'const value = 2\n',
        diff: [
          '--- src/example.ts\told',
          '+++ src/example.ts\tnew',
          '@@ -1,1 +1,1 @@',
          '-const value = 1',
          '+const value = 2',
          '',
        ].join('\n'),
      },
      status: 'modified',
    })

    expect(fileDiff?.name).toBe('src/example.ts')
    expect(fileDiff?.hunks).toHaveLength(1)
  })

  it('synthesizes a diff for added files without git patch text', async () => {
    const { parseFileDiff } = await import('@/lib/file-diff')

    const fileDiff = parseFileDiff({
      filePath: 'src/new-file.ts',
      result: {
        type: 'text',
        content: 'export const value = 1\n',
      },
      status: 'added',
    })

    expect(fileDiff).not.toBeNull()
    expect(fileDiff?.name).toBe('src/new-file.ts')
    expect(fileDiff?.hunks).toHaveLength(1)
    expect(fileDiff?.hunks[0]?.additionCount).toBeGreaterThan(0)
  })
})
