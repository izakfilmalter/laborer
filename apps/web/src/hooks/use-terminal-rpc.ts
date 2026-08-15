import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { Effect, Fiber, Stream } from 'effect'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { isTerminalRevival } from '@/components/terminal-revival-marker'
import type { TerminalScreen } from '@/lib/terminal-screen'

const ACK_BATCH_CHARS = 5000
const INPUT_WRITE_BYTES = 64 * 1024
const INPUT_PENDING_BYTES = 64 * 1024
const encoder = new TextEncoder()

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
type TerminalStatus = 'running' | 'stopped' | 'restarted'
type ReplayStatus = 'idle' | 'replaying' | 'complete'

/**
 * Replay reaches the screen through xterm's write queue, so the backend's
 * `ReplayComplete` only means "no further replay frames are coming". Until
 * xterm parses each replayed chunk and invokes its write callback, the canvas
 * still shows the pre-reconnect buffer. Restoration is therefore complete only
 * when both have happened; trusting the backend signal alone lets the loading
 * overlay lift — and the revival marker appear — over stale output.
 */
interface ReplayRenderState {
  /** The backend has sent every frame belonging to this replay. */
  readonly backendComplete: boolean
  /** Frames handed to xterm that it has not reported parsed yet. */
  readonly pendingRenders: number
  /** The screen holds output this replay has yet to bring up to date. */
  readonly restoring: boolean
}

type ReplayRenderEvent =
  | { readonly _tag: 'ReplayStarted' }
  | { readonly _tag: 'RenderQueued' }
  | { readonly _tag: 'RenderParsed' }
  | { readonly _tag: 'BackendComplete' }

/** Nothing more is coming from the backend and nothing is left unparsed. */
const isReplaySettled = ({
  backendComplete,
  pendingRenders,
}: ReplayRenderState): boolean => backendComplete && pendingRenders === 0

const nextReplayRenderState = (
  state: ReplayRenderState,
  event: ReplayRenderEvent
): ReplayRenderState => {
  switch (event._tag) {
    case 'ReplayStarted':
      // Renders already queued stay counted: they are still in flight, and
      // dropping them here would unbalance their pending parse. Reopening a
      // settled replay means the screen the operator is looking at has just
      // become stale, so this replay is now a restore.
      return {
        ...state,
        backendComplete: false,
        restoring: state.restoring || isReplaySettled(state),
      }
    case 'RenderQueued':
      return { ...state, pendingRenders: state.pendingRenders + 1 }
    case 'RenderParsed':
      return {
        ...state,
        pendingRenders: Math.max(0, state.pendingRenders - 1),
      }
    case 'BackendComplete':
      return { ...state, backendComplete: true }
    default:
      event satisfies never
      return state
  }
}

/**
 * `idle` is the fresh pane: replay is still open, but there is no earlier
 * screen to restore, so the pane keeps its own startup message instead of
 * claiming to restore output nobody has seen.
 */
const replayRenderStatus = (state: ReplayRenderState): ReplayStatus => {
  if (isReplaySettled(state)) {
    return 'complete'
  }
  return state.restoring ? 'replaying' : 'idle'
}

/**
 * Tracks one attach's replay against what xterm has actually parsed.
 *
 * The coordinator holds no timers: it advances only on backend frames and on
 * xterm write callbacks, so a slow render extends restoration instead of
 * racing it.
 */
export interface ReplayCoordinator {
  /** A `Reset` or `Snapshot` frame reopens replay — the screen is stale again. */
  readonly beginReplay: () => void
  /** Every replay frame has been sent; rendering may still be outstanding. */
  readonly endBackendReplay: () => void
  /**
   * Hand a frame to the renderer. `write` receives the commit callback to pass
   * to xterm and reports whether the screen accepted the chunk; `commit` runs
   * once xterm reports the chunk parsed. A rejected chunk never reaches a
   * canvas, so it can never be parsed — it is released here instead of holding
   * restoration open for a parse that will never arrive.
   */
  readonly render: (
    write: (commit: () => void) => boolean,
    commit: () => void
  ) => void
  readonly status: () => ReplayStatus
}

export const createReplayCoordinator = ({
  onStatusChange,
  restoring,
}: {
  readonly onStatusChange: (status: ReplayStatus) => void
  /**
   * Whether this attach reopens a screen the operator has already seen. A
   * reattach must report `replaying` before its first frame lands: otherwise
   * the previous attach's `complete` — and the revival marker it justifies —
   * keeps describing output the backend is about to replace.
   */
  readonly restoring: boolean
}): ReplayCoordinator => {
  let state: ReplayRenderState = {
    backendComplete: false,
    pendingRenders: 0,
    restoring,
  }

  const apply = (event: ReplayRenderEvent): void => {
    state = nextReplayRenderState(state, event)
    onStatusChange(replayRenderStatus(state))
  }

  // Publish the opening status rather than waiting for the backend to speak.
  onStatusChange(replayRenderStatus(state))

  return {
    beginReplay: () => {
      apply({ _tag: 'ReplayStarted' })
    },
    endBackendReplay: () => {
      apply({ _tag: 'BackendComplete' })
    },
    render: (write, commit) => {
      // Everything the backend sends before `ReplayComplete` belongs to the
      // replay — a snapshot, or bare deltas on a cursor-resumed attach — and
      // has to reach the screen before the screen is called restored. Live
      // output arriving after replay settled must not reopen the overlay.
      // Each render remembers its own decision so queued and parsed counts
      // stay balanced.
      const tracked = !isReplaySettled(state)
      if (tracked) {
        apply({ _tag: 'RenderQueued' })
      }
      let settled = false
      const accepted = write(() => {
        if (settled) {
          return
        }
        settled = true
        if (tracked) {
          apply({ _tag: 'RenderParsed' })
        }
        commit()
      })
      if (accepted || settled) {
        return
      }
      // The screen dropped the chunk. Release the render without committing:
      // nothing was drawn, so nothing may be acknowledged either.
      settled = true
      if (tracked) {
        apply({ _tag: 'RenderParsed' })
      }
    },
    status: () => replayRenderStatus(state),
  }
}

/**
 * Remembers which screen a pane has already drawn on, so each attach knows
 * whether it replays over visible output.
 *
 * The first attach onto a canvas paints an empty screen — it starts the pane
 * rather than restoring it. Every later attach onto that same canvas replays
 * over output the operator can see. Rebuilding the canvas — the pane adopting
 * a different terminal, or React remounting it — starts fresh again, because
 * the new canvas is blank whatever the previous one had reached.
 */
export const createAttachHistory = (): {
  readonly beginAttach: (generation: number) => boolean
} => {
  let drawnGeneration: number | undefined
  return {
    /** Records an attach and reports whether it restores a visible screen. */
    beginAttach: (generation: number): boolean => {
      // Generation 0 is "no canvas mounted": there is nothing on screen yet.
      const restoring = generation !== 0 && drawnGeneration === generation
      drawnGeneration = generation
      return restoring
    },
  }
}

/**
 * A point in one terminal's journal that a particular canvas has reached.
 *
 * The terminal and the canvas are part of the fact, not context around it. A
 * cursor is an offset into one terminal's journal, and it only describes the
 * canvas that rendered it; carried anywhere else it names output the operator
 * cannot see.
 *
 * A pane tracks two such points, because handing a chunk to xterm and xterm
 * parsing it are separated by the write queue:
 *
 * - *queued* — the furthest chunk the canvas has accepted. This is what a
 *   reconnect resumes from: those bytes are already in the queue that feeds
 *   the screen, so asking for them again would draw them twice.
 * - *acknowledged* — the furthest chunk xterm has reported parsed. This is
 *   what the daemon is told, because flow control (ADR 0002) may only release
 *   output the renderer has actually consumed.
 */
export interface TerminalResumePoint {
  readonly cursor: number
  readonly generation: number
  readonly terminalId: string
}

/** The daemon's output generation, as last announced for one terminal. */
export interface TerminalEpochRecord {
  readonly epoch: string
  readonly terminalId: string
}

/**
 * The cursor an attach may resume from, or `undefined` when it must ask for a
 * full snapshot instead.
 *
 * Resuming is only safe while both the terminal and the canvas are unchanged:
 * a reconnect to the same screen skips redundant replay, while a rebuilt
 * canvas or an adopted terminal starts from a snapshot it can actually draw.
 */
export const resumableCursor = (
  point: TerminalResumePoint | undefined,
  attach: { readonly generation: number; readonly terminalId: string }
): number | undefined =>
  point !== undefined &&
  attach.generation !== 0 &&
  point.generation === attach.generation &&
  point.terminalId === attach.terminalId
    ? point.cursor
    : undefined

/**
 * The epoch an attach may declare. Offering another terminal's epoch would
 * read as a revival of this one and raise a marker over untouched output.
 */
export const declarableEpoch = (
  record: TerminalEpochRecord | undefined,
  terminalId: string
): string | undefined =>
  record !== undefined && record.terminalId === terminalId
    ? record.epoch
    : undefined

interface Options {
  readonly onStatus?: (status: TerminalStatus, exitCode?: number) => void
  /** The canvas this attach draws onto, and the identity of that canvas. */
  readonly screen: TerminalScreen
  readonly terminalId: string
}

interface TerminalInputLane {
  active: boolean
  bytes: number
  readonly queue: Array<{ readonly bytes: number; readonly data: string }>
  readonly terminalId: string
  writing: boolean
}

const makeInputLane = (
  terminalId: string,
  active = true
): TerminalInputLane => ({
  active,
  bytes: 0,
  queue: [],
  terminalId,
  writing: false,
})

export function useTerminalRpc({ onStatus, screen, terminalId }: Options) {
  useAtomMount(TerminalServiceClient.runtime)
  const runtimeResult = useAtomValue(TerminalServiceClient.runtime)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalStatus>('running')
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>('idle')
  const [wasRevived, setWasRevived] = useState(false)
  /**
   * Counts canvas rebuilds, so a rebuild restarts the attach against the new
   * screen. Named apart from the daemon's `epoch`, which tracks the PTY's
   * output generation rather than the pane's.
   */
  const [screenRebuilds, setScreenRebuilds] = useState(0)
  /** The furthest chunk the canvas has taken, parsed or still in its queue. */
  const queuedRef = useRef<TerminalResumePoint | undefined>(undefined)
  /** The furthest chunk xterm has reported parsed. */
  const ackedRef = useRef<TerminalResumePoint | undefined>(undefined)
  const epochRef = useRef<TerminalEpochRecord | undefined>(undefined)
  const unackedCharsRef = useRef(0)
  const attachHistoryRef = useRef(createAttachHistory())
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  /**
   * The terminal this pane speaks for, from the moment React renders it.
   *
   * A pane is handed a new terminal one render before the previous attach is
   * torn down: React resets this hook's state while the outgoing stream is
   * still open, and only runs the cleanup that interrupts it afterwards. An
   * event, a write callback, an acknowledgement or a stream failure can land
   * in that window, and `active` does not close it — the old attach really is
   * still live. Reading the identity here instead lets every attach ask
   * whether it is still the one the pane is showing.
   */
  const currentTerminalIdRef = useRef(terminalId)
  currentTerminalIdRef.current = terminalId

  // A render React throws away — an interrupted or suspended one — would
  // otherwise leave this naming a terminal the pane never adopted, silencing
  // the attach that is still on screen. Every commit restates what was
  // actually rendered.
  useLayoutEffect(() => {
    currentTerminalIdRef.current = terminalId
  })

  /**
   * A pane can be handed a different terminal. Nothing this hook learned about
   * the previous one survives that: its status, replay progress and revival
   * all describe a screen the pane no longer shows, and the operator would be
   * told a fresh terminal had exited or been revived. The outgoing attach is
   * only interrupted once React runs its cleanup, so this reset is held by the
   * identity check above rather than by the ordering of the two: a frame
   * landing in between is ignored, and the cursors and epoch it would have
   * established name their own terminal anyway.
   */
  const [attachedTerminalId, setAttachedTerminalId] = useState(terminalId)
  if (attachedTerminalId !== terminalId) {
    setAttachedTerminalId(terminalId)
    setStatus('connecting')
    setTerminalStatus('running')
    setReplayStatus('idle')
    setWasRevived(false)
    queuedRef.current = undefined
    ackedRef.current = undefined
    epochRef.current = undefined
    attachHistoryRef.current = createAttachHistory()
  }

  useEffect(() => {
    if (runtimeResult._tag !== 'Success') {
      return
    }
    const runtime = runtimeResult.value
    const leaseId = globalThis.crypto.randomUUID()
    /** The canvas this attach draws onto for as long as it lives. */
    const generation = screen.generation()
    let active = true

    // Attaching resets the daemon's flow-control debt (ADR 0002), so the pane
    // starts counting unacknowledged output from zero rather than carrying a
    // previous attach's part-filled batch into the new one.
    unackedCharsRef.current = 0

    /**
     * Whether this attach still speaks for the pane. An attach is only
     * silenced by its own cleanup, which React runs after it has already
     * rendered the next terminal, so the identity is checked too.
     */
    const isCurrent = (): boolean =>
      active && currentTerminalIdRef.current === terminalId

    const sendAck = (cursor: number, chars: number, force = false) => {
      if (!isCurrent()) {
        return
      }
      ackedRef.current = { cursor, generation, terminalId }
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

    // One coordinator per attach. A reattach announces its restore up front so
    // the previous attach's completed state cannot linger over a screen the
    // backend is replaying; the pane's first attach stays `idle` so it shows
    // startup rather than claiming to restore output nobody has seen.
    const replay = createReplayCoordinator({
      onStatusChange: (next) => {
        if (!isCurrent()) {
          return
        }
        setReplayStatus(next)
      },
      restoring: attachHistoryRef.current.beginAttach(generation),
    })

    /** How far this attach's canvas has taken output, for dedupe and resume. */
    const queuedCursor = (): number | undefined =>
      resumableCursor(queuedRef.current, { generation, terminalId })

    /** How far xterm has parsed, which is all the daemon may be told. */
    const ackedCursor = (): number | undefined =>
      resumableCursor(ackedRef.current, { generation, terminalId })

    /**
     * Record output the canvas accepted. Only a chunk the screen took counts:
     * output dropped for want of a canvas was never drawn, so resuming past it
     * would leave a hole the operator never sees filled.
     */
    const draw = (
      cursor: number,
      data: string,
      commit: () => void
    ): boolean => {
      const accepted = screen.write(data, commit)
      if (accepted) {
        queuedRef.current = { cursor, generation, terminalId }
      }
      return accepted
    }

    const handle = (event: TerminalAttachEvent): void => {
      if (!isCurrent()) {
        return
      }
      switch (event._tag) {
        case 'Reset':
          queuedRef.current = undefined
          ackedRef.current = undefined
          epochRef.current = { epoch: event.epoch, terminalId }
          screen.reset()
          if (isTerminalRevival(event.reason)) {
            setWasRevived(true)
          }
          replay.beginReplay()
          return
        case 'Snapshot': {
          const { cursor, data } = event
          replay.beginReplay()
          replay.render(
            (commit) => {
              // A snapshot replaces the screen, so whatever the canvas had
              // reached describes output it no longer shows.
              screen.reset()
              queuedRef.current = undefined
              ackedRef.current = undefined
              return draw(cursor, data, commit)
            },
            () => {
              sendAck(cursor, data.length)
            }
          )
          return
        }
        case 'Delta': {
          // Deduplicate against what the canvas has taken, not against what
          // xterm has parsed: a delta sitting in the write queue is already on
          // its way to this screen, and drawing it again would repeat it.
          const queued = queuedCursor()
          if (queued !== undefined && event.cursor <= queued) {
            return
          }
          const { cursor, data } = event
          replay.render(
            (commit) => draw(cursor, data, commit),
            () => {
              sendAck(cursor, data.length)
            }
          )
          return
        }
        case 'Meta':
          epochRef.current = { epoch: event.epoch, terminalId }
          setTerminalStatus(event.status)
          onStatusRef.current?.(event.status)
          setStatus('connected')
          return
        case 'ReplayComplete': {
          // The UI only follows once every replayed chunk has been parsed.
          replay.endBackendReplay()
          // Flow control may only be released for output xterm has parsed;
          // chunks still queued are acknowledged by their own callbacks.
          const acked = ackedCursor()
          if (acked !== undefined) {
            sendAck(acked, 0, true)
          }
          return
        }
        case 'Exit':
          setTerminalStatus('stopped')
          onStatusRef.current?.('stopped', event.exitCode)
          return
        default: {
          event satisfies never
          return
        }
      }
    }

    const attach = Effect.suspend(() =>
      Effect.gen(function* () {
        if (isCurrent()) {
          setStatus('connecting')
        }
        // Resume from what the canvas has taken. Replaying a delta that is
        // still in xterm's write queue would draw it a second time.
        const cursor = queuedCursor()
        const epoch = declarableEpoch(epochRef.current, terminalId)
        const client = yield* TerminalServiceClient
        const stream = client('terminal.attach', {
          id: terminalId,
          leaseId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(epoch === undefined ? {} : { epoch }),
        })
        yield* Stream.runForEach(stream, (event) =>
          Effect.sync(() => handle(event))
        )
      })
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (!isCurrent()) {
            return
          }
          setStatus('disconnected')
        })
      )
    )

    // A canvas rebuilt underneath a live attach is blank, and the daemon is
    // still streaming deltas onto the screen it replaced. Restart so the new
    // canvas is bootstrapped from a snapshot instead of inheriting a cursor
    // that describes output it never drew.
    const unsubscribe = screen.subscribe(() => {
      if (!isCurrent()) {
        return
      }
      if (screen.generation() !== generation) {
        setScreenRebuilds((count) => count + 1)
      }
    })

    const fiber = Effect.runForkWith(runtime)(attach)
    return () => {
      active = false
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [runtimeResult, screen, screenRebuilds, terminalId])

  const inputRuntime =
    runtimeResult._tag === 'Success' ? runtimeResult.value : undefined
  const inputLaneRef = useRef<TerminalInputLane>(
    makeInputLane(terminalId, inputRuntime !== undefined)
  )

  useEffect(() => {
    const lane = makeInputLane(terminalId, inputRuntime !== undefined)
    inputLaneRef.current = lane
    return () => {
      // A pane can adopt another terminal while a write is in flight. Keep
      // later keystrokes out of the old drain rather than sending them to the
      // previous terminal or automatically replaying an ambiguous write.
      lane.active = false
      lane.queue.length = 0
      lane.bytes = 0
    }
  }, [inputRuntime, terminalId])

  const send = useCallback(
    (data: string) => {
      if (inputRuntime === undefined) {
        return
      }
      const lane = inputLaneRef.current
      if (!(lane.active && lane.terminalId === terminalId)) {
        return
      }
      const bytes = encoder.encode(data).length
      if (
        bytes > INPUT_WRITE_BYTES ||
        lane.bytes + bytes > INPUT_PENDING_BYTES
      ) {
        console.error(
          `Terminal input overflow for ${terminalId}; input was not dropped silently`
        )
        setStatus('disconnected')
        return
      }
      lane.queue.push({ data, bytes })
      lane.bytes += bytes
      if (lane.writing) {
        return
      }
      lane.writing = true
      const runtime = inputRuntime
      const drain = async () => {
        while (lane.active && lane.queue.length > 0) {
          const item = lane.queue[0]
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
            lane.queue.shift()
            lane.bytes -= item.bytes
          } catch (error) {
            console.error('Terminal input write failed', error)
            if (lane.active) {
              setStatus('disconnected')
            }
            // A failed RPC has ambiguous delivery. Never retain later
            // keystrokes for an automatic retry: replaying terminal input can
            // execute a command twice or deliver it to a different prompt.
            lane.queue.length = 0
            lane.bytes = 0
            break
          }
        }
        lane.writing = false
      }
      drain().catch((error: unknown) => {
        console.error('Terminal input queue failed', error)
      })
    },
    [inputRuntime, terminalId]
  )

  /**
   * Acknowledging the revival marker only hides it. A later epoch change is a
   * new revival and raises the marker again.
   */
  const dismissRevival = useCallback(() => {
    setWasRevived(false)
  }, [])

  return {
    dismissRevival,
    replayStatus,
    send,
    status,
    terminalStatus,
    wasRevived,
  }
}
