/**
 * The way back to the Slack thread a piece of work came from.
 *
 * The control only exists when the work has a thread, and it opens that thread
 * outside the app without activating the card it sits on.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openExternalFn, taskRowsRef } = vi.hoisted(() => ({
  openExternalFn: vi.fn(),
  taskRowsRef: { current: [] as ReadonlyArray<{ slackPermalink: string }> },
}))

vi.mock('@/lib/local-api', () => ({
  localApi: { openExternal: openExternalFn },
}))

vi.mock('@/db/shared-state', () => ({ taskCollection: {} }))

vi.mock('@tanstack/db', () => ({ eq: vi.fn() }))

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({ data: taskRowsRef.current }),
}))

const { OpenSlackThreadButton, SlackThreadButton } = await import(
  '@/components/open-slack-thread-button'
)

afterEach(() => {
  cleanup()
  openExternalFn.mockClear()
  taskRowsRef.current = []
})

describe('SlackThreadButton', () => {
  it('opens the thread outside the app', async () => {
    const user = userEvent.setup()
    render(
      <SlackThreadButton slackPermalink="https://slack.com/archives/C1/p1" />
    )

    await user.click(screen.getByRole('button', { name: 'Open Slack thread' }))

    expect(openExternalFn).toHaveBeenCalledWith(
      'https://slack.com/archives/C1/p1'
    )
  })

  it('leaves the card alone when the work did not come from Slack', () => {
    render(<SlackThreadButton slackPermalink={null} />)

    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('OpenSlackThreadButton', () => {
  it('finds the thread through the task backing the workspace', async () => {
    const user = userEvent.setup()
    taskRowsRef.current = [
      { slackPermalink: 'https://slack.com/archives/C2/p2' },
    ]
    render(<OpenSlackThreadButton workspaceId="task-1" />)

    await user.click(screen.getByRole('button', { name: 'Open Slack thread' }))

    expect(openExternalFn).toHaveBeenCalledWith(
      'https://slack.com/archives/C2/p2'
    )
  })

  it('renders nothing when no task backs the workspace', () => {
    render(<OpenSlackThreadButton workspaceId="root" />)

    expect(screen.queryByRole('button')).toBeNull()
  })
})
