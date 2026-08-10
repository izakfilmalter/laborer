import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpServer } from '@effect/platform'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect, Layer } from 'effect'

const discoveryFile = join(dirname(taskDatabasePath()), 'server.json')

export const serverDiscoveryLayer = (fallback: {
  readonly host: string
  readonly port: number
}) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      const host =
        address._tag === 'TcpAddress' ? address.hostname : fallback.host
      const port = address._tag === 'TcpAddress' ? address.port : fallback.port
      yield* Effect.sync(() => {
        mkdirSync(dirname(discoveryFile), { recursive: true })
        const temporary = `${discoveryFile}.${String(process.pid)}.tmp`
        writeFileSync(
          temporary,
          `${JSON.stringify({ host, port, url: `http://${host}:${String(port)}/mcp` })}\n`,
          { mode: 0o600 }
        )
        renameSync(temporary, discoveryFile)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            const current = JSON.parse(readFileSync(discoveryFile, 'utf8')) as {
              port?: unknown
            }
            if (current.port === port) {
              rmSync(discoveryFile, { force: true })
            }
          } catch {
            // Another process may have replaced or removed the discovery file.
          }
        })
      )
    })
  )
