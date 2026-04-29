import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import {
  readBootstrapConfig,
  runServer,
  ServerRuntimeConfigLive,
} from './server-runtime.js'

const config = readBootstrapConfig()

NodeRuntime.runMain(
  runServer.pipe(Effect.provide(ServerRuntimeConfigLive(config)), Effect.scoped)
)
