import type { GhosttyTheme } from '../src/terminal/ghostty/core'
import { GhosttyTerminalSurface } from '../src/terminal/ghostty/surface'
import {
  connectRpcTerminal,
  type RpcDiagnosticSnapshot,
  type RpcTerminalConnection,
} from './rpc-terminal'
import './style.css'

const MAX_SAMPLES = 2000
const MAX_STALLS = 500
const MAX_PENDING_RPC_INPUT = 256
const STALL_THRESHOLD_MS = 50
const EVENT_LOOP_INTERVAL_MS = 16
const LETTER_KEY = /^[a-z]$/i
const DIGIT_KEY = /^[0-9]$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the point
const NON_PRINTABLE = /[\u0000-\u001f\u007f]/
const LOCAL_ECHO_SCREEN = 'Local echo only — no shell is running.\r\n\r\n'
const LOCAL_ECHO_HELP =
  'Local echo only — this is not a shell. To run OpenCode, enter its command in “Command to launch”, leave Terminal ID empty, and connect RPC.'

interface InputRecord {
  readonly at: number
  readonly key: string
  readonly trusted: boolean
}

interface TimingSample {
  canvasOperation?: string
  canvasSubmissionAt?: number
  echoEndAt?: number
  echoGlyphSubmissionAt?: number
  echoProbe: string
  echoStartAt?: number
  echoVisibleAtCanvasSubmission?: boolean
  emitted: string
  frameSubmissionCompletedAt?: number
  id: number
  inputAt?: number
  inputPrefix: string
  inputToOnDataMs?: number
  key?: string
  nextAnimationFrameCallbackAt?: number
  onDataAt: number
  onDataToCanvasSubmissionMs?: number
  onDataToEchoGlyphSubmissionMs?: number
  onDataToEchoMs?: number
  onDataToFrameCompletionMs?: number
  outputRendering?: string
  parseAndScheduleMs?: number
  rpcOutputAt?: number
  trustedInput?: boolean
}

interface StallRecord {
  readonly at: number
  readonly delayMs: number
  readonly kind: 'event-loop' | 'animation-frame' | 'long-task'
}

interface CanvasFrameRecord {
  readonly attachEventIndex: number
  readonly completedAt: number
  readonly outputRendering: string
  readonly startedAt: number
}

interface ScrollbackVisibilityCase {
  readonly canvasSubmissionsWhileScrolledBack: number
  readonly echoGlyphSubmissionsWhileScrolledBack: number
  readonly emittedExactly: boolean
  readonly marker: string
  readonly parsedAndScheduled: boolean
  readonly typedVisibleAfterScrollToBottom: boolean
  readonly typedVisibleWhileScrolledBack: boolean
  readonly viewportAfterTyping: readonly string[]
  readonly viewportAtBottom: readonly string[]
  readonly viewportBeforeTyping: readonly string[]
}

interface LifecycleCase {
  readonly canvasOperationsWhileSuppressed: number
  readonly contentPreserved: boolean
  readonly kind: 'hidden' | 'zero-sized'
  readonly marker: string
  readonly markerVisibleAfterRestore: boolean
  readonly markerVisibleWhileSuppressed: boolean
  readonly renderResumed: boolean
  readonly viewportAfterRestore: readonly string[]
  readonly viewportBefore: readonly string[]
  readonly viewportWhileSuppressed: readonly string[]
}

interface DiagnosticReport {
  readonly canvasFrames: readonly CanvasFrameRecord[]
  readonly canvasFramesCapped: boolean
  readonly disclaimer: string
  readonly environment: {
    readonly devicePixelRatio: number
    readonly generatedAt: string
    readonly hardwareConcurrency: number | null
    readonly outputRendering: string
    readonly terminalGrid: {
      readonly cols: number
      readonly rows: number
    } | null
    readonly userAgent: string
    readonly viewport: { readonly height: number; readonly width: number }
  }
  readonly lifecycleCases: readonly LifecycleCase[]
  readonly mode: 'local-echo' | 'rpc'
  readonly rpc?: RpcDiagnosticSnapshot
  readonly rpcSummary?: ReturnType<typeof summarizeRpc>
  readonly sequence: {
    readonly emitted: string
    readonly exactMatch: boolean
    readonly expected: string
    readonly firstMismatch: {
      readonly emitted: string | null
      readonly expected: string | null
      readonly index: number
    } | null
    readonly missingSuffix: string
    readonly unexpectedSuffix: string
  }
  readonly stalls: readonly StallRecord[]
  readonly summary: ReturnType<typeof summarize>
  readonly timings: readonly TimingSample[]
  readonly visibilityCases: readonly ScrollbackVisibilityCase[]
}

interface DiagnosticApi {
  clear(): void
  disconnect(): Promise<void>
  exportReport(): DiagnosticReport
  finishExternalRun(): Promise<DiagnosticReport>
  finishScrolledBackCase(marker: string): Promise<DiagnosticReport>
  prepareScrolledBackCase(lines?: number, marker?: string): Promise<void>
  runAutomatic(sequence: string, intervalMs?: number): Promise<DiagnosticReport>
  runLifecycleCases(): Promise<DiagnosticReport>
  startExternalRun(expected: string): void
}

declare global {
  interface Window {
    terminalLatencyDiagnostic?: DiagnosticApi
  }
}

const theme: GhosttyTheme = {
  background: { r: 9, g: 9, b: 11 },
  cursor: { r: 250, g: 250, b: 250 },
  foreground: { r: 250, g: 250, b: 250 },
  selectionBackground: 'rgb(39 39 42 / 50%)',
}

const terminal = requiredElement<HTMLDivElement>('terminal')
const status = requiredElement<HTMLDivElement>('status')
const modeHelp = requiredElement<HTMLParagraphElement>('mode-help')
const summaryElement = requiredElement<HTMLPreElement>('summary')
const rpcUrlInput = requiredElement<HTMLInputElement>('rpc-url')
const terminalIdInput = requiredElement<HTMLInputElement>('terminal-id')
const rpcCommandInput = requiredElement<HTMLInputElement>('rpc-command')
const renderOutputInput = requiredElement<HTMLSelectElement>('render-output')
const diagnosticCanvases = new WeakSet<HTMLCanvasElement>()
const inputs: InputRecord[] = []
const samples: TimingSample[] = []
const awaitingCanvas = new Set<TimingSample>()
const awaitingGlyph = new Set<TimingSample>()
const frameSamples: TimingSample[] = []
const canvasFrames: CanvasFrameRecord[] = []
let canvasFramesCapped = false
let attachEventIndex = -1
const stalls: StallRecord[] = []
const visibilityCases: ScrollbackVisibilityCase[] = []
const lifecycleCases: LifecycleCase[] = []
let plannedSequence = ''
let emittedSequence = ''
let sampleId = 0
let surface: GhosttyTerminalSurface | null = null
let canvasOperationCount = 0
let rpcConnection: RpcTerminalConnection | null = null
/** Terminal replies emitted while an RPC connection is still being set up. */
let pendingRpcInput: string[] | null = null
let summaryTimer: number | null = null
let canvasFrameObserved = false

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`)
  if (!element) {
    throw new Error(`Missing diagnostic element #${id}`)
  }
  return element
}

function recordCanvasFrame(operation: string, at: number): void {
  canvasFrameObserved = true
  // Read the snapshot once per frame, not once per cell draw. Instrumentation
  // must not turn a full TUI repaint into thousands of full-screen reads.
  const lines = surface?.viewportText() ?? []
  const viewport = lines.join('\n')
  const tuiViewport = lines.join('')
  const tui = rpcConnection?.verificationMode === 'tui-viewport'
  const renderedIds: number[] = []
  for (const sample of awaitingCanvas) {
    if (tui) {
      if (!tuiViewport.includes(sample.inputPrefix)) {
        continue
      }
      // A redraw is not a byte echo. Timestamp the snapshot observation at
      // its actual canvas frame, not at an earlier output chunk's arrival.
      sample.rpcOutputAt = at
      renderedIds.push(sample.id)
    } else if (sample.echoStartAt === undefined || sample.echoStartAt > at) {
      continue
    }
    sample.canvasSubmissionAt = at
    sample.outputRendering = renderOutputInput.value
    sample.canvasOperation = operation
    sample.onDataToCanvasSubmissionMs = at - sample.onDataAt
    sample.echoVisibleAtCanvasSubmission = tui
      ? true
      : viewport.includes(sample.echoProbe)
    awaitingCanvas.delete(sample)
    frameSamples.push(sample)
    if (sample.echoVisibleAtCanvasSubmission) {
      awaitingGlyph.add(sample)
    }
  }
  if (renderedIds.length > 0) {
    rpcConnection?.markRendered(renderedIds, at)
  }
}

function recordCanvasSubmission(operation: string, drawnText?: string): void {
  canvasOperationCount += 1
  const at = performance.now()
  if (!canvasFrameObserved) {
    recordCanvasFrame(operation, at)
  }
  if (drawnText === undefined) {
    return
  }
  for (const sample of awaitingGlyph) {
    if (
      sample.echoVisibleAtCanvasSubmission !== true ||
      !drawnText.includes(sample.emitted)
    ) {
      continue
    }
    sample.echoGlyphSubmissionAt = at
    sample.onDataToEchoGlyphSubmissionMs = at - sample.onDataAt
    awaitingGlyph.delete(sample)
  }
}

function instrumentCanvasMethod(
  method: 'clearRect' | 'fillRect' | 'fillText' | 'strokeRect'
): void {
  const prototype = CanvasRenderingContext2D.prototype
  const original = prototype[method] as (...args: unknown[]) => unknown
  Object.defineProperty(prototype, method, {
    configurable: true,
    value(this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (diagnosticCanvases.has(this.canvas)) {
        recordCanvasSubmission(
          method,
          method === 'fillText' && typeof args[0] === 'string'
            ? args[0]
            : undefined
        )
      }
      return original.apply(this, args)
    },
    writable: true,
  })
}

for (const method of [
  'clearRect',
  'fillRect',
  'fillText',
  'strokeRect',
] as const) {
  instrumentCanvasMethod(method)
}

function resetMeasurements(expected = ''): void {
  inputs.length = 0
  samples.length = 0
  awaitingCanvas.clear()
  awaitingGlyph.clear()
  frameSamples.length = 0
  canvasFrames.length = 0
  canvasFramesCapped = false
  stalls.length = 0
  visibilityCases.length = 0
  lifecycleCases.length = 0
  plannedSequence = expected
  emittedSequence = ''
  sampleId = 0
  renderSummary()
}

function sequenceComparison(expected: string, emitted: string) {
  const commonLength = Math.min(expected.length, emitted.length)
  let mismatchIndex = 0
  while (
    mismatchIndex < commonLength &&
    expected[mismatchIndex] === emitted[mismatchIndex]
  ) {
    mismatchIndex += 1
  }
  const exactMatch = expected === emitted
  return {
    emitted,
    exactMatch,
    expected,
    firstMismatch: exactMatch
      ? null
      : {
          emitted: emitted[mismatchIndex] ?? null,
          expected: expected[mismatchIndex] ?? null,
          index: mismatchIndex,
        },
    missingSuffix:
      emitted.length < expected.length ? expected.slice(emitted.length) : '',
    unexpectedSuffix:
      emitted.length > expected.length ? emitted.slice(expected.length) : '',
  }
}

function percentile(
  values: readonly number[],
  fraction: number
): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1
  )
  return Number(sorted[index]?.toFixed(3))
}

function distribution(values: readonly number[]) {
  return {
    count: values.length,
    maxMs: percentile(values, 1),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  }
}

function summarize() {
  return {
    unverifiedFrameSamples: awaitingCanvas.size,
    canvasSubmission: distribution(
      samples.flatMap((sample) =>
        sample.onDataToCanvasSubmissionMs === undefined
          ? []
          : [sample.onDataToCanvasSubmissionMs]
      )
    ),
    echoGlyphSubmission: distribution(
      samples.flatMap((sample) =>
        sample.onDataToEchoGlyphSubmissionMs === undefined
          ? []
          : [sample.onDataToEchoGlyphSubmissionMs]
      )
    ),
    frameCompletion: distribution(
      samples.flatMap((sample) =>
        sample.onDataToFrameCompletionMs === undefined
          ? []
          : [sample.onDataToFrameCompletionMs]
      )
    ),
    inputToOnData: distribution(
      samples.flatMap((sample) =>
        sample.inputToOnDataMs === undefined ? [] : [sample.inputToOnDataMs]
      )
    ),
    onDataToEcho: distribution(
      samples.flatMap((sample) =>
        sample.onDataToEchoMs === undefined ? [] : [sample.onDataToEchoMs]
      )
    ),
    parseAndSchedule: distribution(
      samples.flatMap((sample) =>
        sample.parseAndScheduleMs === undefined
          ? []
          : [sample.parseAndScheduleMs]
      )
    ),
    sampleCount: samples.length,
    stallCount: stalls.length,
  }
}

function summarizeRpc(snapshot: RpcDiagnosticSnapshot) {
  return {
    offeredToOutput: distribution(
      snapshot.writes.flatMap((write) =>
        write.outputAt === undefined ? [] : [write.outputAt - write.offeredAt]
      )
    ),
    offeredToSent: distribution(
      snapshot.writes.flatMap((write) =>
        write.sentAt === undefined ? [] : [write.sentAt - write.offeredAt]
      )
    ),
    sentToOutput: distribution(
      snapshot.writes.flatMap((write) =>
        write.sentAt === undefined || write.outputAt === undefined
          ? []
          : [write.outputAt - write.sentAt]
      )
    ),
    sentToReturned: distribution(
      snapshot.writes.flatMap((write) =>
        write.sentAt === undefined || write.returnedAt === undefined
          ? []
          : [write.returnedAt - write.sentAt]
      )
    ),
  }
}

function exportReport(): DiagnosticReport {
  const rpc = rpcConnection?.snapshot()
  return {
    canvasFrames: [...canvasFrames],
    canvasFramesCapped,
    disclaimer:
      'Canvas submission is the first observed CanvasRenderingContext2D draw call after echo. Echo glyph submission additionally requires a matching fillText call. Both precede browser compositing and physical display paint.',
    environment: {
      devicePixelRatio: window.devicePixelRatio,
      generatedAt: new Date().toISOString(),
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      outputRendering: renderOutputInput.value,
      terminalGrid:
        surface === null ? null : { cols: surface.cols, rows: surface.rows },
      userAgent: navigator.userAgent,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    },
    lifecycleCases: [...lifecycleCases],
    mode: rpcConnection === null ? 'local-echo' : 'rpc',
    ...(rpc === undefined ? {} : { rpc, rpcSummary: summarizeRpc(rpc) }),
    sequence: sequenceComparison(plannedSequence, emittedSequence),
    stalls: [...stalls],
    summary: summarize(),
    timings: samples.map((sample) => ({ ...sample })),
    visibilityCases: [...visibilityCases],
  }
}

function renderSummary(): void {
  const report = exportReport()
  summaryElement.textContent = JSON.stringify(
    { sequence: report.sequence, summary: report.summary },
    null,
    2
  )
}

function scheduleSummary(): void {
  if (summaryTimer !== null) {
    return
  }
  summaryTimer = window.setTimeout(() => {
    summaryTimer = null
    renderSummary()
  }, 250)
}

function addStall(stall: StallRecord): void {
  if (stalls.length < MAX_STALLS) {
    stalls.push(stall)
  }
}

let expectedTimerAt = performance.now() + EVENT_LOOP_INTERVAL_MS
window.setInterval(() => {
  const now = performance.now()
  const delayMs = now - expectedTimerAt
  if (delayMs >= STALL_THRESHOLD_MS) {
    addStall({ at: now, delayMs, kind: 'event-loop' })
  }
  expectedTimerAt = now + EVENT_LOOP_INTERVAL_MS
}, EVENT_LOOP_INTERVAL_MS)

let previousFrameAt = performance.now()
function monitorFrames(now: number): void {
  const delayMs = now - previousFrameAt
  if (delayMs >= STALL_THRESHOLD_MS) {
    addStall({ at: now, delayMs, kind: 'animation-frame' })
  }
  previousFrameAt = now
  requestAnimationFrame(monitorFrames)
}
requestAnimationFrame(monitorFrames)

if ('PerformanceObserver' in window) {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        addStall({
          at: entry.startTime,
          delayMs: entry.duration,
          kind: 'long-task',
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // Long-task observation is optional; timer and frame monitors remain live.
  }
}

window.addEventListener(
  'keydown',
  (event) => {
    if (
      event.target !== surface?.input ||
      event.key.length !== 1 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return
    }
    if (inputs.length < MAX_SAMPLES) {
      const input: InputRecord = {
        at: performance.now(),
        key: event.key,
        trusted: event.isTrusted,
      }
      inputs.length = 0
      inputs.push(input)
      // A shortcut/protocol-encoded key may produce no measured text. It must
      // not stay in the FIFO and get paired with a later unrelated keystroke.
      window.setTimeout(() => {
        const index = inputs.indexOf(input)
        if (index !== -1) {
          inputs.splice(index, 1)
        }
      }, 0)
    }
  },
  { capture: true }
)

function onData(data: string): void {
  // Ghostty invokes this from inside `vt_write` when a program queries the
  // terminal. While an RPC connection is still being established, those
  // replies belong to the remote process: writing them back into the surface
  // here can recursively answer queries with more queries until the WASM
  // stack overflows, leaving the shared runtime unusable.
  if (pendingRpcInput !== null) {
    if (pendingRpcInput.length < MAX_PENDING_RPC_INPUT) {
      pendingRpcInput.push(data)
    }
    return
  }
  // A running program also receives terminal replies, focus reports and mouse
  // tracking. Those never render as prompt text, so verifying a viewport
  // prefix against them would wait forever; forward them unmeasured.
  if (
    rpcConnection?.verificationMode === 'tui-viewport' &&
    NON_PRINTABLE.test(data)
  ) {
    rpcConnection.offer(data, -1)
    return
  }
  const onDataAt = performance.now()
  const candidate = inputs.shift()
  const input = candidate?.key === data ? candidate : undefined
  emittedSequence += data
  if (samples.length < MAX_SAMPLES) {
    const id = ++sampleId
    const sample: TimingSample = {
      emitted: data,
      echoProbe: emittedSequence.slice(-8),
      id,
      inputPrefix: emittedSequence,
      onDataAt,
    }
    if (input) {
      sample.inputAt = input.at
      sample.inputToOnDataMs = onDataAt - input.at
      sample.key = input.key
      sample.trustedInput = input.trusted
    }
    samples.push(sample)
    awaitingCanvas.add(sample)
    if (rpcConnection === null) {
      const echoStartAt = performance.now()
      sample.echoStartAt = echoStartAt
      surface?.write(data)
      const echoEndAt = performance.now()
      sample.echoStartAt = echoStartAt
      sample.echoEndAt = echoEndAt
      sample.onDataToEchoMs = echoStartAt - onDataAt
      sample.parseAndScheduleMs = echoEndAt - echoStartAt
    } else if (!rpcConnection.offer(data, id)) {
      status.textContent = 'RPC input lane rejected data'
    }
    requestAnimationFrame((at) => {
      sample.nextAnimationFrameCallbackAt = at
    })
  } else {
    status.textContent = `Measurement capped at ${String(MAX_SAMPLES)} samples; input still forwarded`
    if (rpcConnection === null) {
      surface?.write(data)
    } else {
      rpcConnection.offer(data, -1)
    }
  }
  scheduleSummary()
}

function handleRpcOutput(
  data: string,
  at: number,
  sampleIds: readonly number[]
): void {
  const echoStartAt = performance.now()
  for (const id of sampleIds) {
    const sample = samples.find((candidate) => candidate.id === id)
    if (sample === undefined) {
      continue
    }
    sample.rpcOutputAt = at
    sample.echoStartAt = echoStartAt
    sample.onDataToEchoMs = echoStartAt - sample.onDataAt
  }
  surface?.write(data)
  const echoEndAt = performance.now()
  for (const id of sampleIds) {
    const sample = samples.find((candidate) => candidate.id === id)
    if (sample === undefined) {
      continue
    }
    sample.echoEndAt = echoEndAt
    sample.parseAndScheduleMs = echoEndAt - echoStartAt
  }
}

async function connectRpc(
  url: string,
  terminalId?: string,
  command?: string
): Promise<void> {
  await disconnectRpc()
  resetMeasurements()
  status.textContent = 'Connecting RPC…'
  pendingRpcInput = []
  attachEventIndex = -1
  let connection: RpcTerminalConnection
  try {
    connection = await connectRpcTerminal({
      ...(command === undefined || command.length === 0 ? {} : { command }),
      onEvent: (event) => {
        attachEventIndex += 1
        if (event._tag === 'Snapshot') {
          surface?.resetAndWrite(event.data)
        } else if (event._tag === 'Reset') {
          surface?.resetAndWrite('')
        }
      },
      onOutput: handleRpcOutput,
      ...(terminalId === undefined || terminalId.length === 0
        ? {}
        : { terminalId }),
      url,
    })
  } catch (error) {
    pendingRpcInput = null
    throw error
  }
  rpcConnection = connection
  // Replies Ghostty produced to the program's startup queries are owed to
  // that program; deliver them now that the input lane exists.
  const queued = pendingRpcInput
  pendingRpcInput = null
  for (const data of queued) {
    connection.offer(data, -1)
  }
  rpcUrlInput.value = url
  // The generated ID is shown in status. Filling the attach field with it
  // would make a later command silently reuse the previous echo process.
  terminalIdInput.value = terminalId ?? ''
  rpcCommandInput.value = command ?? ''
  const isEcho = connection.verificationMode === 'raw-exact'
  status.textContent = `${isEcho ? 'RPC echo only' : 'RPC command ready'} · ${connection.terminalId}`
  modeHelp.textContent = isEcho
    ? 'Raw PTY echo (cat) — commands typed below are only echoed. Enter a command above and reconnect to launch it.'
    : 'Connected to the command process. Type in the terminal below. Use Export JSON to capture a stall.'
  document.body.dataset.rpcReady = 'true'
}

async function disconnectRpc(): Promise<void> {
  const connection = rpcConnection
  rpcConnection = null
  delete document.body.dataset.rpcReady
  await connection?.close()
  terminalIdInput.value = ''
  surface?.resetAndWrite(LOCAL_ECHO_SCREEN)
  status.textContent = 'Local echo only · no shell'
  modeHelp.textContent = LOCAL_ECHO_HELP
}

function keyboardCode(key: string): string {
  if (LETTER_KEY.test(key)) {
    return `Key${key.toUpperCase()}`
  }
  if (DIGIT_KEY.test(key)) {
    return `Digit${key}`
  }
  if (key === ' ') {
    return 'Space'
  }
  return ''
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs))
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

async function runAutomatic(
  sequence: string,
  intervalMs = 8
): Promise<DiagnosticReport> {
  resetMeasurements(sequence)
  rpcConnection?.beginRun()
  await dispatchAutomatic(sequence, intervalMs)
  return finishExternalRun()
}

async function dispatchAutomatic(
  sequence: string,
  intervalMs: number
): Promise<void> {
  surface?.focus()
  for (const key of sequence) {
    const init: KeyboardEventInit = {
      bubbles: true,
      cancelable: true,
      code: keyboardCode(key),
      key,
    }
    surface?.input.dispatchEvent(new KeyboardEvent('keydown', init))
    surface?.input.dispatchEvent(new KeyboardEvent('keyup', init))
    if (intervalMs > 0) {
      await wait(intervalMs)
    }
  }
}

function startExternalRun(expected: string): void {
  resetMeasurements(expected)
  rpcConnection?.beginRun()
  surface?.focus()
}

async function finishExternalRun(): Promise<DiagnosticReport> {
  await rpcConnection?.waitForOutput()
  await settle()
  // A TUI can emit another frame while settling. Include its acknowledgement
  // before snapshotting rather than reporting an in-flight ack as a failure.
  await rpcConnection?.waitForOutput()
  return exportReport()
}

async function prepareScrolledBackCase(
  lines = 250,
  marker = 'SCROLL_ECHO_42'
): Promise<void> {
  const output = Array.from(
    { length: lines },
    (_, index) => `scrollback fixture ${String(index).padStart(4, '0')}\r\n`
  ).join('')
  surface?.write(`\u001b[2J\u001b[H${output}> `)
  await settle()
  surface?.canvas.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -100_000,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    })
  )
  await settle()
  resetMeasurements(marker)
  scrollbackViewportBeforeTyping = surface?.viewportText() ?? []
  surface?.focus()
}

let scrollbackViewportBeforeTyping: readonly string[] = []

async function finishScrolledBackCase(
  marker: string
): Promise<DiagnosticReport> {
  await settle()
  const viewportAfterTyping = surface?.viewportText() ?? []
  const typedVisibleWhileScrolledBack = viewportAfterTyping
    .join('\n')
    .includes(marker)
  const canvasSubmissionsWhileScrolledBack = samples.filter(
    (sample) => sample.canvasSubmissionAt !== undefined
  ).length
  const echoGlyphSubmissionsWhileScrolledBack = samples.filter(
    (sample) => sample.echoGlyphSubmissionAt !== undefined
  ).length
  const parsedAndScheduled =
    emittedSequence === marker &&
    samples.length > 0 &&
    samples.every(
      (sample) =>
        sample.parseAndScheduleMs !== undefined &&
        Number.isFinite(sample.parseAndScheduleMs)
    )
  surface?.scrollToBottom()
  await settle()
  const viewportAtBottom = surface?.viewportText() ?? []
  visibilityCases.push({
    canvasSubmissionsWhileScrolledBack,
    emittedExactly: emittedSequence === marker,
    echoGlyphSubmissionsWhileScrolledBack,
    marker,
    parsedAndScheduled,
    typedVisibleAfterScrollToBottom: viewportAtBottom
      .join('\n')
      .includes(marker),
    typedVisibleWhileScrolledBack,
    viewportAfterTyping,
    viewportAtBottom,
    viewportBeforeTyping: scrollbackViewportBeforeTyping,
  })
  renderSummary()
  return exportReport()
}

function viewportContains(lines: readonly string[], text: string): boolean {
  return lines.join('\n').includes(text)
}

async function runHiddenLifecycleCase(): Promise<void> {
  const anchor = 'VISIBLE_ANCHOR'
  const marker = 'HIDDEN_WRITE_42'
  surface?.resetAndWrite(`${anchor}\r\n> `)
  await settle()
  const viewportBefore = surface?.viewportText() ?? []
  const operationsBefore = canvasOperationCount
  surface?.setVisible(false)
  surface?.write(marker)
  await settle()
  const viewportWhileSuppressed = surface?.viewportText() ?? []
  const canvasOperationsWhileSuppressed =
    canvasOperationCount - operationsBefore
  surface?.setVisible(true)
  await settle()
  const viewportAfterRestore = surface?.viewportText() ?? []
  lifecycleCases.push({
    canvasOperationsWhileSuppressed,
    contentPreserved:
      viewportContains(viewportBefore, anchor) &&
      viewportContains(viewportAfterRestore, anchor),
    kind: 'hidden',
    marker,
    markerVisibleAfterRestore: viewportContains(viewportAfterRestore, marker),
    markerVisibleWhileSuppressed: viewportContains(
      viewportWhileSuppressed,
      marker
    ),
    renderResumed: canvasOperationCount > operationsBefore,
    viewportAfterRestore,
    viewportBefore,
    viewportWhileSuppressed,
  })
}

async function runZeroSizedLifecycleCase(): Promise<void> {
  const anchor = 'SIZE_ANCHOR'
  const marker = 'ZERO_SIZE_WRITE_42'
  surface?.resetAndWrite(`${anchor}\r\n> `)
  await settle()
  const viewportBefore = surface?.viewportText() ?? []
  terminal.style.width = '0px'
  terminal.style.height = '0px'
  surface?.fit()
  const operationsBefore = canvasOperationCount
  surface?.write(marker)
  await settle()
  const viewportWhileSuppressed = surface?.viewportText() ?? []
  const canvasOperationsWhileSuppressed =
    canvasOperationCount - operationsBefore
  terminal.style.removeProperty('width')
  terminal.style.removeProperty('height')
  surface?.fit()
  await settle()
  const viewportAfterRestore = surface?.viewportText() ?? []
  lifecycleCases.push({
    canvasOperationsWhileSuppressed,
    contentPreserved:
      viewportContains(viewportBefore, anchor) &&
      viewportContains(viewportAfterRestore, anchor),
    kind: 'zero-sized',
    marker,
    markerVisibleAfterRestore: viewportContains(viewportAfterRestore, marker),
    markerVisibleWhileSuppressed: viewportContains(
      viewportWhileSuppressed,
      marker
    ),
    renderResumed: canvasOperationCount > operationsBefore,
    viewportAfterRestore,
    viewportBefore,
    viewportWhileSuppressed,
  })
}

async function runLifecycleCases(): Promise<DiagnosticReport> {
  if (rpcConnection !== null) {
    throw new Error('Lifecycle cases are local-only; disconnect RPC first')
  }
  lifecycleCases.length = 0
  await runHiddenLifecycleCase()
  await runZeroSizedLifecycleCase()
  renderSummary()
  surface?.focus()
  return exportReport()
}

function downloadReport(): void {
  const data = JSON.stringify(exportReport(), null, 2)
  const link = document.createElement('a')
  link.download = `ghostty-latency-${new Date().toISOString()}.json`
  link.href = URL.createObjectURL(
    new Blob([data], { type: 'application/json' })
  )
  link.click()
  URL.revokeObjectURL(link.href)
}

async function main(): Promise<void> {
  surface = await GhosttyTerminalSurface.create(terminal, {
    beforeKey: () => true,
    font: { family: 'JetBrains Mono', size: 12 },
    onData,
    onLinkActivate: () => undefined,
    onResize: () => undefined,
    onSelectionChange: () => undefined,
    theme,
  })
  // This private-method wrapper is confined to the diagnostic. It observes a
  // frame boundary without taking another WASM snapshot (which consumes dirty
  // rows) or adding a second animation frame to the measured path.
  const renderFrame: unknown = Reflect.get(surface, 'renderFrame')
  if (typeof renderFrame !== 'function') {
    throw new Error('Ghostty diagnostic render-frame seam changed')
  }
  Reflect.set(surface, 'renderFrame', () => {
    const startedAt = performance.now()
    canvasFrameObserved = false
    frameSamples.length = 0
    Reflect.apply(renderFrame, surface, [])
    const completedAt = performance.now()
    if (canvasFrameObserved) {
      if (canvasFrames.length < MAX_SAMPLES) {
        canvasFrames.push({
          attachEventIndex,
          startedAt,
          completedAt,
          outputRendering: renderOutputInput.value,
        })
      } else {
        canvasFramesCapped = true
      }
    }
    for (const sample of frameSamples) {
      sample.frameSubmissionCompletedAt = completedAt
      sample.onDataToFrameCompletionMs = completedAt - sample.onDataAt
    }
  })
  // Keep the former policy available for controlled comparisons; immediate
  // mode calls the unmodified production output path.
  const renderOutput: unknown = Reflect.get(surface, 'renderOutput')
  const requestRender: unknown = Reflect.get(surface, 'requestRender')
  if (
    typeof renderOutput !== 'function' ||
    typeof requestRender !== 'function'
  ) {
    throw new Error('Ghostty diagnostic output-rendering seam changed')
  }
  Reflect.set(surface, 'renderOutput', () => {
    Reflect.apply(
      renderOutputInput.value === 'frame' ? requestRender : renderOutput,
      surface,
      []
    )
  })
  diagnosticCanvases.add(surface.canvas)
  surface.write(`\u001b[2J\u001b[H${LOCAL_ECHO_SCREEN}`)
  surface.focus()
  status.textContent = `Local echo only · ${String(surface.cols)}×${String(surface.rows)}`
  document.body.dataset.ready = 'true'
  const query = new URLSearchParams(location.search)
  if (query.get('renderOutput') === 'frame') {
    renderOutputInput.value = 'frame'
  }
  const rpcUrl = query.get('rpcUrl')
  if (rpcUrl !== null && rpcUrl.length > 0) {
    await connectRpc(
      rpcUrl,
      query.get('terminalId') ?? undefined,
      query.get('command') ?? undefined
    )
  }
}

requiredElement<HTMLButtonElement>('run').addEventListener(
  'click',
  async () => {
    const sequence = requiredElement<HTMLInputElement>('sequence').value.repeat(
      Number(requiredElement<HTMLInputElement>('repeats').value)
    )
    const interval = Number(requiredElement<HTMLInputElement>('interval').value)
    await runAutomatic(sequence, interval)
  }
)
requiredElement<HTMLButtonElement>('run-scrollback').addEventListener(
  'click',
  async () => {
    const marker = 'SCROLL_ECHO_42'
    await prepareScrolledBackCase(250, marker)
    await dispatchAutomatic(marker, 8)
    await finishScrolledBackCase(marker)
  }
)
requiredElement<HTMLButtonElement>('run-lifecycle').addEventListener(
  'click',
  runLifecycleCases
)
requiredElement<HTMLButtonElement>('connect-rpc').addEventListener(
  'click',
  async () => {
    if (rpcUrlInput.value.length === 0) {
      status.textContent = 'Enter an RPC WebSocket URL'
      return
    }
    try {
      await connectRpc(
        rpcUrlInput.value,
        terminalIdInput.value,
        rpcCommandInput.value
      )
    } catch (error) {
      status.textContent = `RPC failed · ${error instanceof Error ? error.message : String(error)}`
    }
  }
)
requiredElement<HTMLButtonElement>('clear').addEventListener('click', () => {
  resetMeasurements()
  surface?.focus()
})
requiredElement<HTMLButtonElement>('disconnect-rpc').addEventListener(
  'click',
  disconnectRpc
)
requiredElement<HTMLButtonElement>('export').addEventListener(
  'click',
  downloadReport
)

window.terminalLatencyDiagnostic = {
  clear: resetMeasurements,
  disconnect: disconnectRpc,
  exportReport,
  finishExternalRun,
  finishScrolledBackCase,
  prepareScrolledBackCase,
  runAutomatic,
  runLifecycleCases,
  startExternalRun,
}

main().catch((error: unknown) => {
  status.textContent = 'Failed'
  summaryElement.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(error)
})
