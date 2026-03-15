/**
 * Tests for ReviewVerdictBadge component.
 *
 * Verifies that the verdict badge correctly renders for each verdict state
 * (approved, needs_fix) and hides when no review exists or the fetch fails.
 *
 * @see Issue #7: Verdict badge on workspace card
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ResultState =
  | { _tag: 'Initial'; waiting: boolean }
  | { _tag: 'Failure'; waiting: boolean; cause: unknown }
  | { _tag: 'Success'; waiting: boolean; value: unknown }

let currentResult: ResultState = { _tag: 'Initial', waiting: true }

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: () => currentResult,
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    query: () => Symbol.for('query:review.fetchVerdict'),
  },
}))

// Mock useWhenPhase to always return true (simulate Phase 4 / Eventually)
// so the component renders its content without phase gating.
vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
}))

import { ReviewVerdictBadge } from '../src/components/review-verdict-badge'

describe('ReviewVerdictBadge', () => {
  beforeEach(() => {
    currentResult = { _tag: 'Initial', waiting: true }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing during initial loading', () => {
    currentResult = { _tag: 'Initial', waiting: true }
    const { container } = render(
      <ReviewVerdictBadge workspaceId="workspace-1" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the fetch fails', () => {
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: new Error('Network error'),
    }
    const { container } = render(
      <ReviewVerdictBadge workspaceId="workspace-1" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when verdict is null (no review exists)', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null },
    }
    const { container } = render(
      <ReviewVerdictBadge workspaceId="workspace-1" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders approved badge with correct data-verdict attribute', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'approved' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const badge = screen.getByTestId('review-verdict-badge')
    expect(badge).toBeDefined()
    expect(badge.getAttribute('data-verdict')).toBe('approved')
  })

  it('renders needs_fix badge with correct data-verdict attribute', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'needs_fix' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const badge = screen.getByTestId('review-verdict-badge')
    expect(badge).toBeDefined()
    expect(badge.getAttribute('data-verdict')).toBe('needs_fix')
  })

  it('renders approved badge with green success styling', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'approved' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const badge = screen.getByTestId('review-verdict-badge')
    expect(badge.className).toContain('text-success')
    expect(badge.className).toContain('bg-success/10')
    expect(badge.className).toContain('border-success/30')
  })

  it('renders needs_fix badge with red destructive styling', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'needs_fix' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const badge = screen.getByTestId('review-verdict-badge')
    expect(badge.className).toContain('text-destructive')
    expect(badge.className).toContain('bg-destructive/10')
    expect(badge.className).toContain('border-destructive/30')
  })

  it('renders tooltip with "Review: approved" for approved verdict', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'approved' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toBe('Review: approved')
  })

  it('renders tooltip with "Review: needs fix" for needs_fix verdict', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'needs_fix' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toBe('Review: needs fix')
  })

  it('renders badge as compact (icon only, no text)', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: 'approved' },
    }
    render(<ReviewVerdictBadge workspaceId="workspace-1" />)

    const badge = screen.getByTestId('review-verdict-badge')
    // Badge should have the icon (SVG) and no visible text beyond the icon
    const svgs = badge.querySelectorAll('svg')
    expect(svgs.length).toBe(1)
  })
})
