import { describe, expect, it } from 'vitest'

import { terminalLoadingMessage } from '../src/panes/terminal-loading-state'

describe('terminal loading state', () => {
  it('reveals an idle terminal after its restored snapshot has parsed', () => {
    expect(
      terminalLoadingMessage({
        hasReceivedData: true,
        isRunning: true,
        replayStatus: 'complete',
      })
    ).toBeUndefined()
  })

  it('covers the old buffer while a reconnect replay is in progress', () => {
    expect(
      terminalLoadingMessage({
        hasReceivedData: true,
        isRunning: true,
        replayStatus: 'replaying',
      })
    ).toBe('Restoring terminal...')
  })

  it('shows startup until the first output parses', () => {
    expect(
      terminalLoadingMessage({
        hasReceivedData: false,
        isRunning: true,
        replayStatus: 'idle',
      })
    ).toBe('Starting terminal...')
  })
})
