/**
 * Tests for the TabErrorBoundary component.
 *
 * Verifies that errors in child components are caught and displayed
 * with a retry button, and that non-errored children render normally.
 *
 * @see apps/web/src/components/ui/tab-error-boundary.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #28
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { TabErrorBoundary } from '../src/components/ui/tab-error-boundary'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Regex patterns (top-level for lint compliance)
// ---------------------------------------------------------------------------

const TEST_ERROR_PATTERN = /test error/
const WORKSPACE_1_PATTERN = /in "workspace-1"/
const RETRY_PATTERN = /retry/i
// ---------------------------------------------------------------------------
// Helper: a component that throws on render
// ---------------------------------------------------------------------------

function ThrowingChild({ message }: { readonly message: string }): ReactNode {
  throw new Error(message)
}

function GoodChild() {
  return <div data-testid="good-child">Hello</div>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TabErrorBoundary', () => {
  // Suppress console.error from React error boundary logging
  const originalConsoleError = console.error
  beforeAll(() => {
    console.error = vi.fn()
  })
  afterAll(() => {
    console.error = originalConsoleError
  })

  it('renders children when no error occurs', () => {
    render(
      <TabErrorBoundary>
        <GoodChild />
      </TabErrorBoundary>
    )
    expect(screen.getByTestId('good-child')).toBeDefined()
  })

  it('renders error fallback when child throws', () => {
    render(
      <TabErrorBoundary>
        <ThrowingChild message="test error" />
      </TabErrorBoundary>
    )
    expect(screen.getByTestId('tab-error-boundary')).toBeDefined()
    expect(screen.getByText('Something went wrong')).toBeDefined()
    expect(screen.getByText(TEST_ERROR_PATTERN)).toBeDefined()
  })

  it('shows the label in the error message when provided', () => {
    render(
      <TabErrorBoundary label="workspace-1">
        <ThrowingChild message="boom" />
      </TabErrorBoundary>
    )
    expect(screen.getByText(WORKSPACE_1_PATTERN)).toBeDefined()
  })

  it('shows retry button in error state', () => {
    render(
      <TabErrorBoundary>
        <ThrowingChild message="fail" />
      </TabErrorBoundary>
    )
    expect(screen.getByRole('button', { name: RETRY_PATTERN })).toBeDefined()
  })

  it('recovers when retry is clicked and child no longer throws', () => {
    let shouldThrow = true

    function ConditionalThrow(): ReactNode {
      if (shouldThrow) {
        throw new Error('conditional error')
      }
      return <div data-testid="recovered">Recovered</div>
    }

    render(
      <TabErrorBoundary>
        <ConditionalThrow />
      </TabErrorBoundary>
    )

    // Should be in error state
    expect(screen.getByTestId('tab-error-boundary')).toBeDefined()

    // Fix the issue
    shouldThrow = false

    // Click retry
    fireEvent.click(screen.getByRole('button', { name: RETRY_PATTERN }))

    // Should now render the recovered content
    expect(screen.getByTestId('recovered')).toBeDefined()
  })

  it('does not affect siblings outside the boundary', () => {
    render(
      <div>
        <div data-testid="sibling">Sibling</div>
        <TabErrorBoundary>
          <ThrowingChild message="isolated error" />
        </TabErrorBoundary>
      </div>
    )
    // Sibling should still render
    expect(screen.getByTestId('sibling')).toBeDefined()
    // Error boundary should catch the error
    expect(screen.getByTestId('tab-error-boundary')).toBeDefined()
  })
})
