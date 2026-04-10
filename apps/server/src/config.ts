import { basename } from 'node:path'

import type { RuntimeMode } from '@laborer/contracts/server'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  resolveServerWsUrl,
} from '@laborer/shared/server'
import { Context, Layer, Match } from 'effect'

export interface ServerRuntimeConfigShape {
  readonly cwd: string
  readonly host: string
  readonly mode: RuntimeMode
  readonly port: number
  readonly projectName: string
  readonly wsUrl: string
}

export class ServerRuntimeConfig extends Context.Tag(
  '@laborer/server/ServerRuntimeConfig'
)<ServerRuntimeConfig, ServerRuntimeConfigShape>() {
  static readonly layer = Layer.sync(this, createServerRuntimeConfig)
}

function createServerRuntimeConfig() {
  const cwd = process.cwd()
  const host = process.env.LABORER_SERVER_HOST?.trim() || DEFAULT_SERVER_HOST
  const port = resolveServerPort(process.env.LABORER_SERVER_PORT)
  const mode = resolveRuntimeMode(process.env.LABORER_SERVER_MODE)

  return ServerRuntimeConfig.of({
    cwd,
    host,
    mode,
    port,
    projectName: basename(cwd) || 'laborer',
    wsUrl: resolveServerWsUrl({ host, port }),
  })
}

function resolveRuntimeMode(rawMode: string | undefined): RuntimeMode {
  return Match.value(rawMode?.trim()).pipe(
    Match.when('desktop', (): RuntimeMode => 'desktop'),
    Match.orElse((): RuntimeMode => 'web')
  )
}

function resolveServerPort(rawPort: string | undefined): number {
  return Match.value(Number.parseInt(rawPort ?? '', 10)).pipe(
    Match.when(
      (candidate) => Number.isInteger(candidate) && candidate > 0,
      (candidate) => candidate
    ),
    Match.orElse(() => DEFAULT_SERVER_PORT)
  )
}
