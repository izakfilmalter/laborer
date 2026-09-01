import { describe, expect, it } from 'vitest'

import { terminalLoadingMessage } from '../src/panes/terminal-loading-state'

describe('terminal loading state', () => {
  it('reveals the terminal once the daemon reports its replay complete', () => {
    // Ghostty parses synchronously, so `complete` also means "on screen".
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: 'complete' })
    ).toBeUndefined()
  })

  it('covers the old buffer while a reconnect replay is in progress', () => {
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: 'replaying' })
    ).toBe('Restoring terminal...')
  })

  it('shows startup while a fresh pane waits for its first replay', () => {
    expect(
      terminalLoadingMessage({ isRunning: true, replayStatus: 'idle' })
    ).toBe('Starting terminal...')
  })

  it('covers a stopped terminal while its final screen replays', () => {
    expect(
      terminalLoadingMessage({ isRunning: false, replayStatus: 'replaying' })
    ).toBe('Restoring terminal...')
  })

  it('never promises startup for a process that has exited', () => {
    expect(
      terminalLoadingMessage({ isRunning: false, replayStatus: 'idle' })
    ).toBeUndefined()
  })
})
