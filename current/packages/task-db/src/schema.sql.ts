import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const tasks = sqliteTable('tasks', {
  id: text().primaryKey(),
  rootPath: text('root_path').notNull(),
  title: text().notNull(),
  status: text().notNull(),
  source: text().notNull(),
  executionId: text('execution_id').unique(),
  actionName: text('action_name'),
  executionStatus: text('execution_status'),
  slackPermalink: text('slack_permalink'),
  worktreePath: text('worktree_path'),
  branchName: text('branch_name'),
  initialPrompt: text('initial_prompt'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  revision: integer().notNull().default(1),
})

export const taskChanges = sqliteTable('task_changes', {
  sequence: integer().primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  changedAt: integer('changed_at').notNull(),
})
