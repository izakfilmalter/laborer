import { basename } from 'node:path'

import type { RuntimeMode } from '@laborer/contracts/server'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  resolveServerWsUrl,
} from '@laborer/shared/server'
import { Context, Effect, Layer } from 'effect'

export interface ServerRuntimeConfigShape {
  readonly cwd: string
  readonly host: string
  readonly mode: RuntimeMode
  readonly port: number
  readonly projectName: string
  readonly wsUrl: string
}

export class ServerRuntimeConfig extends Context.Service<
  ServerRuntimeConfig,
  ServerRuntimeConfigShape
>()('@laborer/server/ServerRuntimeConfig') {
  static readonly layer = Layer.effect(
    ServerRuntimeConfig,
    Effect.sync(() => {
      const host =
        process.env.LABORER_SERVER_HOST?.trim() || DEFAULT_SERVER_HOST
      const parsedPort = Number.parseInt(
        process.env.LABORER_SERVER_PORT ?? '',
        10
      )
      const port =
        Number.isInteger(parsedPort) && parsedPort > 0
          ? parsedPort
          : DEFAULT_SERVER_PORT
      const rawMode = process.env.LABORER_SERVER_MODE?.trim()
      const mode: RuntimeMode = rawMode === 'desktop' ? 'desktop' : 'web'
      const cwd = process.cwd()
      const projectName = basename(cwd) || 'laborer'

      return ServerRuntimeConfig.of({
        cwd,
        host,
        port,
        mode,
        projectName,
        wsUrl: resolveServerWsUrl({ host, port }),
      })
    })
  )
}
