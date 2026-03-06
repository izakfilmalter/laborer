import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { handleProjectList } from "../src/rpc/handlers.js";
import { ProjectRegistry } from "../src/services/project-registry.js";

const projects = [
	{
		canonicalGitCommonDir: null,
		id: "project-1",
		name: "laborer",
		repoId: null,
		repoPath: "/repo/laborer",
		rlphConfig: null,
	},
	{
		canonicalGitCommonDir: null,
		id: "project-2",
		name: "website",
		repoId: null,
		repoPath: "/repo/website",
		rlphConfig: ".rlphrc",
	},
] as const;

const ProjectRegistryTestLayer = Layer.succeed(
	ProjectRegistry,
	ProjectRegistry.of({
		addProject: () => Effect.die("not used in this test"),
		removeProject: () => Effect.die("not used in this test"),
		listProjects: () => Effect.succeed(projects),
		getProject: () => Effect.die("not used in this test"),
	})
);

describe("project.list RPC handler", () => {
	it.effect("returns registered projects from the project registry", () =>
		Effect.gen(function* () {
			const listedProjects = yield* handleProjectList();

			assert.deepStrictEqual(listedProjects, [
				{
					id: "project-1",
					name: "laborer",
					repoPath: "/repo/laborer",
					rlphConfig: undefined,
				},
				{
					id: "project-2",
					name: "website",
					repoPath: "/repo/website",
					rlphConfig: ".rlphrc",
				},
			]);
		}).pipe(Effect.provide(ProjectRegistryTestLayer))
	);
});
