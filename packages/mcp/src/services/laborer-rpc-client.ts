import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { env } from "@laborer/env/server";
import {
	LaborerRpcs,
	type PrdResponse as PrdResponseSchema,
	type ProjectResponse,
	RpcError,
} from "@laborer/shared/rpc";
import { Context, Effect, Layer } from "effect";

type PrdResponse = typeof PrdResponseSchema.Type;

type PrdReadResponse = PrdResponse & {
	readonly content: string;
};

const serverRpcUrl = `http://localhost:${env.PORT}/rpc`;

class LaborerRpcClient extends Context.Tag("@laborer/mcp/LaborerRpcClient")<
	LaborerRpcClient,
	{
		readonly listProjects: () => Effect.Effect<
			readonly ProjectResponse[],
			RpcError
		>;
		readonly createPrd: (input: {
			readonly projectId: string;
			readonly title: string;
			readonly content: string;
		}) => Effect.Effect<PrdResponse, RpcError>;
		readonly listPrds: (input: {
			readonly projectId: string;
		}) => Effect.Effect<readonly PrdResponse[], RpcError>;
		readonly readPrd: (input: {
			readonly prdId: string;
		}) => Effect.Effect<PrdReadResponse, RpcError>;
		readonly updatePrd: (input: {
			readonly prdId: string;
			readonly content: string;
		}) => Effect.Effect<PrdResponse, RpcError>;
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
					return yield* rpcClient.project
						.list()
						.pipe(Effect.mapError(toRpcError));
				}
			);

			const createPrd = Effect.fn("LaborerRpcClient.createPrd")(
				function* (input: {
					readonly projectId: string;
					readonly title: string;
					readonly content: string;
				}) {
					return yield* rpcClient.prd
						.create(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			const listPrds = Effect.fn("LaborerRpcClient.listPrds")(
				function* (input: { readonly projectId: string }) {
					return yield* rpcClient.prd
						.list(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			const readPrd = Effect.fn("LaborerRpcClient.readPrd")(function* (input: {
				readonly prdId: string;
			}) {
				return yield* rpcClient.prd
					.read(input)
					.pipe(Effect.mapError(toRpcError));
			});

			const updatePrd = Effect.fn("LaborerRpcClient.updatePrd")(
				function* (input: {
					readonly prdId: string;
					readonly content: string;
				}) {
					return yield* rpcClient.prd
						.update(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			return LaborerRpcClient.of({
				createPrd,
				listPrds,
				listProjects,
				readPrd,
				updatePrd,
			});
		})
	);
}

const toRpcError = (error: unknown) =>
	new RpcError({
		code: "RPC_CLIENT_ERROR",
		message: error instanceof RpcClientError ? error.message : String(error),
	});

export { LaborerRpcClient };
