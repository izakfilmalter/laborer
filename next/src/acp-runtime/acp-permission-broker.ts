import { randomUUID } from 'node:crypto'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from '@agentclientprotocol/sdk'
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  type Scope,
  Semaphore,
} from 'effect'
import type {
  AcpAuthorityRepository,
  AcpPendingCapacityScope,
  AcpPermissionAuthorityRecord,
  AcpTurnScope,
} from './acp-authority.ts'
import {
  AcpPermissionAuthorityRecord as AuthorityRecord,
  pendingPermissionCapacityExceeded,
} from './acp-authority.ts'

const DEFAULT_PERMISSION_TIMEOUT_MILLIS = 5 * 60 * 1000
export const ACP_PERMISSION_ALLOW_ACTION_ID = 'laborer_permission_allow_once'
export const ACP_PERMISSION_REJECT_ACTION_ID = 'laborer_permission_reject_once'

export type AcpPermissionCategory =
  | 'file edit'
  | 'file read'
  | 'guarded tool'
  | 'network'
  | 'shell'

export interface AcpPermissionTurnAuthority extends AcpTurnScope {
  readonly authorizedSlackUserId: string | null
}

export interface AcpPermissionPresentationRequest {
  readonly authorizedSlackUserId: string
  readonly capability: string
  readonly category: AcpPermissionCategory
  readonly channelId: string
  readonly expiresAt: number
  readonly presentationMarker: string
  readonly rootTs: string
  readonly workspaceId: string
}

export interface AcpPermissionPresenter {
  readonly drain: Effect.Effect<void, never, never>
  readonly post: (
    request: AcpPermissionPresentationRequest
  ) => Effect.Effect<{ readonly messageTs: string }, unknown, never>
  readonly recover?: (
    resolveState: (
      presentationMarker: string
    ) => Effect.Effect<'allowed' | 'cancelled' | 'rejected' | null>
  ) => Effect.Effect<void, never, never>
  readonly settle: (request: {
    readonly authorizedSlackUserId: string
    readonly capability: string
    readonly category: AcpPermissionCategory
    readonly channelId: string
    readonly messageTs: string | null
    readonly presentationMarker: string
    readonly rootTs: string
    readonly state: 'allowed' | 'cancelled' | 'expired' | 'rejected'
    readonly workspaceId: string
  }) => Effect.Effect<void, never, never>
}

export type AcpPermissionInteractionResult = 'claimed' | 'ignored' | 'retry'

export interface AcpPermissionInteraction {
  readonly actionId: string
  readonly capability: string
  readonly channelId: string
  readonly messageTs: string
  readonly rootTs: string
  readonly slackUserId: string
  readonly workspaceId: string
}

export interface AcpPermissionBroker {
  readonly activateTurn: (
    authority: AcpPermissionTurnAuthority
  ) => Effect.Effect<Effect.Effect<void>>
  readonly cancelAll: Effect.Effect<void>
  readonly claimInteraction: (
    interaction: AcpPermissionInteraction
  ) => Effect.Effect<AcpPermissionInteractionResult>
  readonly handleInteraction: (
    interaction: AcpPermissionInteraction
  ) => Effect.Effect<AcpPermissionInteractionResult>
  readonly request: (
    request: RequestPermissionRequest
  ) => Effect.Effect<RequestPermissionResponse>
}

interface LivePermission {
  readonly allowOptionId: string
  readonly argumentDigest: string
  readonly authority: AcpPermissionTurnAuthority
  readonly capability: string
  readonly capabilityDigest: string
  readonly category: AcpPermissionCategory
  readonly decision: Deferred.Deferred<RequestPermissionResponse>
  readonly expiresAt: number
  readonly inputDigest: string
  readonly messageReady: Deferred.Deferred<void>
  messageTs: string | null
  readonly presentationMarker: string
  readonly recordId: string
  readonly rejectOptionId: string
  readonly requestIdentityDigest: string
  readonly toolCallDigest: string
}

interface PermissionPreparationContext {
  readonly allowOption: RequestPermissionRequest['options'][number]
  readonly authority: AcpPermissionTurnAuthority
  readonly authorizedSlackUserId: string
  readonly rejectOption: RequestPermissionRequest['options'][number]
}

const cancelledResponse: RequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
}

const permissionPreparationContext = (
  authority: AcpPermissionTurnAuthority | undefined,
  request: RequestPermissionRequest
): PermissionPreparationContext | null => {
  const authorizedSlackUserId = authority?.authorizedSlackUserId
  if (authority === undefined || authorizedSlackUserId == null) {
    return null
  }
  const allowOption = request.options.find(
    (option) => option.kind === 'allow_once'
  )
  const rejectOption = request.options.find(
    (option) => option.kind === 'reject_once'
  )
  return allowOption === undefined || rejectOption === undefined
    ? null
    : {
        allowOption,
        authority,
        authorizedSlackUserId,
        rejectOption,
      }
}

const safeCategory = (
  kind: ToolKind | null | undefined
): AcpPermissionCategory => {
  switch (kind) {
    case 'execute':
      return 'shell'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file edit'
    case 'read':
    case 'search':
      return 'file read'
    case 'fetch':
      return 'network'
    default:
      return 'guarded tool'
  }
}

const positiveTimeout = (candidate: number | undefined): number =>
  candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : DEFAULT_PERMISSION_TIMEOUT_MILLIS

const terminalRecord = (
  record: AcpPermissionAuthorityRecord,
  state: 'allowed' | 'cancelled' | 'rejected',
  now: number
): AcpPermissionAuthorityRecord =>
  AuthorityRecord.make({ ...record, state, updatedAt: now })

const interactionMatchesPermission = (
  interaction: AcpPermissionInteraction,
  permission: LivePermission,
  active: AcpPermissionTurnAuthority | undefined
): boolean => {
  const { authority } = permission
  return [
    active === authority,
    authority.workspaceId === interaction.workspaceId,
    authority.channelId === interaction.channelId,
    authority.rootTs === interaction.rootTs,
    authority.authorizedSlackUserId === interaction.slackUserId,
    permission.messageTs === interaction.messageTs,
  ].every(Boolean)
}

const decisionForInteraction = (
  interaction: AcpPermissionInteraction,
  permission: LivePermission
):
  | {
      readonly intent: 'allow' | 'reject'
      readonly optionId: string
      readonly state: 'allowed' | 'rejected'
    }
  | undefined => {
  if (interaction.actionId === ACP_PERMISSION_ALLOW_ACTION_ID) {
    return {
      intent: 'allow',
      optionId: permission.allowOptionId,
      state: 'allowed',
    }
  }
  if (interaction.actionId === ACP_PERMISSION_REJECT_ACTION_ID) {
    return {
      intent: 'reject',
      optionId: permission.rejectOptionId,
      state: 'rejected',
    }
  }
  return undefined
}

const authorityRecordMatches = (options: {
  readonly currentTime?: number
  readonly permission: LivePermission
  readonly record: AcpPermissionAuthorityRecord
  readonly repository: AcpAuthorityRepository
}): boolean => {
  const { authority } = options.permission
  const digest = options.repository.digest
  const expectedMessageDigest = digest(
    'slack-permission-message',
    JSON.stringify({
      channel: authority.channelId,
      root: authority.rootTs,
      ts: options.permission.messageTs,
    })
  )
  return [
    options.currentTime === undefined ||
      options.record.expiresAt > options.currentTime,
    options.record.capabilityDigest === options.permission.capabilityDigest,
    options.record.inputDigest === options.permission.inputDigest,
    options.record.argumentDigest === options.permission.argumentDigest,
    options.record.workspaceDigest ===
      digest('workspace', authority.workspaceId),
    options.record.channelDigest ===
      digest('slack-channel', authority.channelId),
    options.record.rootDigest === digest('slack-root', authority.rootTs),
    options.record.conversationDigest ===
      digest('conversation', authority.conversationId),
    options.record.sessionDigest === digest('acp-session', authority.sessionId),
    options.record.turnDigest === digest('turn', authority.turnId),
    options.record.promptDigest === digest('prompt', authority.promptId),
    options.record.authorizedUserDigest ===
      digest('slack-user', authority.authorizedSlackUserId ?? ''),
    options.record.optionAllowDigest ===
      digest('permission-option', options.permission.allowOptionId),
    options.record.optionRejectDigest ===
      digest('permission-option', options.permission.rejectOptionId),
    options.record.presentationMarkerDigest ===
      digest(
        'permission-presentation-marker',
        options.permission.presentationMarker
      ),
    options.record.messageDigest === expectedMessageDigest,
    options.record.toolCallDigest === options.permission.toolCallDigest,
    options.record.requestIdentityDigest ===
      options.permission.requestIdentityDigest,
    options.record.bindingGeneration === authority.bindingGeneration,
    options.record.processGeneration === authority.processGeneration,
  ].every(Boolean)
}

export const makeAcpPermissionBroker = Effect.fn('makeAcpPermissionBroker')(
  function* (options: {
    readonly presenter: AcpPermissionPresenter
    readonly repository: AcpAuthorityRepository
    readonly testHooks?: {
      readonly afterTerminalPublishBeforeLiveCompletion?: () => Effect.Effect<void>
      readonly onLivePermissionCountChanged?: (counts: {
        readonly capabilities: number
        readonly requestWaiters: number
      }) => void
    }
    readonly timeoutMillis?: number
  }): Effect.fn.Return<AcpPermissionBroker, never, Scope.Scope> {
    const gate = yield* Semaphore.make(1)
    const activeTurns = new Map<string, AcpPermissionTurnAuthority>()
    const byCapability = new Map<string, LivePermission>()
    const byRequestIdentity = new Map<string, LivePermission>()
    const capacityDiagnostics = new Set<AcpPendingCapacityScope>()
    const completionFibers = yield* FiberSet.make<void, never>()
    const runCompletion = yield* FiberSet.runtime(completionFibers)()
    const completions = new Map<
      string,
      Deferred.Deferred<AcpPermissionInteractionResult>
    >()
    const timeoutMillis = positiveTimeout(options.timeoutMillis)
    const reportLivePermissionCount = (): void =>
      options.testHooks?.onLivePermissionCountChanged?.({
        capabilities: byCapability.size,
        requestWaiters: byRequestIdentity.size,
      })

    const recordCapacityDiagnostic = Effect.fn(
      'AcpPermissionBroker.recordCapacityDiagnostic'
    )(function* (scope: AcpPendingCapacityScope) {
      if (capacityDiagnostics.has(scope)) {
        return
      }
      capacityDiagnostics.add(scope)
      yield* Effect.logWarning('ACP permission request capacity reached', {
        scope,
      })
    })

    const now = yield* Clock.currentTimeMillis
    const startupRecords = yield* options.repository
      .transact((records) => {
        const updated = records.map((record) =>
          record.state === 'pending'
            ? terminalRecord(record, 'cancelled', now)
            : record
        )
        return [updated, updated] as const
      })
      .pipe(Effect.orDie)
    yield* options.presenter.recover?.((presentationMarker) =>
      Effect.sync(() => {
        const digest = options.repository.digest(
          'permission-presentation-marker',
          presentationMarker
        )
        const record = startupRecords.find(
          (candidate) => candidate.presentationMarkerDigest === digest
        )
        if (record?.state === 'allowed' || record?.state === 'rejected') {
          return record.state
        }
        return record?.state === 'cancelled' ? 'cancelled' : null
      })
    ) ?? Effect.void

    const removeLive = (permission: LivePermission): void => {
      byCapability.delete(permission.capability)
      if (
        byRequestIdentity.get(permission.requestIdentityDigest) === permission
      ) {
        byRequestIdentity.delete(permission.requestIdentityDigest)
      }
      reportLivePermissionCount()
    }

    const settleLive = Effect.fn('AcpPermissionBroker.settleLive')(function* (
      permission: LivePermission,
      state: 'allowed' | 'cancelled' | 'rejected',
      response: RequestPermissionResponse,
      matches: (record: AcpPermissionAuthorityRecord) => boolean = () => true,
      presentationState:
        | 'allowed'
        | 'cancelled'
        | 'expired'
        | 'rejected' = state
    ) {
      const settledAt = yield* Clock.currentTimeMillis
      const settled = yield* options.repository
        .transact((records) => {
          let didChange = false
          let didSettle = false
          const updated = records.map((record) => {
            if (record.recordId !== permission.recordId) {
              return record
            }
            if (record.state === state) {
              didSettle = true
              return record
            }
            if (record.state !== 'pending' || !matches(record)) {
              return record
            }
            didChange = true
            didSettle = true
            return terminalRecord(record, state, settledAt)
          })
          return [didSettle, didChange ? updated : records] as const
        })
        .pipe(Effect.orDie)
      if (!settled) {
        return false
      }
      removeLive(permission)
      yield* Deferred.succeed(permission.messageReady, undefined)
      yield* options.presenter.settle({
        authorizedSlackUserId: permission.authority.authorizedSlackUserId ?? '',
        capability: permission.capability,
        category: permission.category,
        channelId: permission.authority.channelId,
        messageTs: permission.messageTs,
        presentationMarker: permission.presentationMarker,
        rootTs: permission.authority.rootTs,
        state: presentationState,
        workspaceId: permission.authority.workspaceId,
      })
      yield* Deferred.succeed(permission.decision, response)
      return true
    })

    const cancelMatching = Effect.fn('AcpPermissionBroker.cancelMatching')(
      function* (predicate: (permission: LivePermission) => boolean) {
        const pending = [...byCapability.values()].filter(predicate)
        yield* Effect.forEach(
          pending,
          (permission) =>
            settleLive(permission, 'cancelled', cancelledResponse).pipe(
              Effect.asVoid
            ),
          { discard: true }
        )
      }
    )

    const activateTurn: AcpPermissionBroker['activateTurn'] = (authority) =>
      gate
        .withPermit(
          Effect.gen(function* () {
            yield* cancelMatching(
              (permission) =>
                permission.authority.sessionId === authority.sessionId
            )
            activeTurns.set(authority.sessionId, authority)
            let active = true
            return {
              close: gate.withPermit(
                Effect.gen(function* () {
                  if (!active) {
                    return
                  }
                  active = false
                  if (activeTurns.get(authority.sessionId) === authority) {
                    activeTurns.delete(authority.sessionId)
                  }
                  yield* cancelMatching(
                    (permission) => permission.authority === authority
                  )
                })
              ),
            }
          })
        )
        .pipe(Effect.map(({ close }) => close))

    const requestPermission: AcpPermissionBroker['request'] = (request) =>
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is one explicit durable request state machine; splitting it would hide ordering boundaries.
      Effect.gen(function* () {
        const preparation = yield* gate.withPermit(
          Effect.gen(function* () {
            const context = permissionPreparationContext(
              activeTurns.get(request.sessionId),
              request
            )
            if (context === null) {
              return { _tag: 'Cancelled' as const }
            }
            const {
              allowOption,
              authority,
              authorizedSlackUserId,
              rejectOption,
            } = context
            const requestIdentityDigest = options.repository.digest(
              'permission-request-identity',
              JSON.stringify({
                prompt: authority.promptId,
                session: authority.sessionId,
                toolCall: request.toolCall.toolCallId,
                turn: authority.turnId,
              })
            )
            const argumentDigest = options.repository.digest(
              'permission-tool-arguments',
              JSON.stringify(request.toolCall)
            )
            const inputDigest = options.repository.digest(
              'permission-request-input',
              JSON.stringify({
                options: request.options.map(({ kind, optionId }) => ({
                  kind,
                  optionId,
                })),
                toolCall: request.toolCall,
              })
            )
            const existing = byRequestIdentity.get(requestIdentityDigest)
            if (existing?.inputDigest === inputDigest) {
              return {
                _tag: 'Attached' as const,
                permission: existing,
              }
            }
            if (existing !== undefined) {
              yield* settleLive(existing, 'cancelled', cancelledResponse)
              return { _tag: 'Cancelled' as const }
            }
            const capability = options.repository.makeCapability()
            const presentationMarker = randomUUID()
            const decision = yield* Deferred.make<RequestPermissionResponse>()
            const messageReady = yield* Deferred.make<void>()
            const createdAt = yield* Clock.currentTimeMillis
            const recordId = options.repository.digest(
              'permission-record',
              `${requestIdentityDigest}\0${capability.digest}`
            )
            const toolCallDigest = options.repository.digest(
              'tool-call',
              request.toolCall.toolCallId
            )
            const permission: LivePermission = {
              allowOptionId: allowOption.optionId,
              argumentDigest,
              authority,
              capability: capability.token,
              capabilityDigest: capability.digest,
              category: safeCategory(request.toolCall.kind),
              decision,
              expiresAt: createdAt + timeoutMillis,
              inputDigest,
              messageReady,
              messageTs: null,
              presentationMarker,
              recordId,
              rejectOptionId: rejectOption.optionId,
              requestIdentityDigest,
              toolCallDigest,
            }
            const record = AuthorityRecord.make({
              argumentDigest,
              authorizedUserDigest: options.repository.digest(
                'slack-user',
                authorizedSlackUserId
              ),
              bindingGeneration: authority.bindingGeneration,
              capabilityDigest: capability.digest,
              category: permission.category,
              channelDigest: options.repository.digest(
                'slack-channel',
                authority.channelId
              ),
              conversationDigest: options.repository.digest(
                'conversation',
                authority.conversationId
              ),
              createdAt,
              decisionClaimedAt: null,
              decisionIntent: null,
              expiresAt: permission.expiresAt,
              inputDigest,
              messageDigest: null,
              optionAllowDigest: options.repository.digest(
                'permission-option',
                allowOption.optionId
              ),
              optionRejectDigest: options.repository.digest(
                'permission-option',
                rejectOption.optionId
              ),
              presentationMarkerDigest: options.repository.digest(
                'permission-presentation-marker',
                presentationMarker
              ),
              processGeneration: authority.processGeneration,
              promptDigest: options.repository.digest(
                'prompt',
                authority.promptId
              ),
              recordId,
              requestIdentityDigest,
              rootDigest: options.repository.digest(
                'slack-root',
                authority.rootTs
              ),
              sessionDigest: options.repository.digest(
                'acp-session',
                authority.sessionId
              ),
              state: 'pending',
              toolCallDigest,
              turnDigest: options.repository.digest('turn', authority.turnId),
              updatedAt: createdAt,
              workspaceDigest: options.repository.digest(
                'workspace',
                authority.workspaceId
              ),
            })
            const capacity = yield* options.repository
              .transact((records) => {
                const exceeded = pendingPermissionCapacityExceeded(
                  records,
                  record
                )
                return [
                  exceeded,
                  exceeded === null ? [...records, record] : records,
                ] as const
              })
              .pipe(Effect.orDie)
            if (capacity !== null) {
              yield* recordCapacityDiagnostic(capacity)
              return { _tag: 'Cancelled' as const }
            }
            byCapability.set(permission.capability, permission)
            byRequestIdentity.set(requestIdentityDigest, permission)
            reportLivePermissionCount()
            return { _tag: 'Created' as const, permission }
          })
        )
        if (preparation._tag === 'Cancelled') {
          return cancelledResponse
        }
        const { permission } = preparation
        if (preparation._tag === 'Attached') {
          return yield* Deferred.await(permission.decision)
        }
        const presentationStartsAt = yield* Clock.currentTimeMillis
        const presentationTimeoutMillis = Math.max(
          0,
          permission.expiresAt - presentationStartsAt
        )
        if (presentationTimeoutMillis === 0) {
          yield* gate.withPermit(
            settleLive(
              permission,
              'cancelled',
              cancelledResponse,
              () => true,
              'expired'
            )
          )
          return cancelledResponse
        }
        const presentation = yield* Effect.raceFirst(
          Effect.raceFirst(
            Effect.exit(
              options.presenter.post({
                authorizedSlackUserId:
                  permission.authority.authorizedSlackUserId ?? '',
                capability: permission.capability,
                category: permission.category,
                channelId: permission.authority.channelId,
                expiresAt: permission.expiresAt,
                presentationMarker: permission.presentationMarker,
                rootTs: permission.authority.rootTs,
                workspaceId: permission.authority.workspaceId,
              })
            ).pipe(Effect.map((exit) => ({ _tag: 'Finished' as const, exit }))),
            Effect.sleep(`${presentationTimeoutMillis} millis`).pipe(
              Effect.as({ _tag: 'TimedOut' as const })
            )
          ),
          Deferred.await(permission.decision).pipe(
            Effect.map((response) => ({ _tag: 'Settled' as const, response }))
          )
        )
        if (presentation._tag === 'Settled') {
          return presentation.response
        }
        if (presentation._tag === 'TimedOut') {
          yield* gate.withPermit(
            settleLive(
              permission,
              'cancelled',
              cancelledResponse,
              () => true,
              'expired'
            )
          )
          return cancelledResponse
        }
        const posted = presentation.exit
        if (Exit.isFailure(posted)) {
          yield* gate.withPermit(
            settleLive(permission, 'cancelled', cancelledResponse)
          )
          return cancelledResponse
        }
        const messageTs = posted.value.messageTs
        const messageDigest = options.repository.digest(
          'slack-permission-message',
          JSON.stringify({
            channel: permission.authority.channelId,
            root: permission.authority.rootTs,
            ts: messageTs,
          })
        )
        const messageBound = yield* gate.withPermit(
          Effect.gen(function* () {
            if (byCapability.get(permission.capability) !== permission) {
              return false
            }
            permission.messageTs = messageTs
            yield* options.repository
              .transact((records) => [
                undefined,
                records.map((candidate) =>
                  candidate.recordId === permission.recordId &&
                  candidate.state === 'pending'
                    ? AuthorityRecord.make({
                        ...candidate,
                        messageDigest,
                        updatedAt: candidate.updatedAt,
                      })
                    : candidate
                ),
              ])
              .pipe(Effect.orDie)
            yield* Deferred.succeed(permission.messageReady, undefined)
            return true
          })
        )
        if (!messageBound) {
          yield* options.presenter
            .settle({
              authorizedSlackUserId:
                permission.authority.authorizedSlackUserId ?? '',
              capability: permission.capability,
              category: permission.category,
              channelId: permission.authority.channelId,
              messageTs,
              presentationMarker: permission.presentationMarker,
              rootTs: permission.authority.rootTs,
              state: 'cancelled',
              workspaceId: permission.authority.workspaceId,
            })
            .pipe(Effect.asVoid)
          return yield* Deferred.await(permission.decision)
        }
        const timeoutStartsAt = yield* Clock.currentTimeMillis
        const remainingTimeoutMillis = Math.max(
          0,
          permission.expiresAt - timeoutStartsAt
        )
        const timeout = Effect.sleep(`${remainingTimeoutMillis} millis`).pipe(
          Effect.flatMap(() =>
            gate.withPermit(
              settleLive(
                permission,
                'cancelled',
                cancelledResponse,
                () => true,
                'expired'
              )
            )
          ),
          Effect.as(cancelledResponse)
        )
        return yield* Effect.raceFirst(
          Deferred.await(permission.decision),
          timeout
        ).pipe(
          Effect.onInterrupt(() =>
            gate.withPermit(
              settleLive(permission, 'cancelled', cancelledResponse).pipe(
                Effect.asVoid
              )
            )
          )
        )
      })

    const decisionRecordMatches = (
      record: AcpPermissionAuthorityRecord,
      permission: LivePermission,
      decision: NonNullable<ReturnType<typeof decisionForInteraction>>
    ): boolean =>
      record.decisionIntent === decision.intent &&
      record.decisionClaimedAt !== null &&
      record.decisionClaimedAt <= record.expiresAt &&
      authorityRecordMatches({
        permission,
        record,
        repository: options.repository,
      })

    const finishReconciledClaim = Effect.fn(
      'AcpPermissionBroker.finishReconciledClaim'
    )(function* (
      permission: LivePermission,
      decision: NonNullable<ReturnType<typeof decisionForInteraction>>
    ) {
      removeLive(permission)
      yield* Deferred.succeed(permission.messageReady, undefined)
      yield* Deferred.succeed(permission.decision, {
        outcome: { optionId: decision.optionId, outcome: 'selected' },
      })
    })

    const enqueueReconciledPresentation = Effect.fn(
      'AcpPermissionBroker.enqueueReconciledPresentation'
    )(function* (
      permission: LivePermission,
      decision: NonNullable<ReturnType<typeof decisionForInteraction>>
    ) {
      yield* options.presenter.settle({
        authorizedSlackUserId: permission.authority.authorizedSlackUserId ?? '',
        capability: permission.capability,
        category: permission.category,
        channelId: permission.authority.channelId,
        messageTs: permission.messageTs,
        presentationMarker: permission.presentationMarker,
        rootTs: permission.authority.rootTs,
        state: decision.state,
        workspaceId: permission.authority.workspaceId,
      })
    })

    const persistClaimOutcome = Effect.fn(
      'AcpPermissionBroker.persistClaimOutcome'
    )(function* (
      permission: LivePermission,
      decision: NonNullable<ReturnType<typeof decisionForInteraction>>
    ): Effect.fn.Return<AcpPermissionInteractionResult> {
      const persisted = yield* Effect.exit(
        options.repository.transact((records) => {
          const record = records.find(
            (candidate) => candidate.recordId === permission.recordId
          )
          if (
            record === undefined ||
            !decisionRecordMatches(record, permission, decision)
          ) {
            return ['ignored' as const, records] as const
          }
          if (record.state === decision.state) {
            return ['claimed' as const, records] as const
          }
          if (record.state !== 'pending') {
            return ['ignored' as const, records] as const
          }
          const settledAt = Date.now()
          return [
            'claimed' as const,
            records.map((candidate) =>
              candidate.recordId === permission.recordId
                ? terminalRecord(candidate, decision.state, settledAt)
                : candidate
            ),
          ] as const
        })
      )
      if (Exit.isSuccess(persisted)) {
        return persisted.value
      }
      const reread = yield* Effect.exit(options.repository.load)
      if (Exit.isFailure(reread)) {
        return 'retry'
      }
      const record = reread.value.find(
        (candidate) => candidate.recordId === permission.recordId
      )
      if (
        record?.state !== decision.state ||
        !decisionRecordMatches(record, permission, decision)
      ) {
        return 'retry'
      }
      return 'claimed'
    })

    const startSharedCompletion = Effect.fn(
      'AcpPermissionBroker.startSharedCompletion'
    )(function* (
      permission: LivePermission,
      decision: NonNullable<ReturnType<typeof decisionForInteraction>>
    ): Effect.fn.Return<AcpPermissionInteractionResult> {
      const existing = completions.get(permission.recordId)
      if (existing !== undefined) {
        return yield* Deferred.await(existing)
      }
      const published = yield* Deferred.make<AcpPermissionInteractionResult>()
      completions.set(permission.recordId, published)
      runCompletion(
        Effect.gen(function* () {
          const outcome = yield* persistClaimOutcome(permission, decision)
          yield* Deferred.succeed(published, outcome)
          if (outcome !== 'claimed') {
            completions.delete(permission.recordId)
            return
          }
          yield* Effect.uninterruptible(
            (
              options.testHooks?.afterTerminalPublishBeforeLiveCompletion?.() ??
              Effect.void
            ).pipe(Effect.andThen(finishReconciledClaim(permission, decision)))
          )
          yield* enqueueReconciledPresentation(permission, decision)
          completions.delete(permission.recordId)
        }).pipe(Effect.catchCause(() => Effect.void))
      )
      return yield* Deferred.await(published)
    })

    const claimInteraction: AcpPermissionBroker['claimInteraction'] = (
      interaction
    ) =>
      Effect.gen(function* () {
        const candidate = yield* gate.withPermit(
          Effect.sync(() => byCapability.get(interaction.capability))
        )
        if (candidate === undefined) {
          return 'ignored' as const
        }
        yield* Deferred.await(candidate.messageReady)
        return yield* gate.withPermit(
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Claim, reconciliation, and completion are intentionally one serialized durable state machine.
          Effect.gen(function* () {
            const permission = byCapability.get(interaction.capability)
            if (permission === undefined || permission.messageTs === null) {
              return 'ignored' as const
            }
            const authority = permission.authority
            const active = activeTurns.get(authority.sessionId)
            const decision = decisionForInteraction(interaction, permission)
            if (decision === undefined) {
              return 'ignored' as const
            }
            const valid = interactionMatchesPermission(
              interaction,
              permission,
              active
            )
            if (!valid) {
              return 'ignored' as const
            }
            const currentTime = yield* Clock.currentTimeMillis
            const claimExit = yield* Effect.exit(
              // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This callback is the atomic claim CAS and keeps every accepted persisted state explicit.
              options.repository.transact((records) => {
                const record = records.find(
                  (candidate) => candidate.recordId === permission.recordId
                )
                if (
                  record !== undefined &&
                  decisionRecordMatches(record, permission, decision) &&
                  (record.state === 'pending' ||
                    record.state === decision.state)
                ) {
                  return ['claimed' as const, records] as const
                }
                if (
                  record === undefined ||
                  record.state !== 'pending' ||
                  !authorityRecordMatches({
                    currentTime,
                    permission,
                    record,
                    repository: options.repository,
                  })
                ) {
                  return ['ignored' as const, records] as const
                }
                if (record.decisionIntent === decision.intent) {
                  return ['claimed' as const, records] as const
                }
                if (record.decisionIntent !== null) {
                  return ['ignored' as const, records] as const
                }
                return [
                  'claimed' as const,
                  records.map((candidate) =>
                    candidate.recordId === permission.recordId
                      ? AuthorityRecord.make({
                          ...candidate,
                          decisionClaimedAt: currentTime,
                          decisionIntent: decision.intent,
                          updatedAt: currentTime,
                        })
                      : candidate
                  ),
                ] as const
              })
            )
            if (Exit.isSuccess(claimExit)) {
              return claimExit.value === 'claimed'
                ? yield* startSharedCompletion(permission, decision)
                : 'ignored'
            }
            const reread = yield* Effect.exit(options.repository.load)
            if (Exit.isFailure(reread)) {
              return 'retry'
            }
            const record = reread.value.find(
              (candidate) => candidate.recordId === permission.recordId
            )
            if (
              record === undefined ||
              !decisionRecordMatches(record, permission, decision)
            ) {
              return 'retry'
            }
            if (record.state === decision.state) {
              return yield* startSharedCompletion(permission, decision)
            }
            return record.state === 'pending'
              ? yield* startSharedCompletion(permission, decision)
              : 'ignored'
          })
        )
      })

    const cancelAll = gate.withPermit(
      Effect.gen(function* () {
        activeTurns.clear()
        yield* cancelMatching(() => true)
      })
    )
    yield* Effect.addFinalizer(() =>
      cancelAll.pipe(Effect.andThen(options.presenter.drain))
    )

    return {
      activateTurn,
      cancelAll,
      claimInteraction,
      handleInteraction: claimInteraction,
      request: requestPermission,
    }
  }
)
