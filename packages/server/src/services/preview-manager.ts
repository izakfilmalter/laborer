import { randomUUID } from 'node:crypto'
import type {
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from '@laborer/shared/rpc'
import {
  FILL_PREVIEW_VIEWPORT,
  PreviewInvalidUrlError,
  PreviewSessionLookupError,
} from '@laborer/shared/rpc'
import {
  Clock,
  Context,
  Effect,
  Layer,
  PubSub,
  type Scope,
  Stream,
  SynchronizedRef,
} from 'effect'

const LOOPBACK_PREFIX =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i
const URL_PROTOCOL_PREFIX = /^([A-Za-z][A-Za-z\d+.-]*):/

class PreviewUrlNormalizationError extends Error {
  readonly _tag = 'PreviewUrlNormalizationError'
  override readonly cause: unknown
  readonly protocol: string | undefined
  readonly reason: 'empty' | 'parse' | 'unsupported-protocol'

  constructor(
    reason: 'empty' | 'parse' | 'unsupported-protocol',
    protocol?: string,
    cause?: unknown
  ) {
    super('Preview URL normalization failed')
    this.cause = cause
    this.protocol = protocol
    this.reason = reason
  }
}

let nextPreviewTabSequence = 0

const newPreviewTabId = (): string => {
  nextPreviewTabSequence += 1
  return `tab_${nextPreviewTabSequence.toString(36)}`
}

const previewUrlProtocol = (rawUrl: string): string | undefined =>
  URL_PROTOCOL_PREFIX.exec(rawUrl)?.[1]?.toLowerCase().concat(':')

export const normalizePreviewUrl = (
  rawUrl: string
): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => {
      const trimmed = rawUrl.trim()
      if (trimmed.length === 0) {
        throw new PreviewUrlNormalizationError('empty')
      }
      const candidate = trimmed.includes('://')
        ? trimmed
        : `${LOOPBACK_PREFIX.test(trimmed) ? 'http' : 'https'}://${trimmed}`
      let parsed: URL
      try {
        parsed = new URL(candidate)
      } catch (cause) {
        throw new PreviewUrlNormalizationError(
          'parse',
          previewUrlProtocol(candidate),
          cause
        )
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new PreviewUrlNormalizationError(
          'unsupported-protocol',
          parsed.protocol
        )
      }
      return parsed.href
    },
    catch: (cause) => {
      if (cause instanceof PreviewUrlNormalizationError) {
        return new PreviewInvalidUrlError({
          cause,
          inputLength: rawUrl.length,
          ...(cause.protocol === undefined ? {} : { protocol: cause.protocol }),
          reason: cause.reason,
        })
      }
      return new PreviewInvalidUrlError({
        cause,
        inputLength: rawUrl.length,
        reason: 'unexpected',
      })
    },
  })

interface PreviewSessionState {
  readonly snapshot: PreviewSessionSnapshot
  readonly tabId: string
  readonly workspaceId: string
}

interface ManagerState {
  readonly revision: number
  readonly sessions: ReadonlyMap<string, PreviewSessionState>
}

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, 'revision' | 'serverEpoch'>
    : never
  : never

const compositeKey = (workspaceId: string, tabId: string): string =>
  `${workspaceId}\u0000${tabId}`

const currentIsoTimestamp = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString())
)

const sessionsForWorkspace = (
  state: ManagerState,
  workspaceId: string
): readonly PreviewSessionState[] => {
  const sessions: PreviewSessionState[] = []
  for (const session of state.sessions.values()) {
    if (session.workspaceId === workspaceId) {
      sessions.push(session)
    }
  }
  return sessions
}

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly close: (
      input: PreviewCloseInput
    ) => Effect.Effect<void, PreviewError>
    readonly closeWorkspace: (workspaceId: string) => Effect.Effect<void>
    readonly events: Stream.Stream<PreviewEvent>
    readonly list: (workspaceId: string) => Effect.Effect<PreviewListResult>
    readonly navigate: (
      input: PreviewNavigateInput
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>
    readonly open: (
      input: PreviewOpenInput
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>
    readonly refresh: (
      input: PreviewRefreshInput
    ) => Effect.Effect<void, PreviewError>
    readonly reportStatus: (
      input: PreviewReportStatusInput
    ) => Effect.Effect<void, PreviewError>
    readonly resize: (
      input: PreviewResizeInput
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>
    readonly subscribeEvents: Effect.Effect<
      PubSub.Subscription<PreviewEvent>,
      never,
      Scope.Scope
    >
  }
>()('@laborer/server/PreviewManager') {
  static readonly layer = Layer.effect(
    PreviewManager,
    Effect.gen(function* () {
      const serverEpoch = randomUUID()
      const stateRef = yield* SynchronizedRef.make<ManagerState>({
        revision: 0,
        sessions: new Map(),
      })
      const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(eventsPubSub))

      const mutateExisting = <A>(
        workspaceId: string,
        tabId: string,
        mutate: (session: PreviewSessionState) => Effect.Effect<{
          readonly emit: PreviewEventDraft | null
          readonly next: PreviewSessionState
          readonly result: A
        }>
      ): Effect.Effect<A, PreviewSessionLookupError> => {
        type ModifyResult =
          | {
              readonly _tag: 'Failure'
              readonly error: PreviewSessionLookupError
            }
          | { readonly _tag: 'Success'; readonly result: A }

        return SynchronizedRef.modifyEffect(stateRef, (state) => {
          const session = state.sessions.get(compositeKey(workspaceId, tabId))
          if (session === undefined) {
            return Effect.succeed([
              {
                _tag: 'Failure' as const,
                error: new PreviewSessionLookupError({ tabId, workspaceId }),
              },
              state,
            ] as readonly [ModifyResult, ManagerState])
          }
          return mutate(session).pipe(
            Effect.flatMap(({ emit, next, result }) => {
              const revision =
                emit === null ? state.revision : state.revision + 1
              const publish =
                emit === null
                  ? Effect.void
                  : PubSub.publish(eventsPubSub, {
                      ...emit,
                      revision,
                      serverEpoch,
                    } as PreviewEvent)
              return publish.pipe(
                Effect.map(() => {
                  const sessions = new Map(state.sessions)
                  sessions.set(compositeKey(workspaceId, tabId), next)
                  return [
                    { _tag: 'Success' as const, result },
                    { revision, sessions },
                  ] as readonly [ModifyResult, ManagerState]
                })
              )
            })
          )
        }).pipe(
          Effect.flatMap((result) =>
            result._tag === 'Failure'
              ? Effect.fail(result.error)
              : Effect.succeed(result.result)
          )
        )
      }

      const open = Effect.fn('PreviewManager.open')(function* (
        input: PreviewOpenInput
      ) {
        const tabId = newPreviewTabId()
        const updatedAt = yield* currentIsoTimestamp
        const viewport = input.viewport ?? FILL_PREVIEW_VIEWPORT
        const snapshot: PreviewSessionSnapshot =
          input.url === undefined
            ? {
                canGoBack: false,
                canGoForward: false,
                navStatus: { _tag: 'Idle' },
                tabId,
                updatedAt,
                viewport,
                workspaceId: input.workspaceId,
              }
            : {
                canGoBack: false,
                canGoForward: false,
                navStatus: {
                  _tag: 'Loading',
                  title: '',
                  url: yield* normalizePreviewUrl(input.url),
                },
                tabId,
                updatedAt,
                viewport,
                workspaceId: input.workspaceId,
              }
        yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
          const revision = state.revision + 1
          const sessions = new Map(state.sessions)
          sessions.set(compositeKey(input.workspaceId, tabId), {
            snapshot,
            tabId,
            workspaceId: input.workspaceId,
          })
          return PubSub.publish(eventsPubSub, {
            createdAt: updatedAt,
            revision,
            serverEpoch,
            snapshot,
            tabId,
            type: 'opened',
            workspaceId: input.workspaceId,
          }).pipe(Effect.as([snapshot, { revision, sessions }] as const))
        })
        return snapshot
      })

      const navigate = Effect.fn('PreviewManager.navigate')(function* (
        input: PreviewNavigateInput
      ) {
        const url = yield* normalizePreviewUrl(input.url)
        return yield* mutateExisting(
          input.workspaceId,
          input.tabId,
          Effect.fn('PreviewManager.navigateSession')(function* (session) {
            const updatedAt = yield* currentIsoTimestamp
            const previousTitle =
              session.snapshot.navStatus._tag === 'Idle'
                ? ''
                : session.snapshot.navStatus.title
            const snapshot: PreviewSessionSnapshot = {
              ...session.snapshot,
              navStatus: {
                _tag: 'Success',
                title: input.resolvedTitle ?? previousTitle,
                url,
              },
              updatedAt,
              viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            }
            return {
              emit: {
                createdAt: updatedAt,
                snapshot,
                tabId: input.tabId,
                type: 'navigated',
                workspaceId: input.workspaceId,
              },
              next: { ...session, snapshot },
              result: snapshot,
            }
          })
        )
      })

      const reportStatus = Effect.fn('PreviewManager.reportStatus')(function* (
        input: PreviewReportStatusInput
      ) {
        yield* mutateExisting(
          input.workspaceId,
          input.tabId,
          Effect.fn('PreviewManager.reportSessionStatus')(function* (session) {
            const updatedAt = yield* currentIsoTimestamp
            const snapshot: PreviewSessionSnapshot = {
              ...session.snapshot,
              canGoBack: input.canGoBack,
              canGoForward: input.canGoForward,
              navStatus: input.navStatus,
              updatedAt,
              viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            }
            const emit: PreviewEventDraft =
              input.navStatus._tag === 'LoadFailed'
                ? {
                    code: input.navStatus.code,
                    createdAt: updatedAt,
                    description: input.navStatus.description,
                    tabId: input.tabId,
                    title: input.navStatus.title,
                    type: 'failed',
                    url: input.navStatus.url,
                    workspaceId: input.workspaceId,
                  }
                : {
                    createdAt: updatedAt,
                    snapshot,
                    tabId: input.tabId,
                    type: 'navigated',
                    workspaceId: input.workspaceId,
                  }
            return {
              emit,
              next: { ...session, snapshot },
              result: undefined,
            }
          })
        )
      })

      const resize = Effect.fn('PreviewManager.resize')(function* (
        input: PreviewResizeInput
      ) {
        return yield* mutateExisting(
          input.workspaceId,
          input.tabId,
          Effect.fn('PreviewManager.resizeSession')(function* (session) {
            const updatedAt = yield* currentIsoTimestamp
            const snapshot = {
              ...session.snapshot,
              updatedAt,
              viewport: input.viewport,
            }
            return {
              emit: {
                createdAt: updatedAt,
                snapshot,
                tabId: input.tabId,
                type: 'resized',
                workspaceId: input.workspaceId,
              },
              next: { ...session, snapshot },
              result: snapshot,
            }
          })
        )
      })

      const refresh = Effect.fn('PreviewManager.refresh')(
        (input: PreviewRefreshInput) =>
          mutateExisting(input.workspaceId, input.tabId, (session) =>
            Effect.succeed({ emit: null, next: session, result: undefined })
          )
      )

      const close = Effect.fn('PreviewManager.close')(function* (
        input: PreviewCloseInput
      ) {
        const createdAt = yield* currentIsoTimestamp
        yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
          const targets =
            input.tabId === undefined
              ? sessionsForWorkspace(state, input.workspaceId)
              : [
                  state.sessions.get(
                    compositeKey(input.workspaceId, input.tabId)
                  ),
                ].filter(
                  (session): session is PreviewSessionState =>
                    session !== undefined
                )
          if (targets.length === 0) {
            return Effect.succeed([undefined, state] as const)
          }
          const sessions = new Map(state.sessions)
          let revision = state.revision
          return Effect.forEach(
            targets,
            (target) => {
              revision += 1
              sessions.delete(compositeKey(target.workspaceId, target.tabId))
              return PubSub.publish(eventsPubSub, {
                createdAt,
                revision,
                serverEpoch,
                tabId: target.tabId,
                type: 'closed',
                workspaceId: target.workspaceId,
              })
            },
            { discard: true }
          ).pipe(Effect.as([undefined, { revision, sessions }] as const))
        })
      })

      const list = Effect.fn('PreviewManager.list')(function* (
        workspaceId: string
      ) {
        const state = yield* SynchronizedRef.get(stateRef)
        return {
          revision: state.revision,
          serverEpoch,
          sessions: sessionsForWorkspace(state, workspaceId)
            .map(({ snapshot }) => snapshot)
            .toSorted((left, right) =>
              left.updatedAt.localeCompare(right.updatedAt)
            ),
        }
      })

      return PreviewManager.of({
        close,
        closeWorkspace: (workspaceId) => close({ workspaceId }),
        events: Stream.fromPubSub(eventsPubSub),
        list,
        navigate,
        open,
        refresh,
        reportStatus,
        resize,
        subscribeEvents: PubSub.subscribe(eventsPubSub),
      })
    })
  )
}
