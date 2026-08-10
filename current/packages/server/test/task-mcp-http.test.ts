import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpRouter } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import {
  mcpOriginGuard,
  TaskMcpProtocolLayer,
  TaskMcpToolsLayer,
} from '../src/services/task-mcp.js'

const rpc = (port: number, body: unknown, origin?: string) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      body: JSON.stringify(body),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(origin === undefined ? {} : { origin }),
      },
      method: 'POST',
    }).then(async (response) => ({ response, text: await response.text() }))
  )

describe('task MCP HTTP endpoint', () => {
  it('executes task CRUD over streamable HTTP and rejects web origins', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-task-mcp-')))
    const databasePath = join(root, 'tasks.sqlite')
    const nodeServer = createServer()
    const storeLayer = Layer.succeed(LaborerStore, {
      store: {
        query: () => [{ id: 'project-1', name: 'Project', repoPath: root }],
      } as never,
    })
    const serverLayer = Layer.mergeAll(
      TaskMcpToolsLayer,
      HttpRouter.Default.serve(mcpOriginGuard)
    ).pipe(
      Layer.provide(TaskMcpProtocolLayer),
      Layer.provide(AgentTaskService.layer(databasePath)),
      Layer.provide(
        NodeHttpServer.layer(() => nodeServer, {
          host: '127.0.0.1',
          port: 0,
        })
      ),
      Layer.provide(storeLayer)
    )

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.launch(serverLayer).pipe(Effect.forkScoped)
            if (!nodeServer.listening) {
              yield* Effect.promise(() => once(nodeServer, 'listening'))
            }
            const address = nodeServer.address()
            if (address === null || typeof address === 'string') {
              return yield* Effect.die(
                new Error('Task MCP test server did not bind to TCP')
              )
            }
            const port = address.port
            const initialized = yield* rpc(port, {
              id: 1,
              jsonrpc: '2.0',
              method: 'initialize',
              params: {
                capabilities: {},
                clientInfo: { name: 'test', version: '1.0.0' },
                protocolVersion: '2025-03-26',
              },
            })
            expect(initialized.response.status).toBe(200)

            const listed = yield* rpc(port, {
              id: 2,
              jsonrpc: '2.0',
              method: 'tools/list',
              params: {},
            })
            expect(listed.response.status).toBe(200)
            expect(listed.text).toContain('create_task')
            expect(listed.text).toContain('delete_task')
            expect(listed.text).toContain('list_projects')

            const forbidden = yield* rpc(
              port,
              { id: 3, jsonrpc: '2.0', method: 'tools/list', params: {} },
              'https://example.com'
            )
            expect(forbidden.response.status).toBe(403)

            const created = yield* rpc(port, {
              id: 4,
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                arguments: {
                  description: 'Investigate the race',
                  path: root,
                  title: 'Follow up',
                },
                name: 'create_task',
              },
            })
            expect(created.response.status).toBe(200)
            expect(created.text).toContain('Investigate the race')

            const database = NodeTaskBoardDatabase.open(databasePath)
            const task = database.snapshot().tasks[0]
            database.close()
            expect(task).toMatchObject({ revision: 1, source: 'agent' })
            if (task === undefined) {
              throw new Error('create_task did not persist a task')
            }

            const updated = yield* rpc(port, {
              id: 5,
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                arguments: {
                  expected_revision: 1,
                  id: task.id,
                  title: 'Refined follow-up',
                },
                name: 'update_task',
              },
            })
            expect(updated.text).toContain('Refined follow-up')

            const deleted = yield* rpc(port, {
              id: 6,
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                arguments: { expected_revision: 2, id: task.id },
                name: 'delete_task',
              },
            })
            expect(deleted.text).toContain('cancelled')

            const replayedDelete = yield* rpc(port, {
              id: 7,
              jsonrpc: '2.0',
              method: 'tools/call',
              params: {
                arguments: { expected_revision: 2, id: task.id },
                name: 'delete_task',
              },
            })
            expect(replayedDelete.text).toContain('cancelled')

            const persisted = NodeTaskBoardDatabase.open(databasePath)
            expect(persisted.find(task.id)).toMatchObject({
              revision: 3,
              status: 'cancelled',
            })
            expect(persisted.readChanges(0).cursor).toBe(3)
            persisted.close()
          })
        )
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
