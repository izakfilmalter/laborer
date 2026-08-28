/**
 * Pure logic behind the Files surface, ported from t3code's tests for
 * `filePath`, `filePreviewMode`, `fileLineReveal`, and
 * `fileContentRevision` (renamed to Laborer's workspace-keyed helpers).
 */
import { describe, expect, it } from 'vitest'
import {
  fileCacheKey,
  fileContentRevision,
  fileEditorCacheKey,
} from '@/components/files/file-content-revision'
import { resolveCenteredFileLineScrollTop } from '@/components/files/file-line-reveal'
import { fileBreadcrumbs } from '@/components/files/file-path'
import {
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
} from '@/components/files/file-preview-mode'

describe('fileBreadcrumbs', () => {
  it('builds project, directory, and file crumbs', () => {
    expect(fileBreadcrumbs('laborer', 'apps/web/src/main.tsx')).toEqual([
      { label: 'laborer', path: '', kind: 'project' },
      { label: 'apps', path: 'apps', kind: 'directory' },
      { label: 'web', path: 'apps/web', kind: 'directory' },
      { label: 'src', path: 'apps/web/src', kind: 'directory' },
      { label: 'main.tsx', path: 'apps/web/src/main.tsx', kind: 'file' },
    ])
  })

  it('normalizes repeated separators', () => {
    expect(
      fileBreadcrumbs('workspace', '/src//index.ts').map((crumb) => crumb.label)
    ).toEqual(['workspace', 'src', 'index.ts'])
  })
})

describe('isMarkdownPreviewFile', () => {
  it('recognizes markdown and MDX files case-insensitively', () => {
    expect(isMarkdownPreviewFile('README.md')).toBe(true)
    expect(isMarkdownPreviewFile('docs/guide.MDX')).toBe(true)
  })

  it('does not treat other text files as markdown', () => {
    expect(isMarkdownPreviewFile('docs/guide.txt')).toBe(false)
    expect(isMarkdownPreviewFile('docs/markdown.ts')).toBe(false)
  })
})

describe('setMarkdownTaskChecked', () => {
  const markdown = '- [ ] First\n- [x] Second\n'

  it('checks and unchecks the task marker at the supplied offset', () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe(
      '- [x] First\n- [x] Second\n'
    )
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe(
      '- [ ] First\n- [ ] Second\n'
    )
    expect(setMarkdownTaskChecked('1. [X] Ordered\n', 3, false)).toBe(
      '1. [ ] Ordered\n'
    )
  })

  it('leaves the document unchanged for a stale or invalid marker offset', () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown)
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown)
  })
})

describe('resolveCenteredFileLineScrollTop', () => {
  it('centers an estimated virtualized line position', () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 0,
        scrollHeight: 2000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1000, height: 20 },
      })
    ).toBe(830)
  })

  it('corrects a stale estimate from the rendered line geometry', () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 830,
        scrollHeight: 2000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1000, height: 20 },
        renderedLine: { top: 620, height: 20 },
      })
    ).toBe(1160)
  })
})

describe('fileContentRevision', () => {
  it('changes for same-length edits', () => {
    expect(fileContentRevision('nodeVersion')).not.toBe(
      fileContentRevision('nodeVeasdrs')
    )
  })

  it('keeps identical contents stable', () => {
    expect(fileCacheKey('ws-1', 'file.json', 'contents')).toBe(
      fileCacheKey('ws-1', 'file.json', 'contents')
    )
  })

  it('keeps editor identity stable for locally edited contents', () => {
    const cacheKey = fileEditorCacheKey('ws-1', 'file.json', 'after', undefined)

    expect(
      fileEditorCacheKey('ws-1', 'file.json', 'after edit', {
        cacheKey,
        contents: 'after edit',
      })
    ).toBe(cacheKey)
  })

  it('rotates editor identity for external contents and workspaces', () => {
    const cacheKey = fileEditorCacheKey(
      'ws-1',
      'file.json',
      'before',
      undefined
    )
    const editorFile = { cacheKey, contents: 'before' }

    expect(
      fileEditorCacheKey('ws-1', 'file.json', 'external edit', editorFile)
    ).not.toBe(cacheKey)
    expect(
      fileEditorCacheKey('ws-2', 'file.json', 'before', undefined)
    ).not.toBe(cacheKey)
  })
})
