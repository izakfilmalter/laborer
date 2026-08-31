/**
 * Unit tests for GitActionsControl.
 *
 * The button names the whole remaining journey to a pull request and runs its
 * steps in order, so the tests pin both: which label the worktree's state
 * earns, and which calls a click actually makes.
 *
 * @see apps/web/src/components/git-actions-control.tsx
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cloneElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { commitMock, createPrMock, pushMock, syncStatusRef } = vi.hoisted(
  () => ({
    commitMock: vi.fn(async () => undefined),
    createPrMock: vi.fn(async () => ({
      number: 7,
      state: 'OPEN',
      title: 'Add the thing',
      url: 'https://github.com/acme/repo/pull/7',
    })),
    pushMock: vi.fn(async () => undefined),
    syncStatusRef: {
      current: {
        aheadCount: null as number | null,
        behindCount: null as number | null,
        hasChanges: false,
        hasUpstream: false,
        isKnown: true,
      },
    },
  })
)

vi.mock('@/hooks/use-workspace-sync-status', () => ({
  useWorkspaceSyncStatus: () => syncStatusRef.current,
}))

vi.mock('@/hooks/use-workspace-git-actions', () => ({
  useWorkspaceGitActions: () => ({
    commitWorkspace: commitMock,
    createPullRequest: createPrMock,
    pushWorkspace: pushMock,
  }),
}))

vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), loading: vi.fn(() => 'toast-1'), success: vi.fn() },
}))

vi.mock('@/lib/local-api', () => ({
  localApi: { openExternal: vi.fn(async () => undefined) },
}))

// The @base-ui/react tooltip portals outside jsdom's reach; keep the trigger's
// own markup so the button still renders its label.
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

const { GitActionsControl } = await import('@/components/git-actions-control')

const COMMIT_PUSH_PR_RE = /commit, push & pr/i
const PUSH_PR_RE = /push & pr/i
const ANY_ACTION_RE = /commit|push|pr/i
const COMMIT_MENU_ITEM_RE = /commit/i

describe('GitActionsControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncStatusRef.current = {
      aheadCount: null,
      behindCount: null,
      hasChanges: false,
      hasUpstream: false,
      isKnown: true,
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('drops the journey button once the branch has a pull request, keeping the menu', async () => {
    const user = userEvent.setup()
    syncStatusRef.current = { ...syncStatusRef.current, hasChanges: true }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest
        workspaceId="ws-1"
      />
    )

    expect(screen.queryByTestId('git-actions-quick-action')).toBeNull()

    // Committing and pushing carry on under review; opening a second pull
    // request is the one thing the menu no longer offers.
    await user.click(screen.getByTestId('git-actions-menu-trigger'))
    expect(
      await screen.findByRole('menuitem', { name: COMMIT_MENU_ITEM_RE })
    ).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: /push/i })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: /create pr/i })).toBeNull()
  })

  it.each([
    'main',
    'master',
    'dev',
  ])('stays off %s, which work merges into rather than from', (branchName) => {
    syncStatusRef.current = { ...syncStatusRef.current, hasChanges: true }
    render(
      <GitActionsControl
        branchName={branchName}
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    expect(screen.queryByRole('button', { name: ANY_ACTION_RE })).toBeNull()
  })

  it('says nothing until git has answered', () => {
    syncStatusRef.current = {
      ...syncStatusRef.current,
      hasChanges: true,
      isKnown: false,
    }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    expect(screen.queryByRole('button', { name: ANY_ACTION_RE })).toBeNull()
  })

  it('hides itself when the branch is clean and level with upstream', () => {
    syncStatusRef.current = {
      aheadCount: 0,
      behindCount: 0,
      hasChanges: false,
      hasUpstream: true,
      isKnown: true,
    }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    expect(screen.queryByRole('button', { name: ANY_ACTION_RE })).toBeNull()
  })

  it('runs the whole journey on one click, asking for nothing', async () => {
    const user = userEvent.setup()
    syncStatusRef.current = { ...syncStatusRef.current, hasChanges: true }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    await user.click(screen.getByRole('button', { name: COMMIT_PUSH_PR_RE }))

    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledTimes(1)
    })
    // No message travels with the commit: the server writes one from the diff.
    expect(commitMock).toHaveBeenCalledWith('ws-1', undefined)
    expect(screen.queryByTestId('commit-message-input')).toBeNull()
    expect(pushMock).toHaveBeenCalledWith('ws-1')
    expect(createPrMock).toHaveBeenCalledWith('ws-1')
  })

  it('lets the operator write the message themselves from the menu', async () => {
    const user = userEvent.setup()
    syncStatusRef.current = { ...syncStatusRef.current, hasChanges: true }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    await user.click(screen.getByTestId('git-actions-menu-trigger'))
    await user.click(
      await screen.findByRole('menuitem', { name: COMMIT_MENU_ITEM_RE })
    )

    const message = await screen.findByTestId('commit-message-input')
    await user.type(message, 'Add the thing')
    await user.click(screen.getByTestId('commit-message-submit'))

    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledWith('ws-1', 'Add the thing')
    })
    // The menu's commit is only a commit; it never continues to a PR.
    expect(pushMock).not.toHaveBeenCalled()
    expect(createPrMock).not.toHaveBeenCalled()
  })

  it('starts at the push when the commits exist but were never published', async () => {
    const user = userEvent.setup()
    syncStatusRef.current = {
      aheadCount: 2,
      behindCount: 0,
      hasChanges: false,
      hasUpstream: true,
      isKnown: true,
    }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    await user.click(screen.getByRole('button', { name: PUSH_PR_RE }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('ws-1')
    })
    expect(commitMock).not.toHaveBeenCalled()
    expect(createPrMock).toHaveBeenCalledWith('ws-1')
  })

  it('stops the run when a step fails, so no pull request is claimed', async () => {
    const user = userEvent.setup()
    pushMock.mockRejectedValueOnce(new Error('rejected by remote'))
    syncStatusRef.current = {
      aheadCount: 1,
      behindCount: 0,
      hasChanges: false,
      hasUpstream: true,
      isKnown: true,
    }
    render(
      <GitActionsControl
        branchName="feature"
        hasPullRequest={false}
        workspaceId="ws-1"
      />
    )

    await user.click(screen.getByRole('button', { name: PUSH_PR_RE }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledTimes(1)
    })
    expect(createPrMock).not.toHaveBeenCalled()
  })
})
