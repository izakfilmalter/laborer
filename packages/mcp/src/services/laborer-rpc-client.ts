import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { env } from "@laborer/env/server";
import {
	LaborerRpcs,
	type ProjectResponse,
	RpcError,
} from "@laborer/shared/rpc";
import { Context, Effect, Layer } from "effect";

const serverRpcUrl = `http://localhost:${env.PORT}/rpc`;

class LaborerRpcClient extends Context.Tag("@laborer/mcp/LaborerRpcClient")<
	LaborerRpcClient,
	{
		readonly listProjects: () => Effect.Effect<
			readonly ProjectResponse[],
			RpcError
		>;
	}
>() {
	static readonly layer = Layer.scoped(
		LaborerRpcClient,
		Effect.gen(function* () {
			const rpcClient = yield* RpcClient.make(LaborerRpcs).pipe(
				Effect.provide(
					RpcClient.layerProtocolHttp({
						url: serverRpcUrl,
					}).pipe(
						Layer.provide(FetchHttpClient.layer),
						Layer.provide(RpcSerialization.layerJson)
					)
				)
			);

			const listProjects = Effect.fn("LaborerRpcClient.listProjects")(
				function* () {
					return yield* rpcClient.project.list().pipe(
						Effect.mapError(
							(error) =>
								new RpcError({
									code: "RPC_CLIENT_ERROR",
									message:
										error instanceof RpcClientError
											? error.message
											: String(error),
								})
						)
					);
				}
			);

			return LaborerRpcClient.of({
				listProjects,
			});
		})
	);
}

export { LaborerRpcClient };
