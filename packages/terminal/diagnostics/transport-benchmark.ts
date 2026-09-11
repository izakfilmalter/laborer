import { NodeSocket } from '@effect/platform-node'
import { TerminalRpcs } from '@laborer/shared/rpc'
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import { createSequenceMarkerParser } from './sequence-marker-parser.js'
import type { DiagnosticMode } from './transport-server.js'

const MakeTerminalRpcClient = RpcClient.make(TerminalRpcs)
type TerminalRpcClient = Effect.Success<typeof MakeTerminalRpcClient>

export interface BenchmarkOptions {
  readonly lane: 'concurrent' | 'serial'
  readonly rate: number
  readonly samples: number
  readonly timeoutMs: number
  readonly url: string
}

export interface LatencySummary {
  readonly max: number | null
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
}

export interface SampleTimeline {
  readonly offeredAtMs: number
  readonly outputAtMs: number | null
  readonly returnedAtMs: number | null
  readonly sentAtMs: number | null
  readonly sequence: number
}

export interface BenchmarkTarget {
  readonly loadBlockMs: number | null
  readonly loadEveryMs: number | null
  readonly mode: DiagnosticMode | 'unknown'
}

export interface BenchmarkReport {
  readonly ackFailures: number
  readonly duplicateSamples: number
  readonly inputToOutputMs: LatencySummary
  readonly lane: 'concurrent' | 'serial'
  readonly missingSamples: readonly number[]
  readonly mode: 'transport-roundtrip'
  readonly observedSamples: number
  readonly offeredToSentMs: LatencySummary
  readonly reorderedSamples: number
  readonly requestedRate: number
  readonly requestedSamples: number
  readonly rpcFailures: number
  readonly rpcReturnMs: LatencySummary
  readonly rpcTimeouts: number
  readonly runId: string
  readonly samples: readonly SampleTimeline[]
  readonly sentToOutputMs: LatencySummary
  readonly target: BenchmarkTarget
  readonly timeoutMs: number
  readonly url: string
}

class DiagnosticTimeoutError extends Error {}

const TargetSchema = Schema.Struct({
  loadBlockMs: Schema.Number,
  loadEveryMs: Schema.Number,
  mode: Schema.Literals(['minimal', 'pty']),
  status: Schema.Literal('ok'),
})

const percentile = (
  sorted: readonly number[],
  fraction: number
): number | null => {
  if (sorted.length === 0) {
    return null
  }
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
}

const summarize = (values: readonly number[]): LatencySummary => {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    max: sorted.at(-1) ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Run an Effect with a wall-clock deadline and interrupt its fiber on expiry. */
const runEffectWithDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  timeoutMs: number,
  label: string
): Promise<A> => {
  const fiber = Effect.runFork(effect)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      Effect.runFork(Fiber.interrupt(fiber))
      reject(
        new DiagnosticTimeoutError(`${label} timed out after ${timeoutMs}ms`)
      )
    }, timeoutMs)
  })
  return Promise.race([Effect.runPromise(Fiber.join(fiber)), timeout]).finally(
    () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  )
}

const targetFor = async (
  url: string,
  timeoutMs: number
): Promise<BenchmarkTarget> => {
  const healthUrl = new URL(url)
  healthUrl.protocol = healthUrl.protocol === 'wss:' ? 'https:' : 'http:'
  healthUrl.pathname = '/health'
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const decoded = Schema.decodeUnknownSync(TargetSchema)(
      await response.json()
    )
    return {
      loadBlockMs: decoded.loadBlockMs,
      loadEveryMs: decoded.loadEveryMs,
      mode: decoded.mode,
    }
  } catch {
    return { loadBlockMs: null, loadEveryMs: null, mode: 'unknown' }
  }
}

export const runTransportBenchmark = async (
  options: BenchmarkOptions
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A single orchestration preserves the timestamp timeline and guarantees cleanup across every acquisition stage.
): Promise<BenchmarkReport> => {
  const startedAt = performance.now()
  const relativeNow = () => performance.now() - startedAt
  const scope = Effect.runSync(Scope.make())
  const runId = crypto.randomUUID().replaceAll('-', '')
  const prefix = `__LABORER_TRANSPORT_${runId}_`
  const markerParser = createSequenceMarkerParser(prefix)
  const offeredAt = new Map<number, number>()
  const sentAt = new Map<number, number>()
  const returnedAt = new Map<number, number>()
  const observedAt = new Map<number, number>()
  const observationOrder: number[] = []
  let duplicates = 0
  let ackFailures = 0
  let rpcFailures = 0
  let rpcTimeouts = 0
  let attachFiber: Fiber.Fiber<unknown, unknown> | undefined
  let client: TerminalRpcClient | undefined
  let terminalId = `diagnostic-terminal-${runId}`
  const ackPromises: Promise<void>[] = []

  const targetPromise = targetFor(options.url, options.timeoutMs)
  try {
    const protocolLayer = RpcClient.layerProtocolSocket({
      retryTransientErrors: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeSocket.layerWebSocket(options.url),
          RpcSerialization.layerJson
        )
      )
    )
    const protocolContext = await runEffectWithDeadline(
      Layer.buildWithScope(protocolLayer, scope),
      options.timeoutMs,
      'RPC protocol acquisition'
    )
    client = await runEffectWithDeadline(
      MakeTerminalRpcClient.pipe(
        Effect.provide(Layer.succeedContext(protocolContext)),
        Scope.provide(scope)
      ),
      options.timeoutMs,
      'RPC client acquisition'
    )
    const rpcClient = client
    const terminal = await runEffectWithDeadline(
      rpcClient['terminal.spawn']({
        command: 'stty raw -echo; cat',
        cwd: process.cwd(),
        cols: 80,
        id: terminalId,
        rows: 24,
        workspaceId: 'transport-diagnostic',
      }),
      options.timeoutMs,
      'terminal.spawn'
    )
    terminalId = terminal.id
    const leaseId = `diagnostic-${runId}`
    const warmupToken = `__LABORER_WARMUP_${runId}__`
    let warmupOutput = ''
    let replayReadyResolve: (() => void) | undefined
    let warmupResolve: (() => void) | undefined
    const replayReady = new Promise<void>((resolve) => {
      replayReadyResolve = resolve
    })
    const warmupObserved = new Promise<void>((resolve) => {
      warmupResolve = resolve
    })

    attachFiber = Effect.runFork(
      client['terminal.attach']({ id: terminal.id, leaseId }).pipe(
        Stream.runForEach((event) =>
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This ordered callback owns attach readiness, marker observation, duplicate detection, and cursor acknowledgement.
          Effect.sync(() => {
            if (event._tag === 'ReplayComplete') {
              replayReadyResolve?.()
              return
            }
            if (event._tag !== 'Delta') {
              return
            }
            const warmupCandidate = warmupOutput + event.data
            if (warmupCandidate.includes(warmupToken)) {
              warmupResolve?.()
            }
            warmupOutput = warmupCandidate.slice(-8192)
            for (const sequence of markerParser.write(event.data)) {
              if (!sentAt.has(sequence)) {
                continue
              }
              if (observedAt.has(sequence)) {
                duplicates += 1
              } else {
                observedAt.set(sequence, relativeNow())
                observationOrder.push(sequence)
              }
            }
            ackPromises.push(
              runEffectWithDeadline(
                rpcClient['terminal.ack']({
                  cursor: event.cursor,
                  id: terminal.id,
                  leaseId,
                }),
                options.timeoutMs,
                'terminal.ack'
              ).catch(() => {
                ackFailures += 1
              })
            )
          })
        )
      )
    )

    await Promise.race([
      replayReady,
      sleep(options.timeoutMs).then(() => {
        throw new DiagnosticTimeoutError('terminal.attach replay timed out')
      }),
    ])
    await runEffectWithDeadline(
      rpcClient['terminal.write']({
        id: terminal.id,
        data: `${warmupToken}\n`,
      }),
      options.timeoutMs,
      'warm-up terminal.write'
    )
    await Promise.race([
      warmupObserved,
      sleep(options.timeoutMs).then(() => {
        throw new DiagnosticTimeoutError('PTY warm-up output timed out')
      }),
    ])
    await sleep(20)

    const intervalMs = options.rate > 0 ? 1000 / options.rate : 0
    const writes: Promise<void>[] = []
    let serialLane = Promise.resolve()
    let laneActive = true
    const offerStartedAt = performance.now()
    const send = async (sequence: number): Promise<void> => {
      if (!laneActive) {
        return
      }
      sentAt.set(sequence, relativeNow())
      try {
        await runEffectWithDeadline(
          rpcClient['terminal.write']({
            id: terminal.id,
            data: `${prefix}${String(sequence)}__\n`,
          }),
          options.timeoutMs,
          `terminal.write sample ${sequence}`
        )
        returnedAt.set(sequence, relativeNow())
      } catch (error) {
        rpcFailures += 1
        if (error instanceof DiagnosticTimeoutError) {
          rpcTimeouts += 1
        }
        if (options.lane === 'serial') {
          laneActive = false
        }
      }
    }
    for (let sequence = 0; sequence < options.samples; sequence += 1) {
      const dueAt = offerStartedAt + sequence * intervalMs
      if (intervalMs > 0) {
        await sleep(Math.max(0, dueAt - performance.now()))
      }
      offeredAt.set(sequence, relativeNow())
      const write =
        options.lane === 'serial'
          ? serialLane.then(() => send(sequence))
          : send(sequence)
      if (options.lane === 'serial') {
        serialLane = write
      }
      writes.push(write)
    }
    await Promise.all(writes)

    const outputDeadline = performance.now() + options.timeoutMs
    while (
      observedAt.size < options.samples &&
      performance.now() < outputDeadline
    ) {
      await sleep(5)
    }
    await Promise.all(ackPromises)

    const samples: SampleTimeline[] = []
    const missingSamples: number[] = []
    const inputToOutput: number[] = []
    const offeredToSent: number[] = []
    const rpcReturn: number[] = []
    const sentToOutput: number[] = []
    for (let sequence = 0; sequence < options.samples; sequence += 1) {
      const offered = offeredAt.get(sequence)
      if (offered === undefined) {
        throw new Error(`Missing offered timestamp for sample ${sequence}`)
      }
      const sent = sentAt.get(sequence) ?? null
      const returned = returnedAt.get(sequence) ?? null
      const output = observedAt.get(sequence) ?? null
      samples.push({
        offeredAtMs: offered,
        outputAtMs: output,
        returnedAtMs: returned,
        sentAtMs: sent,
        sequence,
      })
      if (sent === null || output === null) {
        missingSamples.push(sequence)
        continue
      }
      inputToOutput.push(output - offered)
      offeredToSent.push(sent - offered)
      sentToOutput.push(output - sent)
      if (returned !== null) {
        rpcReturn.push(returned - sent)
      }
    }
    let reorderedSamples = 0
    let greatest = -1
    for (const sequence of observationOrder) {
      if (sequence < greatest) {
        reorderedSamples += 1
      }
      greatest = Math.max(greatest, sequence)
    }

    return {
      ackFailures,
      duplicateSamples: duplicates,
      inputToOutputMs: summarize(inputToOutput),
      lane: options.lane,
      missingSamples,
      mode: 'transport-roundtrip',
      observedSamples: observedAt.size,
      offeredToSentMs: summarize(offeredToSent),
      reorderedSamples,
      requestedRate: options.rate,
      requestedSamples: options.samples,
      rpcFailures,
      rpcReturnMs: summarize(rpcReturn),
      rpcTimeouts,
      runId,
      samples,
      sentToOutputMs: summarize(sentToOutput),
      target: await targetPromise,
      timeoutMs: options.timeoutMs,
      url: options.url,
    }
  } finally {
    if (attachFiber !== undefined) {
      await runEffectWithDeadline(
        Fiber.interrupt(attachFiber),
        options.timeoutMs,
        'attach interruption'
      ).catch(() => undefined)
    }
    if (client !== undefined) {
      await runEffectWithDeadline(
        client['terminal.remove']({ id: terminalId }).pipe(Effect.ignore),
        options.timeoutMs,
        'terminal cleanup'
      ).catch(() => undefined)
    }
    await runEffectWithDeadline(
      Scope.close(scope, Exit.void),
      options.timeoutMs,
      'RPC scope cleanup'
    ).catch(() => undefined)
  }
}
