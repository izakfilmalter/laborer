import type { FileNode } from '@laborer/shared/rpc'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseIconName } from '../src/panes/file-tree/file-icon'
import {
  FileTreeView,
  type TreeViewSelectionItem,
} from '../src/panes/file-tree/tree-view'

const treeByDir: Record<string, readonly FileNode[]> = {
  '': [makeDir('apps'), makeDir('docs'), makeFile('package.json')],
  apps: [makeDir('apps/desktop'), makeDir('apps/web')],
  'apps/web': [
    makeDir('apps/web/e2e'),
    makeDir('apps/web/src'),
    makeDir('apps/web/test'),
    makeFile('apps/web/.gitignore'),
    makeFile('apps/web/components.json'),
    makeFile('apps/web/index.html'),
    makeFile('apps/web/package.json'),
    makeFile('apps/web/playwright.config.ts'),
    makeFile('apps/web/tsconfig.json'),
    makeFile('apps/web/vite.config.ts'),
    makeFile('apps/web/vitest.config.ts'),
  ],
}

afterEach(() => {
  cleanup()
})

function makeDir(path: string): FileNode {
  const parts = path.split('/')
  const name = parts.at(-1) ?? path

  return {
    absolute: `/repo/${path}`,
    ignored: false,
    name,
    path,
    type: 'directory',
  }
}

function makeFile(path: string): FileNode {
  const parts = path.split('/')
  const name = parts.at(-1) ?? path

  return {
    absolute: `/repo/${path}`,
    ignored: false,
    name,
    path,
    type: 'file',
  }
}

describe('FileTreeView', () => {
  it('renders only the real visible rows for expanded directories', () => {
    const onContextMenuItem = vi.fn<(item: TreeViewSelectionItem) => void>()
    const onSelect = vi.fn<(item: TreeViewSelectionItem) => void>()
    const store = {
      children: (dir: string) => treeByDir[dir] ?? [],
      collapseDir: vi.fn(),
      expandDir: vi.fn(),
      isDirExpanded: (dir: string) => dir === 'apps' || dir === 'apps/web',
    }

    render(
      <FileTreeView
        gitStatus={[]}
        onContextMenuItem={onContextMenuItem}
        onSelect={onSelect}
        selectedPath={null}
        store={store}
      />
    )

    const items = screen.getAllByRole('treeitem')

    expect(items).toHaveLength(16)
    expect(items.some((item) => item.getAttribute('aria-label') === '')).toBe(
      false
    )
    expect(
      screen.getByRole('treeitem', { name: 'components.json' })
    ).toBeDefined()
    expect(screen.getByRole('treeitem', { name: '.gitignore' })).toBeDefined()
  })

  it('updates selection and context menu target from row interactions', () => {
    const onContextMenuItem = vi.fn<(item: TreeViewSelectionItem) => void>()
    const onSelect = vi.fn<(item: TreeViewSelectionItem) => void>()
    const store = {
      children: (dir: string) => treeByDir[dir] ?? [],
      collapseDir: vi.fn(),
      expandDir: vi.fn(),
      isDirExpanded: (dir: string) => dir === 'apps' || dir === 'apps/web',
    }

    render(
      <FileTreeView
        gitStatus={[]}
        onContextMenuItem={onContextMenuItem}
        onSelect={onSelect}
        selectedPath={null}
        store={store}
      />
    )

    const fileRow = screen.getByRole('treeitem', { name: 'vite.config.ts' })
    fireEvent.click(fileRow)
    fireEvent.contextMenu(fileRow)

    expect(onSelect).toHaveBeenCalledWith({
      path: 'apps/web/vite.config.ts',
      type: 'file',
    })
    expect(onContextMenuItem).toHaveBeenCalledWith({
      path: 'apps/web/vite.config.ts',
      type: 'file',
    })
  })
})

describe('chooseIconName', () => {
  it('matches OpenCode file icon mappings for common project files', () => {
    expect(chooseIconName('package.json', 'file', false)).toBe('Nodejs')
    expect(chooseIconName('vite.config.ts', 'file', false)).toBe('Vite')
    expect(chooseIconName('src/app.tsx', 'file', false)).toBe('React_ts')
    expect(chooseIconName('docs', 'directory', false)).toBe('FolderDocs')
  })
})
