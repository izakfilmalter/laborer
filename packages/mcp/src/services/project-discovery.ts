import { dirname, resolve } from "node:path";
import { type ProjectResponse, RpcError } from "@laborer/shared/rpc";
import { Context, Effect, Layer } from "effect";
import { LaborerRpcClient } from "./laborer-rpc-client.js";

const getParentPaths = (cwd: string): readonly string[] => {
	const paths: string[] = [];
	let currentPath = resolve(cwd);

	while (true) {
		paths.push(currentPath);
		const parentPath = dirname(currentPath);
		if (parentPath === currentPath) {
			return paths;
		}
		currentPath = parentPath;
	}
};

export const discoverProjectFromCwd = (
	projects: readonly ProjectResponse[],
	cwd: string
): ProjectResponse | null => {
	const projectsByRepoPath = new Map(
		projects.map((project) => [resolve(project.repoPath), project])
	);

	for (const candidatePath of getParentPaths(cwd)) {
		const matchedProject = projectsByRepoPath.get(candidatePath);
		if (matchedProject) {
			return matchedProject;
		}
	}

	return null;
};

class ProjectDiscovery extends Context.Tag("@laborer/mcp/ProjectDiscovery")<
	ProjectDiscovery,
	{
		readonly discoverProject: (
			cwd?: string
		) => Effect.Effect<ProjectResponse, RpcError>;
	}
>() {
	static readonly layer = Layer.effect(
		ProjectDiscovery,
		Effect.gen(function* () {
			const laborerRpcClient = yield* LaborerRpcClient;

			const discoverProject = Effect.fn("ProjectDiscovery.discoverProject")(
				function* (cwd?: string) {
					const resolvedCwd = resolve(cwd ?? process.cwd());
					const projects = yield* laborerRpcClient.listProjects();
					const project = discoverProjectFromCwd(projects, resolvedCwd);

					if (project === null) {
						return yield* new RpcError({
							code: "NOT_FOUND",
							message: `No registered Laborer project found for cwd: ${resolvedCwd}`,
						});
					}

					return project;
				}
			);

			return ProjectDiscovery.of({
				discoverProject,
			});
		})
	);
}

export { ProjectDiscovery };
