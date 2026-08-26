/**
 * Review comments: conversations anchored to a line range of a changed file
 * in a workspace.
 *
 * A thread is durable rather than transient chat state, because the coding
 * agent reads it back out of the shared database — and answers it — through
 * the per-workspace `laborer-current` MCP server. This module owns the
 * boundary between the SQLite rows and the domain rows: decoding with
 * `Schema`, reporting expected failures as `Schema.TaggedError` classes, and
 * naming the two authors a boundary may write. The SQL itself lives on
 * {@link NativeLaborerDatabase}, which owns the connection.
 */

import {
  REVIEW_COMMENT_BODY_MAX_LENGTH,
  type ReviewCommentAuthor as SharedReviewCommentAuthor,
  type ReviewCommentSide as SharedReviewCommentSide,
  type ReviewCommentStatus as SharedReviewCommentStatus,
} from '@laborer/shared/rpc'
import { Schema } from 'effect'

export const REVIEW_COMMENT_SIDES = [
  'additions',
  'deletions',
] as const satisfies readonly SharedReviewCommentSide[]
export type ReviewCommentSide = SharedReviewCommentSide

export const REVIEW_COMMENT_STATUSES = [
  'open',
  'resolved',
] as const satisfies readonly SharedReviewCommentStatus[]
export type ReviewCommentStatus = SharedReviewCommentStatus

export const REVIEW_COMMENT_AUTHORS = [
  'human',
  'agent',
] as const satisfies readonly SharedReviewCommentAuthor[]
/**
 * Who wrote a reply. This is a fact about the boundary that persisted it, not
 * a field any caller supplies: no RPC payload, MCP tool parameter, or service
 * input carries an author. The web RPC handlers write {@link HUMAN_AUTHOR},
 * the MCP tools write {@link AGENT_AUTHOR}, and the database refuses anything
 * else.
 */
export type ReviewCommentAuthor = SharedReviewCommentAuthor

/** The only author the web RPC handlers may write. */
export const HUMAN_AUTHOR: ReviewCommentAuthor = 'human'
/** The only author the MCP tools may write. */
export const AGENT_AUTHOR: ReviewCommentAuthor = 'agent'

/** Path bound. A longer path is a client defect, not a reviewable file. */
export const REVIEW_COMMENT_FILE_PATH_MAX_LENGTH = 4096

/** Row-size bound. A thread longer than this is a client defect. */
export const MAX_REVIEW_COMMENT_REPLIES = 200

const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

/** The persisted thread row, exactly as SQLite hands it back. */
const ReviewCommentThreadRow = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  file_path: Schema.String,
  side: Schema.Literals(REVIEW_COMMENT_SIDES),
  start_line: PositiveInt,
  end_line: PositiveInt,
  status: Schema.Literals(REVIEW_COMMENT_STATUSES),
  created_at: Schema.Int,
  updated_at: Schema.Int,
  revision: PositiveInt,
})

/** The persisted reply row, exactly as SQLite hands it back. */
const ReviewCommentReplyRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  author: Schema.Literals(REVIEW_COMMENT_AUTHORS),
  body: Schema.String,
  created_at: Schema.Int,
})

/** One message in a review conversation. */
export interface ReviewCommentReply {
  /** Set by the boundary that wrote it, never claimed by its payload. */
  readonly author: ReviewCommentAuthor
  /** Markdown text. */
  readonly body: string
  readonly createdAt: number
  readonly id: string
  readonly threadId: string
}

/** A review conversation anchored to a line range of a changed file. */
export interface ReviewCommentThread {
  readonly createdAt: number
  /** Last line of the anchor, inclusive. Equals `startLine` for one line. */
  readonly endLine: number
  /** Path relative to the worktree root, as the diff viewer reports it. */
  readonly filePath: string
  readonly id: string
  /** Every message so far, oldest first. Never empty. */
  readonly replies: readonly ReviewCommentReply[]
  readonly revision: number
  /** Which half of the diff the anchor names. */
  readonly side: ReviewCommentSide
  readonly startLine: number
  readonly status: ReviewCommentStatus
  readonly updatedAt: number
  readonly workspaceId: string
}

/** A thread and the first message that opens it, written together. */
export interface NewReviewCommentThread {
  readonly body: string
  readonly createdAt?: number
  readonly endLine: number
  readonly filePath: string
  /** Client-minted id. Re-sending a stored id is an idempotent no-op. */
  readonly id?: string
  /** Client-minted id for the opening reply. */
  readonly replyId?: string
  readonly side: ReviewCommentSide
  readonly startLine: number
  readonly workspaceId: string
}

export interface NewReviewCommentReply {
  readonly body: string
  readonly createdAt?: number
  /** Client-minted id. Re-sending a stored id is an idempotent no-op. */
  readonly id?: string
  readonly threadId: string
}

/** A stored row that no longer decodes: corrupt, or written by a newer build. */
export class ReviewCommentRowError extends Schema.TaggedError<ReviewCommentRowError>()(
  'ReviewCommentRowError',
  {
    message: Schema.String,
  }
) {}

/** A draft that never should have reached the database. */
export class ReviewCommentInvalidError extends Schema.TaggedError<ReviewCommentInvalidError>()(
  'ReviewCommentInvalidError',
  {
    message: Schema.String,
  }
) {}

/** A thread or reply that is not there to read, answer, or edit. */
export class ReviewCommentNotFoundError extends Schema.TaggedError<ReviewCommentNotFoundError>()(
  'ReviewCommentNotFoundError',
  {
    id: Schema.String,
    message: Schema.String,
  }
) {}

/** One boundary's author tried to rewrite another's words. */
export class ReviewCommentAuthorMismatchError extends Schema.TaggedError<ReviewCommentAuthorMismatchError>()(
  'ReviewCommentAuthorMismatchError',
  {
    author: Schema.Literals(REVIEW_COMMENT_AUTHORS),
    id: Schema.String,
    message: Schema.String,
  }
) {}

const decodeThreadRow = Schema.decodeUnknownResult(ReviewCommentThreadRow)
const decodeReplyRow = Schema.decodeUnknownResult(ReviewCommentReplyRow)

const invalidRow = (
  table: string,
  cause: { readonly message: string }
): never => {
  throw new ReviewCommentRowError({
    message: `Laborer database contains an invalid ${table} row: ${cause.message}`,
  })
}

/**
 * Decodes one reply row. A reply carries someone's words, so a row that fails
 * to decode fails the read rather than being silently dropped.
 */
export const decodeReviewCommentReplyRow = (
  value: unknown
): ReviewCommentReply => {
  const result = decodeReplyRow(value)
  if (result._tag === 'Failure') {
    return invalidRow('review_comment_replies', result.failure)
  }
  const row = result.success
  return {
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    id: row.id,
    threadId: row.thread_id,
  }
}

/** Decodes one thread row and attaches its already-ordered reply chain. */
export const decodeReviewCommentThreadRow = (
  value: unknown,
  replies: readonly ReviewCommentReply[]
): ReviewCommentThread => {
  const result = decodeThreadRow(value)
  if (result._tag === 'Failure') {
    return invalidRow('review_comment_threads', result.failure)
  }
  const row = result.success
  return {
    createdAt: row.created_at,
    endLine: row.end_line,
    filePath: row.file_path,
    id: row.id,
    replies,
    revision: row.revision,
    side: row.side,
    startLine: row.start_line,
    status: row.status,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  }
}

/** Oldest first, with the id breaking ties inside one millisecond. */
export const orderReviewCommentReplies = (
  replies: readonly ReviewCommentReply[]
): readonly ReviewCommentReply[] =>
  [...replies].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )

export const reviewCommentBody = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    throw new ReviewCommentInvalidError({
      message: 'A review comment body must not be blank',
    })
  }
  if (trimmed.length > REVIEW_COMMENT_BODY_MAX_LENGTH) {
    throw new ReviewCommentInvalidError({
      message: `A review comment body must be ${REVIEW_COMMENT_BODY_MAX_LENGTH} characters or fewer`,
    })
  }
  return trimmed
}

const reviewCommentFilePath = (filePath: string): string => {
  const trimmed = filePath.trim()
  if (trimmed.length === 0) {
    throw new ReviewCommentInvalidError({
      message: 'A review comment file path must not be blank',
    })
  }
  if (trimmed.length > REVIEW_COMMENT_FILE_PATH_MAX_LENGTH) {
    throw new ReviewCommentInvalidError({
      message: `A review comment file path must be ${REVIEW_COMMENT_FILE_PATH_MAX_LENGTH} characters or fewer`,
    })
  }
  return trimmed
}

const reviewCommentAnchor = (
  startLine: number,
  endLine: number
): { readonly endLine: number; readonly startLine: number } => {
  if (
    !(
      Number.isSafeInteger(startLine) &&
      Number.isSafeInteger(endLine) &&
      startLine >= 1 &&
      endLine >= startLine
    )
  ) {
    throw new ReviewCommentInvalidError({
      message: `A review comment anchor must be a line range starting at 1 or later: ${startLine}-${endLine}`,
    })
  }
  return { endLine, startLine }
}

/** Normalizes a draft, rejecting anything the table's checks would reject. */
export const validateNewReviewCommentThread = (
  input: NewReviewCommentThread
): NewReviewCommentThread => ({
  ...input,
  ...reviewCommentAnchor(input.startLine, input.endLine),
  body: reviewCommentBody(input.body),
  filePath: reviewCommentFilePath(input.filePath),
})
