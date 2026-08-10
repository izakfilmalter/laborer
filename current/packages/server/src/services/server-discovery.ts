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
import { Effect, Layer, Schema } from 'effect'

const discoveryFile = join(dirname(taskDatabasePath()), 'server.json')
const DiscoveryRecord = Schema.Struct({
  host: Schema.String,
  pid: Schema.Int,
  port: Schema.Int,
  url: Schema.String,
})
const DiscoveryJson = Schema.parseJson(DiscoveryRecord)

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
        const record = {
          host,
          pid: process.pid,
          port,
          url: `http://${host}:${String(port)}/mcp`,
        }
        writeFileSync(
          temporary,
          `${Schema.encodeSync(DiscoveryJson)(record)}\n`,
          { mode: 0o600 }
        )
        renameSync(temporary, discoveryFile)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            const current = Schema.decodeUnknownSync(DiscoveryJson)(
              readFileSync(discoveryFile, 'utf8')
            )
            if (current.pid === process.pid && current.port === port) {
              rmSync(discoveryFile, { force: true })
            }
          } catch {
            // Another process may have replaced or removed the discovery file.
          }
        })
      )
    })
  )
