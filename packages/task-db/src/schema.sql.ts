import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const tasks = sqliteTable(
  'tasks',
  {
    id: text().primaryKey(),
    rootPath: text('root_path').notNull(),
    title: text().notNull(),
    taskNumber: integer('task_number'),
    status: text().notNull(),
    source: text().notNull(),
    executionId: text('execution_id').unique(),
    actionName: text('action_name'),
    executionStatus: text('execution_status'),
    slackPermalink: text('slack_permalink'),
    worktreePath: text('worktree_path'),
    branchName: text('branch_name'),
    /**
     * GitHub login of whoever opened the pull request on this branch. Null
     * when the branch has no pull request, which reads as "unattributed"
     * rather than "mine".
     */
    prAuthorLogin: text('pr_author_login'),
    prBaseBranch: text('pr_base_branch'),
    prMergeStatus: text('pr_merge_status'),
    prCheckStatus: text('pr_check_status'),
    /** JSON array of individual check runs behind `pr_check_status`. */
    prChecks: text('pr_checks'),
    /** Review threads still awaiting resolution. Null when never read. */
    prUnresolvedThreads: integer('pr_unresolved_threads'),
    /**
     * GitHub's rolled-up review verdict: `approved`, `changesRequested`, or
     * `reviewRequired`. Null when the pull request asks nobody for review.
     */
    prReviewDecision: text('pr_review_decision'),
    /** How many reviewers' latest review is an approval. Null when never read. */
    prApprovals: integer('pr_approvals'),
    description: text('description'),
    /** JSON array of label ids applied to this task, in application order. */
    labelIds: text('label_ids').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    check(
      'tasks_status_check',
      sql`${table.status} IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')`
    ),
    check(
      'tasks_source_check',
      sql`${table.source} IN ('execution', 'manual', 'slack_url', 'agent', 'worktree')`
    ),
    check(
      'tasks_execution_status_check',
      sql`${table.executionStatus} IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention')`
    ),
    check('tasks_revision_check', sql`${table.revision} >= 1`),
  ]
)

/** Labels are app-wide and referenced by id from tasks in any project. */
export const labels = sqliteTable(
  'labels',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    color: text().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    check(
      'labels_color_check',
      sql`${table.color} IN ('red', 'orange', 'amber', 'emerald', 'teal', 'blue', 'violet', 'pink')`
    ),
    check('labels_revision_check', sql`${table.revision} >= 1`),
    uniqueIndex('labels_name_unique').on(sql`lower(${table.name})`),
  ]
)

/**
 * A review conversation anchored to a line range of a changed file in a
 * workspace. The coding agent reads and answers these through the
 * per-workspace MCP server, so the anchor and the back-and-forth are durable
 * rather than transient chat state.
 */
export const reviewCommentThreads = sqliteTable(
  'review_comment_threads',
  {
    id: text().primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** Path relative to the worktree root, as the diff viewer reports it. */
    filePath: text('file_path').notNull(),
    /** Which half of the diff the line range names. */
    side: text().notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    status: text().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    check(
      'review_comment_threads_side_check',
      sql`${table.side} IN ('additions', 'deletions')`
    ),
    check(
      'review_comment_threads_status_check',
      sql`${table.status} IN ('open', 'resolved')`
    ),
    check(
      'review_comment_threads_line_range_check',
      sql`${table.startLine} >= 1 AND ${table.endLine} >= ${table.startLine}`
    ),
    check('review_comment_threads_revision_check', sql`${table.revision} >= 1`),
    index('review_comment_threads_workspace_id_idx').on(table.workspaceId),
  ]
)

/**
 * One message in a review conversation. Replies are append-only and ordered
 * by `created_at` then `id`, so the chain reads the same way everywhere even
 * when two messages land in the same millisecond.
 */
export const reviewCommentReplies = sqliteTable(
  'review_comment_replies',
  {
    id: text().primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => reviewCommentThreads.id, { onDelete: 'cascade' }),
    /** Set by the boundary that wrote it, never claimed by its payload. */
    author: text().notNull(),
    body: text().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    check(
      'review_comment_replies_author_check',
      sql`${table.author} IN ('human', 'agent')`
    ),
    index('review_comment_replies_thread_id_idx').on(
      table.threadId,
      table.createdAt,
      table.id
    ),
  ]
)

export const taskChanges = sqliteTable('task_changes', {
  sequence: integer().primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  changedAt: integer('changed_at').notNull(),
})
