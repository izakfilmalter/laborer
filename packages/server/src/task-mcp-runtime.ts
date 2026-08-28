import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeRuntime, NodeSocket, NodeStdio } from '@effect/platform-node'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect, Layer, Logger } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import { AgentTaskService } from './services/agent-task-service.js'
import { BrowserAgentClient } from './services/browser-mcp.js'
import { LaborerDatabase } from './services/laborer-database.js'
import {
  BrowserMcpToolsLayer,
  TaskMcpStdioProtocolLayer,
  TaskMcpToolsLayer,
} from './services/task-mcp.js'

export const laborerMcpLogPath = (home: string = homedir()): string =>
  join(
    home,
    'Library',
    'Application Support',
    'Laborer',
    'logs',
    'laborer-mcp.log'
  )

const logPath = laborerMcpLogPath()

const writeLog = (message: string): void => {
  const line = `${new Date().toISOString()} pid=${String(process.pid)} ${message}`
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${line}\n`, 'utf8')
  } catch {
    // Diagnostics are best-effort and must never corrupt or stop MCP.
  }
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    // A closed stderr must not stop protocol handling.
  }
}

const databasePath = taskDatabasePath()
const databaseLayer = LaborerDatabase.layer(databasePath).pipe(Layer.orDie)
const daemonPort = process.env.LABORER_DAEMON_PORT ?? '2100'
const daemonProtocol = RpcClient.layerProtocolSocket({
  retryTransientErrors: true,
}).pipe(
  Layer.provide(
    Layer.merge(
      NodeSocket.layerWebSocket(`ws://127.0.0.1:${daemonPort}/ws`),
      RpcSerialization.layerJson
    )
  )
)
const serverLayer = Layer.merge(TaskMcpToolsLayer, BrowserMcpToolsLayer).pipe(
  Layer.provideMerge(TaskMcpStdioProtocolLayer),
  Layer.provide(AgentTaskService.layer(databasePath)),
  Layer.provide(databaseLayer),
  Layer.provide(NodeStdio.layer),
  Layer.provide(BrowserAgentClient.layer),
  Layer.provide(daemonProtocol),
  Layer.provide(Logger.layer([]))
)

writeLog('starting')

NodeRuntime.runMain(
  Layer.launch(serverLayer).pipe(
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => writeLog('stopped')))
  )
)
