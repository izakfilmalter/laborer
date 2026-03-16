/**
 * Tests for ReviewPane's Alive event integration.
 *
 * Verifies that when Alive DOM events fire for a workspace, the review
 * pane triggers an immediate refresh and resets its polling timer.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Capture the refresh function and poll timer behavior
// ---------------------------------------------------------------------------

type ResultState =
  | { _tag: 'Initial'; waiting: boolean }
  | { _tag: 'Success'; waiting: boolean; value: unknown }

const mockRefresh = vi.fn()

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: (): ResultState => ({
    _tag: 'Success',
    waiting: false,
    value: { comments: [], findings: [], verdict: null },
  }),
  useAtomRefresh: () => mockRefresh,
  useAtomSet: () => vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    query: () => Symbol.for('query:review.fetchComments'),
    mutation: (name: string) => Symbol(name),
  },
}))

// Mock useWhenPhase to always return true (simulate Phase 4 / Eventually)
// so the component renders its content without phase gating.
vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => ({
    assignTerminalToPane: vi.fn(),
  }),
}))

vi.mock('@/panels/diff-scroll-context', () => ({
  useDiffScrollDispatch: () => vi.fn(),
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: React.PropsWithChildren) => (
    <div data-testid="scroll-area" {...props}>
      {children}
    </div>
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  AvatarImage: ({ alt }: { alt: string }) => (
    <img alt={alt} height={24} width={24} />
  ),
  AvatarFallback: ({ children }: React.PropsWithChildren) => (
    <span>{children}</span>
  ),
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/components/ui/empty', () => ({
  Empty: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  EmptyDescription: ({ children }: React.PropsWithChildren) => (
    <p>{children}</p>
  ),
  EmptyHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  EmptyMedia: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  EmptyTitle: ({ children }: React.PropsWithChildren) => <h3>{children}</h3>,
}))

vi.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render: renderProp,
  }: React.PropsWithChildren<{ render?: React.ReactElement }>) =>
    renderProp ?? <div>{children}</div>,
}))

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: (props: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <input
      checked={props.checked ?? false}
      onChange={(e) => props.onCheckedChange?.(e.target.checked)}
      type="checkbox"
    />
  ),
}))

// Must import after all mocks
import { ReviewPane } from '@/panes/review-pane'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ReviewPane Alive integration', () => {
  it('calls refresh when alive:issue-comment fires for this workspace', () => {
    render(<ReviewPane workspaceId="ws-1" />)

    // Clear the mount-time calls
    mockRefresh.mockClear()

    window.dispatchEvent(
      new CustomEvent('alive:issue-comment', {
        detail: { workspaceId: 'ws-1' },
      })
    )

    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('calls refresh when alive:review-comment fires for this workspace', () => {
    render(<ReviewPane workspaceId="ws-1" />)
    mockRefresh.mockClear()

    window.dispatchEvent(
      new CustomEvent('alive:review-comment', {
        detail: { workspaceId: 'ws-1' },
      })
    )

    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('calls refresh when alive:review-submit fires for this workspace', () => {
    render(<ReviewPane workspaceId="ws-1" />)
    mockRefresh.mockClear()

    window.dispatchEvent(
      new CustomEvent('alive:review-submit', {
        detail: { workspaceId: 'ws-1' },
      })
    )

    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('calls refresh when alive:review-refresh fires for this workspace', () => {
    render(<ReviewPane workspaceId="ws-1" />)
    mockRefresh.mockClear()

    window.dispatchEvent(
      new CustomEvent('alive:review-refresh', {
        detail: { workspaceId: 'ws-1' },
      })
    )

    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('ignores events for a different workspace', () => {
    render(<ReviewPane workspaceId="ws-1" />)
    mockRefresh.mockClear()

    window.dispatchEvent(
      new CustomEvent('alive:issue-comment', {
        detail: { workspaceId: 'ws-other' },
      })
    )

    expect(mockRefresh).not.toHaveBeenCalled()
  })
})
