import { readFileSync } from 'node:fs'

export interface TaskDbMigration {
  readonly name: string
  readonly sql: string
}

/** Append-only. The migration ledger fails closed when any SQL bytes drift. */
export const taskDbMigrations: readonly TaskDbMigration[] = [
  {
    name: '0000_shared_task_db',
    sql: readFileSync(
      new URL('./migrations/0000_shared_task_db.sql', import.meta.url),
      'utf8'
    ),
  },
  {
    name: '0001_execution_lifecycle_statuses',
    sql: readFileSync(
      new URL(
        './migrations/0001_execution_lifecycle_statuses.sql',
        import.meta.url
      ),
      'utf8'
    ),
  },
  {
    name: '0002_task_description_agent_source',
    sql: readFileSync(
      new URL(
        './migrations/0002_task_description_agent_source.sql',
        import.meta.url
      ),
      'utf8'
    ),
  },
  {
    name: '0003_worktree_task_source',
    sql: readFileSync(
      new URL('./migrations/0003_worktree_task_source.sql', import.meta.url),
      'utf8'
    ),
  },
  {
    name: '0004_task_worktree_pr_columns',
    sql: readFileSync(
      new URL(
        './migrations/0004_task_worktree_pr_columns.sql',
        import.meta.url
      ),
      'utf8'
    ),
  },
  {
    name: '0005_projects',
    sql: readFileSync(
      new URL('./migrations/0005_projects.sql', import.meta.url),
      'utf8'
    ),
  },
  {
    name: '0006_app_settings_and_ledger',
    sql: readFileSync(
      new URL('./migrations/0006_app_settings_and_ledger.sql', import.meta.url),
      'utf8'
    ),
  },
  {
    name: '0007_projects_sort_order',
    sql: readFileSync(
      new URL('./migrations/0007_projects_sort_order.sql', import.meta.url),
      'utf8'
    ),
  },
  {
    name: '0008_complete_removed_worktrees',
    sql: readFileSync(
      new URL(
        './migrations/0008_complete_removed_worktrees.sql',
        import.meta.url
      ),
      'utf8'
    ),
  },
]
