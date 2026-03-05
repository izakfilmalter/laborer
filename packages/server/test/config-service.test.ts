/**
 * ConfigService integration tests.
 *
 * Tests config resolution, walk-up directory traversal, global config
 * fallback, provenance metadata, tilde expansion, and error handling
 * using real temporary directories on the filesystem.
 *
 * Issue #154: Config Service — resolve config with walk-up + global default
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	LaborerConfig,
	ResolvedLaborerConfig,
} from "../src/services/config-service.js";
import {
	CONFIG_FILE_NAME,
	ConfigService,
	expandTilde,
	GLOBAL_CONFIG_DIR,
	mergeConfigs,
	readConfigFile,
	walkUpForConfigs,
} from "../src/services/config-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temporary directory for test isolation. */
const createTempDir = (prefix: string): string => {
	const dir = join(
		homedir(),
		".config",
		"laborer-test",
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	);
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** Write a laborer.json config file at the given directory. */
const writeConfig = (dir: string, config: LaborerConfig): string => {
	const configPath = join(dir, CONFIG_FILE_NAME);
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
};

/** Run an Effect and return the result. */
const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect);

/** Run ConfigService.resolveConfig via the layer. */
const runResolveConfig = (
	projectRepoPath: string,
	projectName: string
): Promise<ResolvedLaborerConfig> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* ConfigService;
			return yield* service.resolveConfig(projectRepoPath, projectName);
		}).pipe(Effect.provide(ConfigService.layer))
	);

/** Run ConfigService.readGlobalConfig via the layer. */
const runReadGlobalConfig = (): Promise<LaborerConfig> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* ConfigService;
			return yield* service.readGlobalConfig();
		}).pipe(Effect.provide(ConfigService.layer))
	);

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Root temp directory for all tests in this suite. */
let testRoot: string;

beforeAll(() => {
	testRoot = createTempDir("config-service");
});

afterAll(() => {
	if (testRoot) {
		rmSync(testRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// expandTilde tests
// ---------------------------------------------------------------------------

describe("expandTilde", () => {
	it("should expand ~ to home directory", () => {
		expect(expandTilde("~")).toBe(homedir());
	});

	it("should expand ~/ prefix to home directory", () => {
		expect(expandTilde("~/projects/repo")).toBe(
			join(homedir(), "projects/repo")
		);
	});

	it("should not expand ~ in the middle of a path", () => {
		expect(expandTilde("/path/to/~something")).toBe("/path/to/~something");
	});

	it("should return absolute paths unchanged", () => {
		expect(expandTilde("/absolute/path")).toBe("/absolute/path");
	});

	it("should return relative paths unchanged", () => {
		expect(expandTilde("relative/path")).toBe("relative/path");
	});
});

// ---------------------------------------------------------------------------
// readConfigFile tests
// ---------------------------------------------------------------------------

describe("readConfigFile", () => {
	it("should return undefined for non-existent file", async () => {
		const result = await runEffect(
			readConfigFile(join(testRoot, "nonexistent", CONFIG_FILE_NAME))
		);
		expect(result).toBeUndefined();
	});

	it("should parse valid JSON config", async () => {
		const dir = join(testRoot, "valid-config");
		mkdirSync(dir, { recursive: true });
		writeConfig(dir, {
			worktreeDir: "~/worktrees",
			setupScripts: ["bun install"],
		});

		const result = await runEffect(readConfigFile(join(dir, CONFIG_FILE_NAME)));
		expect(result).toEqual({
			worktreeDir: "~/worktrees",
			setupScripts: ["bun install"],
		});
	});

	it("should return empty object for malformed JSON", async () => {
		const dir = join(testRoot, "malformed-json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, CONFIG_FILE_NAME), "{ not valid json }}}");

		const result = await runEffect(readConfigFile(join(dir, CONFIG_FILE_NAME)));
		expect(result).toEqual({});
	});

	it("should return empty object for empty file", async () => {
		const dir = join(testRoot, "empty-file");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, CONFIG_FILE_NAME), "");

		const result = await runEffect(readConfigFile(join(dir, CONFIG_FILE_NAME)));
		expect(result).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// walkUpForConfigs tests
// ---------------------------------------------------------------------------

describe("walkUpForConfigs", () => {
	it("should find config at the starting directory", async () => {
		const dir = join(testRoot, "walk-start");
		mkdirSync(dir, { recursive: true });
		const configPath = writeConfig(dir, { setupScripts: ["echo hello"] });

		const results = await runEffect(walkUpForConfigs(dir));
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]?.path).toBe(configPath);
		expect(results[0]?.config.setupScripts).toEqual(["echo hello"]);
	});

	it("should find configs in ancestor directories", async () => {
		const parent = join(testRoot, "walk-ancestor-parent");
		const child = join(parent, "child-project");
		mkdirSync(child, { recursive: true });

		const parentConfigPath = writeConfig(parent, {
			worktreeDir: "~/parent-worktrees",
		});
		const childConfigPath = writeConfig(child, {
			setupScripts: ["bun install"],
		});

		const results = await runEffect(walkUpForConfigs(child));

		// Child config should be first (closest), parent second
		const childResult = results.find((r) => r.path === childConfigPath);
		const parentResult = results.find((r) => r.path === parentConfigPath);

		expect(childResult).toBeDefined();
		expect(parentResult).toBeDefined();
		expect(childResult?.config.setupScripts).toEqual(["bun install"]);
		expect(parentResult?.config.worktreeDir).toBe("~/parent-worktrees");

		// Child should come before parent in the results
		const childIndex = childResult ? results.indexOf(childResult) : -1;
		const parentIndex = parentResult ? results.indexOf(parentResult) : -1;
		expect(childIndex).toBeLessThan(parentIndex);
	});

	it("should return empty array when no configs found", async () => {
		const dir = join(testRoot, "walk-no-config");
		mkdirSync(dir, { recursive: true });
		// Don't create a config file

		const results = await runEffect(walkUpForConfigs(dir));
		// May find configs in ancestor dirs (testRoot, etc.) — filter to only
		// configs at or below our test directory
		const relevantResults = results.filter(
			(r) =>
				r.path === join(dir, CONFIG_FILE_NAME) ||
				r.path.startsWith(join(dir, "/"))
		);
		expect(relevantResults).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// mergeConfigs tests
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
	it("should use hardcoded defaults when no configs provided", () => {
		const result = mergeConfigs([], "my-project");

		expect(result.worktreeDir.source).toBe("default");
		expect(result.worktreeDir.value).toBe(
			join(GLOBAL_CONFIG_DIR, "my-project")
		);
		expect(result.setupScripts.source).toBe("default");
		expect(result.setupScripts.value).toEqual([]);
		expect(result.rlphConfig.source).toBe("default");
		expect(result.rlphConfig.value).toBeNull();
	});

	it("should use values from config when provided", () => {
		const result = mergeConfigs(
			[
				{
					config: {
						worktreeDir: "/custom/worktrees",
						setupScripts: ["npm install"],
						rlphConfig: "rlph.json",
					},
					path: "/project/laborer.json",
				},
			],
			"my-project"
		);

		expect(result.worktreeDir.value).toBe("/custom/worktrees");
		expect(result.worktreeDir.source).toBe("/project/laborer.json");
		expect(result.setupScripts.value).toEqual(["npm install"]);
		expect(result.setupScripts.source).toBe("/project/laborer.json");
		expect(result.rlphConfig.value).toBe("rlph.json");
		expect(result.rlphConfig.source).toBe("/project/laborer.json");
	});

	it("should prefer closest config (project root over ancestor)", () => {
		const result = mergeConfigs(
			[
				{
					config: { worktreeDir: "/project-level" },
					path: "/repo/laborer.json",
				},
				{
					config: { worktreeDir: "/ancestor-level" },
					path: "/parent/laborer.json",
				},
			],
			"my-project"
		);

		// Closest (first in array) wins
		expect(result.worktreeDir.value).toBe("/project-level");
		expect(result.worktreeDir.source).toBe("/repo/laborer.json");
	});

	it("should merge partial configs from different levels", () => {
		const result = mergeConfigs(
			[
				{
					config: { setupScripts: ["bun install"] },
					path: "/repo/laborer.json",
				},
				{
					config: { worktreeDir: "/ancestor-worktrees" },
					path: "/parent/laborer.json",
				},
			],
			"my-project"
		);

		// setupScripts from project root (closest)
		expect(result.setupScripts.value).toEqual(["bun install"]);
		expect(result.setupScripts.source).toBe("/repo/laborer.json");

		// worktreeDir from ancestor (only place it's defined)
		expect(result.worktreeDir.value).toBe("/ancestor-worktrees");
		expect(result.worktreeDir.source).toBe("/parent/laborer.json");
	});

	it("should expand tilde in worktreeDir", () => {
		const result = mergeConfigs(
			[
				{
					config: { worktreeDir: "~/my-worktrees" },
					path: "/repo/laborer.json",
				},
			],
			"my-project"
		);

		expect(result.worktreeDir.value).toBe(join(homedir(), "my-worktrees"));
	});

	it("should resolve relative worktreeDir to absolute", () => {
		const result = mergeConfigs(
			[
				{
					config: { worktreeDir: "relative/path" },
					path: "/repo/laborer.json",
				},
			],
			"my-project"
		);

		// resolve() converts relative to absolute based on cwd
		expect(result.worktreeDir.value.startsWith("/")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ConfigService integration tests (via layer)
// ---------------------------------------------------------------------------

describe("ConfigService", () => {
	describe("resolveConfig", () => {
		it("should return defaults when no config files exist", async () => {
			const projectDir = join(testRoot, "no-config-project");
			mkdirSync(projectDir, { recursive: true });

			const result = await runResolveConfig(projectDir, "test-project");

			expect(result.worktreeDir.source).toBe("default");
			expect(result.worktreeDir.value).toBe(
				join(GLOBAL_CONFIG_DIR, "test-project")
			);
			expect(result.setupScripts.source).toBe("default");
			expect(result.setupScripts.value).toEqual([]);
			expect(result.rlphConfig.source).toBe("default");
			expect(result.rlphConfig.value).toBeNull();
		});

		it("should read config from project root", async () => {
			const projectDir = join(testRoot, "project-root-config");
			mkdirSync(projectDir, { recursive: true });
			const configPath = writeConfig(projectDir, {
				worktreeDir: "/custom/worktrees",
				setupScripts: ["bun install", "cp .env.example .env"],
				rlphConfig: "rlph-config.json",
			});

			const result = await runResolveConfig(projectDir, "test-project");

			expect(result.worktreeDir.value).toBe("/custom/worktrees");
			expect(result.worktreeDir.source).toBe(configPath);
			expect(result.setupScripts.value).toEqual([
				"bun install",
				"cp .env.example .env",
			]);
			expect(result.setupScripts.source).toBe(configPath);
			expect(result.rlphConfig.value).toBe("rlph-config.json");
			expect(result.rlphConfig.source).toBe(configPath);
		});

		it("should inherit from ancestor config", async () => {
			const parent = join(testRoot, "ancestor-inherit-parent");
			const child = join(parent, "child-project");
			mkdirSync(child, { recursive: true });

			writeConfig(parent, {
				worktreeDir: "~/parent-worktrees",
			});
			const childConfigPath = writeConfig(child, {
				setupScripts: ["pnpm install"],
			});

			const result = await runResolveConfig(child, "child-project");

			// setupScripts from child (closest)
			expect(result.setupScripts.value).toEqual(["pnpm install"]);
			expect(result.setupScripts.source).toBe(childConfigPath);

			// worktreeDir from parent (inherited)
			expect(result.worktreeDir.value).toBe(
				join(homedir(), "parent-worktrees")
			);
		});

		it("should override ancestor config with project root config", async () => {
			const parent = join(testRoot, "override-parent");
			const child = join(parent, "override-child");
			mkdirSync(child, { recursive: true });

			writeConfig(parent, {
				worktreeDir: "/parent-worktrees",
				setupScripts: ["parent-script"],
			});
			const childConfigPath = writeConfig(child, {
				worktreeDir: "/child-worktrees",
			});

			const result = await runResolveConfig(child, "child-project");

			// worktreeDir from child overrides parent
			expect(result.worktreeDir.value).toBe("/child-worktrees");
			expect(result.worktreeDir.source).toBe(childConfigPath);

			// setupScripts still from parent (child doesn't set it)
			expect(result.setupScripts.value).toEqual(["parent-script"]);
		});

		it("should expand tilde in worktreeDir from config", async () => {
			const projectDir = join(testRoot, "tilde-expansion");
			mkdirSync(projectDir, { recursive: true });
			writeConfig(projectDir, {
				worktreeDir: "~/my-laborer-worktrees",
			});

			const result = await runResolveConfig(projectDir, "test-project");

			expect(result.worktreeDir.value).toBe(
				join(homedir(), "my-laborer-worktrees")
			);
		});

		it("should handle malformed config gracefully", async () => {
			const projectDir = join(testRoot, "malformed-config-project");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, CONFIG_FILE_NAME), "{ broken json !!!");

			// Should not throw — falls back to defaults
			const result = await runResolveConfig(projectDir, "test-project");

			// Malformed config is treated as empty, so defaults apply
			expect(result.worktreeDir.source).toBe("default");
		});

		it("should use global config as fallback", async () => {
			// This test depends on whether a global config exists on the machine.
			// We just verify the service doesn't crash and returns a valid result.
			const projectDir = join(testRoot, "global-fallback-project");
			mkdirSync(projectDir, { recursive: true });

			const result = await runResolveConfig(projectDir, "global-fallback-test");

			// Should always have a valid worktreeDir
			expect(result.worktreeDir.value).toBeTruthy();
			expect(typeof result.worktreeDir.value).toBe("string");
		});

		it("should preserve provenance for each field independently", async () => {
			const grandparent = join(testRoot, "provenance-grandparent");
			const parent = join(grandparent, "provenance-parent");
			const child = join(parent, "provenance-child");
			mkdirSync(child, { recursive: true });

			const gpPath = writeConfig(grandparent, {
				rlphConfig: "grandparent-rlph.json",
			});
			writeConfig(parent, {
				worktreeDir: "/parent-worktrees",
			});
			const childPath = writeConfig(child, {
				setupScripts: ["child-script"],
			});

			const result = await runResolveConfig(child, "provenance-test");

			// Each field's provenance should trace to the config that set it
			expect(result.setupScripts.source).toBe(childPath);
			expect(result.rlphConfig.source).toBe(gpPath);
		});
	});

	describe("readGlobalConfig", () => {
		it("should return empty config when no global config file exists", async () => {
			// The global config file may or may not exist on the machine.
			// This test just verifies it doesn't crash.
			const result = await runReadGlobalConfig();

			expect(result).toBeDefined();
			expect(typeof result).toBe("object");
		});

		it("should ensure global config directory exists", async () => {
			// Just calling readGlobalConfig should create the directory
			await runReadGlobalConfig();

			// The GLOBAL_CONFIG_DIR should exist (it may have existed before)
			const { existsSync } = await import("node:fs");
			expect(existsSync(GLOBAL_CONFIG_DIR)).toBe(true);
		});
	});
});
