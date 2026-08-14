import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHostStatusPill } from '../src/components/service-status-dots'
import {
  isTerminalRevival,
  TerminalRevivalMarker,
} from '../src/components/terminal-revival-marker'

describe('terminal host UX', () => {
  afterEach(() => {
    cleanup()
  })

  it('marks tier-iii revival without claiming the process survived', () => {
    render(<TerminalRevivalMarker />)

    expect(screen.getByTestId('terminal-revival-marker').textContent).toContain(
      'History restored — process was restarted'
    )
  })

  it('lets the operator acknowledge the revival marker', async () => {
    const dismiss = vi.fn()
    render(<TerminalRevivalMarker onDismiss={dismiss} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss restored history notice' })
    )
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('keeps same-epoch cursor fallback silent', () => {
    expect(isTerminalRevival('cursor_out_of_range')).toBe(false)
    expect(isTerminalRevival('epoch_changed')).toBe(true)
  })

  it('makes an outdated host explicitly restartable', async () => {
    const restart = vi.fn()
    render(
      <TerminalHostStatusPill
        onRestart={restart}
        status={{
          expectedVersion: '2',
          runningVersion: '1',
          state: 'outdated',
        }}
      />
    )

    expect(screen.getByText('Terminal host outdated')).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: 'Restart terminal host' })
    )
    expect(restart).toHaveBeenCalledOnce()
  })

  it('keeps host versions in the detail rather than the summary', () => {
    render(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{
          expectedVersion: '2',
          runningVersion: '1',
          state: 'outdated',
        }}
      />
    )

    const pill = screen.getByTestId('terminal-host-status')
    expect(screen.getByText('Terminal host outdated').textContent).toBe(
      'Terminal host outdated'
    )
    expect(pill.textContent).toContain('Running 1, expected 2.')
  })

  it('separates an outdated host from a lost one by tone', () => {
    const { rerender } = render(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{
          expectedVersion: '2',
          runningVersion: '1',
          state: 'outdated',
        }}
      />
    )
    expect(screen.getByTestId('terminal-host-status').dataset.tone).toBe(
      'update'
    )

    rerender(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{ expectedVersion: '2', state: 'unavailable' }}
      />
    )
    expect(screen.getByTestId('terminal-host-status').dataset.tone).toBe(
      'critical'
    )
  })

  it('offers manual restart for an unresponsive host instead of killing it', async () => {
    const restart = vi.fn()
    render(
      <TerminalHostStatusPill
        onRestart={restart}
        status={{
          expectedVersion: '1',
          runningVersion: '1',
          state: 'unresponsive',
        }}
      />
    )

    expect(screen.getByText('Terminal host unresponsive')).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: 'Restart terminal host' })
    )
    expect(restart).toHaveBeenCalledOnce()
  })

  it('keeps a delayed host advisory with no restart action', () => {
    render(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{ expectedVersion: '1', runningVersion: '1', state: 'warning' }}
      />
    )

    expect(screen.getByTestId('terminal-host-status').dataset.tone).toBe(
      'advisory'
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows an in-flight restart without re-offering the action', () => {
    render(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{
          expectedVersion: '2',
          runningVersion: '1',
          state: 'restarting',
        }}
      />
    )

    expect(screen.getByText('Restarting terminal host…')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Restart terminal host' })
    ).toHaveProperty('disabled', true)
  })

  it('keeps healthy host detail out of the status hierarchy', () => {
    const { container } = render(
      <TerminalHostStatusPill
        onRestart={() => undefined}
        status={{
          expectedVersion: '1',
          runningVersion: '1',
          state: 'healthy',
        }}
      />
    )

    expect(container.childElementCount).toBe(0)
  })
})
