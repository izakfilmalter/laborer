import { Markdown } from '@laborer/ui/components/markdown'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileCommentAnnotations } from '@/components/files/file-comment-annotations'
import { serializeFileMention } from '@/components/files/file-mention'

afterEach(cleanup)

describe('file mentions', () => {
  it('escapes file mentions like t3', () => {
    expect(serializeFileMention('docs/My File (draft).md')).toBe(
      '[My File (draft).md](docs/My%20File%20%28draft%29.md)'
    )
  })
})

describe('rendered markdown tasks', () => {
  it('reports the source marker offset and requested state', () => {
    const onTaskListChange = vi.fn()
    render(
      <Markdown onTaskListChange={onTaskListChange}>
        {'- [ ] First\n- [x] Second'}
      </Markdown>
    )
    const first = screen.getAllByRole('checkbox')[0]
    expect(first).toBeDefined()
    if (!first) {
      return
    }
    fireEvent.click(first)
    expect(onTaskListChange).toHaveBeenCalledWith({
      checked: true,
      markerOffset: 2,
    })
  })
})

describe('file review annotations', () => {
  it('groups Laborer review threads by their source line and includes drafts', () => {
    const thread = {
      id: 'thread-1',
      workspaceId: 'ws-1',
      filePath: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      side: 'additions',
      status: 'open',
      replies: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as const
    const annotations = fileCommentAnnotations('src/a.ts', [thread], {
      kind: 'create',
      body: '',
      anchor: {
        filePath: 'src/a.ts',
        startLine: 8,
        endLine: 8,
        side: 'additions',
        label: 'src/a.ts:8',
      },
    })
    expect(annotations.map(({ lineNumber }) => lineNumber)).toEqual([3, 8])
    expect(annotations[0]?.metadata.threads).toEqual([thread])
  })
})
