/**
 * Tests for LifecyclePhaseContext — 4-phase renderer lifecycle.
 *
 * Verifies that the lifecycle phase system manages forward-only
 * phase transitions correctly, that barriers resolve at the right
 * time, and that the public hooks report accurate phase state.
 *
 * @see Issue #4: Lifecycle phase enum and context
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../src/components/lifecycle-phase-context'

/**
 * Test component that displays the current phase and exposes
 * advanceTo/when controls via buttons.
 */
function PhaseDisplay() {
  const { phase, advanceTo } = useLifecyclePhase()
  return (
    <div>
      <span data-testid="phase">{phase}</span>
      <button onClick={() => advanceTo(LifecyclePhase.Ready)} type="button">
        Advance to Ready
      </button>
      <button onClick={() => advanceTo(LifecyclePhase.Restored)} type="button">
        Advance to Restored
      </button>
      <button
        onClick={() => advanceTo(LifecyclePhase.Eventually)}
        type="button"
      >
        Advance to Eventually
      </button>
      <button onClick={() => advanceTo(LifecyclePhase.Starting)} type="button">
        Advance to Starting
      </button>
    </div>
  )
}

describe('LifecyclePhaseContext', () => {
  afterEach(() => {
    cleanup()
  })

  // Tracer bullet: phase starts at Starting and can advance forward
  it('initial phase is Starting', () => {
    render(
      <LifecyclePhaseProvider>
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )
  })

  it('advanceTo(Ready) changes phase to Ready', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    await user.click(screen.getByText('Advance to Ready'))

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )
  })

  it('advanceTo(Starting) after Ready is a no-op (no regression)', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    await user.click(screen.getByText('Advance to Ready'))
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )

    // Attempt to go backwards — should be a no-op
    await user.click(screen.getByText('Advance to Starting'))
    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )
  })

  it('advanceTo(Eventually) skips intermediate phases (jumps forward)', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    // Jump directly from Starting to Eventually
    await user.click(screen.getByText('Advance to Eventually'))

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Eventually)
    )
  })

  it('multiple advanceTo calls with the same phase are idempotent', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <PhaseDisplay />
      </LifecyclePhaseProvider>
    )

    await user.click(screen.getByText('Advance to Ready'))
    await user.click(screen.getByText('Advance to Ready'))
    await user.click(screen.getByText('Advance to Ready'))

    expect(screen.getByTestId('phase').textContent).toBe(
      String(LifecyclePhase.Ready)
    )
  })

  it('when(phase) resolves when phase is reached', async () => {
    const resolved = vi.fn()

    function WhenTracker() {
      const { when } = useLifecyclePhase()
      const subscribed = useRef(false)

      // Start waiting for Ready phase on first render only
      if (!subscribed.current) {
        subscribed.current = true
        when(LifecyclePhase.Ready).then(resolved)
      }

      return null
    }

    function AdvanceButton() {
      const { advanceTo } = useLifecyclePhase()
      return (
        <button onClick={() => advanceTo(LifecyclePhase.Ready)} type="button">
          Go Ready
        </button>
      )
    }

    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <WhenTracker />
        <AdvanceButton />
      </LifecyclePhaseProvider>
    )

    // Not yet resolved
    expect(resolved).not.toHaveBeenCalled()

    // Advance to Ready
    await user.click(screen.getByText('Go Ready'))

    // Allow microtasks to flush
    await act(async () => {
      await Promise.resolve()
    })

    expect(resolved).toHaveBeenCalledTimes(1)
  })

  it('when(phase) resolves immediately if phase already passed', async () => {
    const resolved = vi.fn()

    function LateWhenTracker() {
      const { phase, when } = useLifecyclePhase()

      // Only start waiting after we're past Ready
      if (phase >= LifecyclePhase.Ready) {
        // when(Starting) should resolve immediately since Starting is already past
        when(LifecyclePhase.Starting).then(resolved)
      }

      return <span data-testid="late-phase">{phase}</span>
    }

    function AdvanceButton() {
      const { advanceTo } = useLifecyclePhase()
      return (
        <button onClick={() => advanceTo(LifecyclePhase.Ready)} type="button">
          Go Ready
        </button>
      )
    }

    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <LateWhenTracker />
        <AdvanceButton />
      </LifecyclePhaseProvider>
    )

    await user.click(screen.getByText('Go Ready'))

    // Allow microtasks to flush
    await act(async () => {
      await Promise.resolve()
    })

    expect(resolved).toHaveBeenCalledTimes(1)
  })

  it('when(phase) resolves for skipped intermediate phases', async () => {
    const resolvedReady = vi.fn()
    const resolvedRestored = vi.fn()

    function WhenTracker() {
      const { when } = useLifecyclePhase()
      const subscribed = useRef(false)

      if (!subscribed.current) {
        subscribed.current = true
        when(LifecyclePhase.Ready).then(resolvedReady)
        when(LifecyclePhase.Restored).then(resolvedRestored)
      }

      return null
    }

    function AdvanceButton() {
      const { advanceTo } = useLifecyclePhase()
      return (
        <button
          onClick={() => advanceTo(LifecyclePhase.Eventually)}
          type="button"
        >
          Go Eventually
        </button>
      )
    }

    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <WhenTracker />
        <AdvanceButton />
      </LifecyclePhaseProvider>
    )

    // Jump straight to Eventually — both Ready and Restored barriers should open
    await user.click(screen.getByText('Go Eventually'))

    await act(async () => {
      await Promise.resolve()
    })

    expect(resolvedReady).toHaveBeenCalledTimes(1)
    expect(resolvedRestored).toHaveBeenCalledTimes(1)
  })

  it('provides sensible defaults without a provider', () => {
    // When used outside a provider, the context provides defaults
    function Standalone() {
      const { phase } = useLifecyclePhase()
      return <span data-testid="standalone-phase">{phase}</span>
    }

    render(<Standalone />)

    expect(screen.getByTestId('standalone-phase').textContent).toBe(
      String(LifecyclePhase.Starting)
    )
  })
})
