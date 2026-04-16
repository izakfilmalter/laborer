import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileNode } from '@laborer/shared/rpc'
import { useFileTreeStore } from '../src/panes/file-tree/use-file-tree-store'

afterEach(() => {
  cleanup()
})

describe('useFileTreeStore', () => {
  it('marks unloaded directories with a trailing slash for @pierre/trees', async () => {
    const list = vi.fn((dir: string): Promise<readonly FileNode[]> => {
      if (dir === '') {
        return Promise.resolve([
          {
            absolute: '/repo/src',
            ignored: false,
            name: 'src',
            path: 'src',
            type: 'directory',
          },
          {
            absolute: '/repo/package.json',
            ignored: false,
            name: 'package.json',
            path: 'package.json',
            type: 'file',
          },
        ])
      }

      return Promise.resolve([
        {
          absolute: '/repo/src/index.ts',
          ignored: false,
          name: 'index.ts',
          path: 'src/index.ts',
          type: 'file',
        },
      ])
    })

    const { result } = renderHook(() => useFileTreeStore({ list }))

    act(() => {
      result.current.listDir('')
    })

    await waitFor(() => {
      expect(result.current.files).toEqual(['src/', 'package.json'])
    })

    act(() => {
      result.current.expandDir('src')
    })

    await waitFor(() => {
      expect(result.current.files).toEqual([
        'src/',
        'src/index.ts',
        'package.json',
      ])
    })
  })
})
