import { McpServer } from '@effect/ai'
import { NodeRuntime, NodeSink, NodeStream } from '@effect/platform-node'
import { Effect, Layer, Logger } from 'effect'

const McpLive = McpServer.layerStdio({
  name: 'laborer',
  version: '0.0.0',
  stdin: NodeStream.stdin,
  stdout: NodeSink.stdout,
})

const AppLive = McpLive.pipe(
  Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
)

const main = AppLive.pipe(Layer.launch, Effect.scoped)

NodeRuntime.runMain(main)
