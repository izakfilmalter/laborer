import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeRuntime, NodeStdio } from '@effect/platform-node'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect, Layer } from 'effect'
import { AgentTaskService } from './services/agent-task-service.js'
import { LaborerDatabase } from './services/laborer-database.js'
import {
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
const serverLayer = TaskMcpToolsLayer.pipe(
  Layer.provideMerge(TaskMcpStdioProtocolLayer),
  Layer.provide(AgentTaskService.layer(databasePath)),
  Layer.provide(databaseLayer),
  Layer.provide(NodeStdio.layer)
)

writeLog('starting')

NodeRuntime.runMain(
  Layer.launch(serverLayer).pipe(
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => writeLog('stopped')))
  )
)
