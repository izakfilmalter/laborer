import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const dockerfile = readFileSync(".sandcastle/Dockerfile", "utf8");
const installsTiniPattern = /apt-get install -y[\s\S]*\btini\b/;
const tiniEntrypointPattern =
  /ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--", "sleep", "infinity"\]/;

describe("Sandcastle Docker image", () => {
  it("uses an init process that reaps orphaned test children", () => {
    assert.match(dockerfile, installsTiniPattern);
    assert.match(dockerfile, tiniEntrypointPattern);
  });
});
