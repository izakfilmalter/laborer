/**
 * Unit tests for WorkspaceSyncStatus.
 *
 * The control is a single button in the style of GitHub Desktop's toolbar:
 * one action at a time, both counts visible, and its own in-flight state.
 *
 * @see apps/web/src/components/workspace-sync-status.tsx
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cloneElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pullMock, pushMock, syncCountsRef } = vi.hoisted(() => ({
  pullMock: vi.fn(async () => undefined),
  pushMock: vi.fn(async () => undefined),
  syncCountsRef: {
    current: {
      aheadCount: null as number | null,
      behindCount: null as number | null,
    },
  },
}))

vi.mock('@/hooks/use-workspace-sync-status', () => ({
  useWorkspaceSyncStatus: () => syncCountsRef.current,
}))

vi.mock('@/hooks/use-workspace-sync-actions', () => ({
  useWorkspaceSyncActions: () => ({
    pullWorkspace: pullMock,
    pushWorkspace: pushMock,
  }),
}))

vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

// The @base-ui/react tooltip portals outside jsdom's reach; keep the trigger's
// own markup so the button still renders its counts.
vi.mock('@laborer/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => (render ? cloneElement(render, undefined, children) : children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

const { WorkspaceSyncStatus } = await import(
  '@/components/workspace-sync-status'
)

const SYNC_RE = /pull|push/i
const PULL_RE = /pull 3 commits/i
const PUSH_RE = /push 2 commits/i
const PULLING_RE = /pulling/i

describe('WorkspaceSyncStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncCountsRef.current = { aheadCount: null, behindCount: null }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing while the workspace is level with upstream', () => {
    syncCountsRef.current = { aheadCount: 0, behindCount: 0 }
    render(<WorkspaceSyncStatus workspaceId="ws-1" />)

    expect(screen.queryByRole('button', { name: SYNC_RE })).toBeNull()
  })

  it('collapses both directions into one pull button, counts intact', async () => {
    const user = userEvent.setup()
    syncCountsRef.current = { aheadCount: 2, behindCount: 3 }
    render(<WorkspaceSyncStatus workspaceId="ws-1" />)

    const buttons = screen.getAllByRole('button', { name: SYNC_RE })
    expect(buttons).toHaveLength(1)

    const button = screen.getByRole('button', { name: PULL_RE })
    // The push count still shows, it just is not what the click does.
    expect(button.textContent).toContain('3')
    expect(button.textContent).toContain('2')

    await user.click(button)
    expect(pullMock).toHaveBeenCalledWith('ws-1')
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('pushes when the workspace is only ahead', async () => {
    const user = userEvent.setup()
    syncCountsRef.current = { aheadCount: 2, behindCount: 0 }
    render(<WorkspaceSyncStatus workspaceId="ws-1" />)

    await user.click(screen.getByRole('button', { name: PUSH_RE }))
    expect(pushMock).toHaveBeenCalledWith('ws-1')
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('marks the button busy until the sync settles', async () => {
    const user = userEvent.setup()
    let releasePull: () => void = () => undefined
    pullMock.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releasePull = () => {
            resolve(undefined)
          }
        })
    )
    syncCountsRef.current = { aheadCount: 0, behindCount: 3 }
    render(<WorkspaceSyncStatus workspaceId="ws-1" />)

    await user.click(screen.getByRole('button', { name: PULL_RE }))

    const busy = screen.getByRole('button', { name: PULLING_RE })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.hasAttribute('disabled')).toBe(true)

    releasePull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: PULL_RE })).toBeTruthy()
    })
  })

  it('does not fire a second sync while one is in flight', async () => {
    const user = userEvent.setup()
    pullMock.mockImplementationOnce(
      () => new Promise<undefined>(() => undefined)
    )
    syncCountsRef.current = { aheadCount: 0, behindCount: 3 }
    render(<WorkspaceSyncStatus workspaceId="ws-1" />)

    await user.click(screen.getByRole('button', { name: PULL_RE }))
    await user.click(screen.getByRole('button', { name: PULLING_RE }))

    expect(pullMock).toHaveBeenCalledTimes(1)
  })
})
