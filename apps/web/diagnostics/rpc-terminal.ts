import { type TerminalAttachEvent, TerminalRpcs } from '@laborer/shared/rpc'
import { Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'

const MAX_RECORDS = 2000
const MAX_PENDING_BYTES = 64 * 1024
const MAX_RECORDED_OUTPUT_CHARS = 2 * 1024 * 1024
const STARTUP_QUIET_MS = 750
const STARTUP_SETTLE_MAX_MS = 15_000
const encoder = new TextEncoder()
const RPC_TIMEOUT_MS = 5000

export interface RpcWriteTiming {
  readonly data: string
  error?: string
  readonly id: number
  readonly offeredAt: number
  outputAt?: number
  returnedAt?: number
  sentAt?: number
}

export interface RpcAttachRecord {
  readonly at: number
  readonly cursor?: number
  readonly data?: string
  readonly dataTruncated?: boolean
  readonly epoch?: string
  readonly tag: TerminalAttachEvent['_tag']
}

export interface RpcAckRecord {
  readonly cursor: number
  error?: string
  readonly offeredAt: number
  returnedAt?: number
}

export interface RpcDiagnosticSnapshot {
  readonly acknowledgements: readonly RpcAckRecord[]
  readonly attachEvents: readonly RpcAttachRecord[]
  readonly error: string | null
  readonly expectedOutput: string
  readonly measurementCapped: boolean
  readonly observedOutput: string
  readonly outputExact: boolean
  readonly pendingBytes: number
  readonly renderedPromptVerified: boolean
  readonly terminalId: string
  readonly url: string
  readonly verificationMode: 'raw-exact' | 'tui-viewport'
  readonly writes: readonly RpcWriteTiming[]
}

interface RpcTerminalOptions {
  readonly command?: string
  readonly onEvent: (event: TerminalAttachEvent) => void
  readonly onOutput: (
    data: string,
    at: number,
    sampleIds: readonly number[]
  ) => void
  readonly terminalId?: string
  readonly url: string
}

export interface RpcTerminalConnection {
  readonly beginRun: () => void
  readonly close: () => Promise<void>
  readonly markRendered: (sampleIds: readonly number[], at: number) => void
  readonly offer: (data: string, id: number) => boolean
  readonly snapshot: () => RpcDiagnosticSnapshot
  readonly terminalId: string
  readonly verificationMode: 'raw-exact' | 'tui-viewport'
  readonly waitForOutput: (timeoutMs?: number) => Promise<void>
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const runEffectWithDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  label: string
): Promise<A> => {
  const fiber = Effect.runFork(effect)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      Effect.runFork(Fiber.interrupt(fiber))
      reject(new Error(`${label} timed out after ${String(RPC_TIMEOUT_MS)} ms`))
    }, RPC_TIMEOUT_MS)
  })
  return Promise.race([Effect.runPromise(Fiber.join(fiber)), timeout]).finally(
    () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  )
}

export const connectRpcTerminal = async (
  options: RpcTerminalOptions
): Promise<RpcTerminalConnection> => {
  const socket = layerWebSocket(options.url).pipe(
    Layer.provide(layerWebSocketConstructorGlobal)
  )
  const protocolLayer = RpcClient.layerProtocolSocket({
    retryTransientErrors: false,
  }).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)))
  const scope = Effect.runSync(Scope.make())
  let removeOwnedTerminal: (() => Promise<void>) | undefined
  try {
    const protocolContext = await runEffectWithDeadline(
      Layer.buildWithScope(protocolLayer, scope),
      'RPC protocol acquisition'
    )
    const client = await runEffectWithDeadline(
      RpcClient.make(TerminalRpcs).pipe(
        Effect.provide(Layer.succeedContext(protocolContext)),
        Scope.provide(scope)
      ),
      'RPC client acquisition'
    )
    const requestedId = options.terminalId?.trim() || crypto.randomUUID()
    const terminals = await runEffectWithDeadline(
      client['terminal.list'](),
      'terminal.list'
    )
    const existing = terminals.find((terminal) => terminal.id === requestedId)
    const terminal =
      existing ??
      (await runEffectWithDeadline(
        client['terminal.spawn']({
          args: [],
          cols: 120,
          command: options.command ?? 'stty raw -echo; cat',
          cwd: '.',
          id: requestedId,
          rows: 30,
          workspaceId: 'browser-latency-diagnostic',
        }),
        'terminal.spawn'
      ))
    const ownsTerminal = existing === undefined
    if (ownsTerminal) {
      removeOwnedTerminal = () =>
        runEffectWithDeadline(
          client['terminal.remove']({ id: terminal.id }),
          'terminal.remove'
        )
    }
    const leaseId = `browser-diagnostic-${crypto.randomUUID()}`
    const writes: RpcWriteTiming[] = []
    const attachEvents: RpcAttachRecord[] = []
    const acknowledgements: RpcAckRecord[] = []
    const outputQueue: RpcWriteTiming[] = []
    let expectedOutput = ''
    let observedOutput = ''
    let unmatchedOutput = ''
    let pendingBytes = 0
    let pendingAcknowledgements = 0
    let lane = Promise.resolve()
    let active = true
    let connectionError: string | null = null
    let measurementCapped = false
    let lastOutputAt = 0
    let recordedOutputChars = 0
    const verificationMode =
      options.command === undefined ? 'raw-exact' : 'tui-viewport'
    let replayReadyResolve: (() => void) | undefined
    const replayReady = new Promise<void>((resolve) => {
      replayReadyResolve = resolve
    })
    const warmupToken = `__BROWSER_RPC_WARMUP_${crypto.randomUUID()}__`
    let warmupReadyResolve: (() => void) | undefined
    const warmupReady = new Promise<void>((resolve) => {
      warmupReadyResolve = resolve
    })
    let commandReadyResolve: (() => void) | undefined
    const commandReady = new Promise<void>((resolve) => {
      commandReadyResolve = resolve
    })

    const acknowledge = (cursor: number): void => {
      const record: RpcAckRecord = { cursor, offeredAt: performance.now() }
      if (acknowledgements.length < MAX_RECORDS) {
        acknowledgements.push(record)
      }
      pendingAcknowledgements += 1
      runEffectWithDeadline(
        client['terminal.ack']({ cursor, id: terminal.id, leaseId }),
        'terminal.ack'
      )
        .then(
          () => {
            record.returnedAt = performance.now()
          },
          (error: unknown) => {
            record.error = errorMessage(error)
          }
        )
        .finally(() => {
          pendingAcknowledgements -= 1
        })
    }

    const observeOutput = (data: string): void => {
      const at = performance.now()
      lastOutputAt = at
      observedOutput = `${observedOutput}${data}`.slice(-MAX_PENDING_BYTES)
      if (observedOutput.includes(warmupToken)) {
        warmupReadyResolve?.()
      }
      const sampleIds: number[] = []
      if (verificationMode === 'tui-viewport') {
        options.onOutput(data, at, sampleIds)
        return
      }
      unmatchedOutput = `${unmatchedOutput}${data}`.slice(-MAX_PENDING_BYTES)
      while (unmatchedOutput.length > 0 && outputQueue.length > 0) {
        const next = outputQueue[0]
        if (next === undefined) {
          break
        }
        if (unmatchedOutput.length < next.data.length) {
          break
        }
        if (!unmatchedOutput.startsWith(next.data)) {
          connectionError = `RPC output diverged before sample ${String(next.id)}`
          break
        }
        next.outputAt = at
        sampleIds.push(next.id)
        unmatchedOutput = unmatchedOutput.slice(next.data.length)
        outputQueue.shift()
      }
      options.onOutput(data, at, sampleIds)
    }

    const recordAttachEvent = (event: TerminalAttachEvent): void => {
      if (attachEvents.length >= MAX_RECORDS) {
        return
      }
      switch (event._tag) {
        case 'Delta':
        case 'Snapshot': {
          const data = event.data.slice(
            0,
            MAX_RECORDED_OUTPUT_CHARS - recordedOutputChars
          )
          recordedOutputChars += data.length
          attachEvents.push({
            at: performance.now(),
            cursor: event.cursor,
            data,
            dataTruncated: data.length !== event.data.length,
            tag: event._tag,
          })
          return
        }
        case 'Meta':
        case 'Reset':
          attachEvents.push({
            at: performance.now(),
            epoch: event.epoch,
            tag: event._tag,
          })
          return
        default:
          attachEvents.push({ at: performance.now(), tag: event._tag })
      }
    }

    const handleAttachEvent = (event: TerminalAttachEvent): void => {
      recordAttachEvent(event)
      options.onEvent(event)
      if (event._tag === 'Delta') {
        commandReadyResolve?.()
        observeOutput(event.data)
        acknowledge(event.cursor)
      } else if (event._tag === 'Snapshot') {
        if (event.data.length > 0) {
          commandReadyResolve?.()
        }
        acknowledge(event.cursor)
      } else if (event._tag === 'ReplayComplete') {
        replayReadyResolve?.()
      }
    }

    const attachFiber = Effect.runFork(
      client['terminal.attach']({ id: terminal.id, leaseId }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => handleAttachEvent(event))
        )
      )
    )

    const withTimeout = async (
      promise: Promise<void>,
      description: string
    ): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for ${description}`)),
              RPC_TIMEOUT_MS
            )
          }),
        ])
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
      }
    }

    await withTimeout(replayReady, 'terminal.attach replay')
    if (verificationMode === 'raw-exact') {
      await runEffectWithDeadline(
        client['terminal.write']({ data: warmupToken, id: terminal.id }),
        'terminal.write warm-up'
      )
      await withTimeout(warmupReady, 'raw PTY warm-up echo')
    } else {
      await withTimeout(commandReady, 'custom command startup output')
      // A TUI keeps drawing while it starts up. Measuring keystrokes typed
      // into that window records the program's startup backlog, not the
      // input path; wait for its output to go quiet first (bounded).
      const settleDeadline = performance.now() + STARTUP_SETTLE_MAX_MS
      while (performance.now() < settleDeadline) {
        const seen = lastOutputAt
        await new Promise((resolve) => setTimeout(resolve, STARTUP_QUIET_MS))
        if (lastOutputAt === seen) {
          break
        }
      }
    }
    expectedOutput = ''
    observedOutput = ''
    unmatchedOutput = ''

    const offer = (data: string, id: number): boolean => {
      if (!active) {
        return false
      }
      const bytes = encoder.encode(data).length
      if (pendingBytes + bytes > MAX_PENDING_BYTES) {
        connectionError = 'The serialized input lane exceeded 64 KiB'
        return false
      }
      const record: RpcWriteTiming = { data, id, offeredAt: performance.now() }
      const measured = id >= 0 && writes.length < MAX_RECORDS
      if (measured) {
        writes.push(record)
        outputQueue.push(record)
        expectedOutput += data
      } else if (id >= 0) {
        measurementCapped = true
      }
      pendingBytes += bytes
      lane = lane.then(async () => {
        if (!active) {
          return
        }
        if (measured) {
          record.sentAt = performance.now()
        }
        try {
          await runEffectWithDeadline(
            client['terminal.write']({ data, id: terminal.id }),
            'terminal.write'
          )
          if (measured) {
            record.returnedAt = performance.now()
          }
        } catch (error) {
          connectionError = errorMessage(error)
          if (measured) {
            record.error = connectionError
          }
        } finally {
          pendingBytes -= bytes
        }
      })
      return true
    }

    return {
      beginRun: () => {
        if (pendingBytes !== 0 || outputQueue.length !== 0) {
          throw new Error(
            'Cannot reset RPC measurements while input is pending'
          )
        }
        writes.length = 0
        expectedOutput = ''
        observedOutput = ''
        unmatchedOutput = ''
        connectionError = null
        measurementCapped = false
      },
      close: async () => {
        active = false
        try {
          await withTimeout(lane, 'serialized input lane')
          await runEffectWithDeadline(
            Fiber.interrupt(attachFiber),
            'attach interruption'
          )
          await removeOwnedTerminal?.()
        } finally {
          await runEffectWithDeadline(
            Scope.close(scope, Exit.void),
            'scope cleanup'
          )
        }
      },
      offer,
      markRendered: (sampleIds, at) => {
        const rendered = new Set(sampleIds)
        for (const record of outputQueue) {
          if (rendered.has(record.id)) {
            record.outputAt = at
          }
        }
        for (let index = outputQueue.length - 1; index >= 0; index -= 1) {
          const record = outputQueue[index]
          if (record !== undefined && rendered.has(record.id)) {
            outputQueue.splice(index, 1)
          }
        }
      },
      snapshot: () => ({
        acknowledgements: acknowledgements.map((record) => ({ ...record })),
        attachEvents: attachEvents.map((record) => ({ ...record })),
        error: connectionError,
        measurementCapped,
        expectedOutput,
        observedOutput,
        outputExact: expectedOutput === observedOutput,
        pendingBytes,
        terminalId: terminal.id,
        url: options.url,
        verificationMode,
        renderedPromptVerified:
          verificationMode === 'tui-viewport' &&
          expectedOutput.length > 0 &&
          outputQueue.length === 0,
        writes: writes.map((record) => ({ ...record })),
      }),
      terminalId: terminal.id,
      verificationMode,
      waitForOutput: async (timeoutMs = 5000) => {
        const deadline = performance.now() + timeoutMs
        while (
          (pendingBytes !== 0 ||
            outputQueue.length !== 0 ||
            pendingAcknowledgements !== 0) &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (
          pendingBytes !== 0 ||
          outputQueue.length !== 0 ||
          pendingAcknowledgements !== 0
        ) {
          connectionError = `Timed out after ${String(timeoutMs)} ms waiting for RPC output`
        }
      },
    }
  } catch (error) {
    await removeOwnedTerminal?.().catch(() => undefined)
    await runEffectWithDeadline(
      Scope.close(scope, Exit.void),
      'scope cleanup'
    ).catch(() => undefined)
    throw error
  }
}
