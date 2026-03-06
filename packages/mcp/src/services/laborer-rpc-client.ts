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
import type { TaskStatus } from "@laborer/shared/types";
import { Context, Effect, Layer } from "effect";

type PrdResponse = typeof PrdResponseSchema.Type;

type PrdReadResponse = PrdResponse & {
	readonly content: string;
};

export interface TaskResponse {
	readonly externalId?: string | undefined;
	readonly id: string;
	readonly prdId?: string | undefined;
	readonly projectId: string;
	readonly source: string;
	readonly status: string;
	readonly title: string;
}

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
		readonly createIssue: (input: {
			readonly prdId: string;
			readonly title: string;
			readonly body: string;
		}) => Effect.Effect<TaskResponse, RpcError>;
		readonly readIssues: (input: {
			readonly prdId: string;
		}) => Effect.Effect<string, RpcError>;
		readonly listRemainingIssues: (input: {
			readonly prdId: string;
		}) => Effect.Effect<readonly TaskResponse[], RpcError>;
		readonly updateIssue: (input: {
			readonly taskId: string;
			readonly body?: string | undefined;
			readonly status?: TaskStatus | undefined;
		}) => Effect.Effect<TaskResponse, RpcError>;
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

			const createIssue = Effect.fn("LaborerRpcClient.createIssue")(
				function* (input: {
					readonly prdId: string;
					readonly title: string;
					readonly body: string;
				}) {
					return yield* rpcClient.prd
						.createIssue(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			const readIssues = Effect.fn("LaborerRpcClient.readIssues")(
				function* (input: { readonly prdId: string }) {
					return yield* rpcClient.prd
						.readIssues(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			const listRemainingIssues = Effect.fn(
				"LaborerRpcClient.listRemainingIssues"
			)(function* (input: { readonly prdId: string }) {
				return yield* rpcClient.prd
					.listRemainingIssues(input)
					.pipe(Effect.mapError(toRpcError));
			});

			const updateIssue = Effect.fn("LaborerRpcClient.updateIssue")(
				function* (input: {
					readonly taskId: string;
					readonly body?: string | undefined;
					readonly status?: TaskStatus | undefined;
				}) {
					return yield* rpcClient.prd
						.updateIssue(input)
						.pipe(Effect.mapError(toRpcError));
				}
			);

			return LaborerRpcClient.of({
				createIssue,
				createPrd,
				listRemainingIssues,
				listPrds,
				listProjects,
				readPrd,
				readIssues,
				updateIssue,
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
