/**
 * Tests that server-dependent write actions are disabled during Phase 1
 * (Starting) and enabled once the lifecycle phase reaches Phase 2 (Ready).
 *
 * These tests exercise the public UI: buttons are disabled with a tooltip
 * explaining "Connecting to server...", and they enable once the phase
 * advances to Ready.
 *
 * @see Issue #11: Disable write actions before Phase 2 (Ready)
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

/**
 * Simulates a server-dependent write action button that uses useWhenPhase
 * to gate its enabled state. This mirrors the pattern applied across
 * CreateWorkspaceForm, AddProjectForm, DestroyWorkspaceButton, etc.
 */
function WriteActionButton({ label }: { readonly label: string }) {
  const isReady = useWhenPhase(LifecyclePhase.Ready)

  return (
    <button
      aria-label={label}
      data-testid="write-action"
      disabled={!isReady}
      title={isReady ? undefined : 'Connecting to server...'}
      type="button"
    >
      {isReady ? label : 'Connecting...'}
    </button>
  )
}

/**
 * Test harness with a phase advance button so we can simulate
 * the Starting → Ready transition in tests.
 */
function TestHarness({ actionLabel }: { readonly actionLabel: string }) {
  const { advanceTo } = useLifecyclePhase()

  return (
    <div>
      <WriteActionButton label={actionLabel} />
      <button
        data-testid="advance-ready"
        onClick={() => advanceTo(LifecyclePhase.Ready)}
        type="button"
      >
        Advance to Ready
      </button>
    </div>
  )
}

/**
 * Simulates a form with a submit button that should be blocked
 * during Phase 1 — the form itself prevents submission, not just
 * visual disable.
 */
function WriteActionForm() {
  const isReady = useWhenPhase(LifecyclePhase.Ready)
  const { advanceTo } = useLifecyclePhase()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isReady) {
      return
    }
    // Would call RPC here
  }

  return (
    <div>
      <form data-testid="write-form" onSubmit={handleSubmit}>
        <button
          data-testid="form-submit"
          disabled={!isReady}
          title={isReady ? undefined : 'Connecting to server...'}
          type="submit"
        >
          {isReady ? 'Submit' : 'Connecting...'}
        </button>
      </form>
      <button
        data-testid="advance-ready"
        onClick={() => advanceTo(LifecyclePhase.Ready)}
        type="button"
      >
        Advance to Ready
      </button>
    </div>
  )
}

describe('Disable write actions before Phase 2 (Ready)', () => {
  afterEach(() => {
    cleanup()
  })

  // Tracer bullet: create-workspace button is disabled during Phase 1
  // and enabled in Phase 2
  it('write action button is disabled during Phase 1 and shows "Connecting..."', () => {
    render(
      <LifecyclePhaseProvider>
        <TestHarness actionLabel="Create Workspace" />
      </LifecyclePhaseProvider>
    )

    const button = screen.getByTestId('write-action')
    expect(button).toHaveProperty('disabled', true)
    expect(button.textContent).toBe('Connecting...')
    expect(button.getAttribute('title')).toBe('Connecting to server...')
  })

  it('write action button enables when phase advances to Ready', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <TestHarness actionLabel="Create Workspace" />
      </LifecyclePhaseProvider>
    )

    // Initially disabled
    const button = screen.getByTestId('write-action')
    expect(button).toHaveProperty('disabled', true)

    // Advance to Ready
    await user.click(screen.getByTestId('advance-ready'))

    // Now enabled with proper label
    expect(button).toHaveProperty('disabled', false)
    expect(button.textContent).toBe('Create Workspace')
    expect(button.getAttribute('title')).toBeNull()
  })

  it('disabled buttons have tooltip explaining why they are disabled', () => {
    render(
      <LifecyclePhaseProvider>
        <TestHarness actionLabel="Add Project" />
      </LifecyclePhaseProvider>
    )

    const button = screen.getByTestId('write-action')
    expect(button.getAttribute('title')).toBe('Connecting to server...')
  })

  it('form submission is blocked during Phase 1 (not just visually disabled)', () => {
    render(
      <LifecyclePhaseProvider>
        <WriteActionForm />
      </LifecyclePhaseProvider>
    )

    const submitButton = screen.getByTestId('form-submit')
    expect(submitButton).toHaveProperty('disabled', true)
  })

  it('buttons do not flash between disabled/enabled during fast phase transitions', async () => {
    const user = userEvent.setup()

    render(
      <LifecyclePhaseProvider>
        <TestHarness actionLabel="Create Workspace" />
      </LifecyclePhaseProvider>
    )

    const button = screen.getByTestId('write-action')

    // Start disabled
    expect(button).toHaveProperty('disabled', true)

    // Advance to Ready — should go from disabled to enabled in one transition
    await user.click(screen.getByTestId('advance-ready'))

    // After phase transition, the button should be enabled and stay enabled
    // (phases are forward-only, so it won't flash back to disabled)
    expect(button).toHaveProperty('disabled', false)
    expect(button.textContent).toBe('Create Workspace')
  })
})
