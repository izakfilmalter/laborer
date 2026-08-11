import { readFileSync } from 'node:fs'

export interface TaskDbMigration {
  readonly name: string
  readonly sql: string
}

/** Append-only. Copy this file and the SQL migrations verbatim into current. */
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
]
