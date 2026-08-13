/**
 * Unit tests for the invalidateFromWatcher pure function.
 *
 * Tests verify the client-side invalidation logic that processes
 * watcher events to determine which directories to refresh.
 *
 * @see Issue 6: Client tree pane — Lazy per-directory fetching
 */

import { describe, expect, it, vi } from 'vitest'
import {
  invalidateFromWatcher,
  type WatcherOps,
} from '@/panes/file-tree/invalidate-from-watcher'

const createOps = (overrides: Partial<WatcherOps> = {}): WatcherOps => ({
  hasNode: vi.fn(() => false),
  nodeType: vi.fn(() => undefined),
  isDirLoaded: vi.fn(() => false),
  refreshDir: vi.fn(),
  ...overrides,
})

describe('invalidateFromWatcher', () => {
  it('"add" event calls refreshDir on the parent directory', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher({ file: 'src/new-file.ts', event: 'add' }, ops)

    expect(ops.refreshDir).toHaveBeenCalledWith('src')
    expect(ops.refreshDir).toHaveBeenCalledTimes(1)
  })

  it('"add" event on root-level file calls refreshDir on root (empty string)', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher({ file: 'new-file.ts', event: 'add' }, ops)

    expect(ops.refreshDir).toHaveBeenCalledWith('')
    expect(ops.refreshDir).toHaveBeenCalledTimes(1)
  })

  it('"unlink" event calls refreshDir on the parent directory', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher(
      { file: 'lib/utils/helpers.ts', event: 'unlink' },
      ops
    )

    expect(ops.refreshDir).toHaveBeenCalledWith('lib/utils')
    expect(ops.refreshDir).toHaveBeenCalledTimes(1)
  })

  it('"change" event on a loaded directory calls refreshDir on that directory', () => {
    const ops = createOps({
      nodeType: vi.fn((p: string): 'file' | 'directory' | undefined =>
        p === 'src/components' ? 'directory' : undefined
      ),
      isDirLoaded: vi.fn((p: string) => p === 'src/components'),
    })
    invalidateFromWatcher({ file: 'src/components', event: 'change' }, ops)

    expect(ops.refreshDir).toHaveBeenCalledWith('src/components')
    expect(ops.refreshDir).toHaveBeenCalledTimes(1)
  })

  it('"change" event on an unloaded directory does nothing', () => {
    const ops = createOps({
      nodeType: vi.fn((): 'directory' => 'directory'),
      isDirLoaded: vi.fn(() => false),
    })
    invalidateFromWatcher({ file: 'src/components', event: 'change' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('"change" event on a file (not directory) does nothing', () => {
    const ops = createOps({
      nodeType: vi.fn((): 'file' => 'file'),
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher({ file: 'src/index.ts', event: 'change' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('.git/ paths are ignored', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher({ file: '.git/index', event: 'change' }, ops)
    invalidateFromWatcher({ file: '.git/HEAD', event: 'change' }, ops)
    invalidateFromWatcher({ file: '.git/refs/heads/main', event: 'add' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('.git bare path is ignored', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => true),
    })
    invalidateFromWatcher({ file: '.git', event: 'change' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('"add" event does not refresh unloaded parent directory', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => false),
    })
    invalidateFromWatcher({ file: 'src/new-file.ts', event: 'add' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('"unlink" event does not refresh unloaded parent directory', () => {
    const ops = createOps({
      isDirLoaded: vi.fn(() => false),
    })
    invalidateFromWatcher({ file: 'src/deleted.ts', event: 'unlink' }, ops)

    expect(ops.refreshDir).not.toHaveBeenCalled()
  })

  it('deeply nested "add" event refreshes the immediate parent', () => {
    const ops = createOps({
      isDirLoaded: vi.fn((p: string) => p === 'src/components/ui'),
    })
    invalidateFromWatcher(
      { file: 'src/components/ui/Button.tsx', event: 'add' },
      ops
    )

    expect(ops.refreshDir).toHaveBeenCalledWith('src/components/ui')
    expect(ops.refreshDir).toHaveBeenCalledTimes(1)
  })
})
