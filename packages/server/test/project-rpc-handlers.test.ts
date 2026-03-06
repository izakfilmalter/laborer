import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { handleProjectList } from "../src/rpc/handlers.js";
import { ProjectRegistry } from "../src/services/project-registry.js";

const projects = [
	{
		id: "project-1",
		name: "laborer",
		repoPath: "/repo/laborer",
		rlphConfig: null,
	},
	{
		id: "project-2",
		name: "website",
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
	it("returns registered projects from the project registry", async () => {
		const listedProjects = await Effect.runPromise(
			handleProjectList().pipe(Effect.provide(ProjectRegistryTestLayer))
		);

		expect(listedProjects).toEqual([
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
	});
});
