/**
 * One terminal pane's half of the `terminal.attach` protocol.
 *
 * The frame handling itself lives in `terminal-attach-loop.ts`; this hook is
 * everything around it that a production pane needs and a proof does not: which
 * screen a cursor describes, when a failed attach may be reopened, an input
 * lane that cannot grow without bound, and the reset a pane owes the operator
 * when it is handed a different terminal.
 *
 * @see apps/web/src/lib/terminal-attach-loop.ts — the frame ordering
 * @see apps/web/src/lib/terminal-screen.ts — the surface identity it attaches to
 */

import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import { Effect, Fiber, Stream } from 'effect'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import {
  createTerminalAttachLoop,
  type TerminalReplayStatus,
} from '@/lib/terminal-attach-loop'
import type { TerminalScreen } from '@/lib/terminal-screen'

const INPUT_WRITE_BYTES = 64 * 1024
const INPUT_PENDING_BYTES = 64 * 1024
const encoder = new TextEncoder()

/**
 * How long a pane waits before reopening an attach that failed, indexed by the
 * number of failures that came before it. The attach protocol resumes from the
 * cursor the screen has drawn to, so a reattach is cheap; the delays exist to
 * keep a pane from hammering a daemon that is shedding load — which is exactly
 * what most attach failures mean — rather than to protect the pane.
 *
 * Named after `RENDERER_RECONNECT_DELAYS_MS`, but deliberately shorter: that
 * supervisor re-establishes the whole transport, while this only reopens one
 * terminal's stream over a transport that is still up.
 */
export const TERMINAL_REATTACH_DELAYS_MS = [1000, 2000, 4000, 8000] as const

const reattachDelay = (failureCount: number): number =>
  TERMINAL_REATTACH_DELAYS_MS[
    Math.min(failureCount, TERMINAL_REATTACH_DELAYS_MS.length - 1)
  ] ?? 8000

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
type TerminalStatus = 'running' | 'stopped' | 'restarted'

/**
 * Remembers which screen a pane has already drawn on, so each attach knows
 * whether it replays over visible output.
 *
 * The first attach onto a surface paints an empty screen — it starts the pane
 * rather than restoring it. Every later attach onto that same surface replays
 * over output the operator can see. Rebuilding the surface — the pane adopting
 * a different terminal, or React remounting it — starts fresh again, because
 * the new surface is blank whatever the previous one had reached.
 */
export const createAttachHistory = (): {
  readonly beginAttach: (generation: number) => boolean
} => {
  let drawnGeneration: number | undefined
  return {
    /** Records an attach and reports whether it restores a visible screen. */
    beginAttach: (generation: number): boolean => {
      // Generation 0 is "no surface mounted": there is nothing on screen yet.
      const restoring = generation !== 0 && drawnGeneration === generation
      drawnGeneration = generation
      return restoring
    },
  }
}

/**
 * A point in one terminal's journal that a particular screen has reached.
 *
 * The terminal and the screen are part of the fact, not context around it. A
 * cursor is an offset into one terminal's journal, and it only describes the
 * surface that rendered it; carried anywhere else it names output the operator
 * cannot see.
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
 * Resuming is only safe while both the terminal and the surface are unchanged:
 * a reconnect to the same screen skips redundant replay, while a rebuilt
 * surface or an adopted terminal starts from a snapshot it can actually draw.
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
  /** The screen this attach draws onto, and the identity of that screen. */
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
  const [replayStatus, setReplayStatus] = useState<TerminalReplayStatus>('idle')
  const [wasRevived, setWasRevived] = useState(false)
  /**
   * Counts surface rebuilds, so a rebuild restarts the attach against the new
   * screen. Named apart from the daemon's `epoch`, which tracks the PTY's
   * output generation rather than the pane's. It is also what opens the very
   * first attach: Ghostty's surface is built asynchronously, so a pane renders
   * before it has any screen to draw on.
   */
  const [screenRebuilds, setScreenRebuilds] = useState(0)
  /**
   * Counts reattach requests, so a failed attach — or a write that could not
   * be delivered — reopens the stream instead of leaving the pane showing a
   * "reconnecting" banner that nothing is acting on.
   */
  const [attachAttempt, setAttachAttempt] = useState(0)
  /**
   * Consecutive attaches that failed without delivering anything. A stream
   * that produced even one event proves the daemon is reachable, so the next
   * failure starts the backoff over rather than escalating a flap that has
   * already recovered once.
   */
  const attachFailuresRef = useRef(0)
  /** The furthest chunk the mounted surface has parsed. */
  const drawnRef = useRef<TerminalResumePoint | undefined>(undefined)
  const epochRef = useRef<TerminalEpochRecord | undefined>(undefined)
  const attachHistoryRef = useRef(createAttachHistory())
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  /**
   * The terminal this pane speaks for, from the moment React renders it.
   *
   * A pane is handed a new terminal one render before the previous attach is
   * torn down: React resets this hook's state while the outgoing stream is
   * still open, and only runs the cleanup that interrupts it afterwards. An
   * event, an acknowledgement or a stream failure can land in that window, and
   * `active` does not close it — the old attach really is still live. Reading
   * the identity here instead lets every attach ask whether it is still the one
   * the pane is showing.
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
   * landing in between is ignored, and the cursor and epoch it would have
   * established name their own terminal anyway.
   */
  const [attachedTerminalId, setAttachedTerminalId] = useState(terminalId)
  if (attachedTerminalId !== terminalId) {
    setAttachedTerminalId(terminalId)
    setStatus('connecting')
    setTerminalStatus('running')
    setReplayStatus('idle')
    setWasRevived(false)
    drawnRef.current = undefined
    epochRef.current = undefined
    attachHistoryRef.current = createAttachHistory()
    // The backoff describes how badly the previous terminal's stream was
    // faring. A fresh terminal deserves its first retry immediately.
    attachFailuresRef.current = 0
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `screenRebuilds` and `attachAttempt` are triggers, not values the body reads — a rebuilt screen needs a fresh attach to redraw onto the new surface, and a failed attach or write needs the stream reopened.
  useEffect(() => {
    if (runtimeResult._tag !== 'Success') {
      return
    }
    const runtime = runtimeResult.value
    /** The surface this attach draws onto for as long as it lives. */
    const generation = screen.generation()

    let active = true
    let reattachTimer: ReturnType<typeof setTimeout> | undefined

    /**
     * Whether this attach still speaks for the pane. An attach is only
     * silenced by its own cleanup, which React runs after it has already
     * rendered the next terminal, so the identity is checked too.
     */
    const isCurrent = (): boolean =>
      active && currentTerminalIdRef.current === terminalId

    // A surface rebuilt underneath a live attach is blank, and the daemon is
    // still streaming deltas onto the screen it replaced. Restart so the new
    // surface is bootstrapped from a snapshot instead of inheriting a cursor
    // that describes output it never drew. The same subscription is what opens
    // the first attach once the asynchronously built surface mounts.
    const unsubscribe = screen.subscribe(() => {
      if (!isCurrent()) {
        return
      }
      if (screen.generation() !== generation) {
        setScreenRebuilds((count) => count + 1)
      }
    })

    if (generation === 0) {
      // Nothing to draw onto yet. Attaching now would have the daemon replay a
      // snapshot into a screen that cannot show it, and the pane would then
      // have to throw that replay away when the surface arrives.
      return () => {
        active = false
        unsubscribe()
      }
    }

    const leaseId = globalThis.crypto.randomUUID()

    const sendAck = (cursor: number) => {
      if (!isCurrent()) {
        return
      }
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

    // One loop per attach. Attaching resets the daemon's flow-control debt
    // (ADR 0002), so a fresh loop is also what stops a previous attach's
    // part-filled acknowledgement batch from being carried into this one.
    const loop = createTerminalAttachLoop({
      effects: {
        ack: sendAck,
        onCursor: (cursor) => {
          if (!isCurrent()) {
            return
          }
          drawnRef.current =
            cursor === undefined
              ? undefined
              : { cursor, generation, terminalId }
        },
        onEpoch: (epoch) => {
          if (!isCurrent()) {
            return
          }
          epochRef.current = { epoch, terminalId }
        },
        onExit: (exit) => {
          if (!isCurrent()) {
            return
          }
          setTerminalStatus('stopped')
          onStatusRef.current?.('stopped', exit.exitCode)
        },
        onReplayStatus: (next) => {
          if (!isCurrent()) {
            return
          }
          setReplayStatus(next)
        },
        onRevival: () => {
          if (!isCurrent()) {
            return
          }
          setWasRevived(true)
        },
        onStatus: (next) => {
          if (!isCurrent()) {
            return
          }
          setTerminalStatus(next)
          onStatusRef.current?.(next)
          setStatus('connected')
        },
      },
      // A reattach announces its restore up front so the previous attach's
      // completed state cannot linger over a screen the daemon is replaying;
      // the pane's first attach stays `idle` so it shows startup rather than
      // claiming to restore output nobody has seen.
      restoring: attachHistoryRef.current.beginAttach(generation),
      resume: {
        cursor: resumableCursor(drawnRef.current, { generation, terminalId }),
      },
      target: {
        resetAndWrite: (data) => screen.resetAndWrite(data),
        write: (data) => screen.write(data),
      },
    })

    const attach = Effect.suspend(() =>
      Effect.gen(function* () {
        if (isCurrent()) {
          setStatus('connecting')
        }
        // Resume from what this surface has parsed. Everything it took has
        // already been drawn, so replaying it would put it on screen twice.
        const cursor = resumableCursor(drawnRef.current, {
          generation,
          terminalId,
        })
        const epoch = declarableEpoch(epochRef.current, terminalId)
        const client = yield* TerminalServiceClient
        const stream = client('terminal.attach', {
          id: terminalId,
          leaseId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(epoch === undefined ? {} : { epoch }),
        })
        yield* Stream.runForEach(stream, (event) =>
          Effect.sync(() => {
            if (!isCurrent()) {
              return
            }
            // Any frame proves this attach reached the daemon, so the next
            // failure is a new incident rather than a continuation of the last.
            attachFailuresRef.current = 0
            loop.handle(event)
          })
        )
      })
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (!isCurrent()) {
            return
          }
          setStatus('disconnected')
          // Attach failures under load — a server-side queue overflow, a
          // pty-host request timing out, a transport error — are transient,
          // and the pane already tells the operator it is reconnecting. Make
          // that true: reopen the stream, which resumes from the cursor this
          // surface has drawn to or falls back to a snapshot.
          const failures = attachFailuresRef.current
          attachFailuresRef.current = failures + 1
          reattachTimer = setTimeout(() => {
            reattachTimer = undefined
            if (!isCurrent()) {
              return
            }
            setAttachAttempt((count) => count + 1)
          }, reattachDelay(failures))
        })
      )
    )

    const fiber = Effect.runForkWith(runtime)(attach)
    return () => {
      active = false
      unsubscribe()
      // A pending retry belongs to this attach. Unmounting the pane or handing
      // it another terminal retires the attach that scheduled it.
      if (reattachTimer !== undefined) {
        clearTimeout(reattachTimer)
        reattachTimer = undefined
      }
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [attachAttempt, runtimeResult, screen, screenRebuilds, terminalId])

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
        // The lane is backed up, which says nothing about the screen. Reopen
        // the attach so the pane resyncs and reports what it finds instead of
        // holding "disconnected" over a terminal that may be perfectly live.
        setAttachAttempt((count) => count + 1)
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
              // Output and input travel separately, so a failed write leaves
              // the pane unable to say what the terminal is doing. Reopen the
              // attach at once — this is the first sign of trouble, so there
              // is no backoff to serve yet — and let the stream report the
              // truth, including whichever of these keystrokes landed.
              setAttachAttempt((count) => count + 1)
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
