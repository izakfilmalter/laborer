/** THROWAWAY ISSUE #217 CANARY — local runtime paths. */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeCanarySocketPath = (runtimeRoot: string): string =>
  join(
    tmpdir(),
    `laborer-canary-${createHash("sha256").update(runtimeRoot).digest("hex").slice(0, 16)}.sock`
  );
