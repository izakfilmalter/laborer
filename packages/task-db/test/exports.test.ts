import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { taskDbMigrations } from '@laborer/task-db/migrations'
import { describe, expect, it } from 'vitest'

const migrationLedger = [
  [
    '0000_shared_task_db',
    '3264d634d1a77c6eaf1d3eb224a62ade548a11853ba11daab15d14ba9f0df3f5',
  ],
  [
    '0001_execution_lifecycle_statuses',
    '8996c9042812807ca5860caabea9ac26701c07af8cd64e5de3c24cc60db06087',
  ],
  [
    '0002_task_description_agent_source',
    'a92e1eec06d3472edc1a0c158f70a11c8ce20b07ffc7e3d25253a3b2ed3ce73f',
  ],
  [
    '0003_worktree_task_source',
    'b1acb7569989fa450149706d7e550519fbd27a2c5921e0008c1ad58bcf66642a',
  ],
  [
    '0004_task_worktree_pr_columns',
    '5cedabec3897807ee4989c9cd66d6f1aa6995ba810a71614c8f81c3af3e1589d',
  ],
  [
    '0005_projects',
    '4ffc231b6369f07683f4b3c21f7507b6df426799db2305b114a04a221455c2f1',
  ],
  [
    '0006_app_settings_and_ledger',
    'f58304502ae583036cbb6847c9253fed482b737fa5a8e76b44db698c232d63e0',
  ],
  [
    '0007_projects_sort_order',
    '4d0f661e5d17a81bb63be3a8c8e87732b6a24d0404baa02687d814addd1c3351',
  ],
  [
    '0008_complete_removed_worktrees',
    '949b371a78627208de4cd23376e586d3efc5000d42f3c7db631434e57cfc1766',
  ],
  [
    '0009_git_hosted_status',
    '4a8ceac62baca7a4a5b96839be6061a890e99486665c05628490dac710584335',
  ],
  [
    '0010_pr_check_runs',
    'e7938c241a71411f6357c961d0e93d45c1a5d8a9211c9f29f498047df7c86a21',
  ],
  [
    '0011_task_numbers',
    '35a3125b9e6fc416742731a6247acb89bbed61522208c42a5ff5ddbb1e0bde83',
  ],
  [
    '0012_task_labels',
    'e0889187314cb52bfde30a4127664ea60b0e926bb4cd8a36a68894ab627ec9e5',
  ],
  [
    '0013_correlated_operations',
    '4a853d0fcad0e8874d8f909d826e927853ca0f68f02b49982b15bcf8b1837657',
  ],
  [
    '0014_pr_unresolved_threads',
    '6cfa6fc5cba0a47d45edece72c6103d35ce0d835c61a0636e4c6aae30076279e',
  ],
]

describe('@laborer/task-db exports', () => {
  it('preserves the migration ledger', () => {
    expect(
      taskDbMigrations.map(({ name, sql }) => [
        name,
        createHash('sha256').update(sql).digest('hex'),
      ])
    ).toEqual(migrationLedger)
  })

  // Spawning two runtimes costs seconds on a loaded CI runner, well past
  // vitest's 5s default.
  it(
    'resolves every public subpath under Bun and Node',
    { timeout: 60_000 },
    () => {
      const imports = [
        '@laborer/task-db',
        '@laborer/task-db/path',
        '@laborer/task-db/migrations',
        '@laborer/task-db/schema',
        '@laborer/task-db/ulid',
      ]
      const script = `await Promise.all(${JSON.stringify(imports)}.map((specifier) => import(specifier)))`

      for (const [runtime, arguments_] of [
        ['node', ['--input-type=module', '--eval', script]],
        ['bun', ['--eval', script]],
      ] as const) {
        const result = spawnSync(runtime, arguments_, {
          cwd: new URL('..', import.meta.url),
          encoding: 'utf8',
        })
        expect(result.error, `${runtime} failed to start`).toBeUndefined()
        expect(result.stderr, `${runtime} wrote to stderr`).toBe('')
        expect(result.status, `${runtime} exited unsuccessfully`).toBe(0)
      }
    }
  )

  it(
    'normalizes a missing task when the database runs under Bun',
    { timeout: 60_000 },
    () => {
      const script = `
      import { mkdtempSync, rmSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { NativeTaskDatabase } from '@laborer/task-db'
      const root = mkdtempSync(join(tmpdir(), 'laborer-task-db-bun-'))
      try {
        const database = NativeTaskDatabase.open(join(root, 'tasks.sqlite'))
        try {
          if (database.find('missing') !== null) {
            throw new Error('Expected a missing task to return null')
          }
        } finally {
          database.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `
      const result = spawnSync('bun', ['--eval', script], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      })

      expect(result.error, 'bun failed to start').toBeUndefined()
      expect(result.stderr, 'bun wrote to stderr').toBe('')
      expect(result.status, 'bun exited unsuccessfully').toBe(0)
    }
  )
})
