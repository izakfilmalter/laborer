import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useTerminalMessagePort } from '../src/hooks/use-terminal-messageport'

const acquireTerminalDataPortMock =
  vi.fn<(terminalId: string) => Promise<MessagePort | null>>()

vi.mock('@/lib/desktop', () => ({
  acquireTerminalDataPort: (terminalId: string) =>
    acquireTerminalDataPortMock(terminalId),
}))

afterEach(() => {
  cleanup()
  acquireTerminalDataPortMock.mockReset()
})

describe('useTerminalMessagePort', () => {
  it('emits replay lifecycle without flattening replay frames into onData', async () => {
    const { port1, port2 } = new MessageChannel()
    acquireTerminalDataPortMock.mockResolvedValue(port1)

    const events: string[] = []

    const { result } = renderHook(() =>
      useTerminalMessagePort({
        terminalId: 'terminal-1',
        onData: (data) => {
          events.push(`data:${data}`)
        },
        onReplayStart: (replayEvent) => {
          events.push(
            `replay-start:${replayEvent.commands?.commands[0]?.command ?? 'none'}:${replayEvent.events
              .map((frame) => `${frame.cols}x${frame.rows}:${frame.data}`)
              .join('|')}`
          )
        },
        onReplayComplete: () => {
          events.push('replay-complete')
        },
      })
    )

    await waitFor(() => {
      expect(result.current.status).toBe('connected')
    })

    act(() => {
      port2.postMessage(JSON.stringify({ type: 'status', status: 'running' }))
      port2.postMessage(
        JSON.stringify({
          type: 'replay',
          commands: {
            isWindowsPty: false,
            hasRichCommandDetection: true,
            commands: [
              {
                command: 'ls',
                commandLineConfidence: 'high',
                isTrusted: true,
                timestamp: 123,
                duration: 45,
              },
            ],
          },
          events: [
            { cols: 91, rows: 27, data: 'revived-output\r\n' },
            { cols: 120, rows: 40, data: '$ ' },
          ],
        })
      )
      port2.postMessage(JSON.stringify({ type: 'replayComplete' }))
    })

    await waitFor(() => {
      expect(result.current.replayStatus).toBe('complete')
    })

    expect(events).toEqual([
      'replay-start:ls:91x27:revived-output\r\n|120x40:$ ',
      'replay-complete',
    ])
  })
})
