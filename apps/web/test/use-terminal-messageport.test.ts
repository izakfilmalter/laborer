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
  it('send() no-ops during replay to prevent input corruption', async () => {
    const { port1, port2 } = new MessageChannel()
    acquireTerminalDataPortMock.mockResolvedValue(port1)

    const sentToServer: string[] = []

    // Capture messages sent from the renderer to the server.
    // port1 is the renderer side, port2 is the server side.
    // The hook sends via port1.postMessage, which the server
    // receives on port2. We spy on port2's message handler.
    port2.onmessage = (event: MessageEvent) => {
      sentToServer.push(event.data as string)
    }
    port2.start?.()

    const { result } = renderHook(() =>
      useTerminalMessagePort({
        terminalId: 'terminal-replay-guard',
        onData: (_data) => {
          // Intentionally empty — output not needed for this test
        },
        onReplayStart: (_event) => {
          // Intentionally empty — replay start not needed for this test
        },
        onReplayComplete: () => {
          // Intentionally empty — replay complete not needed for this test
        },
      })
    )

    await waitFor(() => {
      expect(result.current.status).toBe('connected')
    })

    // Trigger replay — send() should now no-op.
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
          events: [{ cols: 80, rows: 24, data: 'replay-data\r\n' }],
        })
      )
    })

    await waitFor(() => {
      expect(result.current.replayStatus).toBe('replaying')
    })

    // Try to send input during replay — should be dropped.
    act(() => {
      result.current.send('input-during-replay')
    })

    // Small delay to allow any messages to propagate.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify no input was sent to the server during replay.
    const inputMessages = sentToServer.filter((msg) => !msg.startsWith('{'))
    expect(inputMessages).toEqual([])

    // Now complete replay.
    act(() => {
      port2.postMessage(JSON.stringify({ type: 'replayComplete' }))
    })

    await waitFor(() => {
      expect(result.current.replayStatus).toBe('complete')
    })

    // Send input after replay — should work.
    act(() => {
      result.current.send('input-after-replay')
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify input was sent after replay completed.
    const postReplayInput = sentToServer.filter(
      (msg) => msg === 'input-after-replay'
    )
    expect(postReplayInput).toHaveLength(1)

    port1.close()
    port2.close()
  })

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
