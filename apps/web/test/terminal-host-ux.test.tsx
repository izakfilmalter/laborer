import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TerminalHostStatusPill } from '../src/components/service-status-dots'
import {
  isTerminalRevival,
  TerminalRevivalMarker,
} from '../src/components/terminal-revival-marker'

describe('terminal host UX', () => {
  it('marks tier-iii revival without claiming the process survived', () => {
    render(<TerminalRevivalMarker />)

    expect(screen.getByTestId('terminal-revival-marker').textContent).toContain(
      'History restored — process was restarted'
    )
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
