import { McpServer } from '@effect/ai'
import { NodeRuntime, NodeSink, NodeStream } from '@effect/platform-node'
import { Effect, Layer, Logger } from 'effect'
import { LaborerRpcClient } from './services/laborer-rpc-client.js'
import { ProjectDiscovery } from './services/project-discovery.js'
import { IssueToolsLayer } from './tools/issue-tools.js'
import { PrdToolsLayer } from './tools/prd-tools.js'

const McpLive = McpServer.layerStdio({
  name: 'laborer',
  version: '0.0.0',
  stdin: NodeStream.stdin,
  stdout: NodeSink.stdout,
})

const AppLive = PrdToolsLayer.pipe(
  Layer.merge(IssueToolsLayer),
  Layer.provide(ProjectDiscovery.layer),
  Layer.provide(LaborerRpcClient.layer),
  Layer.provide(McpLive),
  Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
)

const main = AppLive.pipe(Layer.launch, Effect.scoped)

NodeRuntime.runMain(main)
