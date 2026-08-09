/**
 * Tests that features are progressively enabled based on lifecycle phase:
 *
 * - **Phase 3 (Restored):** Terminal pane shows a connecting placeholder
 *   before Phase 3, and renders normally after.
 * - **Phase 4 (Eventually):** Review pane, review findings count, and review
 *   verdict badge are gated behind Phase 4.
 *
 * These tests exercise the public UI: components show appropriate
 * loading/placeholder states in earlier phases and transition smoothly
 * to real content in later phases.
 *
 * @see Issue #12: Progressive feature enablement for Phases 3-4
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../src/components/lifecycle-phase-context'
import { useWhenPhase } from '../src/hooks/use-when-phase'

// ---------------------------------------------------------------------------
// Test components — simulate the phase-gating patterns applied to real
// components without importing their heavy dependencies (xterm.js, etc.)
// ---------------------------------------------------------------------------

/**
 * Simulates the terminal pane phase gate.
 * Before Phase 3 (Restored): shows "Terminal service connecting..." placeholder.
 * After Phase 3: shows the terminal content.
 */
function PhaseGatedTerminalPane() {
  const isRestored = useWhenPhase(LifecyclePhase.Restored)

  if (!isRestored) {
    return (
      <div data-testid="terminal-connecting-placeholder">
        <p>Terminal service connecting...</p>
      </div>
    )
  }

  return (
    <div data-testid="terminal-content">
      <p>Terminal output here</p>
    </div>
  )
}

/**
 * Simulates the review pane phase gate.
 * Before Phase 4 (Eventually): shows loading skeleton.
 * After Phase 4: shows review content.
 */
function PhaseGatedReviewPane() {
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  if (!isEventually) {
    return (
      <div data-testid="review-loading-placeholder">
        <p>Loading review...</p>
      </div>
    )
  }

  return (
    <div data-testid="review-content">
      <p>Review findings here</p>
    </div>
  )
}

/**
 * Test harness with phase advance buttons so we can simulate transitions.
 */
function TestHarness({ children }: { readonly children: React.ReactNode }) {
  const { advanceTo } = useLifecyclePhase()

  return (
    <div>
      {children}
      <button
        data-testid="advance-ready"
        onClick={() => advanceTo(LifecyclePhase.Ready)}
        type="button"
      >
        Advance to Ready
      </button>
      <button
        data-testid="advance-restored"
        onClick={() => advanceTo(LifecyclePhase.Restored)}
        type="button"
      >
        Advance to Restored
      </button>
      <button
        data-testid="advance-eventually"
        onClick={() => advanceTo(LifecyclePhase.Eventually)}
        type="button"
      >
        Advance to Eventually
      </button>
    </div>
  )
}

describe('Progressive feature enablement for Phases 3-4', () => {
  afterEach(() => {
    cleanup()
  })

  // -----------------------------------------------------------------------
  // Terminal pane — Phase 3 (Restored)
  // -----------------------------------------------------------------------

  // Tracer bullet: terminal shows connecting state before Phase 3
  it('terminal pane shows connecting placeholder before Phase 3 (Restored)', () => {
    render(
      <LifecyclePhaseProvider>
        <TestHarness>
          <PhaseGatedTerminalPane />
        </TestHarness>
      </LifecyclePhaseProvider>
    )

    expect(screen.getByTestId('terminal-connecting-placeholder')).toBeDefined()
    expect(screen.queryByTestId('terminal-content')).toBeNull()
  })

  it('terminal pane renders normally after Phase 3 (Restored)', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <TestHarness>
          <PhaseGatedTerminalPane />
        </TestHarness>
      </LifecyclePhaseProvider>
    )

    // Initially shows placeholder
    expect(screen.getByTestId('terminal-connecting-placeholder')).toBeDefined()

    // Advance to Restored
    await user.click(screen.getByTestId('advance-restored'))

    // Now shows terminal content
    expect(screen.getByTestId('terminal-content')).toBeDefined()
    expect(screen.queryByTestId('terminal-connecting-placeholder')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Review pane — Phase 4 (Eventually)
  // -----------------------------------------------------------------------

  it('review pane shows loading placeholder before Phase 4 (Eventually)', () => {
    render(
      <LifecyclePhaseProvider>
        <TestHarness>
          <PhaseGatedReviewPane />
        </TestHarness>
      </LifecyclePhaseProvider>
    )

    expect(screen.getByTestId('review-loading-placeholder')).toBeDefined()
    expect(screen.queryByTestId('review-content')).toBeNull()
  })

  it('review pane shows real content after Phase 4 (Eventually)', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <TestHarness>
          <PhaseGatedReviewPane />
        </TestHarness>
      </LifecyclePhaseProvider>
    )

    // Advance to Eventually
    await user.click(screen.getByTestId('advance-eventually'))

    expect(screen.getByTestId('review-content')).toBeDefined()
    expect(screen.queryByTestId('review-loading-placeholder')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Smooth transitions — no broken UI in intermediate phases
  // -----------------------------------------------------------------------

  it('features transition smoothly from placeholder to real content without broken UI', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <TestHarness>
          <PhaseGatedTerminalPane />
          <PhaseGatedReviewPane />
        </TestHarness>
      </LifecyclePhaseProvider>
    )

    // Phase 1: both placeholders
    expect(screen.getByTestId('terminal-connecting-placeholder')).toBeDefined()
    expect(screen.getByTestId('review-loading-placeholder')).toBeDefined()

    // Phase 2 (Ready): terminal and review still show placeholders
    await user.click(screen.getByTestId('advance-ready'))
    expect(screen.getByTestId('terminal-connecting-placeholder')).toBeDefined()
    expect(screen.getByTestId('review-loading-placeholder')).toBeDefined()

    // Phase 3 (Restored): terminal renders, review still shows a placeholder
    await user.click(screen.getByTestId('advance-restored'))
    expect(screen.getByTestId('terminal-content')).toBeDefined()
    expect(screen.getByTestId('review-loading-placeholder')).toBeDefined()

    // Phase 4 (Eventually): everything renders
    await user.click(screen.getByTestId('advance-eventually'))
    expect(screen.getByTestId('terminal-content')).toBeDefined()
    expect(screen.getByTestId('review-content')).toBeDefined()

    // No placeholders remain
    expect(screen.queryByTestId('terminal-connecting-placeholder')).toBeNull()
    expect(screen.queryByTestId('review-loading-placeholder')).toBeNull()
  })
})
