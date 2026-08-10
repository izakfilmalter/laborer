import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpRouter } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import {
  TaskMcpProtocolLayer,
  TaskMcpToolsLayer,
} from '../src/services/task-mcp.js'

const rpc = (port: number, body: unknown) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      body: JSON.stringify(body),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      method: 'POST',
    }).then(async (response) => ({ response, text: await response.text() }))
  )

describe('task MCP HTTP endpoint', () => {
  it('advertises the task tools over streamable HTTP', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-task-mcp-')))
    const databasePath = join(root, 'tasks.sqlite')
    const port = 40_000 + (process.pid % 10_000)
    const storeLayer = Layer.succeed(LaborerStore, {
      store: {
        query: () => [{ id: 'project-1', name: 'Project', repoPath: root }],
      } as never,
    })
    const serverLayer = Layer.mergeAll(
      TaskMcpToolsLayer,
      HttpRouter.Default.serve()
    ).pipe(
      Layer.provide(TaskMcpProtocolLayer),
      Layer.provide(AgentTaskService.layer(databasePath)),
      Layer.provide(
        NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })
      ),
      Layer.provide(storeLayer)
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.launch(serverLayer).pipe(Effect.forkScoped)
          yield* Effect.sleep('50 millis')
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
        })
      )
    )
  })
})
