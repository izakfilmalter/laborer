import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightPanelResizeHandle } from '@/components/right-panel/right-panel-resize-handle'
import {
  browserSurfaceTitle,
  RightPanelTabs,
  sameBrowserOrigin,
} from '@/components/right-panel/right-panel-tabs'

afterEach(cleanup)

describe('browser tab parity', () => {
  it('uses the document title then falls back to the URL host', () => {
    expect(browserSurfaceTitle('Dashboard', 'https://example.test/a')).toBe(
      'Dashboard'
    )
    expect(browserSurfaceTitle(' ', 'https://example.test:444/a')).toBe(
      'example.test:444'
    )
    expect(browserSurfaceTitle('', 'not a url')).toBe('Browser')
  })

  it('rejects stale captured favicons from another origin', () => {
    expect(
      sameBrowserOrigin('https://example.test/icon', 'https://example.test/a')
    ).toBe(true)
    expect(
      sameBrowserOrigin('https://old.test/icon', 'https://example.test/a')
    ).toBe(false)
  })
})

describe('right panel resize accessibility', () => {
  it('exposes separator values and forwards keyboard resizing', () => {
    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
      event.preventDefault()
    }
    render(
      <RightPanelResizeHandle
        handlers={{
          onKeyDown,
          onPointerCancel: () => undefined,
          onPointerDown: () => undefined,
          onPointerMove: () => undefined,
          onPointerUp: () => undefined,
        }}
        max={900}
        min={360}
        value={540}
      />
    )
    const separator = screen.getByRole('separator', {
      name: 'Resize right panel',
    })
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('aria-valuemin')).toBe('360')
    expect(separator.getAttribute('aria-valuemax')).toBe('900')
    expect(separator.getAttribute('aria-valuenow')).toBe('540')
    expect(separator.getAttribute('tabindex')).toBe('0')
    expect(fireEvent.keyDown(separator, { key: 'ArrowLeft' })).toBe(false)
  })
})

describe('file tab interactions', () => {
  it('shows pending state and copies the path from its context menu', () => {
    const file = {
      id: 'file:src/a.ts' as const,
      kind: 'file' as const,
      relativePath: 'src/a.ts',
      revealLine: null,
      revealRequestId: 0,
    }
    const copy = vi.fn()
    render(
      <RightPanelTabs
        activeSurfaceId={file.id}
        browserAvailable={false}
        diffAvailable={false}
        filesAvailable
        onActivate={() => undefined}
        onAddBrowser={() => undefined}
        onAddDiff={() => undefined}
        onAddFiles={() => undefined}
        onAddPullRequest={() => undefined}
        onCloseAllSurfaces={() => undefined}
        onCloseOtherSurfaces={() => undefined}
        onCloseSurface={() => undefined}
        onCloseSurfacesToRight={() => undefined}
        onCopyFilePath={copy}
        pendingSurfaceIds={new Set([file.id])}
        pullRequestAvailable={false}
        surfaces={[file]}
        widthStorageKey="test:right-panel-width"
        workspaceId="ws-1"
      >
        <div>content</div>
      </RightPanelTabs>
    )

    const close = screen.getByRole('button', { name: 'Close a.ts' })
    const identity = close.firstElementChild
    expect(identity?.querySelector('[data-pierre-icon]')).not.toBeNull()
    const pending = identity?.querySelector('[data-pending-indicator]')
    expect(pending).not.toBeNull()
    expect(pending?.className).toContain('-right-0.5')
    expect(pending?.className).toContain('-bottom-0.5')
    expect(pending?.className).toContain('size-1.5')
    const tab = close.parentElement
    expect(tab).not.toBeNull()
    if (!tab) {
      return
    }
    fireEvent.contextMenu(tab)
    fireEvent.click(screen.getByText('Copy path'))
    expect(copy).toHaveBeenCalledWith('src/a.ts')
  })
})
