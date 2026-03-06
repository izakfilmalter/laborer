import { McpServer } from "@effect/ai";
import { BunRuntime, BunSink, BunStream } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { LaborerRpcClient } from "./services/laborer-rpc-client.js";
import { ProjectDiscovery } from "./services/project-discovery.js";

const McpLive = McpServer.layerStdio({
	name: "laborer",
	version: "0.0.0",
	stdin: BunStream.stdin,
	stdout: BunSink.stdout,
});

const AppLive = ProjectDiscovery.layer.pipe(
	Layer.provide(LaborerRpcClient.layer),
	Layer.provide(McpLive),
	Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
);

const main = AppLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
