import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const dockerfile = readFileSync("../.sandcastle/Dockerfile", "utf8");
const dockerignore = readFileSync("../.dockerignore", "utf8");
const packageJson = JSON.parse(
  readFileSync("../.sandcastle/package.json", "utf8")
) as {
  readonly devDependencies: Readonly<Record<string, string>>;
};
const installsTiniPattern = /apt-get install -y[\s\S]*\btini\b/;
const tiniEntrypointPattern =
  /ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--", "sleep", "infinity"\]/;
const openCodeCliInstallPattern = /npm install -g @opencode-ai\/cli@([^\s]+)/;
const nodeGypInstallPattern = /npm install -g node-gyp@([^\s]+)/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("Sandcastle Docker image", () => {
  it("uses an init process that reaps orphaned test children", () => {
    assert.match(dockerfile, installsTiniPattern);
    assert.match(dockerfile, tiniEntrypointPattern);
  });

  it("can build native dependencies in fresh Linux ARM64 worktrees", () => {
    for (const tool of ["g++", "make", "python3"]) {
      assert.include(dockerfile, `  ${tool} \\`);
    }
    assert.match(
      nodeGypInstallPattern.exec(dockerfile)?.[1] ?? "",
      exactVersionPattern
    );
  });

  it("warms both frozen Bun dependency caches without sending secrets", () => {
    assert.include(dockerfile, "current/package.json current/bun.lock");
    assert.include(dockerfile, "next/package.json next/bun.lock");
    assert.include(
      dockerfile,
      "bun install --cwd /tmp/sandcastle-current --frozen-lockfile --ignore-scripts"
    );
    assert.include(
      dockerfile,
      "bun install --cwd /tmp/sandcastle-next --frozen-lockfile --ignore-scripts"
    );
    assert.include(dockerignore, "**/.env");
    assert.include(dockerignore, "**/node_modules/");
  });

  it("installs the exact Sandcastle opencode2 CLI pin", () => {
    const install = openCodeCliInstallPattern.exec(dockerfile);
    const packageVersion =
      packageJson.devDependencies["@opencode-ai/cli"] ?? "";
    assert.isNotNull(install);
    assert.match(packageVersion, exactVersionPattern);
    assert.strictEqual(install[1], packageVersion);
  });
});
