import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { Effect, Fiber, Stream } from 'effect'
import { useCallback, useEffect, useRef, useState } from 'react'

import { TerminalServiceClient } from '@/atoms/terminal-service-client'

const ACK_BATCH_CHARS = 5000
const INPUT_WRITE_BYTES = 64 * 1024
const INPUT_PENDING_BYTES = 64 * 1024
const encoder = new TextEncoder()

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
type TerminalStatus = 'running' | 'stopped' | 'restarted'
type ReplayStatus = 'idle' | 'replaying' | 'complete'

interface Options {
  readonly onData: (data: string, cursor: number, commit: () => void) => void
  readonly onReset: () => void
  readonly onSnapshot: (
    data: string,
    cursor: number,
    commit: () => void
  ) => void
  readonly onStatus?: (status: TerminalStatus, exitCode?: number) => void
  readonly terminalId: string
}

export function useTerminalRpc({
  terminalId,
  onData,
  onReset,
  onSnapshot,
  onStatus,
}: Options) {
  useAtomMount(TerminalServiceClient.runtime)
  const runtimeResult = useAtomValue(TerminalServiceClient.runtime)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalStatus>('running')
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>('idle')
  const cursorRef = useRef<number | undefined>(undefined)
  const epochRef = useRef<string | undefined>(undefined)
  const unackedCharsRef = useRef(0)
  const callbacksRef = useRef({ onData, onReset, onSnapshot, onStatus })
  callbacksRef.current = { onData, onReset, onSnapshot, onStatus }

  const acknowledgeRef = useRef<
    (cursor: number, chars: number, force?: boolean) => void
  >(() => undefined)

  useEffect(() => {
    if (runtimeResult._tag !== 'Success') {
      return
    }
    const runtime = runtimeResult.value
    const leaseId = globalThis.crypto.randomUUID()
    let active = true

    const sendAck = (cursor: number, chars: number, force = false) => {
      if (!active) {
        return
      }
      cursorRef.current = cursor
      unackedCharsRef.current += chars
      if (!force && unackedCharsRef.current < ACK_BATCH_CHARS) {
        return
      }
      unackedCharsRef.current = 0
      Effect.runForkWith(runtime)(
        Effect.gen(function* () {
          const client = yield* TerminalServiceClient
          yield* client('terminal.ack', {
            id: terminalId,
            leaseId,
            cursor,
          })
        }).pipe(Effect.catch(() => Effect.void))
      )
    }
    acknowledgeRef.current = sendAck

    const handle = (event: TerminalAttachEvent): void => {
      if (!active) {
        return
      }
      switch (event._tag) {
        case 'Reset':
          cursorRef.current = undefined
          epochRef.current = event.epoch
          callbacksRef.current.onReset()
          setReplayStatus('replaying')
          return
        case 'Snapshot':
          setReplayStatus('replaying')
          callbacksRef.current.onSnapshot(event.data, event.cursor, () =>
            sendAck(event.cursor, event.data.length)
          )
          return
        case 'Delta':
          if (
            cursorRef.current !== undefined &&
            event.cursor <= cursorRef.current
          ) {
            return
          }
          callbacksRef.current.onData(event.data, event.cursor, () =>
            sendAck(event.cursor, event.data.length)
          )
          return
        case 'Meta':
          epochRef.current = event.epoch
          setTerminalStatus(event.status)
          callbacksRef.current.onStatus?.(event.status)
          setStatus('connected')
          return
        case 'ReplayComplete':
          setReplayStatus('complete')
          if (cursorRef.current !== undefined) {
            sendAck(cursorRef.current, 0, true)
          }
          return
        case 'Exit':
          setTerminalStatus('stopped')
          callbacksRef.current.onStatus?.('stopped', event.exitCode)
          return
        default: {
          event satisfies never
          return
        }
      }
    }

    const attach = Effect.suspend(() =>
      Effect.gen(function* () {
        setStatus('connecting')
        const client = yield* TerminalServiceClient
        const stream = client('terminal.attach', {
          id: terminalId,
          leaseId,
          ...(cursorRef.current === undefined
            ? {}
            : { cursor: cursorRef.current }),
          ...(epochRef.current === undefined
            ? {}
            : { epoch: epochRef.current }),
        })
        yield* Stream.runForEach(stream, (event) =>
          Effect.sync(() => handle(event))
        )
      })
    ).pipe(Effect.tapError(() => Effect.sync(() => setStatus('disconnected'))))

    const fiber = Effect.runForkWith(runtime)(attach)
    return () => {
      active = false
      acknowledgeRef.current = () => undefined
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [runtimeResult, terminalId])

  const inputQueueRef = useRef<Array<{ data: string; bytes: number }>>([])
  const inputBytesRef = useRef(0)
  const writingRef = useRef(false)

  const send = useCallback(
    (data: string) => {
      if (runtimeResult._tag !== 'Success') {
        return
      }
      const bytes = encoder.encode(data).length
      if (
        bytes > INPUT_WRITE_BYTES ||
        inputBytesRef.current + bytes > INPUT_PENDING_BYTES
      ) {
        console.error(
          `Terminal input overflow for ${terminalId}; input was not dropped silently`
        )
        setStatus('disconnected')
        return
      }
      inputQueueRef.current.push({ data, bytes })
      inputBytesRef.current += bytes
      if (writingRef.current) {
        return
      }
      writingRef.current = true
      const runtime = runtimeResult.value
      const drain = async () => {
        while (inputQueueRef.current.length > 0) {
          const item = inputQueueRef.current[0]
          if (!item) {
            break
          }
          try {
            await Effect.runPromiseWith(runtime)(
              Effect.gen(function* () {
                const client = yield* TerminalServiceClient
                yield* client('terminal.write', {
                  id: terminalId,
                  data: item.data,
                })
              })
            )
            inputQueueRef.current.shift()
            inputBytesRef.current -= item.bytes
          } catch (error) {
            console.error('Terminal input write failed', error)
            setStatus('disconnected')
            // A failed RPC has ambiguous delivery. Never retain later
            // keystrokes for an automatic retry: replaying terminal input can
            // execute a command twice or deliver it to a different prompt.
            inputQueueRef.current.length = 0
            inputBytesRef.current = 0
            break
          }
        }
        writingRef.current = false
      }
      drain().catch((error: unknown) => {
        console.error('Terminal input queue failed', error)
      })
    },
    [runtimeResult, terminalId]
  )

  return { replayStatus, send, status, terminalStatus }
}
