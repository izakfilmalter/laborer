import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const createTempDir = (prefix: string, tempRoots?: string[]): string => {
	const dir = join(
		tmpdir(),
		`laborer-test-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	tempRoots?.push(dir);
	return dir;
};

export const git = (args: string, cwd: string): string =>
	execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();

export const initRepo = (prefix: string, tempRoots?: string[]): string => {
	const repoPath = createTempDir(prefix, tempRoots);
	git("init", repoPath);
	git("config user.email test@example.com", repoPath);
	git("config user.name Test User", repoPath);
	writeFileSync(join(repoPath, "README.md"), "# test\n");
	git("add README.md", repoPath);
	git('commit -m "initial"', repoPath);
	return repoPath;
};
