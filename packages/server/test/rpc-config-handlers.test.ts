import { RpcError } from "@laborer/shared/rpc";
import { Effect, Either, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handleConfigGet, handleConfigUpdate } from "../src/rpc/handlers.js";
import { ConfigService } from "../src/services/config-service.js";
import { ProjectRegistry } from "../src/services/project-registry.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: null,
} as const;

const makeProjectRegistryLayer = (
	getProject: (projectId: string) => Effect.Effect<typeof project, RpcError>
) =>
	Layer.succeed(
		ProjectRegistry,
		ProjectRegistry.of({
			addProject: () => Effect.die("not used in this test"),
			removeProject: () => Effect.die("not used in this test"),
			listProjects: () => Effect.succeed([]),
			getProject,
		})
	);

const makeConfigServiceLayer = (
	resolveConfig: ConfigService["Type"]["resolveConfig"],
	writeProjectConfig: ConfigService["Type"]["writeProjectConfig"]
) =>
	Layer.succeed(
		ConfigService,
		ConfigService.of({
			resolveConfig,
			readGlobalConfig: () => Effect.succeed({}),
			writeProjectConfig,
		})
	);

describe("config RPC handlers", () => {
	it("config.get returns NOT_FOUND when project does not exist", async () => {
		const getProject = vi.fn((projectId: string) =>
			Effect.fail(
				new RpcError({
					code: "NOT_FOUND",
					message: `Project not found: ${projectId}`,
				})
			)
		);
		const resolveConfig = vi.fn(() => Effect.die("should not be called"));

		const result = await Effect.runPromise(
			handleConfigGet({ projectId: "missing-project" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(getProject),
						makeConfigServiceLayer(resolveConfig, () =>
							Effect.die("should not be called")
						)
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("Project not found");
		}
		expect(getProject).toHaveBeenCalledWith("missing-project");
		expect(resolveConfig).not.toHaveBeenCalled();
	});

	it("config.update returns NOT_FOUND and does not write config", async () => {
		const getProject = vi.fn((projectId: string) =>
			Effect.fail(
				new RpcError({
					code: "NOT_FOUND",
					message: `Project not found: ${projectId}`,
				})
			)
		);
		const writeProjectConfig = vi.fn(() => Effect.die("should not be called"));

		const result = await Effect.runPromise(
			handleConfigUpdate({
				projectId: "missing-project",
				config: { worktreeDir: "~/worktrees" },
			}).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(getProject),
						makeConfigServiceLayer(
							() => Effect.die("should not be called"),
							writeProjectConfig
						)
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("Project not found");
		}
		expect(getProject).toHaveBeenCalledWith("missing-project");
		expect(writeProjectConfig).not.toHaveBeenCalled();
	});

	it("config.update returns INVALID_INPUT for malformed config payload", async () => {
		const getProject = vi.fn(() => Effect.succeed(project));
		const writeProjectConfig = vi.fn(() => Effect.die("should not be called"));

		const result = await Effect.runPromise(
			handleConfigUpdate({
				projectId: project.id,
				config: {
					setupScripts: ["bun install", 42] as unknown as readonly string[],
				},
			}).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(getProject),
						makeConfigServiceLayer(
							() => Effect.die("not used"),
							writeProjectConfig
						)
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("INVALID_INPUT");
		}
		expect(getProject).not.toHaveBeenCalled();
		expect(writeProjectConfig).not.toHaveBeenCalled();
	});

	it("config.update writes project config for existing projects", async () => {
		const getProject = vi.fn(() => Effect.succeed(project));
		const writeProjectConfig = vi.fn(() => Effect.void);

		const result = await Effect.runPromise(
			handleConfigUpdate({
				projectId: project.id,
				config: { setupScripts: ["bun install"] },
			}).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(getProject),
						makeConfigServiceLayer(
							() => Effect.die("not used"),
							writeProjectConfig
						)
					)
				)
			)
		);

		expect(Either.isRight(result)).toBe(true);
		expect(getProject).toHaveBeenCalledWith(project.id);
		expect(writeProjectConfig).toHaveBeenCalledWith(project.repoPath, {
			setupScripts: ["bun install"],
		});
	});
});
