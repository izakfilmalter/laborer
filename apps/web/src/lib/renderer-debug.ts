const DEBUG_STORAGE_KEY = 'laborer:renderer-debug'
const MAX_EVENTS = 500
const PREFIX = '[laborer-debug]'

interface DebugEvent {
  readonly at: number
  readonly category: string
  readonly details?: unknown
  readonly event: string
}

interface DebugTrace {
  readonly capturedAt: string
  readonly events: readonly DebugEvent[]
  readonly location: string
  readonly sessionId: string
  readonly userAgent: string
}

interface LaborerDebugApi {
  readonly clear: () => void
  readonly copy: () => Promise<string>
  readonly disable: () => void
  readonly dump: () => DebugTrace
}

declare global {
  interface Window {
    laborerDebug?: LaborerDebugApi
  }
}

const enabled = (() => {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    const requested = new URLSearchParams(window.location.search).get(
      'laborerDebug'
    )
    if (requested === '1') {
      window.localStorage.setItem(DEBUG_STORAGE_KEY, '1')
      return true
    }
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
})()

const startedAt = globalThis.performance?.now() ?? 0
const sessionId = globalThis.crypto?.randomUUID?.() ?? 'unknown'
const events: DebugEvent[] = []

const trace = (): DebugTrace => ({
  capturedAt: new Date().toISOString(),
  events: [...events],
  location:
    typeof window === 'undefined'
      ? 'unknown'
      : `${window.location.origin}${window.location.pathname}`,
  sessionId,
  userAgent: globalThis.navigator?.userAgent ?? 'unknown',
})

if (enabled && typeof window !== 'undefined') {
  window.laborerDebug = {
    clear: () => {
      events.length = 0
    },
    copy: async () => {
      const output = JSON.stringify(trace(), null, 2)
      await globalThis.navigator.clipboard.writeText(output).then(
        () => {
          console.info(`${PREFIX} copied ${String(events.length)} events`)
        },
        () => {
          console.warn(
            `${PREFIX} clipboard access failed; the trace is returned as the command result`
          )
        }
      )
      return output
    },
    disable: () => {
      window.localStorage.removeItem(DEBUG_STORAGE_KEY)
      console.info(`${PREFIX} disabled; reload the page`)
    },
    dump: trace,
  }
  console.info(
    `${PREFIX} enabled for session ${sessionId}; run await window.laborerDebug.copy() after reproducing`
  )
}

export const rendererDebug = (
  category: string,
  event: string,
  details?: unknown
): void => {
  if (!enabled) {
    return
  }
  const entry: DebugEvent = {
    at: Math.round((globalThis.performance?.now() ?? startedAt) - startedAt),
    category,
    event,
    ...(details === undefined ? {} : { details }),
  }
  events.push(entry)
  if (events.length > MAX_EVENTS) {
    events.shift()
  }
  console.debug(PREFIX, entry)
}

export const rendererDebugSampled = (
  category: string,
  event: string,
  count: number,
  details: unknown
): void => {
  if (count === 1 || count % 100 === 0) {
    rendererDebug(category, event, details)
  }
}

export const debugError = (error: unknown): unknown => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.cause === undefined ? {} : { cause: debugError(error.cause) }),
    }
  }
  if (typeof error === 'string' || typeof error === 'number') {
    return error
  }
  return String(error)
}

export const instrumentWebSocket = (
  socket: WebSocket,
  owner: 'rpc' | 'supervisor',
  url: string
): void => {
  if (!enabled) {
    return
  }
  const socketId = globalThis.crypto.randomUUID()
  const safeUrl = new URL(url)
  const details = {
    owner,
    socketId,
    url: `${safeUrl.origin}${safeUrl.pathname}`,
  }
  rendererDebug('websocket', 'created', details)
  socket.addEventListener('open', () => {
    rendererDebug('websocket', 'open', details)
  })
  socket.addEventListener('error', () => {
    rendererDebug('websocket', 'error', {
      ...details,
      readyState: socket.readyState,
    })
  })
  socket.addEventListener('close', (event) => {
    rendererDebug('websocket', 'close', {
      ...details,
      clean: event.wasClean,
      code: event.code,
      reason: event.reason,
    })
  })
}
