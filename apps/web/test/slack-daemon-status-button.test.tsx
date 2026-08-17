import { TooltipProvider } from '@laborer/ui/components/tooltip'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlackDaemonStatusButton } from '@/components/slack-daemon-status-button'

const STATUS_TRIGGER_PATTERN = /Slack daemon status/
const STATUS_LABELS = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
} as const

afterEach(cleanup)

describe('SlackDaemonStatusButton', () => {
  it.each([
    'running',
    'stopped',
    'error',
  ] as const)('shows %s status', async (status) => {
    render(
      <TooltipProvider>
        <SlackDaemonStatusButton
          onStart={vi.fn()}
          onStop={vi.fn()}
          starting={false}
          status={{ status }}
          stopping={false}
        />
      </TooltipProvider>
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: `Slack daemon status: ${STATUS_LABELS[status].toLowerCase()}`,
      })
    )

    expect(await screen.findByText(STATUS_LABELS[status])).toBeTruthy()
  })

  it('offers start when stopped and disables it while starting', async () => {
    const onStart = vi.fn()
    render(
      <TooltipProvider>
        <SlackDaemonStatusButton
          onStart={onStart}
          onStop={vi.fn()}
          starting={false}
          status={{ status: 'stopped' }}
          stopping={false}
        />
      </TooltipProvider>
    )

    fireEvent.click(
      screen.getByRole('button', { name: STATUS_TRIGGER_PATTERN })
    )
    const startButton = await screen.findByRole('button', {
      name: 'Start Slack daemon',
    })
    expect(startButton.hasAttribute('disabled')).toBe(false)

    cleanup()
    render(
      <TooltipProvider>
        <SlackDaemonStatusButton
          onStart={onStart}
          onStop={vi.fn()}
          starting={true}
          status={{ status: 'stopped' }}
          stopping={false}
        />
      </TooltipProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: STATUS_TRIGGER_PATTERN })
    )

    const startingButton = await screen.findByRole('button', {
      name: 'Starting Slack daemon',
    })
    expect(startingButton.hasAttribute('disabled')).toBe(true)
  })

  it('offers only stop when running and disables it while stopping', async () => {
    const onStop = vi.fn()
    render(
      <TooltipProvider>
        <SlackDaemonStatusButton
          onStart={vi.fn()}
          onStop={onStop}
          starting={false}
          status={{ status: 'running' }}
          stopping={true}
        />
      </TooltipProvider>
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Slack daemon status: stopping' })
    )
    expect(
      screen.queryByRole('button', { name: 'Start Slack daemon' })
    ).toBeNull()
    const stopButton = await screen.findByRole('button', {
      name: 'Stopping Slack daemon',
    })
    expect(stopButton.hasAttribute('disabled')).toBe(true)
  })

  it('shows no action after an action failure leaves error status', async () => {
    render(
      <TooltipProvider>
        <SlackDaemonStatusButton
          onStart={vi.fn()}
          onStop={vi.fn()}
          starting={false}
          status={{ status: 'error' }}
          stopping={false}
        />
      </TooltipProvider>
    )

    fireEvent.click(
      screen.getByRole('button', { name: STATUS_TRIGGER_PATTERN })
    )
    await screen.findByText('Error')
    expect(screen.queryByText('Start Slack daemon')).toBeNull()
    expect(screen.queryByText('Stop Slack daemon')).toBeNull()
  })
})
