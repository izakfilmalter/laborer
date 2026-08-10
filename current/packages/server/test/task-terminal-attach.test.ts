import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { handleTaskTerminalAttach } from '../src/rpc/handlers.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import { TerminalClient } from '../src/services/terminal-client.js'

describe('task terminal attach', () => {
  it('passes the shared-db worktree path directly to the terminal sidecar seam', async () => {
    const root = mkdtempSync(join(tmpdir(), 'laborer-task-attach-'))
    const databasePath = join(root, 'tasks.sqlite')
    const worktreePath = join(root, 'next-worktree')
    mkdirSync(worktreePath)
    const database = NodeTaskBoardDatabase.open(databasePath)
    database.close()
    const writer = new DatabaseSync(databasePath)
    writer
      .prepare(`INSERT INTO tasks (
        id, root_path, title, status, source, execution_id, worktree_path,
        created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) `)
      .run(
        'task-1',
        root,
        'Attach me',
        'in_progress',
        'execution',
        'execution-1',
        worktreePath,
        1,
        1,
        1
      )
    writer.close()

    const spawnInDirectory = vi.fn((ownerId: string, _cwd: string) =>
      Effect.succeed({
        command: '/bin/zsh',
        id: 'terminal-1',
        status: 'running' as const,
        workspaceId: ownerId,
      })
    )
    const terminalLayer = Layer.succeed(
      TerminalClient,
      TerminalClient.of({
        killAllForWorkspace: () => Effect.succeed(0),
        spawnInDirectory,
        spawnInWorkspace: () => Effect.die('must not use workspace lookup'),
      })
    )

    const result = await Effect.runPromise(
      handleTaskTerminalAttach({ taskId: 'task-1' }, databasePath).pipe(
        Effect.provide(terminalLayer)
      )
    )

    expect(spawnInDirectory).toHaveBeenCalledWith('task:task-1', worktreePath)
    expect(result.terminal.id).toBe('terminal-1')
    expect(result.botOwned).toBe(false)

    rmSync(worktreePath, { recursive: true })
    await expect(
      Effect.runPromise(
        handleTaskTerminalAttach({ taskId: 'task-1' }, databasePath).pipe(
          Effect.provide(terminalLayer)
        )
      )
    ).rejects.toThrow('The task worktree is not available on disk')
    expect(spawnInDirectory).toHaveBeenCalledTimes(1)
  })
})
