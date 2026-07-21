import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";

const repositoryRoot = resolve(process.cwd(), "..");
const forbiddenPrefixes = [
  ["x", "app", "-"].join(""),
  ["x", "oxb", "-"].join(""),
  ["x", "oxe", "-"].join(""),
  ["x", "oxr", "-"].join(""),
  ["x", "oxe", ".", "xoxp", "-"].join(""),
  ["x", "oxe", ".", "xoxb", "-"].join(""),
] as const;
const allowedSuffix = "[REDACTED]";

const trackableFiles = (): readonly string[] =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" }
  )
    .split("\0")
    .filter((path) => path.length > 0);

describe("repository secret safety", () => {
  it("contains no unredacted Slack token prefixes in trackable files", () => {
    const violations: string[] = [];
    for (const relativePath of trackableFiles()) {
      const content = readFileSync(resolve(repositoryRoot, relativePath));
      if (content.includes(0)) {
        continue;
      }
      const text = content.toString("utf8");
      for (const prefix of forbiddenPrefixes) {
        let index = text.indexOf(prefix);
        while (index >= 0) {
          const suffix = text.slice(index + prefix.length);
          if (!suffix.startsWith(allowedSuffix)) {
            violations.push(relativePath);
            break;
          }
          index = text.indexOf(prefix, index + prefix.length);
        }
      }
    }
    assert.deepStrictEqual([...new Set(violations)].sort(), []);
  });

  it("ignores local environments, runtime state, and token files while tracking the example", () => {
    const ignoredPaths = [
      "next/.env",
      "next/.env.local",
      "next/.laborer-runtime/state.json",
      "next/local.token",
      "next/local.tokens",
      "next/slack-token-local",
      "next/slack-config-access-token-local",
    ];
    for (const path of ignoredPaths) {
      const ignored = execFileSync("git", ["check-ignore", path], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();
      assert.strictEqual(ignored, path);
    }
    assert.ok(trackableFiles().includes("next/.env.example"));
  });
});
