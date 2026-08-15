import { Atom } from 'effect/unstable/reactivity'
import { getDesktopBridge } from '@/lib/desktop'
import {
  debugError,
  instrumentWebSocket,
  rendererDebug,
} from '@/lib/renderer-debug'

export const RENDERER_RECONNECT_DELAYS_MS = [3000, 4000, 8000, 16_000] as const
export const RENDERER_RECONNECT_STABILITY_RESET_MS = 30_000
export const RENDERER_DISCONNECT_GRACE_MS = 2000
export const RECONNECT_MUTATION_MESSAGE =
  'Reconnecting — try again once connected'

export type RendererConnectionPhase =
  | 'connecting'
  | 'connected'
  | 'backoff'
  | 'blocked'

export interface RendererConnectionState {
  readonly attempt: number
  readonly generation: number
  readonly phase: RendererConnectionPhase
  readonly retryAt: number | null
  /** Identity of the active transport lease; null while disconnected. */
  readonly session: number | null
}

export interface RendererConnectionLease {
  readonly close: () => void
  readonly closed: Promise<void>
}

export type RendererConnector = (
  signal: AbortSignal
) => Promise<RendererConnectionLease>

export class RendererConnectionBlockedError extends Error {
  constructor() {
    super('The desktop daemon could not be restarted')
    this.name = 'RendererConnectionBlockedError'
  }
}

const retryDelay = (failureCount: number): number =>
  RENDERER_RECONNECT_DELAYS_MS[
    Math.min(failureCount, RENDERER_RECONNECT_DELAYS_MS.length - 1)
  ] ?? 16_000

/**
 * The sole owner of browser reconnect timing. RPC transports get one attempt;
 * a successful reconnection advances generation so mounted atoms acquire
 * fresh transports while retaining their last successful values. The initial
 * lease keeps generation zero because the RPC runtime is already being built;
 * invalidating it during startup can interrupt its first requests.
 */
export class RendererConnectionSupervisor {
  private readonly connect: RendererConnector
  private readonly now: () => number
  private state: RendererConnectionState = {
    attempt: 1,
    generation: 0,
    phase: 'connecting',
    retryAt: null,
    session: null,
  }
  private readonly listeners = new Set<() => void>()
  private running = false
  private stopped = false
  private interrupt: (() => void) | undefined

  constructor(connect: RendererConnector, now: () => number = Date.now) {
    this.connect = connect
    this.now = now
  }

  readonly getSnapshot = (): RendererConnectionState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.running) {
      rendererDebug('supervisor', 'start-ignored-already-running')
      return
    }
    rendererDebug('supervisor', 'start')
    this.running = true
    this.stopped = false
    this.run().catch((error: unknown) => {
      rendererDebug('supervisor', 'unexpected-stop', debugError(error))
      console.error(
        'Renderer connection supervisor stopped unexpectedly',
        error
      )
    })
  }

  stop(): void {
    rendererDebug('supervisor', 'stop')
    this.stopped = true
    this.interrupt?.()
  }

  retryNow(): void {
    rendererDebug('supervisor', 'retry-now')
    this.interrupt?.()
  }

  private publish(next: RendererConnectionState): void {
    rendererDebug('supervisor', 'state', next)
    this.state = next
    for (const listener of this.listeners) {
      listener()
    }
  }

  private wait(delayMs: number): Promise<'elapsed' | 'retry'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.interrupt = undefined
        resolve('elapsed')
      }, delayMs)
      this.interrupt = () => {
        clearTimeout(timer)
        this.interrupt = undefined
        resolve('retry')
      }
    })
  }

  private async run(): Promise<void> {
    let failureCount = 0
    let sessionSequence = 0
    while (!this.stopped) {
      const attempt = failureCount + 1
      this.publish({
        ...this.state,
        attempt,
        phase: 'connecting',
        retryAt: null,
        session: null,
      })
      const controller = new AbortController()
      let manuallyInterrupted = false
      this.interrupt = () => {
        manuallyInterrupted = true
        controller.abort()
      }
      try {
        rendererDebug('supervisor', 'connect-attempt', { attempt })
        const lease = await this.connect(controller.signal)
        if (this.stopped) {
          lease.close()
          break
        }
        const connectedAt = this.now()
        const generation =
          sessionSequence === 0
            ? this.state.generation
            : this.state.generation + 1
        sessionSequence += 1
        rendererDebug('supervisor', 'lease-connected', {
          attempt,
          generation,
          session: sessionSequence,
        })
        this.publish({
          attempt,
          generation,
          phase: 'connected',
          retryAt: null,
          session: sessionSequence,
        })
        await new Promise<void>((resolve) => {
          this.interrupt = () => {
            manuallyInterrupted = true
            lease.close()
            resolve()
          }
          lease.closed.then(resolve, resolve)
        })
        rendererDebug('supervisor', 'lease-ended', {
          attempt,
          manuallyInterrupted,
          session: sessionSequence,
        })
        if (this.now() - connectedAt >= RENDERER_RECONNECT_STABILITY_RESET_MS) {
          failureCount = 0
        }
      } catch (error) {
        rendererDebug('supervisor', 'connect-failed', {
          attempt,
          error: debugError(error),
          manuallyInterrupted,
        })
        // Transport failures are represented by phase, not thrown into views.
        if (error instanceof RendererConnectionBlockedError) {
          this.publish({
            ...this.state,
            phase: 'blocked',
            retryAt: null,
            session: null,
          })
          break
        }
      } finally {
        this.interrupt = undefined
      }
      if (this.stopped) {
        break
      }
      if (manuallyInterrupted) {
        failureCount = 0
        continue
      }
      const delayMs = retryDelay(failureCount)
      failureCount += 1
      this.publish({
        ...this.state,
        attempt,
        phase: 'backoff',
        retryAt: this.now() + delayMs,
        session: null,
      })
      if ((await this.wait(delayMs)) === 'retry') {
        failureCount = 0
      }
    }
    this.running = false
  }
}

const connectWebSocket: RendererConnector = async (signal) => {
  const bridge = getDesktopBridge()
  if (bridge && import.meta.env.PROD) {
    try {
      await bridge.ensureDaemon()
    } catch {
      throw new RendererConnectionBlockedError()
    }
  }
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', globalThis.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    instrumentWebSocket(socket, 'supervisor', url.href)
    let opened = false
    let resolveClosed: (() => void) | undefined
    const closed = new Promise<void>((done) => {
      resolveClosed = done
    })
    const abort = () => socket.close()
    signal.addEventListener('abort', abort, { once: true })
    socket.addEventListener(
      'open',
      () => {
        opened = true
        resolve({ closed, close: () => socket.close() })
      },
      { once: true }
    )
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', abort)
      if (opened) {
        resolveClosed?.()
      } else {
        reject(new Error('Daemon WebSocket did not open'))
      }
    })
    socket.addEventListener(
      'error',
      () => {
        if (!opened) {
          reject(new Error('Daemon WebSocket did not open'))
        }
      },
      { once: true }
    )
  })
}

export const rendererConnectionSupervisor = new RendererConnectionSupervisor(
  connectWebSocket
)

/** Reactive dependency read by every browser RPC runtime layer. */
export const rendererConnectionGenerationAtom = Atom.make(0)

export const isRendererConnected = (): boolean =>
  rendererConnectionSupervisor.getSnapshot().phase === 'connected'
