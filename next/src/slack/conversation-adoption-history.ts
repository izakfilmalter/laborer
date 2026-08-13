import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import type { NormalizedImage } from '../core/domain.ts'

// Retained only as an internal application-state schema boundary. The Slack
// history reader was part of the retired bespoke Slack plane and is gone.
export const CONVERSATION_ADOPTION_HISTORY_MAX_MESSAGES = 200
export const CONVERSATION_ADOPTION_HISTORY_MAX_BYTES = 256 * 1024
export const CONVERSATION_ADOPTION_HISTORY_MAX_REQUESTS = 24

export type ConversationAdoptionHistoryDiagnosticCode =
  | 'cursor-cycle'
  | 'page-limit'
  | 'request-limit'
  | 'slack-permanent'
  | 'slack-transient-exhausted'
  | 'time-limit'

export interface ConversationAdoptionHistoryTruncation {
  readonly age: boolean
  readonly bytes: boolean
  readonly count: boolean
}

export interface ConversationAdoptionHistorySnapshot {
  readonly bytes: number
  readonly degradation: 'complete' | 'partial' | 'unavailable'
  readonly diagnosticCodes: readonly ConversationAdoptionHistoryDiagnosticCode[]
  readonly digest: string
  readonly firstSlackTs: string | null
  readonly images: readonly NormalizedImage[]
  readonly lastSlackTs: string | null
  readonly messageCount: number
  readonly rendered: string
  readonly requestCount: number
  readonly truncation: ConversationAdoptionHistoryTruncation
}

export interface ConversationAdoptionHistoryRequest {
  readonly channelId: string
  readonly cutoffSlackTs: string
  readonly rootTs: string
  readonly workspaceId: string
}

export interface ConversationAdoptionHistoryGateway {
  readonly read: (
    request: ConversationAdoptionHistoryRequest
  ) => Effect.Effect<ConversationAdoptionHistorySnapshot>
}

export const unavailableConversationAdoptionHistoryGateway = (
  diagnosticCode: ConversationAdoptionHistoryDiagnosticCode = 'slack-permanent'
): ConversationAdoptionHistoryGateway => ({
  read: () => {
    const rendered =
      '<conversation-adoption-history trust="untrusted-reference-only" snapshot="unavailable"></conversation-adoption-history>'
    return Effect.succeed({
      bytes: Buffer.byteLength(rendered, 'utf8'),
      degradation: 'unavailable',
      diagnosticCodes: [diagnosticCode],
      digest: createHash('sha256').update(rendered).digest('base64url'),
      firstSlackTs: null,
      images: [],
      lastSlackTs: null,
      messageCount: 0,
      rendered,
      requestCount: 0,
      truncation: { age: false, bytes: false, count: false },
    })
  },
})
